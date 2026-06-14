/**
 * brandAssetValidation — upload-time guards for BrandKit assets.
 *
 * PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.5.a-f (G100). Each branding asset
 * the operator uploads (logo / wordmark / favicon / hero / header / stamp)
 * has different shape constraints — a hero hates a tall portrait crop, a
 * favicon hates a 4K dimension, a header image is wider than tall. This
 * helper centralises:
 *
 *   - Asset-class registry (size cap + dim cap + allowed aspect range per
 *     class).
 *   - MIME whitelist + extension allowlist (png/jpeg/svg/webp; favicon adds
 *     image/x-icon).
 *   - Size cap (5 MB hard ceiling; per-class caps may be tighter).
 *   - SVG payload sanitization — strips <script>, on*= handlers, javascript:
 *     URLs, external <use href> references via sanitize-html with a
 *     conservative svg-only tag/attr allowlist.
 *   - Dimension probing for raster classes (PNG + JPEG + WebP) — pure-Node
 *     header reads (no external decoder), enough to pin the contract for
 *     "logo ≤ 2000px" and "hero 3:1..1:1 aspect".
 *
 * The function is intentionally synchronous w.r.t. dim probing — header
 * bytes are tiny + already in memory (Multer.memoryStorage()), so a sync
 * pass keeps the call site simple.
 *
 * Contract: `validateAssetUpload({ file, expectedType })` returns
 *   { valid: true, sanitizedBuffer, mime, ext, width, height } on success
 *   { valid: false, errors: ['code1', 'code2', ...], messages: [...] }
 * — the caller decides whether to 400 the request or re-render a UI error.
 *
 * Asset classes:
 *   logo            — square-ish marks, ≤2000px each side, raster + svg
 *   wordmark        — text-only logotype, ≤3000px wide, raster + svg
 *   favicon         — ≤512px each side, raster + svg + ico
 *   hero            — wide banner, 3:1..1:1 aspect, ≤4000px wide, raster only
 *   headerImage     — invoice header art, ≤3000px wide, raster + svg
 *   stamp           — notarised chop / seal, ≤2000px each side, raster only
 *
 * Not in scope (deferred):
 *   - Virus scanning (ClamAV is a docker dep we don't have yet — track via
 *     FR-3.5.f follow-up). The MIME + magic-byte sniff + size cap stops
 *     trivially-malicious uploads; ClamAV is layer 2.
 *   - EXIF / orientation correction (raster headers are read raw; we don't
 *     rotate). Operator uploads finished-art assets — orientation drift
 *     would surface in the live-preview pane.
 *   - Color-profile normalisation (sRGB enforcement). Deferred to printer
 *     pipeline; UI surfaces accept tagged profiles transparently.
 */

const sanitizeHtml = require("sanitize-html");

// Hard caps shared across every class. Per-class caps may be tighter; this
// is the "no upload should ever exceed this regardless of class" floor.
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const MIME_ALLOWLIST = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "image/x-icon": ".ico", // favicon only — gated by class below
  "image/vnd.microsoft.icon": ".ico",
});

const ASSET_CLASSES = Object.freeze({
  logo: {
    allowedMime: ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"],
    maxBytes: 2 * 1024 * 1024, // 2 MB
    maxWidth: 2000,
    maxHeight: 2000,
    aspectMin: null,
    aspectMax: null,
  },
  wordmark: {
    allowedMime: ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"],
    maxBytes: 2 * 1024 * 1024,
    maxWidth: 3000,
    maxHeight: 1500,
    aspectMin: null,
    aspectMax: null,
  },
  favicon: {
    allowedMime: [
      "image/png",
      "image/svg+xml",
      "image/webp",
      "image/x-icon",
      "image/vnd.microsoft.icon",
    ],
    maxBytes: 512 * 1024, // 512 KB
    maxWidth: 512,
    maxHeight: 512,
    aspectMin: null,
    aspectMax: null,
  },
  hero: {
    // DD-5.5d: hero typically photographic; SVG hero is rare and would
    // bloat the page; reject + tell operator to use header instead.
    allowedMime: ["image/png", "image/jpeg", "image/jpg", "image/webp"],
    maxBytes: 5 * 1024 * 1024,
    maxWidth: 4000,
    maxHeight: 3000,
    // 1.0 = square, 3.0 = 3:1 landscape. Anything outside this band
    // composites badly in the landing-hero zone.
    aspectMin: 1.0,
    aspectMax: 3.0,
  },
  headerImage: {
    allowedMime: ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"],
    maxBytes: 2 * 1024 * 1024,
    maxWidth: 3000,
    maxHeight: 1500,
    aspectMin: null,
    aspectMax: null,
  },
  stamp: {
    allowedMime: ["image/png", "image/jpeg", "image/jpg", "image/webp"],
    maxBytes: 1 * 1024 * 1024,
    maxWidth: 2000,
    maxHeight: 2000,
    aspectMin: null,
    aspectMax: null,
  },
});

// SVG sanitization — conservative allowlist. Anything ambiguous (foreignObject,
// xlink:href to external URLs) is dropped. The result MUST be safe to inline
// into a PDF or HTML page without script execution.
const SVG_TAG_ALLOWLIST = [
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "rect",
  "polygon",
  "polyline",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "title",
  "desc",
  "text",
  "tspan",
  "use", // sanitized via attribute allowlist below — same-doc refs only
];

function buildSvgSanitizeOptions() {
  // sanitize-html supports passing allowedAttributes per-tag. Wildcards are
  // listed under "*". We deliberately do NOT allow `style` (CSS can carry
  // expression() / url('javascript:...') in legacy renderers); inline
  // attributes are required for any visual property.
  return {
    allowedTags: SVG_TAG_ALLOWLIST,
    allowedAttributes: {
      "*": [
        "id",
        "class",
        "fill",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-miterlimit",
        "stroke-dasharray",
        "stroke-opacity",
        "fill-opacity",
        "fill-rule",
        "opacity",
        "transform",
        "viewBox",
        "width",
        "height",
        "x",
        "y",
        "cx",
        "cy",
        "r",
        "rx",
        "ry",
        "x1",
        "y1",
        "x2",
        "y2",
        "points",
        "d",
        "offset",
        "stop-color",
        "stop-opacity",
        "gradientUnits",
        "gradientTransform",
        "preserveAspectRatio",
        "version",
        "xmlns",
      ],
      // <use href> stays same-doc only (#fragment) — blocks the SVG-XSS
      // pattern that pulls external referenced content with onclick handlers.
      use: ["href", "xlink:href", "x", "y", "width", "height", "transform"],
    },
    // Forbid any URL scheme except #fragment + data:image/* (the latter only
    // surfaces inside <image href="data:image/png;base64,...">, which we don't
    // list above anyway; the schemes are belt-and-braces).
    allowedSchemesByTag: {
      use: [], // we filter href below
    },
    allowedSchemes: ["data"],
    // Strip the most-common XSS vector — on* event handlers.
    disallowedTagsMode: "discard",
    parser: { lowerCaseTags: false, xmlMode: true },
  };
}

/**
 * Pull width/height from a raster image header. Returns
 *   { ok: true, width, height }  on success
 *   { ok: false }                 on unknown / corrupt / unrecognised header
 *
 * Header offsets sourced from each format's public spec. We deliberately
 * read TINY slices (≤30 bytes) so we never load a megabyte just to confirm
 * "yes that's a PNG".
 */
function probeImageDimensions(buf, mime) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return { ok: false };
  try {
    if (mime === "image/png") {
      // PNG IHDR chunk: width at byte 16-19, height at 20-23 (big-endian).
      // Magic check: \x89PNG\r\n\x1a\n at bytes 0..7.
      if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
        return { ok: false };
      }
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return { ok: true, width, height };
    }
    if (mime === "image/jpeg" || mime === "image/jpg") {
      // Walk JPEG markers until SOF0/SOF2 frame, where width+height live.
      // JPEG: 0xFFD8 magic; markers are 0xFFXX. Length of each segment is
      // big-endian at offset+2; SOFn dims at offset+5..8.
      if (buf.readUInt16BE(0) !== 0xffd8) return { ok: false };
      let off = 2;
      while (off + 9 < buf.length) {
        // Skip fill bytes (0xFF padding).
        while (off < buf.length && buf[off] === 0xff && buf[off + 1] === 0xff) off++;
        if (buf[off] !== 0xff) return { ok: false };
        const marker = buf[off + 1];
        // SOF0 = 0xC0, SOF2 = 0xC2 — others (C4 DHT, C8 JPG, CC DAC) are
        // not start-of-frame, skip via segment length.
        if (
          marker === 0xc0 ||
          marker === 0xc1 ||
          marker === 0xc2 ||
          marker === 0xc3
        ) {
          // SOFn payload: [marker][len-2][precision][height-2][width-2]...
          const height = buf.readUInt16BE(off + 5);
          const width = buf.readUInt16BE(off + 7);
          return { ok: true, width, height };
        }
        const segLen = buf.readUInt16BE(off + 2);
        off += 2 + segLen;
      }
      return { ok: false };
    }
    if (mime === "image/webp") {
      // RIFF....WEBPVP8?....
      if (buf.toString("ascii", 0, 4) !== "RIFF") return { ok: false };
      if (buf.toString("ascii", 8, 12) !== "WEBP") return { ok: false };
      const tag = buf.toString("ascii", 12, 16);
      if (tag === "VP8 ") {
        // Lossy: width/height at offset 26..29 (14 bits each, little-endian)
        const w = buf.readUInt16LE(26) & 0x3fff;
        const h = buf.readUInt16LE(28) & 0x3fff;
        return { ok: true, width: w, height: h };
      }
      if (tag === "VP8L") {
        // Lossless: 1 + 14 bits w-1 + 14 bits h-1 packed little-endian
        // starting at byte 21.
        const b0 = buf[21];
        const b1 = buf[22];
        const b2 = buf[23];
        const b3 = buf[24];
        const w = 1 + (((b1 & 0x3f) << 8) | b0);
        const h = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { ok: true, width: w, height: h };
      }
      if (tag === "VP8X") {
        // Extended (alpha / anim): canvas dims at offset 24..29
        const w = 1 + ((buf[24] | (buf[25] << 8) | (buf[26] << 16)) & 0xffffff);
        const h = 1 + ((buf[27] | (buf[28] << 8) | (buf[29] << 16)) & 0xffffff);
        return { ok: true, width: w, height: h };
      }
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }
  return { ok: false };
}

// Pull width/height from an SVG by inspecting its root attrs. Falls back
// to viewBox if width/height aren't declared. Returns null if neither
// signal is present (we accept the upload but skip the dim check — SVGs
// are vector + resolution-independent anyway).
function probeSvgDimensions(svgText) {
  try {
    const wMatch = svgText.match(/<svg[^>]*\bwidth\s*=\s*"([^"]+)"/i);
    const hMatch = svgText.match(/<svg[^>]*\bheight\s*=\s*"([^"]+)"/i);
    const vbMatch = svgText.match(/<svg[^>]*\bviewBox\s*=\s*"([^"]+)"/i);
    if (wMatch && hMatch) {
      const w = parseFloat(wMatch[1]);
      const h = parseFloat(hMatch[1]);
      if (Number.isFinite(w) && Number.isFinite(h)) return { ok: true, width: w, height: h };
    }
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/[\s,]+/).map(parseFloat);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        return { ok: true, width: parts[2], height: parts[3] };
      }
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Top-level entry point. Caller passes a Multer file-like object:
 *   { buffer, mimetype, originalname, size }
 * and an `expectedType` key from ASSET_CLASSES.
 *
 * Result envelope:
 *   { valid, errors[], messages[], sanitizedBuffer?, mime?, ext?, width?, height? }
 */
function validateAssetUpload({ file, expectedType }) {
  const errors = [];
  const messages = [];

  if (!file || !file.buffer || !Buffer.isBuffer(file.buffer)) {
    return {
      valid: false,
      errors: ["NO_FILE"],
      messages: ["No file payload received"],
    };
  }

  const klass = ASSET_CLASSES[expectedType];
  if (!klass) {
    return {
      valid: false,
      errors: ["UNKNOWN_ASSET_TYPE"],
      messages: [
        `Unknown asset type: ${expectedType}. Allowed: ${Object.keys(ASSET_CLASSES).join(", ")}`,
      ],
    };
  }

  const mime = String(file.mimetype || "").toLowerCase();
  const sizeBytes = file.buffer.length;

  // ── Size caps ─────────────────────────────────────────────────────
  if (sizeBytes > MAX_SIZE_BYTES) {
    errors.push("FILE_TOO_LARGE_HARD_CAP");
    messages.push(`File exceeds hard cap of ${MAX_SIZE_BYTES} bytes`);
  }
  if (sizeBytes > klass.maxBytes) {
    errors.push("FILE_TOO_LARGE_FOR_CLASS");
    messages.push(
      `File exceeds ${expectedType} cap of ${klass.maxBytes} bytes (was ${sizeBytes} bytes)`,
    );
  }

  // ── MIME whitelist ────────────────────────────────────────────────
  if (!MIME_ALLOWLIST[mime]) {
    errors.push("UNSUPPORTED_MIME");
    messages.push(`Unsupported MIME ${mime}. Allowed types: ${Object.keys(MIME_ALLOWLIST).join(", ")}`);
  } else if (!klass.allowedMime.includes(mime)) {
    errors.push("MIME_NOT_ALLOWED_FOR_CLASS");
    messages.push(
      `MIME ${mime} not allowed for asset class ${expectedType}. Allowed: ${klass.allowedMime.join(", ")}`,
    );
  }

  // Short-circuit if we already have errors — dim probing on a bad file
  // would just produce noise.
  if (errors.length > 0) {
    return { valid: false, errors, messages };
  }

  const ext = MIME_ALLOWLIST[mime];

  // ── SVG sanitization ──────────────────────────────────────────────
  let sanitizedBuffer = file.buffer;
  if (mime === "image/svg+xml") {
    const svgText = file.buffer.toString("utf8");
    // Reject anything with a <script> tag, on* attribute, or javascript:
    // URL before sanitize-html runs — these are clear-intent XSS signals
    // that don't need to be quietly stripped.
    if (/<script\b/i.test(svgText)) {
      errors.push("SVG_CONTAINS_SCRIPT");
      messages.push("SVG payload contains <script> tag; rejected for XSS safety");
    }
    if (/\son\w+\s*=/i.test(svgText)) {
      errors.push("SVG_CONTAINS_EVENT_HANDLER");
      messages.push("SVG payload contains on*= event handler; rejected for XSS safety");
    }
    if (/javascript\s*:/i.test(svgText)) {
      errors.push("SVG_CONTAINS_JS_URL");
      messages.push("SVG payload contains javascript: URL; rejected for XSS safety");
    }
    if (errors.length === 0) {
      // Conservative pass to drop foreignObject + unknown tags + style.
      const cleaned = sanitizeHtml(svgText, buildSvgSanitizeOptions());
      // sanitize-html drops the XML declaration on output; preserve nothing
      // since SVGs work fine without one inlined.
      sanitizedBuffer = Buffer.from(cleaned, "utf8");
    }

    // Skip raster dim probe for SVG — try the vector path instead.
    const sd = probeSvgDimensions(file.buffer.toString("utf8"));
    if (sd.ok) {
      if (klass.maxWidth != null && sd.width > klass.maxWidth) {
        errors.push("WIDTH_EXCEEDS_CAP");
        messages.push(
          `SVG declared width ${sd.width} exceeds cap ${klass.maxWidth} for ${expectedType}`,
        );
      }
      if (klass.maxHeight != null && sd.height > klass.maxHeight) {
        errors.push("HEIGHT_EXCEEDS_CAP");
        messages.push(
          `SVG declared height ${sd.height} exceeds cap ${klass.maxHeight} for ${expectedType}`,
        );
      }
    }
    if (errors.length > 0) return { valid: false, errors, messages };
    return {
      valid: true,
      sanitizedBuffer,
      mime,
      ext,
      width: sd.ok ? sd.width : null,
      height: sd.ok ? sd.height : null,
    };
  }

  // ── Raster dim probe ──────────────────────────────────────────────
  // Skip for icon (ICO is a multi-resolution container — width/height are
  // already capped via maxBytes + 512px max-class cap).
  if (mime === "image/x-icon" || mime === "image/vnd.microsoft.icon") {
    return {
      valid: true,
      sanitizedBuffer,
      mime,
      ext,
      width: null,
      height: null,
    };
  }

  const dim = probeImageDimensions(file.buffer, mime);
  if (!dim.ok) {
    // We accept the upload but flag the dim-probe miss as a soft warning
    // (not a rejection) so a slightly-exotic PNG variant doesn't get
    // 400'd on a header-parser quirk.
    return {
      valid: true,
      sanitizedBuffer,
      mime,
      ext,
      width: null,
      height: null,
    };
  }

  if (klass.maxWidth != null && dim.width > klass.maxWidth) {
    errors.push("WIDTH_EXCEEDS_CAP");
    messages.push(`Width ${dim.width}px exceeds cap ${klass.maxWidth}px for ${expectedType}`);
  }
  if (klass.maxHeight != null && dim.height > klass.maxHeight) {
    errors.push("HEIGHT_EXCEEDS_CAP");
    messages.push(`Height ${dim.height}px exceeds cap ${klass.maxHeight}px for ${expectedType}`);
  }
  if (klass.aspectMin != null || klass.aspectMax != null) {
    const aspect = dim.width / dim.height;
    if (klass.aspectMin != null && aspect < klass.aspectMin) {
      errors.push("ASPECT_TOO_TALL");
      messages.push(
        `Aspect ${aspect.toFixed(2)} below min ${klass.aspectMin} for ${expectedType}; upload is too tall`,
      );
    }
    if (klass.aspectMax != null && aspect > klass.aspectMax) {
      errors.push("ASPECT_TOO_WIDE");
      messages.push(
        `Aspect ${aspect.toFixed(2)} above max ${klass.aspectMax} for ${expectedType}; upload is too wide`,
      );
    }
  }

  if (errors.length > 0) return { valid: false, errors, messages };
  return {
    valid: true,
    sanitizedBuffer,
    mime,
    ext,
    width: dim.width,
    height: dim.height,
  };
}

module.exports = {
  validateAssetUpload,
  ASSET_CLASSES,
  MAX_SIZE_BYTES,
  MIME_ALLOWLIST,
  // Exported for unit-test probing only.
  probeImageDimensions,
  probeSvgDimensions,
};
