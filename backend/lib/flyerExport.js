// Travel CRM — pure helpers for marketing flyer export (#908 slice 8).
//
// Lays the substrate the future PDF (pdfkit-extended) + PNG (Puppeteer-
// based imageRenderer.js, deferred) slices both need: format/aspect
// taxonomy, request-envelope validation, stable template-shape hashing,
// and cache-key composition. PRD anchors:
//
//   - FR-3.4.1 PDF export (A4 / US-letter)              → FORMATS, ASPECTS
//   - FR-3.4.2 PNG export (square / portrait /
//              landscape / email-banner)                → ASPECTS
//   - FR-3.4.5 Output URLs cached by template-hash      → hashTemplateShape
//   - AC-6.3 / AC-6.4 (PNG / PDF export acceptance)     → validateExportRequest
//
// Pure JS — no Prisma, no fetch, no fs, no Puppeteer/pdfkit. The future
// renderer modules consume these helpers; this file commits to the
// stable surface so the renderer can be slotted in without re-deriving
// cache semantics or format taxonomy.
//
// === Format / aspect taxonomy ===
//
//   PDF formats: 'a4' (210×297mm), 'us_letter' (8.5×11").
//   PNG aspects: 'square' (1080×1080), 'portrait' (1080×1920),
//                'landscape' (1920×1080), 'email_banner' (1200×628).
//
// PDF docs are dimensioned by paper SIZE not aspect ratio (you don't ask
// for a "square PDF"), and PNG outputs are dimensioned by aspect not
// paper size — so the two output classes use different secondary keys
// ('aspect' vs 'paper'). To keep the validateExportRequest envelope
// uniform, both keys are accepted under a single `aspect` field —
// validateExportRequest looks up the allowed values from the
// format-specific list.
//
// === Hash design ===
//
// hashTemplateShape({ palette, layout, assets }) returns a deterministic
// hex SHA-256 of the JSON-stringified shape with stable key ordering.
// "Stable key ordering" is critical — two semantically-identical shapes
// must hash to the same value regardless of property iteration order
// across nodes / engines / SDK versions. Implementation uses a recursive
// canonicalizer that sorts object keys alphabetically before stringify;
// arrays preserve order (layout block order is semantically meaningful
// — rearranging blocks changes the render output).
//
// Hash is consumed by the future MarketingFlyer.outputUrls cache: when
// the operator hits "Export PDF A4", the renderer computes the current
// hash, checks the cache for an entry keyed by
// buildOutputCacheKey({ format, aspect, hash }) — cache hit returns
// the existing URL, cache miss triggers re-render + writes to cache.
//
// === Why these are pure ===
//
// Hashing + validation are deterministic functions of input. Pulling
// them into a pure helper lets the future renderer slice (Puppeteer /
// pdfkit) plug in without re-deriving cache semantics; lets the route
// layer validate export requests before kicking the renderer; and lets
// frontend tests assert against the same canonical hash without
// importing the renderer.

"use strict";

const crypto = require("crypto");

// PDF document sizes. Keyed under 'aspect' in the request envelope
// uniformity sense — see file header rationale.
const PDF_PAPER_SIZES = ["a4", "us_letter"];

// PNG output aspect ratios. portrait + email_banner are the WhatsApp-
// share / email-banner targets called out in PRD §3.4; square +
// landscape cover Instagram / Facebook surfaces.
const PNG_ASPECTS = ["square", "portrait", "landscape", "email_banner"];

const FORMATS = ["pdf", "png"];

// Look-up table the validator and cache-key builder share.
const FORMAT_ASPECT_TABLE = {
  pdf: PDF_PAPER_SIZES,
  png: PNG_ASPECTS,
};

/**
 * Recursively canonicalize a JS value so two semantically-identical
 * shapes serialise to the same string. Object keys are sorted; arrays
 * preserve order (layout block order is semantically meaningful).
 *
 * @param {*} value
 * @returns {*} — canonicalized form (safe to JSON.stringify)
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  // Plain object — sort keys alphabetically.
  const sortedKeys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  const out = {};
  for (const key of sortedKeys) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

/**
 * Compute a deterministic SHA-256 hex hash of a flyer template shape.
 *
 * Accepts `{ palette, layout, assets }`. Each is optional; missing
 * fields fold to `null` in the canonical form so two shapes that differ
 * only in "field present vs absent" still hash distinctly from "field
 * explicitly null" (canonicalize preserves null/undefined boundary via
 * JSON's natural treatment).
 *
 * @param {object} shape — { palette?, layout?, assets? }
 * @returns {string} — 64-char lowercase hex SHA-256
 */
function hashTemplateShape(shape) {
  // Invalid input folds into the same empty envelope as `{}` so callers
  // can still cache-key the "default placeholder" state without a
  // try/catch dance. Renderer rejects empty shapes separately via the
  // flyerTemplateValidator path.
  const safe =
    shape && typeof shape === "object" && !Array.isArray(shape) ? shape : {};
  const envelope = {
    palette: safe.palette ?? null,
    layout: safe.layout ?? null,
    assets: safe.assets ?? null,
  };
  const canonical = canonicalize(envelope);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

/**
 * Validate an export request envelope. Returns the route-shape
 * { ok, errors[] } pair so the future route layer can surface a
 * 400 INVALID_EXPORT_REQUEST with the errors array attached.
 *
 * @param {object} request — { format, aspect }
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateExportRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors = [];
  const { format, aspect } = request;
  if (!FORMATS.includes(format)) {
    errors.push(`format must be one of: ${FORMATS.join(", ")}`);
  }
  if (typeof aspect !== "string" || aspect.length === 0) {
    errors.push("aspect is required");
  } else if (FORMATS.includes(format)) {
    const allowed = FORMAT_ASPECT_TABLE[format];
    if (!allowed.includes(aspect)) {
      errors.push(
        `aspect must be one of: ${allowed.join(", ")} (for format=${format})`
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Build the stable cache key the future MarketingFlyer.outputUrls
 * JSON-blob is indexed by. Shape:
 *
 *   `<format>:<aspect>:<hash>`
 *
 * Caller passes the hash from hashTemplateShape; this fn just joins.
 * Pinning the verbatim string format here (rather than letting each
 * caller construct it) means a future change to the key shape is
 * a single-point edit + a test update.
 *
 * @param {object} args — { format, aspect, hash }
 * @returns {string}
 */
function buildOutputCacheKey({ format, aspect, hash }) {
  if (!format || !aspect || !hash) {
    throw new Error("buildOutputCacheKey requires { format, aspect, hash }");
  }
  return `${format}:${aspect}:${hash}`;
}

module.exports = {
  FORMATS,
  PDF_PAPER_SIZES,
  PNG_ASPECTS,
  FORMAT_ASPECT_TABLE,
  canonicalize,
  hashTemplateShape,
  validateExportRequest,
  buildOutputCacheKey,
};
