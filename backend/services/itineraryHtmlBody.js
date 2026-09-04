"use strict";

// itineraryHtmlBody — renders an itinerary PDF template's BODY from real
// HTML/CSS instead of a fixed enum of layout knobs.
//
// Why this exists
// ---------------
// The template-faithful renderer copies the operator's uploaded PDF page
// verbatim (so logo / header / footer / rules stay pixel-identical) and
// redraws only the content box. That redraw was parameterised by an ~18-field
// `design` object in which typography was literally "sans" | "serif", mapping
// to Helvetica or Times. A brochure set in Poppins could therefore never come
// back as Poppins, and any body layout outside the enum vocabulary (a two
// column day spread, a timeline spine, alternating photo bands) collapsed to
// the nearest generic table. The ceiling was the vocabulary, not the model.
//
// Storing the body as HTML/CSS removes that ceiling: the template says what it
// actually is, real brand fonts and layout are expressible, and — the part no
// enum can offer — a human can fix it when the AI drafts it wrong.
//
// What it does NOT change
// -----------------------
// Everything around it. Page chrome is still the copied source page, the
// content box is still where the body lands, and overflow still spills onto
// extra copies of the same template page. This only produces the buffer that
// gets stamped. A template with no bodyHtml keeps using the existing PDFKit
// sections, so nothing regresses.
//
// The PDF page size is set to the content box exactly, which makes Chromium's
// own pagination the overflow engine: a long schedule simply produces body
// page 2, 3, ... and the caller stamps each onto another copy of the template
// page. That is why no row-height or page-break arithmetic appears here.

const { renderTemplate } = require("../lib/microTemplate");

// Mirrors flyerRenderEngine's resolution strategy: puppeteer is a real
// dependency, but it must stay optional at RUNTIME (CI boxes and slim
// containers routinely skip the Chromium download). A missing browser
// degrades to the PDFKit renderer instead of failing the whole PDF.
let _puppeteerResolution = null;
function tryRequirePuppeteer() {
  if (_puppeteerResolution) return _puppeteerResolution;
  try {
    _puppeteerResolution = { puppeteer: require("puppeteer"), ok: true };
  } catch (err) {
    _puppeteerResolution = { puppeteer: null, ok: false, reason: err.message };
  }
  return _puppeteerResolution;
}
function _resetPuppeteerCacheForTests() {
  _puppeteerResolution = null;
}

// Same reasoning as the flyer engine's PNG gate: every render is a full
// Chromium (~300-500 MB). Bulk PDF generation alongside resident WhatsApp
// sessions will OOM a small box without a cap.
const MAX_CONCURRENT = (() => {
  const v = parseInt(process.env.ITINERARY_HTML_MAX_CONCURRENT, 10);
  return Number.isFinite(v) && v >= 1 ? v : 2;
})();
const RENDER_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.ITINERARY_HTML_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 5000 ? v : 45000;
})();

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

const _gate = { running: 0, queue: [] };
async function _acquireSlot() {
  if (_gate.running < MAX_CONCURRENT) {
    _gate.running += 1;
    return;
  }
  await new Promise((resolve) => _gate.queue.push(resolve));
  // Resumed into a slot the releaser already accounted for.
}
function _releaseSlot() {
  _gate.running = Math.max(0, _gate.running - 1);
  const next = _gate.queue.shift();
  if (next) {
    _gate.running += 1;
    next();
  }
}

// Only these may be fetched by a template. Everything else — file://,
// http://localhost, any internal host — is aborted. This body HTML is
// AI-drafted and operator-editable, i.e. untrusted input handed to a browser
// running with --no-sandbox; without this a template could probe the internal
// network or read local files through an <img> or <link>.
const ALLOWED_REMOTE_PREFIXES = [
  "https://fonts.googleapis.com/",
  "https://fonts.gstatic.com/",
];
function isAllowedRequestUrl(url) {
  if (url.startsWith("data:") || url.startsWith("about:")) return true;
  return ALLOWED_REMOTE_PREFIXES.some((p) => url.startsWith(p));
}

// Defaults only. Deliberately minimal — it must not impose a look, only stop
// the browser's own margins and print quirks from fighting the template.
const BASE_CSS = [
  "*, *::before, *::after { box-sizing: border-box; }",
  "html, body { margin: 0; padding: 0; }",
  "body {",
  "  font-family: Helvetica, Arial, sans-serif;",
  "  font-size: 10pt;",
  "  line-height: 1.4;",
  "  color: #1a1a1a;",
  "  -webkit-print-color-adjust: exact;",
  "  print-color-adjust: exact;",
  "}",
  "img { max-width: 100%; }",
  "table { border-collapse: collapse; width: 100%; }",
  // Keep a day block from splitting across a page boundary when it would fit
  // whole on the next one — the most common brochure paging rule there is.
  ".avoid-break, tr, .day { break-inside: avoid; }",
].join("\n");

// CSS requires every @import to precede all other rules, but author CSS is
// concatenated AFTER the base stylesheet — so a template pulling a webfont
// the obvious way would have its @import silently dropped and render in the
// fallback face. Hoisting them keeps the natural authoring style working.
// Must not stop at the first ";" — a Google Fonts URL carries them inside the
// query string (family=Poppins:wght@400;500;600;700), and truncating there
// left the remainder loose in the stylesheet, which broke CSS parsing for
// every rule after it. Consume the url()/quoted target whole, then run to the
// terminating semicolon.
const IMPORT_RE = /@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/g;
function splitCssImports(css) {
  if (!css) return { imports: "", rest: "" };
  const found = String(css).match(IMPORT_RE) || [];
  return { imports: found.join(" "), rest: String(css).replace(IMPORT_RE, "") };
}

// Puppeteer parses page dimensions with a strict CSS-unit regex that rejects
// a long float tail ("500.03150400000004pt"), and content boxes are computed
// by scaling so they routinely have one. Two decimals is 1/50th of a point —
// far below anything visible — and keeps the stamped body aligned with the
// box pdf-lib draws it into.
function ptValue(n) {
  return Math.round(Number(n) * 100) / 100;
}

// page.pdf() accepts only px/in/cm/mm — "pt" is not in puppeteer's unit table,
// so a "500pt" string silently falls through to Number("500pt") = NaN and the
// call throws. Content boxes are in PDF points, so convert: 72pt = 1in.
function ptToInches(n) {
  return `${(Number(n) / 72).toFixed(4)}in`;
}

function buildHtmlDocument({ bodyHtml, bodyCss, box }) {
  const w = ptValue(box.width);
  const h = ptValue(box.height);
  const { imports, rest } = splitCssImports(bodyCss);
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    "<style>",
    imports,
    `@page { size: ${w}pt ${h}pt; margin: 0; }`,
    BASE_CSS,
    rest,
    "</style></head><body>",
    bodyHtml,
    "</body></html>",
  ].join("\n");
}

/**
 * Render a template body to a PDF whose every page is exactly the content box.
 *
 * @param {object} opts
 * @param {string} opts.bodyHtml  microTemplate source for this page role
 * @param {string} [opts.bodyCss] author CSS
 * @param {object} opts.context   data for interpolation
 * @param {{width:number,height:number}} opts.box content box, PDF points
 * @returns {Promise<Buffer|null>} null whenever the HTML path cannot be used,
 *   so the caller falls back to the existing PDFKit renderer.
 */
async function renderHtmlSection({ bodyHtml, bodyCss, context, box }) {
  if (!bodyHtml || typeof bodyHtml !== "string" || !bodyHtml.trim()) return null;
  if (!box || !Number.isFinite(Number(box.width)) || !Number.isFinite(Number(box.height))) return null;

  const resolution = tryRequirePuppeteer();
  if (!resolution.ok) {
    console.warn(
      "[itineraryHtmlBody] puppeteer unavailable, using the built-in renderer instead:",
      resolution.reason,
    );
    return null;
  }

  let interpolated;
  try {
    interpolated = renderTemplate(bodyHtml, context || {});
  } catch (err) {
    // A malformed template must never take down PDF generation — the operator
    // still gets their itinerary, just on the built-in layout.
    console.warn("[itineraryHtmlBody] template did not parse, falling back:", err.message);
    return null;
  }

  const html = buildHtmlDocument({ bodyHtml: interpolated, bodyCss, box });

  await _acquireSlot();
  let browser = null;
  let page = null;
  try {
    browser = await withTimeout(
      resolution.puppeteer.launch({
        headless: true,
        // Same low-RAM flag set the flyer engine settled on.
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
        timeout: 30000,
        protocolTimeout: 60000,
      }),
      20000,
      "puppeteer.launch",
    );
    page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      try {
        if (isAllowedRequestUrl(req.url())) req.continue();
        else req.abort();
      } catch (_e) {
        /* already handled */
      }
    });

    await withTimeout(
      page.setContent(html, { waitUntil: "networkidle0" }),
      RENDER_TIMEOUT_MS,
      "page.setContent",
    );
    // Webfonts can settle after networkidle0; without this the layout can be
    // measured against a fallback face and shift. Passed as a STRING rather
    // than a callback so the browser-context `document` is never parsed as
    // Node code (it lints as an undefined global otherwise), and resolved to
    // a boolean because a FontFaceSet itself will not serialise back.
    try {
      await withTimeout(
        page.evaluate("document.fonts ? document.fonts.ready.then(function () { return true; }) : true"),
        10000,
        "fonts.ready",
      );
    } catch (_e) {
      /* non-fatal */
    }

    const buffer = await withTimeout(
      page.pdf({
        width: ptToInches(box.width),
        height: ptToInches(box.height),
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        printBackground: true,
      }),
      RENDER_TIMEOUT_MS,
      "page.pdf",
    );
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  } catch (err) {
    console.warn("[itineraryHtmlBody] HTML body render failed, falling back:", err.message);
    return null;
  } finally {
    if (page) {
      try {
        await withTimeout(page.close(), 5000, "page.close");
      } catch (_e) {
        /* ignore */
      }
    }
    if (browser) {
      try {
        await withTimeout(browser.close(), 10000, "browser.close");
      } catch (_e) {
        /* ignore */
      }
    }
    _releaseSlot();
  }
}

module.exports = {
  renderHtmlSection,
  // Exposed for unit-test introspection only, same convention as
  // flyerRenderEngine — not a stable public surface.
  buildHtmlDocument,
  isAllowedRequestUrl,
  splitCssImports,
  ptValue,
  ptToInches,
  BASE_CSS,
  _resetPuppeteerCacheForTests,
  _tryRequirePuppeteer: tryRequirePuppeteer,
};
