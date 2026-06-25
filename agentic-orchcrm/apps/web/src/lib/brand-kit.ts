/**
 * Server-side brand-kit sanitizer for the run-create boundary.
 *
 * The client may send an OPTIONAL brand kit: a logo (as a base64 data: URI built
 * from an uploaded file) plus optional name / contact lines / colours / socials.
 * EVERYTHING here is hardened before it ever reaches the render engine:
 *   - the logo must be a real raster image (magic-byte sniff: PNG / JPEG / WebP /
 *     GIF) under a hard byte cap — NOT an SVG (script-bearing) and NOT an external
 *     URL (SSRF / non-determinism). It is re-emitted as a normalised data: URI.
 *   - every text field is length-capped; colours must be #hex; socials are slugged.
 * Anything invalid is dropped (not rejected) so a bad logo never fails the run —
 * the brochure simply falls back to its text wordmark. Returns `undefined` when
 * there is nothing usable, so the engine path is byte-identical to "no brand".
 */
import zlib from 'node:zlib';
import type { BrandKit, LogoCorner, LogoPlacementCustom } from '@agentic-os/tools';

const MAX_LOGO_BYTES = 120 * 1024; // 120KB inlined cap (keeps the PDF lean)
const NAME_MAX = 80;
const TAGLINE_MAX = 140;
const CONTACT_MAX = 120;
const MAX_CONTACT_LINES = 4;
const MAX_SOCIALS = 6;

/** Sniff the real image type from the decoded bytes (don't trust the declared mime). */
function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  const b = bytes;
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

/**
 * Decide whether an uploaded logo needs the frosted white backing PLATE to stay
 * legible, or reads fine on its own (BARE — transparent, just a soft drop-shadow).
 *
 * The render engine can't see the uploaded pixels, so historically EVERY logo got
 * a white plate — which puts an unwanted white box behind a logo that already
 * reads on any background (e.g. a dark "cut-out" wordmark on transparency). The
 * user asked: bigger logo, and no white box when it's visible without one. So we
 * inspect the bytes here, once, at the trust boundary:
 *   - effectively OPAQUE image (a solid rectangle, incl. all JPEGs) → 'bare':
 *     a plate behind a full rectangle is invisible anyway.
 *   - transparent CUT-OUT logo whose ink is DARK → 'bare': it reads on light
 *     pages natively and the .bare drop-shadow halo carries it on dark photos.
 *   - transparent CUT-OUT logo whose ink is LIGHT/white → 'plate': it would
 *     vanish on a white interior page, so it keeps the frosted backing.
 *   - undecodable (palette<8bit / interlaced / GIF / WebP-with-alpha) → null →
 *     caller falls back to the safe default (plate).
 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function analyzePng(bytes: Buffer): 'plate' | 'bare' | null {
  const len = bytes.length;
  let off = 8; // past the 8-byte PNG signature
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= len) {
    const clen = bytes.readUInt32BE(off);
    const type = bytes.toString('ascii', off + 4, off + 8);
    const dStart = off + 8;
    const dEnd = dStart + clen;
    if (dEnd + 4 > len) break; // truncated chunk
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(dStart);
      height = bytes.readUInt32BE(dStart + 4);
      bitDepth = bytes[dStart + 8]!;
      colorType = bytes[dStart + 9]!;
      interlace = bytes[dStart + 12]!;
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
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4, 3: 1 } as Record<number, number>)[colorType];
  if (!channels) return null;
  if (colorType === 3 && !plte) return null;
  let raw: Buffer;
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
      const rb = raw[rowStart + x]!;
      const a = x >= bpp ? out[outRow + x - bpp]! : 0;
      const b = y > 0 ? out[prevRow + x]! : 0;
      const c = x >= bpp && y > 0 ? out[prevRow + x - bpp]! : 0;
      let val: number;
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
      let r: number;
      let g: number;
      let bl: number;
      let al: number;
      if (colorType === 6) { r = out[idx]!; g = out[idx + 1]!; bl = out[idx + 2]!; al = out[idx + 3]!; }
      else if (colorType === 2) { r = out[idx]!; g = out[idx + 1]!; bl = out[idx + 2]!; al = 255; }
      else if (colorType === 0) { r = g = bl = out[idx]!; al = 255; }
      else if (colorType === 4) { r = g = bl = out[idx]!; al = out[idx + 1]!; }
      else { const pi = out[idx]!; r = plte![pi * 3]!; g = plte![pi * 3 + 1]!; bl = plte![pi * 3 + 2]!; al = trns && pi < trns.length ? trns[pi]! : 255; }
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

function analyzeLogoTreatment(bytes: Buffer, mime: string): 'plate' | 'bare' | null {
  try {
    if (mime === 'image/png') return analyzePng(bytes);
    if (mime === 'image/jpeg') return 'bare'; // JPEG has no alpha → always a solid rectangle
    return null; // GIF / WebP may carry alpha; can't decode cheaply → safe default (plate)
  } catch {
    return null;
  }
}

/** Validate + normalise an uploaded logo data: URI, returning the clean URI plus
 *  whether it needs the frosted plate. Empty url when invalid. */
function sanitizeLogo(input: unknown): { url: string; treatment: 'plate' | 'bare' | null } {
  if (typeof input !== 'string') return { url: '', treatment: null };
  const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(input.trim());
  if (!m) return { url: '', treatment: null };
  const b64 = m[1]!.replace(/\s/g, '');
  let bytes: Buffer;
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

function capStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function sanitizeHex(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(t) ? t : undefined;
}

/** Coerce to a finite number clamped to [lo,hi]; non-numbers fall back to `dflt`. */
function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
}

const LOGO_CORNERS: readonly LogoCorner[] = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

// Size bounds. cover.scale = fraction of page WIDTH; interior.scale = a 0.06–0.30
// slider that the engine maps to a zone-safe mark HEIGHT (customMarkH). Kept in
// lock-step with the placer sliders + the engine so what's dragged is what renders.
const COVER_SCALE = { lo: 0.06, hi: 0.6, dflt: 0.24 } as const;
const INNER_SCALE = { lo: 0.06, hi: 0.3, dflt: 0.12 } as const;

/**
 * Validate the OPTIONAL custom (visual-placer) logo placement into pure clamped
 * numbers + a fixed corner enum. NOTHING here is free text, so the result is safe
 * to interpolate straight into inline styles in the engine. Returns undefined when
 * there is nothing usable (→ the engine falls back to the prompt-parsed placement).
 */
function sanitizeCustomPlacement(raw: unknown): LogoPlacementCustom | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  let cover: LogoPlacementCustom['cover'] = null;
  if (r.cover && typeof r.cover === 'object') {
    const c = r.cover as Record<string, unknown>;
    cover = {
      x: clampNum(c.x, 0, 1, 0.5),
      y: clampNum(c.y, 0, 1, 0.32),
      scale: clampNum(c.scale, COVER_SCALE.lo, COVER_SCALE.hi, COVER_SCALE.dflt),
    };
  }

  let interior: LogoPlacementCustom['interior'] = null;
  if (r.interior && typeof r.interior === 'object') {
    const i = r.interior as Record<string, unknown>;
    const corner = LOGO_CORNERS.includes(i.corner as LogoCorner) ? (i.corner as LogoCorner) : 'top-left';
    interior = { corner, scale: clampNum(i.scale, INNER_SCALE.lo, INNER_SCALE.hi, INNER_SCALE.dflt) };
  }

  // No usable surface → undefined so the engine path is identical to "no custom".
  if (!cover && !interior) return undefined;
  return { cover, interior };
}

/** The placer's explicit logo-backing choice, or undefined to leave auto-detection. */
function sanitizeBacking(v: unknown): 'plate' | 'none' | undefined {
  return v === 'plate' || v === 'none' ? v : undefined;
}

/**
 * Build a trusted BrandKit from raw client input, or undefined if nothing usable.
 *
 * Placement: by DEFAULT the orchestrator parses a fixed placement enum from the
 * goal text (the client sends none). OPTIONALLY the visual "Place logo" placer
 * sends an exact `custom` placement — which we accept here ONLY as clamped numbers
 * + a fixed corner enum (`sanitizeCustomPlacement`); never free text, so there is
 * no injection surface. Custom is attached only when a logo exists.
 */
export function sanitizeBrandKit(raw: unknown): BrandKit | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  const logo = sanitizeLogo(r.logoUrl ?? r.logo);
  const logoUrl = logo.url;
  // Custom placement is meaningless without a logo to place.
  const custom = logoUrl ? sanitizeCustomPlacement(r.custom) : undefined;
  // The placer may also send an explicit backing choice (default: as-uploaded).
  const backing = custom ? sanitizeBacking((r.custom as Record<string, unknown>).backing) : undefined;
  const name = capStr(r.name, NAME_MAX);
  const tagline = capStr(r.tagline, TAGLINE_MAX);

  const contactRaw = Array.isArray(r.contact) ? r.contact : [];
  const contact = contactRaw
    .map((l) => capStr(l, CONTACT_MAX))
    .filter((l): l is string => !!l)
    .slice(0, MAX_CONTACT_LINES);

  const socialsRaw = Array.isArray(r.socials) ? r.socials : [];
  const socials = socialsRaw
    .map((s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') : ''))
    .filter(Boolean)
    .slice(0, MAX_SOCIALS);

  const colorsRaw = (r.colors && typeof r.colors === 'object' ? r.colors : {}) as Record<string, unknown>;
  const accent = sanitizeHex(colorsRaw.accent);
  const accentSecondary = sanitizeHex(colorsRaw.accentSecondary);
  const colors = accent || accentSecondary ? { ...(accent ? { accent } : {}), ...(accentSecondary ? { accentSecondary } : {}) } : undefined;

  // onDark drives the logo backing in the engine: `onDark === false` → BARE
  // (no white box, just a drop-shadow); anything else → frosted plate. We derive
  // it from the logo pixels so the white box appears ONLY when a logo actually
  // needs it, falling back to the client hint (then the safe plate default) when
  // the bytes can't be decoded.
  let onDark: boolean | undefined;
  if (logoUrl) {
    if (logo.treatment === 'bare') onDark = false; // dark/opaque → reads on its own, no plate
    else if (logo.treatment === 'plate') onDark = true; // light cut-out → keep the plate
    else onDark = r.onDark === true ? true : undefined; // undecodable → hint, else default (plate)
    // The visual placer's explicit backing choice WINS over auto-detection, so the
    // logo renders exactly as the user asked — default 'none' = AS-UPLOADED, no box.
    if (backing === 'none') onDark = false;
    else if (backing === 'plate') onDark = true;
  }

  const kit: BrandKit = {
    ...(logoUrl ? { logoUrl } : {}),
    ...(name ? { name } : {}),
    ...(tagline ? { tagline } : {}),
    ...(contact.length ? { contact } : {}),
    ...(socials.length ? { socials } : {}),
    ...(colors ? { colors } : {}),
    ...(typeof onDark === 'boolean' ? { onDark } : {}),
    ...(custom ? { custom } : {}),
  };
  // Nothing usable → undefined so the engine path is identical to "no brand".
  return Object.keys(kit).length ? kit : undefined;
}
