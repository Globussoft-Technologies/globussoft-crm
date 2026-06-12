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
 * The PNG path is gated on Puppeteer. As of #908 slice S17 dispatch
 * (2026-06-10), `puppeteer` is NOT in `backend/package.json` (only `pdfkit`
 * is — see grep `"(puppeteer|pdfkit)"` in package.json). Per the slice
 * prompt's "Stub fallback" clause + PRD FR-3.4.2's Puppeteer dep
 * (cred-blocked / infra-blocked):
 *
 *   - If `require('puppeteer')` resolves AND `FLYER_RENDER_FORCE_STUB`
 *     is not set, we launch headless Chrome, render an HTML template at
 *     the requested aspect, screenshot to PNG, and return a real PNG
 *     Buffer. The response header reads
 *     `X-Flyer-Render-Engine: puppeteer-headless`.
 *   - If `require('puppeteer')` throws (MODULE_NOT_FOUND) — e.g. a CI
 *     box where the Chromium download was skipped and the package never
 *     resolved — OR `FLYER_RENDER_FORCE_STUB=1` is set (test stability /
 *     CI without headless-Chrome libs), we return a deterministic
 *     minimal PNG Buffer (an 8-byte PNG signature + a single
 *     IHDR/IDAT/IEND chunk set encoding a 1×1 transparent placeholder
 *     pixel — small but VALID PNG). The header reads
 *     `X-Flyer-Render-Engine: stub-1x1`.
 *
 * S74 (this slice) landed `puppeteer@^25.1.0` in `backend/package.json`,
 * so the default branch on a non-CI dev box is the real Puppeteer render.
 * S17 (the engine surface) shipped with the stub branch ONLY; S74 added
 * the install + real-render wiring with zero caller-side changes (route
 * response shape — Content-Type + Content-Disposition + bytes — is
 * identical between modes).
 *
 * This degraded behaviour mirrors slice 10/11's STUB pattern in the
 * existing `routes/travel_flyer_templates.js` (`/:id/export` returns a 202
 * queued envelope for PNGs because Puppeteer infra is pending). The
 * difference: S17's `/:id/render` is the SYNCHRONOUS surface, so we MUST
 * return a buffer — falling back to a 1×1 PNG keeps the contract
 * "buffer + correct mime" stable for callers, and a `?inline=1` browser
 * preview that shows a 1×1 placeholder is a useful operator signal that
 * "PNG renderer is not yet wired".
 *
 * === Module API ===
 *
 *   renderFlyer({ template, data, format }) → Promise<{
 *     buffer: Buffer,
 *     mimeType: 'application/pdf' | 'image/png',
 *     extension: 'pdf' | 'png',
 *     widthPx: number | null,   // PNG only (PDF dimensions in pt, exposed via aspect)
 *     heightPx: number | null,  // PNG only
 *     engine: 'pdfkit' | 'puppeteer-headless' | 'stub-1x1',  // for X-Flyer-Render-Engine
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
 *   - PNG branch: when Puppeteer is absent, the stub PNG branch is
 *     deterministic — tests assert the PNG magic bytes (`\x89PNG\r\n\x1a\n`)
 *     and the engine label `'stub-1x1'`. Once Puppeteer lands, integration
 *     tests will swap to asserting against real Chrome screenshots.
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
 * Lazily resolve puppeteer. We do this inside the render path (not at
 * module-load time) so `require('./services/flyerRenderEngine')` never
 * throws even on a backend that hasn't installed Puppeteer yet — the
 * graceful PNG stub is the contract.
 *
 * Memoised after the first attempt — repeated requires are cheap but
 * the MODULE_NOT_FOUND throw on every call is noisy in tests.
 */
let _puppeteerResolution = null;
function tryRequirePuppeteer() {
  if (_puppeteerResolution !== null) return _puppeteerResolution;
  try {
    const puppeteer = require("puppeteer");
    _puppeteerResolution = { ok: true, puppeteer };
  } catch (_e) {
    _puppeteerResolution = { ok: false, puppeteer: null };
  }
  return _puppeteerResolution;
}

/**
 * Test-only hook to clear the puppeteer-resolution cache. Lets unit
 * tests flip "puppeteer not installed → puppeteer mocked installed"
 * without restarting the test runner. NOT exported as part of the
 * public surface — tests reach in via the module.exports indirection.
 */
function _resetPuppeteerCacheForTests() {
  _puppeteerResolution = null;
}

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
 * Hand-built minimal valid PNG. 1×1 fully-transparent pixel.
 *
 * Layout (binary):
 *   - 8 bytes : PNG signature `\x89PNG\r\n\x1a\n`
 *   - IHDR chunk (25 bytes): 1×1, bit depth 8, RGBA colour type
 *   - IDAT chunk (varies): the deflate-compressed scanline (zero-length)
 *   - IEND chunk (12 bytes): chunk terminator
 *
 * We pin the byte sequence at build time rather than computing it per
 * call — the placeholder is deterministic and the test surface is the
 * "PNG magic bytes present" assertion, NOT the IDAT contents. Sourced
 * from the well-known minimal PNG (see https://github.com/mathiasbynens/small).
 *
 * 67 bytes total — enough to render in every PNG viewer, small enough
 * not to bloat caller responses.
 */
const STUB_PNG_BUFFER = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);

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
 * Build the minimal HTML document Puppeteer screenshots. Keeps the
 * inline-template construction in one place + ensures the Puppeteer
 * branch + the future Puppeteer-real-render branch share a single
 * source of truth for the document shell.
 *
 * The PRD's FR-3.4.2 says PNG path renders via "Puppeteer HTML-to-image
 * pipeline (new)". This is the new pipeline's HTML half — when Puppeteer
 * lands, this function's output is what Chrome loads.
 *
 * Pure — no Puppeteer dep + no fs. Unit-testable end-to-end via string
 * snapshot.
 */
function buildHtmlShellForPng(template, widthPx, heightPx) {
  const palette = (template && template.palette) || {};
  const layout = (template && Array.isArray(template.layout)) ? template.layout : [];
  const assets = (template && template.assets) || {};

  const safePrimary = typeof palette.primaryHex === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(palette.primaryHex)
    ? palette.primaryHex
    : "#122647";
  const safeBg = typeof palette.bgHex === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(palette.bgHex)
    ? palette.bgHex
    : "#FFFFFF";

  const titleBlock = layout.find((b) => b && b.type === "text");
  const priceBlock = layout.find((b) => b && b.type === "price");
  const ctaBlock = layout.find((b) => b && b.type === "cta");

  const titleText = (titleBlock && typeof titleBlock.content === "string") ? titleBlock.content : "Untitled Flyer";
  const priceText = (priceBlock && typeof priceBlock.content === "string") ? priceBlock.content : "Price on request";
  const ctaText = (ctaBlock && typeof ctaBlock.content === "string") ? ctaBlock.content : "Book Now";
  const heroUrl = typeof assets.hero === "string" ? assets.hero : "";

  // Minimal, safe-escaped (no rich HTML in content — just text nodes).
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  ));

  return [
    "<!DOCTYPE html>",
    "<html><head>",
    '<meta charset="UTF-8">',
    `<title>${esc(titleText)}</title>`,
    "<style>",
    "* { box-sizing: border-box; margin: 0; padding: 0; }",
    `body { width: ${widthPx}px; height: ${heightPx}px; background: ${safeBg}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }`,
    `.strip { background: ${safePrimary}; color: white; padding: 24px; }`,
    ".hero { width: 100%; height: 45%; background-size: cover; background-position: center; }",
    ".title { padding: 32px 24px 0; font-size: 36px; font-weight: 700; }",
    ".price { padding: 16px 24px; font-size: 28px; }",
    `.cta { display: inline-block; margin: 16px 24px; padding: 12px 24px; background: ${safePrimary}; color: white; border-radius: 6px; font-size: 18px; }`,
    "</style>",
    "</head><body>",
    `<div class="strip">Flyer</div>`,
    `<div class="hero" style="background-image:url('${esc(heroUrl)}');"></div>`,
    `<div class="title">${esc(titleText)}</div>`,
    `<div class="price">${esc(priceText)}</div>`,
    `<div class="cta">${esc(ctaText)}</div>`,
    "</body></html>",
  ].join("\n");
}

/**
 * Returns the stub PNG response shape. Pulled out so both the
 * MODULE_NOT_FOUND fallback AND the FLYER_RENDER_FORCE_STUB=1 override
 * share a single source of truth.
 */
function buildStubPngResponse(formatMeta) {
  return {
    buffer: STUB_PNG_BUFFER,
    mimeType: formatMeta.mimeType,
    extension: formatMeta.extension,
    widthPx: formatMeta.widthPx,
    heightPx: formatMeta.heightPx,
    engine: "stub-1x1",
  };
}

/**
 * Render the PNG path. When Puppeteer is installed AND the
 * `FLYER_RENDER_FORCE_STUB` env var is not truthy, launches headless
 * Chrome + screenshots a viewport-sized page (real render). Otherwise
 * returns the 1×1 stub PNG.
 *
 * The env-var override exists for CI: the `unit_tests` gate's Linux
 * runners don't ship the libnss3 / libatk1.0-0 / libcups2 libs Puppeteer
 * needs to launch headless-Chrome, so setting `FLYER_RENDER_FORCE_STUB=1`
 * in deploy.yml's unit_tests env block forces the stub fast-path and
 * keeps the per-push gate green. Production + dev boxes can install the
 * libs (or use puppeteer's bundled chromium download) and run the real
 * render branch.
 */
async function renderPngBranch({ template, formatMeta }) {
  // Honour the force-stub override BEFORE attempting to require puppeteer
  // — this avoids spinning up a Chrome process on test runs that explicitly
  // opt-out of the real render (deploy.yml's unit_tests + most vitest cases).
  if (process.env.FLYER_RENDER_FORCE_STUB === "1") {
    return buildStubPngResponse(formatMeta);
  }

  // Go through module.exports indirection so vitest can override the
  // resolution path without monkey-patching puppeteer's read-only ESM
  // exports. CJS self-mocking seam pattern — same shape as the cap-consumer
  // service clients (adsGptClient / ratehawkClient / callifiedClient).
  const resolution = module.exports._tryRequirePuppeteer();
  if (!resolution.ok) {
    return buildStubPngResponse(formatMeta);
  }

  const { puppeteer } = resolution;
  const html = buildHtmlShellForPng(template, formatMeta.widthPx, formatMeta.heightPx);

  // Real Puppeteer branch. Wrapped in try/finally so a failed page
  // close or a Chrome crash mid-render doesn't leak a child process.
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
    await page.setContent(html, { waitUntil: "networkidle0" });
    const buffer = await page.screenshot({ type: "png", omitBackground: false });
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
  STUB_PNG_BUFFER,
  _resetPuppeteerCacheForTests,
  _tryRequirePuppeteer: tryRequirePuppeteer,
};
