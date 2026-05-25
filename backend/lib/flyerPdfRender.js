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

const DEFAULT_PALETTE = Object.freeze({
  primaryHex: "#122647",
  secondaryHex: "#C89A4E",
  accentHex: "#F5E6CC",
  textHex: "#1A1A1A",
  bgHex: "#FFFFFF",
});

// pdfkit page-size tokens. We accept the same `aspect` taxonomy as
// lib/flyerExport.js (PDF_PAPER_SIZES = ['a4', 'us_letter']).
const PAPER_SIZES = {
  a4: "A4",
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
  const assets =
    safeTemplate.assets && typeof safeTemplate.assets === "object"
      ? safeTemplate.assets
      : {};

  const primaryHex = safeHex(palette.primaryHex, DEFAULT_PALETTE.primaryHex);
  const secondaryHex = safeHex(
    palette.secondaryHex,
    DEFAULT_PALETTE.secondaryHex,
  );
  const accentHex = safeHex(palette.accentHex, DEFAULT_PALETTE.accentHex);
  const textHex = safeHex(palette.textHex, DEFAULT_PALETTE.textHex);
  const bgHex = safeHex(palette.bgHex, DEFAULT_PALETTE.bgHex);

  const doc = new PDFDocument({ size, margin: 36 });
  const bufferPromise = streamToBuffer(doc);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const inset = 36;
  const contentWidth = pageWidth - inset * 2;

  // Page background.
  doc.rect(0, 0, pageWidth, pageHeight).fill(bgHex);

  // Logo strip: primary-colour band at the top with the sub-brand logo URL
  // (placeholder — Puppeteer rasteriser slot fetches the actual image).
  const logoStripTop = inset;
  const logoStripHeight = 60;
  doc
    .rect(inset, logoStripTop, contentWidth, logoStripHeight)
    .fill(primaryHex);
  doc
    .fillColor("#FFFFFF")
    .fontSize(11)
    .text(
      assets.logo ? `LOGO: ${assets.logo}` : "Sub-brand logo",
      inset + 12,
      logoStripTop + 22,
      { width: contentWidth - 24, align: "left" },
    );

  // Title block: first 'text' block content, falling back to a generic
  // placeholder so empty layouts still render readable PDFs.
  const titleBlock = pickBlock(layout, "text");
  const titleTop = logoStripTop + logoStripHeight + 16;
  const titleHeight = 90;
  doc
    .fillColor(textHex)
    .fontSize(28)
    .text(
      titleBlock && typeof titleBlock.content === "string"
        ? titleBlock.content
        : "Untitled Flyer",
      inset,
      titleTop,
      { width: contentWidth, height: titleHeight, ellipsis: true },
    );

  // Hero placeholder: accent-colour fill + the asset URL (rendered as
  // text, not the actual image — see file header rationale).
  const heroTop = titleTop + titleHeight + 8;
  const heroHeight = 280;
  doc.rect(inset, heroTop, contentWidth, heroHeight).fill(accentHex);
  doc
    .fillColor(textHex)
    .fontSize(10)
    .text(
      assets.hero ? `HERO IMAGE: ${assets.hero}` : "Hero image placeholder",
      inset + 12,
      heroTop + heroHeight - 20,
      { width: contentWidth - 24, align: "left" },
    );

  // Price box: first 'price' block content + secondary-colour fill.
  const priceBlock = pickBlock(layout, "price");
  const priceTop = heroTop + heroHeight + 16;
  const priceHeight = 70;
  doc.rect(inset, priceTop, contentWidth, priceHeight).fill(secondaryHex);
  doc
    .fillColor("#FFFFFF")
    .fontSize(20)
    .text(
      priceBlock && typeof priceBlock.content === "string"
        ? priceBlock.content
        : "Price on request",
      inset + 12,
      priceTop + 22,
      { width: contentWidth - 24, align: "center" },
    );

  // CTA: first 'cta' block content + primary-colour fill.
  const ctaBlock = pickBlock(layout, "cta");
  const ctaTop = priceTop + priceHeight + 16;
  const ctaHeight = 60;
  doc.rect(inset, ctaTop, contentWidth, ctaHeight).fill(primaryHex);
  doc
    .fillColor("#FFFFFF")
    .fontSize(18)
    .text(
      ctaBlock && typeof ctaBlock.content === "string"
        ? ctaBlock.content
        : "Book Now",
      inset + 12,
      ctaTop + 18,
      { width: contentWidth - 24, align: "center" },
    );

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
    .fontSize(8)
    .text(
      `Generated ${generatedIso} · template ${hashPreview}`,
      inset,
      pageHeight - inset - 12,
      { width: contentWidth, align: "right" },
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
};
