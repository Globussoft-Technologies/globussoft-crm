/**
 * Travel CRM — Marketing Flyer PDF renderer (#908 slice 11).
 *
 * Materialises a TravelFlyerTemplate's `{ palette, layout, assets }`
 * shape into a single-page A4 / US-letter PDF Buffer using pdfkit
 * (already a backend dep — same engine as services/pdfRenderer.js for
 * wellness Rx + invoice PDFs).
 *
 * PRD anchors:
 *   - FR-3.4.1 PDF export (A4 / US-letter)        → opts.aspect
 *   - AC-6.4   PDF export acceptance              → this renderer
 *
 * Scope of THIS slice:
 *   - Single-page, fixed-zone layout (title, price box, destination
 *     photo placeholder, CTA, sub-brand logo). The layoutJson's block
 *     positions are NOT honoured verbatim — that's a future renderer
 *     refinement once we can pull from a Canva-like coordinate space
 *     reliably. Instead we pick the FIRST block of each meaningful
 *     `type` and render it into a predictable on-page zone. This keeps
 *     the renderer deterministic + the unit tests stable while still
 *     respecting palette + content choices the operator made.
 *   - paletteJson.{primaryHex,secondaryHex,accentHex,textHex,bgHex}
 *     drive the colour scheme. Missing palette folds to safe defaults
 *     (so a malformed/empty template still renders a placeholder PDF
 *     rather than throwing — the route layer separately gates malformed
 *     templates via the validator).
 *   - assetsJson.{logo,hero} are referenced for placement intent only;
 *     pdfkit-side network image fetching is OUT of scope (would add
 *     fetch + caching + retry logic to a "pure" renderer). The hero
 *     zone draws a coloured placeholder rectangle with the hero URL
 *     text; downstream Puppeteer-based PNG renderer (deferred slice)
 *     will materialise real images.
 *
 * Pure-ish: takes a template-shape object + opts, returns a Promise<Buffer>.
 * No Prisma, no fs, no network. Only `pdfkit` + Node's built-in stream
 * collection. Renderer can be unit-tested by inspecting the returned
 * Buffer's PDF magic bytes + length + (optionally) parsed page count.
 *
 * Output contract:
 *   - Returns a Buffer whose first 4 bytes are `%PDF` (0x25 0x50 0x44 0x46).
 *   - Buffer length is >0 (a non-empty PDF always exceeds the magic-
 *     bytes header).
 *   - Single page, oriented by opts.aspect (a4 portrait, us_letter portrait).
 *
 * Layout zones (top-down, in points, A4 = 595×842, US-letter = 612×792):
 *   - Margin: 36pt all sides
 *   - Logo strip:    top 60pt   — palette.primaryHex band + sub-brand logo URL text
 *   - Title block:   next 90pt  — layout block with type='text' first match
 *   - Hero placeholder: next 280pt — palette.accentHex fill + assets.hero URL
 *   - Price box:     next 70pt  — layout block with type='price' first match (palette.secondaryHex bg)
 *   - CTA button:    next 60pt  — layout block with type='cta' first match (palette.primaryHex)
 *   - Footer:        bottom 36pt — "Generated <ISO date> · template <hash7>"
 */

"use strict";

const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const DEFAULT_PALETTE = Object.freeze({
  primaryHex: "#122647",
  secondaryHex: "#C89A4E",
  accentHex: "#F5E6CC",
  textHex: "#1A1A1A",
  bgHex: "#FFFFFF",
});

// Source-canvas dimensions (matches MarketingFlyerStudio's
// CANVAS_W / CANVAS_H). The editor positions every block absolutely
// inside this 540×720 space; the PDF renderer scales each block to the
// page dimensions using independent X/Y factors so the operator's
// composition lands at the same proportional positions in the PDF.
const CANVAS_W = 540;
const CANVAS_H = 720;

// Image fetcher — held in a swappable holder so unit tests can replace
// the network/disk reads with a fake. Default impl uses axios for
// remote URLs and fs.promises for local paths under /uploads/.
let _imageFetcher = null;
async function _defaultImageFetcher(src) {
  if (typeof src !== "string" || !src) return null;
  // data:image/png;base64,... — decode inline.
  if (src.startsWith("data:")) {
    const m = src.match(/^data:[^;]+;base64,(.+)$/);
    return m ? Buffer.from(m[1], "base64") : null;
  }
  // Local upload path served by Express static — read from disk.
  if (src.startsWith("/uploads/")) {
    const uploadsRoot = path.resolve(__dirname, "..", "uploads");
    const rel = src.slice("/uploads/".length);
    const abs = path.resolve(uploadsRoot, rel);
    // Path-traversal guard — refuse anything outside uploadsRoot.
    if (!abs.startsWith(uploadsRoot)) return null;
    try {
      return await fs.promises.readFile(abs);
    } catch (_e) {
      return null;
    }
  }
  // Remote URL — axios fetch. Time-limited so a stuck OpenAI / S3
  // fetch doesn't hang the entire PDF render.
  if (/^https?:\/\//.test(src)) {
    try {
      const axios = require("axios");
      const r = await axios.get(src, {
        responseType: "arraybuffer",
        timeout: 8000,
        maxContentLength: 25 * 1024 * 1024,
      });
      return Buffer.from(r.data);
    } catch (_e) {
      return null;
    }
  }
  return null;
}
function _getImageFetcher() {
  return _imageFetcher || _defaultImageFetcher;
}
function _setImageFetcherForTests(fn) {
  _imageFetcher = fn;
}

// pdfkit page-size tokens. We accept the same `aspect` taxonomy as
// lib/flyerExport.js (PDF_PAPER_SIZES = ['a4', 'us_letter']) plus 'a5'
// (S75 — A5 was previously coerced to A4 by services/flyerRenderEngine.js
// because this table didn't include it). pdfkit accepts the string 'A5'
// as a built-in page-size token (148 × 210 mm = 419.53 × 595.28 pt portrait).
const PAPER_SIZES = {
  a4: "A4",
  a5: "A5",
  us_letter: "LETTER",
};

/**
 * Pick the first layout block matching a given `type`. Layout is the
 * parsed array stored in the row's `layoutJson` column. Falls back to
 * `null` when no match (caller renders a placeholder for that zone).
 */
function pickBlock(layout, type) {
  if (!Array.isArray(layout)) return null;
  for (const block of layout) {
    if (block && typeof block === "object" && block.type === type) {
      return block;
    }
  }
  return null;
}

/**
 * Stream → Buffer helper. Mirrors services/pdfRenderer.js#streamToBuffer.
 */
function streamToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

/**
 * Coerce a hex string to a pdfkit-safe colour. Returns the default if
 * input is missing / malformed (so a corrupted palette still renders a
 * readable PDF).
 */
function safeHex(input, fallback) {
  if (typeof input !== "string") return fallback;
  if (!/^#[0-9A-Fa-f]{3,8}$/.test(input)) return fallback;
  return input;
}

/**
 * Render a flyer template into a PDF Buffer.
 *
 * @param {object} template — { palette, layout, assets } (from row's
 *                            parsed JSON columns, NOT the Prisma row
 *                            itself — caller does the JSON.parse step).
 * @param {object} opts     — { aspect: 'a4'|'us_letter', hash?: string }
 * @returns {Promise<Buffer>}
 */
async function renderFlyerPdf(template, opts = {}) {
  const aspect = opts && typeof opts.aspect === "string" ? opts.aspect : "a4";
  const size = PAPER_SIZES[aspect] || PAPER_SIZES.a4;

  const safeTemplate =
    template && typeof template === "object" && !Array.isArray(template)
      ? template
      : {};
  const palette =
    safeTemplate.palette && typeof safeTemplate.palette === "object"
      ? safeTemplate.palette
      : {};
  const layout = Array.isArray(safeTemplate.layout) ? safeTemplate.layout : [];

  const primaryHex = safeHex(palette.primaryHex, DEFAULT_PALETTE.primaryHex);
  const secondaryHex = safeHex(
    palette.secondaryHex,
    DEFAULT_PALETTE.secondaryHex,
  );
  const accentHex = safeHex(palette.accentHex, DEFAULT_PALETTE.accentHex);
  const textHex = safeHex(palette.textHex, DEFAULT_PALETTE.textHex);
  const bgHex = safeHex(palette.bgHex, DEFAULT_PALETTE.bgHex);

  const doc = new PDFDocument({ size, margin: 0 });
  const bufferPromise = streamToBuffer(doc);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;

  // Page background.
  doc.rect(0, 0, pageWidth, pageHeight).fill(bgHex);

  // Independent X/Y scale: stretch each block from the editor's
  // 540×720 canvas to the PDF page dimensions. Mirrors the PNG
  // renderer's scaling so PDF + PNG show the same composition.
  const scaleX = pageWidth / CANVAS_W;
  const scaleY = pageHeight / CANVAS_H;

  // Pre-fetch every image block's bytes in parallel so the synchronous
  // pdfkit render loop can drop them into doc.image() without awaiting
  // mid-stream. A failed fetch leaves the block's buffer as null; the
  // render loop draws a coloured placeholder rectangle in that slot
  // instead of crashing the PDF.
  const fetcher = _getImageFetcher();
  const imageBuffers = await Promise.all(
    layout.map(async (b) => {
      if (!b || b.type !== "image" || typeof b.src !== "string" || !b.src) {
        return null;
      }
      return fetcher(b.src);
    }),
  );

  for (let i = 0; i < layout.length; i += 1) {
    const b = layout[i];
    if (!b || typeof b !== "object") continue;
    const x = Math.round((Number(b.x) || 0) * scaleX);
    const y = Math.round((Number(b.y) || 0) * scaleY);
    const w = Math.round((Number(b.width) || 0) * scaleX);
    const h = Math.round((Number(b.height) || 0) * scaleY);
    if (w <= 0 || h <= 0) continue;

    if (b.type === "image") {
      const buf = imageBuffers[i];
      if (buf) {
        try {
          // `cover` would crop; PDF preview should show the WHOLE
          // operator-uploaded image inside the block (no surprise
          // cropping when comparing PNG vs PDF). pdfkit's `fit` scales
          // the image proportionally within the (w, h) box and pads
          // with the page background.
          doc.image(buf, x, y, { fit: [w, h], align: "center", valign: "center" });
        } catch (_e) {
          // pdfkit throws on unsupported image formats (e.g. WebP) —
          // fall through to the placeholder rectangle below.
          doc.rect(x, y, w, h).fill(accentHex);
        }
      } else {
        doc.rect(x, y, w, h).fill(accentHex);
      }
      continue;
    }

    // text / price / cta blocks. Font-size scaled by the X factor so
    // type stays readable at the page dimensions.
    const content = typeof b.content === "string" ? b.content : "";
    if (!content) continue;
    const color = b.type === "price" ? secondaryHex
      : b.type === "cta" ? primaryHex
        : (typeof b.color === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(b.color))
          ? b.color
          : textHex;
    const fontSize = Math.max(6, Math.round(((Number(b.fontSize) || 18)) * scaleX));
    doc.fillColor(color).fontSize(fontSize);
    doc.text(content, x, y, {
      width: w,
      height: h,
      ellipsis: true,
      lineBreak: true,
    });
  }

  // Footer: provenance line so the recipient can verify the rendered
  // PDF against a known template hash (FR-3.4.5 cache audit). We render
  // a short prefix of the hash (first 7 hex chars) — full 64-char SHA-256
  // is impolite in a footer.
  const hashPreview =
    typeof opts.hash === "string" && /^[0-9a-f]{8,}$/.test(opts.hash)
      ? opts.hash.slice(0, 7)
      : "no-hash";
  const generatedIso = new Date().toISOString();
  doc
    .fillColor(textHex)
    .fontSize(7)
    .text(
      `Generated ${generatedIso} · template ${hashPreview}`,
      8,
      pageHeight - 12,
      { width: pageWidth - 16, align: "right" },
    );

  doc.end();
  return bufferPromise;
}

module.exports = {
  renderFlyerPdf,
  pickBlock,
  safeHex,
  DEFAULT_PALETTE,
  PAPER_SIZES,
  _setImageFetcherForTests,
};
