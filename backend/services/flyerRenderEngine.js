/**
 * Travel CRM — Marketing Flyer multi-format render engine
 * (PRD_TRAVEL_MARKETING_FLYER #908 slice S17 — `docs/TRAVEL_BIG_SCOPE_BACKLOG.md`).
 *
 * Materialises a `TravelFlyerTemplate`'s `{ palette, layout, assets }` shape
 * into one of FIVE deliverable formats:
 *
 *   - `pdf-a4`         : 595×842 pt portrait PDF (A4, FR-3.4.1)
 *   - `pdf-a5`         : 420×595 pt portrait PDF (A5, FR-3.4.1)
 *   - `png-square`     : 1200×1200 PNG (Instagram square / FB cover, FR-3.4.2)
 *   - `png-portrait-ig`: 1080×1920 PNG (Instagram story / WhatsApp story, FR-3.4.2/3)
 *   - `png-landscape-fb`: 1920×1080 PNG (Facebook landscape banner / YouTube card, FR-3.4.2)
 *
 * The PDF path delegates to `backend/lib/flyerPdfRender.js` (slice 11, already
 * shipped) — A5 plugs in by extending the PAPER_SIZES table locally so the
 * existing renderer doesn't have to re-bake its layout zones. The renderer
 * accepts a pdfkit page-size token; "A5" is one of pdfkit's built-ins.
 *
 * The PNG path uses Puppeteer. `puppeteer` is a backend dependency
 * (see `backend/package.json`); the renderer launches headless Chrome,
 * loads the HTML shell produced by `buildHtmlShellForPng()` at the
 * requested viewport, and screenshots to PNG. If Chrome fails to launch
 * (missing binary, infra error), the renderer throws — callers MUST get
 * a real image or a clean error, never a placeholder.
 *
 * === Module API ===
 *
 *   renderFlyer({ template, data, format }) → Promise<{
 *     buffer: Buffer,
 *     mimeType: 'application/pdf' | 'image/png',
 *     extension: 'pdf' | 'png',
 *     widthPx: number | null,   // PNG only (PDF dimensions in pt, exposed via aspect)
 *     heightPx: number | null,  // PNG only
 *     engine: 'pdfkit' | 'puppeteer',  // for X-Flyer-Render-Engine
 *   }>
 *
 *   - `template`  : { palette?, layout?, assets? } — parsed JSON columns
 *                    from `TravelFlyerTemplate` (caller does JSON.parse).
 *   - `data`      : Optional caller-provided overlay overrides — e.g.
 *                    { priceOverride: '₹78,000', dateOverride: 'May 18' }.
 *                    Merged INTO the template's layout block content so the
 *                    Hassan-clone-and-tweak flow (PRD §1 Story 1) doesn't
 *                    have to persist a fresh template per departure date.
 *                    Optional; missing data → render the template as-is.
 *   - `format`    : One of the 5 strings listed at the top of this header.
 *                    Throws Error with `code='INVALID_FORMAT'` + `status=400`
 *                    on any other value so the route layer can surface a
 *                    clean 400.
 *
 * The function is pure-ish — no Prisma, no fs, no audit logging. The route
 * layer wraps the call in its auth + sub-brand gate + writeAudit, exactly
 * the way `/:id/preview.pdf` (slice 12) wraps `lib/flyerPdfRender.js`.
 *
 * === Format ↔ dimensions table ===
 *
 *   | format            | width × height (px) | mime           | engine    |
 *   |-------------------|--------------------|----------------|-----------|
 *   | pdf-a4            | 595 × 842 pt       | application/pdf| pdfkit    |
 *   | pdf-a5            | 420 × 595 pt       | application/pdf| pdfkit    |
 *   | png-square        | 1200 × 1200        | image/png      | puppeteer-headless |
 *   | png-portrait-ig   | 1080 × 1920        | image/png      | puppeteer-headless |
 *   | png-landscape-fb  | 1920 × 1080        | image/png      | puppeteer-headless |
 *
 * === Testability ===
 *
 * The module is mock-friendly:
 *   - PDF branch: `lib/flyerPdfRender.js` is itself pure (returns
 *     Promise<Buffer>) — tests can call this module directly and inspect
 *     the PDF magic bytes (`%PDF`) on the returned buffer.
 *   - PNG branch: tests inject a `vi.mock('puppeteer', ...)` block to
 *     stub the launch + screenshot calls; the renderer's path through
 *     `puppeteer.launch().newPage().screenshot()` is asserted via the
 *     mock's call args. `buildHtmlShellForPng()` is a pure string
 *     transform — tested independently via snapshot assertions.
 *
 * === References ===
 *
 *   - PRD: docs/PRD_TRAVEL_MARKETING_FLYER.md FR-3.4.1, FR-3.4.2, AC-6.3, AC-6.4
 *   - Backlog: docs/TRAVEL_BIG_SCOPE_BACKLOG.md slice S17
 *   - Sibling lib: backend/lib/flyerPdfRender.js (PDF renderer, slice 11)
 *   - Sibling lib: backend/lib/flyerExport.js (cache-key + hash helpers, slice 8)
 *   - Route consumer: backend/routes/travel_flyer_templates.js POST /:id/render (this slice)
 */

"use strict";

const { renderFlyerPdf } = require("../lib/flyerPdfRender");

/**
 * Source-canvas dimensions (matches `CANVAS_W` / `CANVAS_H` in
 * `frontend/src/pages/travel/MarketingFlyerStudio.jsx`). The editor
 * positions every block absolutely inside this 540×720 space; the
 * renderer scales the layout to the requested output `widthPx`/`heightPx`
 * using independent X/Y factors so the operator's composition lands
 * pixel-for-pixel in the exported PNG.
 */
const CANVAS_W = 540;
const CANVAS_H = 720;

/**
 * The 5 supported `format` values + their dispatch metadata. Keyed for
 * O(1) format-validity lookup + tidy switch dispatch in renderFlyer.
 *
 * `pdfAspect` is the lib/flyerPdfRender pdfkit page-size token. We pass
 * 'a4' for pdf-a4 (existing branch) and inject a fresh 'a5' token below
 * (lib/flyerPdfRender's PAPER_SIZES has `a4`, `us_letter`; A5 is a
 * pdfkit built-in size string).
 */
const FORMAT_TABLE = Object.freeze({
  "pdf-a4": {
    kind: "pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    pdfPageSize: "A4",
    widthPx: null,
    heightPx: null,
  },
  "pdf-a5": {
    kind: "pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    pdfPageSize: "A5",
    widthPx: null,
    heightPx: null,
  },
  "png-square": {
    kind: "png",
    mimeType: "image/png",
    extension: "png",
    widthPx: 1200,
    heightPx: 1200,
  },
  "png-portrait-ig": {
    kind: "png",
    mimeType: "image/png",
    extension: "png",
    widthPx: 1080,
    heightPx: 1920,
  },
  "png-landscape-fb": {
    kind: "png",
    mimeType: "image/png",
    extension: "png",
    widthPx: 1920,
    heightPx: 1080,
  },
});

const SUPPORTED_FORMATS = Object.freeze(Object.keys(FORMAT_TABLE));

/**
 * Merge caller-provided `data` overrides into the template's layout
 * blocks. Used for the Hassan clone-and-tweak flow — instead of writing a
 * fresh template row per departure-date variant, the operator passes the
 * variant fields in the `data` object and the renderer applies them at
 * render time only.
 *
 * Override keys (all optional):
 *   - `priceOverride`   → replaces content of first 'price' block
 *   - `titleOverride`   → replaces content of first 'text' block
 *   - `ctaOverride`     → replaces content of first 'cta' block
 *   - `dateOverride`    → appended to the title block (if present, with " — ")
 *
 * Unknown override keys are silently ignored (forward-compatible: a
 * future renderer can add new override types without breaking older
 * callers).
 *
 * Returns a NEW template shape — never mutates the caller's input.
 */
function applyDataOverrides(template, data) {
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    return template;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return template;
  }

  const {
    priceOverride,
    titleOverride,
    ctaOverride,
    dateOverride,
  } = data;

  const layoutSrc = Array.isArray(template.layout) ? template.layout : [];
  const layout = layoutSrc.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type === "price" && typeof priceOverride === "string" && priceOverride.length > 0) {
      return { ...block, content: priceOverride };
    }
    if (block.type === "text" && (typeof titleOverride === "string" || typeof dateOverride === "string")) {
      const base = typeof titleOverride === "string" && titleOverride.length > 0
        ? titleOverride
        : block.content;
      const withDate = typeof dateOverride === "string" && dateOverride.length > 0
        ? `${base} — ${dateOverride}`
        : base;
      return { ...block, content: withDate };
    }
    if (block.type === "cta" && typeof ctaOverride === "string" && ctaOverride.length > 0) {
      return { ...block, content: ctaOverride };
    }
    return block;
  });

  return { ...template, layout };
}

/**
 * Render the PDF path. Delegates to `lib/flyerPdfRender.js`'s
 * `renderFlyerPdf(template, opts)`, mapping the pdfkit page-size token
 * back to the lib's aspect-token taxonomy.
 *
 * History: pre-S75, lib/flyerPdfRender.js's PAPER_SIZES table mapped
 * only `'a4' → 'A4'` and `'us_letter' → 'LETTER'` — so this branch
 * passed `aspect: 'a4'` for BOTH pdf-a4 AND pdf-a5 formats, and pdf-a5
 * silently rendered as an A4-sized PDF. S75 extended the lib's
 * PAPER_SIZES table to include `'a5' → 'A5'`, so pdf-a5 can now honour
 * the requested page size end-to-end. This dispatch maps formatMeta's
 * pdfkit-token back to the lib's aspect-token verbatim.
 */
async function renderPdfBranch({ template, formatMeta }) {
  // Map pdfkit page-size tokens back to the lib's aspect taxonomy. The
  // lib accepts 'a4' | 'a5' | 'us_letter' and defaults to 'a4' on any
  // unrecognised value — but we shouldn't need that fallback now.
  const ASPECT_BY_PAGE_SIZE = { A4: "a4", A5: "a5", LETTER: "us_letter" };
  const opts = {
    aspect: ASPECT_BY_PAGE_SIZE[formatMeta.pdfPageSize] || "a4",
    hash: "synthetic",
  };
  const buffer = await renderFlyerPdf(template, opts);
  return {
    buffer,
    mimeType: formatMeta.mimeType,
    extension: formatMeta.extension,
    widthPx: null,
    heightPx: null,
    engine: "pdfkit",
  };
}

/**
 * Build the HTML document Puppeteer screenshots. The shell renders the
 * operator's full canvas composition — every block at its
 * absolute (x, y, width, height) position from the editor, scaled into
 * the requested output dimensions. This is what loadable Chrome paints,
 * so the exported PNG matches the editor preview block-for-block.
 *
 * Layout block types honoured:
 *   - `text`  : absolute-positioned div with `content`, `color`, `fontSize`
 *   - `image` : absolute-positioned img with `src` (DALL-E URL / upload URL)
 *   - `price` / `cta` : rendered as styled text blocks (palette accents)
 *
 * Pure — no Puppeteer dep + no fs. Unit-testable end-to-end via string
 * snapshot.
 */
function buildHtmlShellForPng(template, widthPx, heightPx) {
  const palette = (template && template.palette) || {};
  const layout = (template && Array.isArray(template.layout)) ? template.layout : [];

  const safeHex = (input, fallback) => (
    typeof input === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(input) ? input : fallback
  );
  const safePrimary = safeHex(palette.primaryHex, "#122647");
  const safeBg = safeHex(palette.bgHex, "#FFFFFF");
  const safeText = safeHex(palette.textHex, "#222222");
  const safeAccent = safeHex(palette.accentHex, "#C89A4E");
  const safeSecondary = safeHex(palette.secondaryHex, "#265855");

  // Independent X/Y scale: stretch from editor canvas to output.
  // Operator's composition lands at the same proportional positions
  // even when aspect ratios differ (e.g. 540×720 → 1080×1920).
  const scaleX = widthPx / CANVAS_W;
  const scaleY = heightPx / CANVAS_H;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  ));

  const titleBlock = layout.find((b) => b && b.type === "text");
  const titleText = (titleBlock && typeof titleBlock.content === "string") ? titleBlock.content : "Untitled Flyer";

  // Render each block as an absolute-positioned div, scaled from the
  // editor's 540×720 canvas to the requested output. Unknown block
  // types fall through silently (forward-compat).
  const blocksHtml = layout.map((b) => {
    if (!b || typeof b !== "object") return "";
    const left = Math.round((Number(b.x) || 0) * scaleX);
    const top = Math.round((Number(b.y) || 0) * scaleY);
    const w = Math.round((Number(b.width) || 0) * scaleX);
    const h = Math.round((Number(b.height) || 0) * scaleY);
    const base = `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;`;

    if (b.type === "image") {
      const src = typeof b.src === "string" ? b.src : "";
      if (!src) return "";
      return `<img src="${esc(src)}" style="${base}object-fit:cover;" alt="" />`;
    }
    // text / price / cta — all render as styled text. Font-size scaled
    // by the X factor so type stays readable at the output dimensions.
    const color = b.type === "price" ? safeSecondary
      : b.type === "cta" ? safeAccent
        : (typeof b.color === "string" ? b.color : safeText);
    const fs = Math.round(((Number(b.fontSize) || 18)) * scaleX);
    const weight = b.type === "text" && (b.fontSize || 0) >= 24 ? 700 : 600;
    const content = typeof b.content === "string" ? b.content : "";
    if (!content) return "";
    return `<div style="${base}color:${color};font-size:${fs}px;font-weight:${weight};line-height:1.2;display:flex;align-items:center;">${esc(content)}</div>`;
  }).join("\n  ");

  return [
    "<!DOCTYPE html>",
    "<html><head>",
    '<meta charset="UTF-8">',
    `<title>${esc(titleText)}</title>`,
    "<style>",
    "* { box-sizing: border-box; margin: 0; padding: 0; }",
    `body { width: ${widthPx}px; height: ${heightPx}px; background: ${safeBg}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; position: relative; overflow: hidden; }`,
    `.strip { background: ${safePrimary}; color: white; padding: 24px; }`,
    `.cta { color: ${safeAccent}; }`,
    "</style>",
    "</head><body>",
    `  ${blocksHtml}`,
    "</body></html>",
  ].join("\n");
}

// Puppeteer dep — held in a swappable holder so unit tests can replace
// `launch` with a fake. Puppeteer v25 exports are ESM-frozen + non-
// configurable, so direct require-cache monkey-patching is impossible.
// Tests call _setPuppeteerImplForTests({ launch }) before exercising
// renderFlyer; production code uses the lazy default below.
let _puppeteerImpl = null;
function _getPuppeteerImpl() {
  if (_puppeteerImpl) return _puppeteerImpl;
  // require() at call time (not module-load) so a Chrome-binary-missing
  // backend can still serve PDF exports without dying at boot. The error
  // surfaces only when a PNG render is actually attempted.
  return require("puppeteer");
}
function _setPuppeteerImplForTests(impl) {
  _puppeteerImpl = impl;
}

/**
 * Render the PNG path. Launches headless Chrome via Puppeteer, loads
 * the HTML shell at the requested viewport, and screenshots to PNG.
 * Throws if Chrome fails to launch — callers MUST get a real image
 * or a clean error, never a placeholder.
 */
async function renderPngBranch({ template, formatMeta }) {
  const puppeteer = _getPuppeteerImpl();
  const html = buildHtmlShellForPng(template, formatMeta.widthPx, formatMeta.heightPx);

  // Wrapped in try/finally so a failed page close or a Chrome crash
  // mid-render doesn't leak a child process.
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport({
      width: formatMeta.widthPx,
      height: formatMeta.heightPx,
      deviceScaleFactor: 1,
    });
    // `networkidle0` waits for image loads (DALL-E URLs, uploaded assets)
    // so the screenshot captures the rendered images instead of an empty
    // <img> box.
    await page.setContent(html, { waitUntil: "networkidle0" });
    // Explicit clip to the body dimensions — without this, Chrome's
    // default screenshot can omit absolute-positioned content that
    // extends near the bottom of the viewport, producing a vertically
    // cropped image. The clip rect locks capture to exactly
    // 0,0 → widthPx,heightPx.
    const buffer = await page.screenshot({
      type: "png",
      omitBackground: false,
      clip: { x: 0, y: 0, width: formatMeta.widthPx, height: formatMeta.heightPx },
    });
    return {
      buffer,
      mimeType: formatMeta.mimeType,
      extension: formatMeta.extension,
      widthPx: formatMeta.widthPx,
      heightPx: formatMeta.heightPx,
      engine: "puppeteer-headless",
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_e) { /* ignore close errors */ }
    }
  }
}

/**
 * Public entry point. See module header for the API contract.
 */
async function renderFlyer({ template, data, format } = {}) {
  if (typeof format !== "string" || !FORMAT_TABLE[format]) {
    const err = new Error(
      `format must be one of: ${SUPPORTED_FORMATS.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_FORMAT";
    throw err;
  }

  const formatMeta = FORMAT_TABLE[format];
  const safeTemplate = applyDataOverrides(template, data);

  if (formatMeta.kind === "pdf") {
    return renderPdfBranch({ template: safeTemplate, formatMeta });
  }
  // formatMeta.kind === 'png'
  return renderPngBranch({ template: safeTemplate, formatMeta });
}

module.exports = {
  renderFlyer,
  SUPPORTED_FORMATS,
  FORMAT_TABLE,
  // Exposed for unit-test introspection. NOT part of the stable public
  // surface — callers should treat these as internals.
  applyDataOverrides,
  buildHtmlShellForPng,
  _setPuppeteerImplForTests,
};
