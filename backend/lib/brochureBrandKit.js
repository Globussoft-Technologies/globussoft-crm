/**
 * brochureBrandKit.js — server-side brand-kit sanitizer for the Brochure Engine.
 *
 * The CRM route layer (routes/travel_brochures.js) is the TRUST BOUNDARY between
 * the operator's browser and the vendored agentic-orchcrm engine: the engine
 * passes `brand` through verbatim, so everything must be hardened HERE before it
 * reaches the subprocess bridge.
 *
 * This is a CommonJS port of agentic-orchcrm/apps/web/src/lib/brand-kit.ts
 * (`sanitizeBrandKit`). Behaviour is intentionally byte-identical so a brochure
 * generated from the CRM matches the standalone engine. Keep the two in sync; if
 * the upstream sanitizer changes, re-port it here (it has no engine-internal deps,
 * only node:zlib + raw byte math).
 *
 * What it guarantees:
 *   - logo: a REAL raster image only (magic-byte sniff PNG/JPEG/WebP/GIF) — never
 *     an SVG (script-bearing) and never an external URL (SSRF / non-determinism),
 *     re-emitted as a normalised data: URI, ≤120KB.
 *   - every text field length-capped; colours #hex-validated; socials slugged.
 *   - `custom` (visual-placer) placement → pure CLAMPED numbers + a fixed corner
 *     enum, never free text → safe to interpolate into engine inline styles.
 *   - invalid input is DROPPED (→ undefined), never rejected — a bad logo falls
 *     back to the text wordmark; the run never fails on branding.
 *
 * TMC school extension:
 *   - Accepts the extended brand shape used by the TMC school brochure flow
 *     (school name, school logo URL, school brand colours) alongside the legacy
 *     agency-brand fields.
 *   - Emits soft warnings about the school logo (missing, non-PNG format,
 *     undersized dimensions, large byte size) but NEVER blocks generation.
 *   - Returns { kit, warnings } so the route can surface warnings in the
 *     start-run response while passing only the sanitized kit to the engine.
 *
 * Returns { kit: undefined, warnings: [] } when nothing is usable, so the engine
 * path is byte-identical to "no brand".
 */
'use strict';

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const s3Service = require('../services/s3Service');

const MAX_LOGO_BYTES = 10 * 1024 * 1024; // 10MB inlined cap (large logos bloat the PDF — keep reasonable)
const SCHOOL_LOGO_SOFT_MAX_BYTES = 500 * 1024; // 500KB — soft warning only
const SCHOOL_LOGO_MIN_DIMENSION = 800; // px — soft warning only (TMC print spec)
const SCHOOL_LOGO_MAX_DIMENSION = 2000; // px — soft warning only (TMC print spec)
const NAME_MAX = 80;
const TAGLINE_MAX = 140;
const CONTACT_MAX = 120;
const MAX_CONTACT_LINES = 4;
const MAX_SOCIALS = 6;
const SCHOOL_NAME_MAX = 120;

/** Sniff the real image type from the decoded bytes (don't trust the declared mime). */
function sniffImage(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  )
    return 'image/webp';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return null;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a PNG far enough to decide whether the logo needs the frosted white
 * backing PLATE or reads fine BARE (transparent + drop-shadow). Mirrors the
 * upstream analyzePng — dependency-free (node:zlib inflate + scanline unfilter).
 * Returns 'plate' | 'bare' | null (null → caller uses the safe default).
 */
function analyzePng(bytes) {
  const len = bytes.length;
  let off = 8; // past the 8-byte PNG signature
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idat = [];
  while (off + 8 <= len) {
    const clen = bytes.readUInt32BE(off);
    const type = bytes.toString('ascii', off + 4, off + 8);
    const dStart = off + 8;
    const dEnd = dStart + clen;
    if (dEnd + 4 > len) break; // truncated chunk
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(dStart);
      height = bytes.readUInt32BE(dStart + 4);
      bitDepth = bytes[dStart + 8];
      colorType = bytes[dStart + 9];
      interlace = bytes[dStart + 12];
    } else if (type === 'PLTE') {
      plte = bytes.subarray(dStart, dEnd);
    } else if (type === 'tRNS') {
      trns = bytes.subarray(dStart, dEnd);
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dStart, dEnd));
    } else if (type === 'IEND') {
      break;
    }
    off = dEnd + 4; // skip the 4-byte CRC
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  if (width * height > 4_000_000) return null; // bound the work
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4, 3: 1 }[colorType];
  if (!channels) return null;
  if (colorType === 3 && !plte) return null;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  // Unfilter scanlines into a contiguous pixel buffer.
  const out = Buffer.allocUnsafe(stride * height);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const fOff = y * (stride + 1);
    const filter = raw[fOff];
    const rowStart = fOff + 1;
    const outRow = y * stride;
    const prevRow = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[rowStart + x];
      const a = x >= bpp ? out[outRow + x - bpp] : 0;
      const b = y > 0 ? out[prevRow + x] : 0;
      const c = x >= bpp && y > 0 ? out[prevRow + x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = rb; break;
        case 1: val = rb + a; break;
        case 2: val = rb + b; break;
        case 3: val = rb + ((a + b) >> 1); break;
        case 4: val = rb + paeth(a, b, c); break;
        default: return null;
      }
      out[outRow + x] = val & 0xff;
    }
  }
  // Sample on a coarse grid; weigh only meaningfully-opaque pixels.
  const stepX = Math.max(1, Math.floor(width / 120));
  const stepY = Math.max(1, Math.floor(height / 120));
  let total = 0;
  let transparent = 0;
  let opaque = 0;
  let lumSum = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      total++;
      const idx = y * stride + x * channels;
      let r;
      let g;
      let bl;
      let al;
      if (colorType === 6) { r = out[idx]; g = out[idx + 1]; bl = out[idx + 2]; al = out[idx + 3]; }
      else if (colorType === 2) { r = out[idx]; g = out[idx + 1]; bl = out[idx + 2]; al = 255; }
      else if (colorType === 0) { r = g = bl = out[idx]; al = 255; }
      else if (colorType === 4) { r = g = bl = out[idx]; al = out[idx + 1]; }
      else { const pi = out[idx]; r = plte[pi * 3]; g = plte[pi * 3 + 1]; bl = plte[pi * 3 + 2]; al = trns && pi < trns.length ? trns[pi] : 255; }
      if (al < 16) { transparent++; continue; }
      if (al < 128) continue; // skip anti-aliased edges
      opaque++;
      lumSum += 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    }
  }
  if (opaque === 0) return null;
  const transFrac = transparent / total;
  if (transFrac < 0.03) return 'bare'; // solid rectangle — a plate would be invisible
  const meanLum = lumSum / opaque / 255; // 0..1
  return meanLum < 0.5 ? 'bare' : 'plate'; // dark cut-out reads on its own; light cut-out keeps the plate
}

function analyzeLogoTreatment(bytes, mime) {
  try {
    if (mime === 'image/png') return analyzePng(bytes);
    if (mime === 'image/jpeg') return 'bare'; // JPEG has no alpha → always a solid rectangle
    return null; // GIF / WebP may carry alpha; can't decode cheaply → safe default (plate)
  } catch {
    return null;
  }
}

/**
 * Read PNG pixel dimensions from the IHDR chunk without full decode.
 * Returns { width, height } or null for non-PNG / truncated input.
 */
function readPngDimensions(bytes) {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  let off = 8; // past signature
  const len = bytes.length;
  while (off + 8 <= len) {
    const clen = bytes.readUInt32BE(off);
    const type = bytes.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR' && clen >= 13 && off + 24 <= len) {
      const dStart = off + 8;
      return {
        width: bytes.readUInt32BE(dStart),
        height: bytes.readUInt32BE(dStart + 4),
      };
    }
    if (type === 'IEND') break;
    off += 8 + clen + 4; // length + type + data + CRC
  }
  return null;
}

function isOwnS3ImageUrl(input) {
  // Only accept URLs inside this app's brand-kits prefix. The upload endpoint
  // already validated MIME type / magic bytes, so the key prefix is enough.
  return (
    s3Service.S3_BASE_URL &&
    typeof input === 'string' &&
    input.startsWith(s3Service.S3_BASE_URL) &&
    /\/brand-kits\//i.test(input)
  );
}

/**
 * Resolve a local /uploads/brand-kits/... URL (or /api/uploads/brand-kits/...) to
 * an inline data: URI so the engine subprocess can render it without needing the
 * CRM static server. Validates the path shape, resolves it under backend/uploads,
 * sniffs magic bytes, and rejects anything outside the brand-kits directory.
 */
function resolveLocalUploadUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const m = trimmed.match(/^\/(?:api\/)?uploads\/(brand-kits\/.+)$/);
  if (!m) return null;
  const rel = m[1].split('?')[0];
  // Reject any path that tries to escape the uploads tree. URLs use '/' regardless
  // of platform, so normalize with path.posix before comparing.
  const normalizedRel = path.posix.normalize(rel);
  if (normalizedRel.startsWith('..') || normalizedRel.includes('/../') || normalizedRel !== rel) return null;
  // Convert URL separators to platform separators for the filesystem lookup.
  const fsRel = rel.replace(/\//g, path.sep);
  const abs = path.join(__dirname, '..', 'uploads', fsRel);
  // Final safety: the resolved path must still live inside backend/uploads.
  const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
  if (!abs.startsWith(uploadsRoot + path.sep) && abs !== uploadsRoot) return null;
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  if (!buf.length || buf.length > MAX_LOGO_BYTES) return null;
  const mime = sniffImage(new Uint8Array(buf));
  if (!mime) return null;
  return { url: `data:${mime};base64,${buf.toString('base64')}`, treatment: analyzeLogoTreatment(buf, mime) };
}

/** Validate + normalise an uploaded logo. Accepts legacy base64 data: URIs,
 *  S3 URLs that belong to this app's bucket (uploaded via the brand-image endpoint),
 *  and local /uploads/brand-kits/... paths written by the BrandKit admin UI.
 *  Empty url when invalid. For S3-hosted logos we cannot decode the bytes here
 *  without a network round-trip, so treatment is left null → the engine falls
 *  back to its safe plate default (the placer's explicit backing toggle still wins).
 */
function sanitizeLogo(input) {
  if (typeof input !== 'string') return { url: '', treatment: null };
  const trimmed = input.trim();

  // Local /uploads path from the BrandKit admin UI → inline it so the engine
  // subprocess (different cwd) can render it without proxying the CRM static route.
  const local = resolveLocalUploadUrl(trimmed);
  if (local) return local;

  // S3-hosted image uploaded by this tenant. We trust our own bucket and only
  // validate the URL shape; SSRF is avoided because the bucket/domain is fixed.
  if (isOwnS3ImageUrl(trimmed)) {
    return { url: trimmed, treatment: null };
  }

  const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(trimmed);
  if (!m) return { url: '', treatment: null };
  const b64 = m[1].replace(/\s/g, '');
  let bytes;
  try {
    bytes = Buffer.from(b64, 'base64');
  } catch {
    return { url: '', treatment: null };
  }
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return { url: '', treatment: null };
  const mime = sniffImage(new Uint8Array(bytes));
  if (!mime) return { url: '', treatment: null }; // not a real raster image (SVG, junk, …) → drop
  return { url: `data:${mime};base64,${bytes.toString('base64')}`, treatment: analyzeLogoTreatment(bytes, mime) };
}

function capStr(v, max) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function sanitizeHex(v) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(t) ? t : undefined;
}

/** Validate a user-supplied URL for the QR code: http(s) only, length-capped, no
 *  javascript:/data:/mailto: schemes (the QR is scanned and OPENED). Drop → undefined. */
function sanitizeUrl(v) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t || t.length > 500) return undefined;
  if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(t)) return undefined;
  return t;
}

/** Coerce to a finite number clamped to [lo,hi]; non-numbers fall back to `dflt`. */
function clampNum(v, lo, hi, dflt) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
}

const LOGO_CORNERS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

// Size bounds. cover.scale = fraction of page WIDTH; interior.scale = a 0.06–0.30
// slider the engine maps to a zone-safe mark HEIGHT (customMarkH). Kept in
// lock-step with the placer sliders + the engine so what's dragged is what renders.
const COVER_SCALE = { lo: 0.06, hi: 0.6, dflt: 0.24 };
const INNER_SCALE = { lo: 0.06, hi: 0.3, dflt: 0.12 };
// TMC-school cover logo placement (Brochure Engine's own logo-size/position
// preview — a DIFFERENT slider semantics from COVER_SCALE above: this scale
// is a plain multiplier on the logo's default size (1 = default), not a
// fraction of page width, so it gets its own bounds.
const TMC_LOGO_SCALE = { lo: 0.5, hi: 2, dflt: 1 };

/** Validate an optional {x,y,scale} TMC-school logo placement into pure
 *  clamped numbers. Returns undefined when nothing usable was supplied. */
function sanitizeTmcLogoPlacement(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    x: clampNum(raw.x, 0, 1, 0.5),
    y: clampNum(raw.y, 0, 1, 0.12),
    scale: clampNum(raw.scale, TMC_LOGO_SCALE.lo, TMC_LOGO_SCALE.hi, TMC_LOGO_SCALE.dflt),
  };
}

/**
 * Validate the OPTIONAL custom (visual-placer) logo placement into pure clamped
 * numbers + a fixed corner enum. NOTHING here is free text. Returns undefined when
 * there is nothing usable (→ the engine falls back to the prompt-parsed placement).
 */
function sanitizeCustomPlacement(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw;

  let cover = null;
  if (r.cover && typeof r.cover === 'object') {
    const c = r.cover;
    cover = {
      x: clampNum(c.x, 0, 1, 0.5),
      y: clampNum(c.y, 0, 1, 0.32),
      scale: clampNum(c.scale, COVER_SCALE.lo, COVER_SCALE.hi, COVER_SCALE.dflt),
    };
  }

  let interior = null;
  if (r.interior && typeof r.interior === 'object') {
    const i = r.interior;
    const corner = LOGO_CORNERS.includes(i.corner) ? i.corner : 'top-left';
    interior = { corner, scale: clampNum(i.scale, INNER_SCALE.lo, INNER_SCALE.hi, INNER_SCALE.dflt) };
  }

  // No usable surface → undefined so the engine path is identical to "no custom".
  if (!cover && !interior) return undefined;
  return { cover, interior };
}

/** The placer's explicit logo-backing choice, or undefined to leave auto-detection. */
function sanitizeBacking(v) {
  return v === 'plate' || v === 'none' ? v : undefined;
}

/**
 * Build a trusted BrandKit from raw client input.
 *
 * Returns { kit, warnings } where:
 *   - kit is the sanitized engine-ready BrandKit, or undefined when nothing
 *     is usable (engine path identical to "no brand").
 *   - warnings is an array of soft advisory strings (never blocking) so the
 *     route can return them in the start-run response.
 *
 * See the file header for the security guarantees.
 */
function sanitizeBrandKit(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { kit: undefined, warnings };
  }
  const r = raw;

  const logo = sanitizeLogo(r.logoUrl != null ? r.logoUrl : r.logo);
  const logoUrl = logo.url;
  // Custom placement is meaningless without a logo to place.
  const custom = logoUrl ? sanitizeCustomPlacement(r.custom) : undefined;
  // The placer may also send an explicit backing choice (default: as-uploaded).
  const backing = custom && r.custom && typeof r.custom === 'object' ? sanitizeBacking(r.custom.backing) : undefined;
  const name = capStr(r.name, NAME_MAX);
  const tagline = capStr(r.tagline, TAGLINE_MAX);
  // Optional QR link (client-pasted) — drives the brochure QR code with priority over
  // the composer's own qrData. http(s) only, validated.
  const qrData = sanitizeUrl(r.qrUrl != null ? r.qrUrl : r.qrData);

  const contactRaw = Array.isArray(r.contact) ? r.contact : [];
  const contact = contactRaw
    .map((l) => capStr(l, CONTACT_MAX))
    .filter((l) => !!l)
    .slice(0, MAX_CONTACT_LINES);

  const socialsRaw = Array.isArray(r.socials) ? r.socials : [];
  const socials = socialsRaw
    .map((s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') : ''))
    .filter(Boolean)
    .slice(0, MAX_SOCIALS);

  const colorsRaw = r.colors && typeof r.colors === 'object' ? r.colors : {};
  const accent = sanitizeHex(colorsRaw.accent);
  const accentSecondary = sanitizeHex(colorsRaw.accentSecondary);
  const colors = accent || accentSecondary
    ? { ...(accent ? { accent } : {}), ...(accentSecondary ? { accentSecondary } : {}) }
    : undefined;

  // onDark drives the logo backing in the engine: `onDark === false` → BARE
  // (no white box, just a drop-shadow); anything else → frosted plate. Derived
  // from the logo pixels so the white box appears ONLY when a logo needs it,
  // falling back to the client hint (then the safe plate default) when the bytes
  // can't be decoded. The placer's explicit backing choice WINS.
  let onDark;
  if (logoUrl) {
    if (logo.treatment === 'bare') onDark = false;
    else if (logo.treatment === 'plate') onDark = true;
    else onDark = r.onDark === true ? true : undefined;
    if (backing === 'none') onDark = false;
    else if (backing === 'plate') onDark = true;
  }

  // ADDITIONAL cover logos (beyond the primary logo) — each validated as a raster
  // data-URI with a server-CLAMPED free cover placement. Cover-only; capped to 8.
  const coverLogosRaw = Array.isArray(r.coverLogos) ? r.coverLogos : [];
  const coverLogos = coverLogosRaw
    .map((l) => {
      if (!l || typeof l !== 'object') return null;
      const lg = sanitizeLogo(l.url != null ? l.url : l.logoUrl);
      if (!lg.url) return null;
      const entry = {
        url: lg.url,
        x: clampNum(l.x, 0, 1, 0.5),
        y: clampNum(l.y, 0, 1, 0.32),
        scale: clampNum(l.scale, COVER_SCALE.lo, COVER_SCALE.hi, COVER_SCALE.dflt),
      };
      if (lg.treatment === 'bare') entry.onDark = false;
      else if (lg.treatment === 'plate') entry.onDark = true;
      return entry;
    })
    .filter(Boolean)
    .slice(0, 8);

  // Interior logo BAND — a row of logos (from the kit) on pages after the cover. Each
  // item validated as a raster data-URI with a clamped horizontal position; the band
  // position is a fixed enum and the shared size is clamped. Cover/interior independent.
  let interiorLogos;
  const ilRaw = r.interiorLogos && typeof r.interiorLogos === 'object' ? r.interiorLogos : null;
  if (ilRaw && Array.isArray(ilRaw.items)) {
    const items = ilRaw.items
      .map((it) => {
        if (!it || typeof it !== 'object') return null;
        const lg = sanitizeLogo(it.url != null ? it.url : it.logoUrl);
        if (!lg.url) return null;
        const entry = { url: lg.url, x: clampNum(it.x, 0, 1, 0.5) };
        if (lg.treatment === 'bare') entry.onDark = false;
        else if (lg.treatment === 'plate') entry.onDark = true;
        return entry;
      })
      .filter(Boolean)
      .slice(0, 8);
    if (items.length) {
      interiorLogos = {
        band: ilRaw.band === 'bottom' ? 'bottom' : 'header',
        scale: clampNum(ilRaw.scale, INNER_SCALE.lo, INNER_SCALE.hi, INNER_SCALE.dflt),
        items,
      };
    }
  }

  // User-uploaded destination/student photos (Brochure Engine "Images" step).
  // Same trust boundary as coverLogos — each entry validated as a raster
  // image (S3 URL from this tenant's own bucket, a local /uploads path, or a
  // data: URI); anything else is dropped. Without this the frontend's upload
  // control had nowhere real to land — images went into brand.imagePool but
  // were never forwarded past this sanitizer, so nothing uploaded ever
  // reached the rendered brochure.
  const imagePoolRaw = Array.isArray(r.imagePool) ? r.imagePool : [];
  const imagePool = imagePoolRaw
    .map((u) => sanitizeLogo(u).url)
    .filter(Boolean)
    .slice(0, 12);

  // ─── TMC school identity (soft-warned, never blocking) ───────────────────
  const schoolName = capStr(r.schoolName, SCHOOL_NAME_MAX);
  const schoolLogo = sanitizeLogo(r.schoolLogoUrl);
  const schoolLogoUrl = schoolLogo.url;
  // Operator-set exact position/size for each cover logo (Brochure Engine's
  // logo placement preview). Only kept when the corresponding logo actually
  // exists — a placement with no logo to place is meaningless.
  const tmcLogoPlacement = logoUrl ? sanitizeTmcLogoPlacement(r.tmcLogoPlacement) : undefined;
  const schoolLogoPlacement = schoolLogoUrl ? sanitizeTmcLogoPlacement(r.schoolLogoPlacement) : undefined;

  if (!schoolLogoUrl) {
    if (typeof r.schoolLogoUrl === 'string' && r.schoolLogoUrl.trim()) {
      warnings.push('School logo was provided but is not a valid raster image (PNG/JPEG/WebP/GIF); it will be omitted.');
    } else if (schoolName) {
      warnings.push('School logo is missing; the cover will show TMC branding only.');
    }
  } else {
    // Soft format warning: PNG is preferred for transparency on the co-branding cover.
    if (!schoolLogoUrl.startsWith('data:image/png;')) {
      warnings.push('School logo is not a PNG; transparency may not render correctly on the cover.');
    }
    // Byte-size warning (soft only).
    try {
      const b64 = schoolLogoUrl.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > SCHOOL_LOGO_SOFT_MAX_BYTES) {
        warnings.push('School logo file is large; PDF generation may take longer.');
      }
      // Dimension warning for PNG only (cheap, no extra decode).
      if (schoolLogoUrl.startsWith('data:image/png;')) {
        const dims = readPngDimensions(bytes);
        if (dims && (dims.width < SCHOOL_LOGO_MIN_DIMENSION || dims.height < SCHOOL_LOGO_MIN_DIMENSION)) {
          warnings.push('School logo dimensions are small (ideally 800-1600 px); it may appear pixelated in print.');
        }
        if (dims && (dims.width > SCHOOL_LOGO_MAX_DIMENSION || dims.height > SCHOOL_LOGO_MAX_DIMENSION)) {
          warnings.push('School logo is larger than 2000 px; consider resizing for optimal print quality.');
        }
      }
    } catch {
      /* ignore dimension/size read failures — never block */
    }
  }

  const kit = {
    ...(logoUrl ? { logoUrl } : {}),
    ...(name ? { name } : {}),
    ...(tagline ? { tagline } : {}),
    ...(contact.length ? { contact } : {}),
    ...(socials.length ? { socials } : {}),
    ...(qrData ? { qrData } : {}),
    ...(colors ? { colors } : {}),
    ...(typeof onDark === 'boolean' ? { onDark } : {}),
    ...(custom ? { custom } : {}),
    ...(coverLogos.length ? { coverLogos } : {}),
    ...(interiorLogos ? { interiorLogos } : {}),
    ...(schoolName ? { schoolName } : {}),
    ...(schoolLogoUrl ? { schoolLogoUrl } : {}),
    ...(imagePool.length ? { imagePool } : {}),
    ...(tmcLogoPlacement ? { tmcLogoPlacement } : {}),
    ...(schoolLogoPlacement ? { schoolLogoPlacement } : {}),
  };
  // Nothing usable → undefined so the engine path is identical to "no brand".
  return { kit: Object.keys(kit).length ? kit : undefined, warnings };
}

module.exports = { sanitizeBrandKit };
