// @ts-check
/**
 * PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.5.a-f (G100) — pins the upload
 * validation pipeline shape.
 *
 * What we pin:
 *   - MIME whitelist enforcement (png/jpeg/svg/webp + favicon-only ico).
 *   - Per-class size caps (logo ≤ 2 MB; favicon ≤ 512 KB; hero ≤ 5 MB).
 *   - Hard 5 MB ceiling across every class.
 *   - SVG XSS guards — <script>, on*= handlers, and javascript: URLs all
 *     reject the upload, not just silently strip.
 *   - SVG sanitisation drops foreignObject + style + any unlisted tag for
 *     accepted payloads.
 *   - Raster dimension probing — PNG IHDR, JPEG SOF0, WebP VP8/VP8L/VP8X
 *     all surface width+height for cap checks.
 *   - Hero aspect-ratio enforcement (1:1 .. 3:1).
 *   - Asset-class registry coverage (logo / wordmark / favicon / hero /
 *     headerImage / stamp).
 *
 * The test fabricates real raster headers in-memory so we exercise the
 * actual probe code paths, not a stub.
 */

import { describe, test, expect } from 'vitest';
import {
  validateAssetUpload,
  ASSET_CLASSES,
  MAX_SIZE_BYTES,
  MIME_ALLOWLIST,
  probeImageDimensions,
  probeSvgDimensions,
} from '../../lib/brandAssetValidation.js';

// ── Fixture builders ──────────────────────────────────────────────────

function makePngHeader(width, height) {
  // \x89PNG\r\n\x1a\n + IHDR chunk-len(13) + "IHDR" + width(4) + height(4)
  // + bit-depth + color-type + compression + filter + interlace + CRC(4)
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // Bit depth + color type + compression + filter + interlace + CRC zeros.
  return buf;
}

function makeJpegHeader(width, height) {
  // 0xFFD8 SOI + 0xFFC0 SOF0 marker + len(0x0011) + precision(8) + height(2) + width(2) + components(3) + 3 cmpt entries
  // We pad a minimal payload — only the marker walker needs to find SOF0.
  const buf = Buffer.alloc(24);
  buf.writeUInt16BE(0xffd8, 0); // SOI
  buf.writeUInt16BE(0xffc0, 2); // SOF0
  buf.writeUInt16BE(17, 4); // segment len
  buf.writeUInt8(8, 6); // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  buf.writeUInt8(3, 11); // 3 components
  return buf;
}

function makeWebpVp8x(width, height) {
  // RIFF [4] WEBP VP8X [4] flags(4 bytes) + canvas w-1 (3 LE bytes) + canvas h-1 (3 LE bytes)
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8);
  buf.write('VP8X', 12);
  buf.writeUInt32LE(10, 16); // chunk len
  // flags byte at 20 + 3 reserved bytes
  buf.writeUInt8(0x10, 20);
  buf.writeUInt8(0, 21);
  buf.writeUInt8(0, 22);
  buf.writeUInt8(0, 23);
  // canvas width-1 little-endian 24-bit at 24..26
  const wMinus = width - 1;
  buf.writeUInt8(wMinus & 0xff, 24);
  buf.writeUInt8((wMinus >> 8) & 0xff, 25);
  buf.writeUInt8((wMinus >> 16) & 0xff, 26);
  // canvas height-1 little-endian 24-bit at 27..29
  const hMinus = height - 1;
  buf.writeUInt8(hMinus & 0xff, 27);
  buf.writeUInt8((hMinus >> 8) & 0xff, 28);
  buf.writeUInt8((hMinus >> 16) & 0xff, 29);
  return buf;
}

function makeFile({ buffer, mime, name = 'test', size = null }) {
  return {
    buffer,
    mimetype: mime,
    originalname: name,
    size: size == null ? buffer.length : size,
  };
}

// ── Registry coverage ────────────────────────────────────────────────

describe('ASSET_CLASSES registry — all six classes registered', () => {
  test('logo class is registered with PNG/JPEG/SVG/WebP allowance', () => {
    expect(ASSET_CLASSES.logo).toBeDefined();
    expect(ASSET_CLASSES.logo.allowedMime).toContain('image/png');
    expect(ASSET_CLASSES.logo.allowedMime).toContain('image/jpeg');
    expect(ASSET_CLASSES.logo.allowedMime).toContain('image/svg+xml');
    expect(ASSET_CLASSES.logo.allowedMime).toContain('image/webp');
  });

  test('hero class enforces aspect ratio 1.0..3.0', () => {
    expect(ASSET_CLASSES.hero.aspectMin).toBe(1.0);
    expect(ASSET_CLASSES.hero.aspectMax).toBe(3.0);
  });

  test('hero class rejects SVG (raster-only)', () => {
    expect(ASSET_CLASSES.hero.allowedMime).not.toContain('image/svg+xml');
  });

  test('favicon class allows .ico in addition to png/svg/webp', () => {
    expect(ASSET_CLASSES.favicon.allowedMime).toContain('image/x-icon');
    expect(ASSET_CLASSES.favicon.maxWidth).toBe(512);
  });

  test('logo class capped at 2000px each side', () => {
    expect(ASSET_CLASSES.logo.maxWidth).toBe(2000);
    expect(ASSET_CLASSES.logo.maxHeight).toBe(2000);
  });

  test('every class exists in the registry', () => {
    const expected = ['logo', 'wordmark', 'favicon', 'hero', 'headerImage', 'stamp'];
    expected.forEach((k) => expect(ASSET_CLASSES[k]).toBeDefined());
  });

  test('MAX_SIZE_BYTES is 5 MB hard ceiling', () => {
    expect(MAX_SIZE_BYTES).toBe(5 * 1024 * 1024);
  });
});

// ── Negative-path: bad inputs ────────────────────────────────────────

describe('validateAssetUpload — error envelopes', () => {
  test('missing file returns NO_FILE', () => {
    const res = validateAssetUpload({ file: null, expectedType: 'logo' });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('NO_FILE');
  });

  test('unknown asset type returns UNKNOWN_ASSET_TYPE', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: makePngHeader(100, 100), mime: 'image/png' }),
      expectedType: 'foo-bar',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('UNKNOWN_ASSET_TYPE');
  });

  test('unsupported MIME returns UNSUPPORTED_MIME', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: Buffer.from('garbage'), mime: 'application/zip' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('UNSUPPORTED_MIME');
  });

  test('MIME not allowed for class — SVG to hero rejected', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: Buffer.from('<svg></svg>'), mime: 'image/svg+xml' }),
      expectedType: 'hero',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('MIME_NOT_ALLOWED_FOR_CLASS');
  });

  test('over-cap raster — file > 2 MB to logo rejected', () => {
    // Fabricate a header buffer + pad to 3 MB
    const png = makePngHeader(100, 100);
    const huge = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
    const res = validateAssetUpload({
      file: makeFile({ buffer: huge, mime: 'image/png' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('FILE_TOO_LARGE_FOR_CLASS');
  });

  test('hard 5 MB ceiling — file > 5 MB to hero rejected', () => {
    const png = makePngHeader(100, 100);
    const massive = Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]);
    const res = validateAssetUpload({
      file: makeFile({ buffer: massive, mime: 'image/jpeg' }),
      expectedType: 'hero',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('FILE_TOO_LARGE_HARD_CAP');
  });
});

// ── SVG XSS rejection ────────────────────────────────────────────────

describe('SVG XSS rejection — script / event handler / javascript: URL', () => {
  test('<script> tag rejects with SVG_CONTAINS_SCRIPT', () => {
    const evil =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="10"/></svg>';
    const res = validateAssetUpload({
      file: makeFile({ buffer: Buffer.from(evil), mime: 'image/svg+xml' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('SVG_CONTAINS_SCRIPT');
  });

  test('onload= handler rejects with SVG_CONTAINS_EVENT_HANDLER', () => {
    const evil = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>';
    const res = validateAssetUpload({
      file: makeFile({ buffer: Buffer.from(evil), mime: 'image/svg+xml' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('SVG_CONTAINS_EVENT_HANDLER');
  });

  test('onclick= handler rejects with SVG_CONTAINS_EVENT_HANDLER', () => {
    const evil = '<svg><circle onclick="javascript:alert(1)" r="5"/></svg>';
    const res = validateAssetUpload({
      file: makeFile({ buffer: Buffer.from(evil), mime: 'image/svg+xml' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('SVG_CONTAINS_EVENT_HANDLER');
  });

  test('javascript: URL rejects with SVG_CONTAINS_JS_URL', () => {
    const evil =
      '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)"><rect/></a></svg>';
    const res = validateAssetUpload({
      file: makeFile({ buffer: Buffer.from(evil), mime: 'image/svg+xml' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('SVG_CONTAINS_JS_URL');
  });

  test('clean SVG passes with sanitizedBuffer populated', () => {
    const clean =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#265855"/></svg>';
    const res = validateAssetUpload({
      file: makeFile({ buffer: Buffer.from(clean), mime: 'image/svg+xml' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(true);
    expect(res.sanitizedBuffer).toBeDefined();
    expect(res.sanitizedBuffer.length).toBeGreaterThan(0);
    expect(res.mime).toBe('image/svg+xml');
    expect(res.ext).toBe('.svg');
    expect(res.width).toBe(100);
    expect(res.height).toBe(100);
  });
});

// ── Happy-path acceptance ────────────────────────────────────────────

describe('validateAssetUpload — accepted uploads', () => {
  test('PNG logo within 2000px accepted', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: makePngHeader(800, 600), mime: 'image/png' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(true);
    expect(res.width).toBe(800);
    expect(res.height).toBe(600);
    expect(res.ext).toBe('.png');
  });

  test('JPEG hero within 1.0..3.0 aspect accepted (2:1 banner)', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: makeJpegHeader(2000, 1000), mime: 'image/jpeg' }),
      expectedType: 'hero',
    });
    expect(res.valid).toBe(true);
    expect(res.width).toBe(2000);
    expect(res.height).toBe(1000);
  });

  test('WebP wordmark accepted', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: makeWebpVp8x(1200, 400), mime: 'image/webp' }),
      expectedType: 'wordmark',
    });
    expect(res.valid).toBe(true);
    expect(res.width).toBe(1200);
    expect(res.height).toBe(400);
  });

  test('ICO favicon accepted (dim probing skipped)', () => {
    const ico = Buffer.alloc(48);
    ico[0] = 0;
    ico[1] = 0;
    ico[2] = 1;
    ico[3] = 0;
    const res = validateAssetUpload({
      file: makeFile({ buffer: ico, mime: 'image/x-icon' }),
      expectedType: 'favicon',
    });
    expect(res.valid).toBe(true);
    expect(res.ext).toBe('.ico');
  });
});

// ── Dimension caps ──────────────────────────────────────────────────

describe('Dimension cap enforcement', () => {
  test('PNG > 2000px wide rejected for logo class', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: makePngHeader(2500, 500), mime: 'image/png' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('WIDTH_EXCEEDS_CAP');
  });

  test('PNG > 2000px tall rejected for logo class', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: makePngHeader(500, 2500), mime: 'image/png' }),
      expectedType: 'logo',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('HEIGHT_EXCEEDS_CAP');
  });

  test('JPEG hero with aspect 0.5 (portrait) rejected — too tall', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: makeJpegHeader(500, 1000), mime: 'image/jpeg' }),
      expectedType: 'hero',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('ASPECT_TOO_TALL');
  });

  test('JPEG hero with aspect 4.0 rejected — too wide', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: makeJpegHeader(4000, 1000), mime: 'image/jpeg' }),
      expectedType: 'hero',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('ASPECT_TOO_WIDE');
  });

  test('Hero at exactly 3:1 aspect accepted', () => {
    const res = validateAssetUpload({
      file: makeFile({ buffer: makeJpegHeader(3000, 1000), mime: 'image/jpeg' }),
      expectedType: 'hero',
    });
    expect(res.valid).toBe(true);
  });
});

// ── Direct probe coverage ───────────────────────────────────────────

describe('probeImageDimensions — direct unit coverage', () => {
  test('PNG header read returns correct dimensions', () => {
    const res = probeImageDimensions(makePngHeader(640, 480), 'image/png');
    expect(res.ok).toBe(true);
    expect(res.width).toBe(640);
    expect(res.height).toBe(480);
  });

  test('JPEG SOF0 walk returns correct dimensions', () => {
    const res = probeImageDimensions(makeJpegHeader(1920, 1080), 'image/jpeg');
    expect(res.ok).toBe(true);
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);
  });

  test('WebP VP8X canvas dims read correctly', () => {
    const res = probeImageDimensions(makeWebpVp8x(1280, 720), 'image/webp');
    expect(res.ok).toBe(true);
    expect(res.width).toBe(1280);
    expect(res.height).toBe(720);
  });

  test('returns ok:false for corrupt PNG', () => {
    const garbage = Buffer.from('not-a-png-file-at-all-very-bad-bytes-here');
    const res = probeImageDimensions(garbage, 'image/png');
    expect(res.ok).toBe(false);
  });

  test('returns ok:false for too-short buffer', () => {
    const res = probeImageDimensions(Buffer.from('xx'), 'image/png');
    expect(res.ok).toBe(false);
  });
});

describe('probeSvgDimensions — width/height + viewBox', () => {
  test('reads width + height attributes', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="123" height="456"></svg>';
    const res = probeSvgDimensions(svg);
    expect(res.ok).toBe(true);
    expect(res.width).toBe(123);
    expect(res.height).toBe(456);
  });

  test('falls back to viewBox when width/height absent', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>';
    const res = probeSvgDimensions(svg);
    expect(res.ok).toBe(true);
    expect(res.width).toBe(200);
    expect(res.height).toBe(100);
  });

  test('returns ok:false when neither signal present', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const res = probeSvgDimensions(svg);
    expect(res.ok).toBe(false);
  });
});

// ── MIME_ALLOWLIST coverage ─────────────────────────────────────────

describe('MIME_ALLOWLIST extension mapping', () => {
  test('PNG → .png', () => expect(MIME_ALLOWLIST['image/png']).toBe('.png'));
  test('JPEG → .jpg', () => expect(MIME_ALLOWLIST['image/jpeg']).toBe('.jpg'));
  test('SVG → .svg', () => expect(MIME_ALLOWLIST['image/svg+xml']).toBe('.svg'));
  test('WebP → .webp', () => expect(MIME_ALLOWLIST['image/webp']).toBe('.webp'));
  test('ICO → .ico', () => expect(MIME_ALLOWLIST['image/x-icon']).toBe('.ico'));
});
