// Travel CRM — pure validator for marketing flyer template shapes (#908).
//
// Slice 1 of the #908 Travel marketing flyer studio module (PRD:
// docs/PRD_TRAVEL_MARKETING_FLYER.md). Pure helpers — no Prisma, no fetch,
// no IO. Returns { ok, errors:[] } envelopes the future route layer (and
// the existing frontend page MarketingFlyerStudio.jsx) can destructure
// before committing operator-composed templates to storage.
//
// === Why this slice ===
//
// Flyer templates are operator-composed JSON blobs (palette + layout +
// asset placeholders) that future routes will persist on a flyer template
// record and downstream renderers (PDF / PNG export) will consume. Without
// a validator surface the route layer either (a) trusts every payload and
// crashes downstream when a renderer hits a malformed block, or (b)
// inlines ad-hoc validation that drifts from the renderer's expectations.
// Pure-helper-first lets slice 2's route + slice 3's renderer share a
// single shape contract.
//
// === Template shape ===
//
//   palette: { primaryHex, secondaryHex, accentHex?, textHex, bgHex }
//     — 6-digit hex (#RRGGBB). accentHex is optional.
//
//   layout:  Array<{ type, x, y, width, height, content?, src?, href? }>
//     — type ∈ { text, image, cta, divider, logo }
//     — x/y/width/height: non-negative finite numbers (page units, not
//       pixels — renderer maps to its target surface).
//     — text needs content; image / logo need src; cta needs content + href;
//       divider needs nothing extra.
//
//   assets:  { logo?, hero?, footer? } — optional, string URLs (or null).
//
// === Strictness decisions ===
//
//   - palette accentHex is OPTIONAL. Single-color brand kits (per Q22
//     pending Yasin handover) ship without an accent; renderers fall back
//     to the primary.
//   - Block dimensions are validated as non-negative finite NUMBERS, not
//     restricted to integers. Renderers handle fractional pixel scaling.
//   - No upper bound on x/y/width/height — renderer enforces page-size
//     clipping at draw time. The validator's job is shape sanity, not
//     layout fitness.
//   - Hex pattern is strict: exactly `#` + 6 hex digits. 3-digit shorthand
//     (`#ABC`) is rejected because the renderer pipeline expects full
//     6-digit hex without preprocessing.
//
// Pure JS — no Prisma, no fetch.

"use strict";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const VALID_BLOCK_TYPES = ["text", "image", "cta", "divider", "logo"];

/**
 * Validate a hex color string (`#RRGGBB`).
 *
 * @param {*} hex
 * @returns {boolean}
 */
function isValidHex(hex) {
  return typeof hex === "string" && HEX_COLOR_RE.test(hex);
}

/**
 * Validate a palette object.
 *
 * Required: primaryHex, secondaryHex, textHex, bgHex.
 * Optional: accentHex.
 *
 * @param {object} palette
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validatePalette(palette) {
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) {
    return { ok: false, errors: ["palette must be an object"] };
  }
  const errors = [];
  const required = ["primaryHex", "secondaryHex", "textHex", "bgHex"];
  for (const key of required) {
    if (palette[key] === undefined || palette[key] === null || palette[key] === "") {
      errors.push(`palette.${key} is required`);
    } else if (!isValidHex(palette[key])) {
      errors.push(`palette.${key} must be 6-digit hex (#RRGGBB)`);
    }
  }
  // accentHex is optional but must be valid if present
  if (palette.accentHex !== undefined && palette.accentHex !== null && palette.accentHex !== "") {
    if (!isValidHex(palette.accentHex)) {
      errors.push("palette.accentHex must be 6-digit hex (#RRGGBB)");
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a single layout block.
 *
 * @param {object} block
 * @param {number} idx — index into the layout array (for error messages)
 * @returns {string[]} — accumulated errors (empty array if valid)
 */
function validateBlock(block, idx) {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return [`layout[${idx}] must be an object`];
  }
  const errors = [];
  if (!VALID_BLOCK_TYPES.includes(block.type)) {
    errors.push(
      `layout[${idx}].type must be one of: ${VALID_BLOCK_TYPES.join(", ")}`
    );
  }
  for (const dim of ["x", "y", "width", "height"]) {
    const value = block[dim];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push(`layout[${idx}].${dim} must be a non-negative number`);
    }
  }
  // text blocks need non-empty content
  if (block.type === "text") {
    if (typeof block.content !== "string" || block.content.length === 0) {
      errors.push(`layout[${idx}] (text) needs non-empty content`);
    }
  }
  // image / logo blocks need non-empty src
  if (block.type === "image" || block.type === "logo") {
    if (typeof block.src !== "string" || block.src.length === 0) {
      errors.push(`layout[${idx}] (${block.type}) needs non-empty src`);
    }
  }
  // cta blocks need content + href
  if (block.type === "cta") {
    if (typeof block.content !== "string" || block.content.length === 0) {
      errors.push(`layout[${idx}] (cta) needs non-empty content`);
    }
    if (typeof block.href !== "string" || block.href.length === 0) {
      errors.push(`layout[${idx}] (cta) needs non-empty href`);
    }
  }
  return errors;
}

/**
 * Validate the full layout array.
 *
 * @param {Array} layout
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateLayout(layout) {
  if (!Array.isArray(layout)) {
    return { ok: false, errors: ["layout must be an array"] };
  }
  const errors = [];
  layout.forEach((block, idx) => {
    errors.push(...validateBlock(block, idx));
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Validate the full flyer template.
 *
 * Aggregates palette + layout errors; assets is optional but must be an
 * object if provided.
 *
 * @param {object} template
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateTemplate(template) {
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    return { ok: false, errors: ["template must be an object"] };
  }
  const errors = [];
  const paletteResult = validatePalette(template.palette);
  errors.push(...paletteResult.errors);
  const layoutResult = validateLayout(template.layout);
  errors.push(...layoutResult.errors);
  if (
    template.assets !== undefined &&
    template.assets !== null &&
    (typeof template.assets !== "object" || Array.isArray(template.assets))
  ) {
    errors.push("assets must be an object if provided");
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  HEX_COLOR_RE,
  VALID_BLOCK_TYPES,
  isValidHex,
  validatePalette,
  validateBlock,
  validateLayout,
  validateTemplate,
};
