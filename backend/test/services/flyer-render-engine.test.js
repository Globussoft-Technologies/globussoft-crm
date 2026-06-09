/**
 * PRD_TRAVEL_MARKETING_FLYER #908 slice S17 — flyerRenderEngine service tests.
 *
 * Unit tests of the multi-format render engine at
 * backend/services/flyerRenderEngine.js. The engine takes a parsed
 * `{ template, data, format }` shape and returns a Promise<{ buffer,
 * mimeType, extension, widthPx, heightPx, engine }>. These tests pin the
 * contract the route layer (POST /api/travel/flyer-templates/:id/render)
 * depends on:
 *
 *   - All 5 supported format strings dispatch correctly:
 *       pdf-a4, pdf-a5, png-square, png-portrait-ig, png-landscape-fb
 *   - Invalid format throws Error with `code='INVALID_FORMAT'` + `status=400`
 *     (route surfaces this as a clean 400 INVALID_FORMAT).
 *   - PDF branch: returns Buffer with %PDF magic bytes, mimeType
 *     'application/pdf', extension 'pdf', engine 'pdfkit'.
 *   - PNG branch (Puppeteer absent — today's state): returns the
 *     deterministic 1×1 stub PNG with the correct mimeType +
 *     `engine: 'stub-1x1'`. Confirms the graceful-degradation contract.
 *   - `data` overrides flow into the layout block content (Hassan
 *     clone-and-tweak flow) — assert via the helper export
 *     `applyDataOverrides` so we're testing the transform without
 *     spelunking inside the PDF/PNG bytes.
 *   - `buildHtmlShellForPng` helper produces a valid HTML5 document
 *     containing the template's title + price + CTA text — the future
 *     Puppeteer-real-render branch loads this exact HTML.
 *
 * Mocking note: Puppeteer is intentionally NOT installed in
 * backend/package.json as of this slice's dispatch. The PNG branch's
 * `tryRequirePuppeteer()` lazy-resolution will return `{ ok: false }`,
 * which is exactly the "stub fallback" path we want to pin. Once
 * Puppeteer lands (deferred slice), a follow-up test extends this file
 * with a `vi.mock('puppeteer', ...)` block that asserts the real
 * branch.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const flyerRenderEngine = requireCJS('../../services/flyerRenderEngine.js');
const {
  renderFlyer,
  SUPPORTED_FORMATS,
  FORMAT_TABLE,
  applyDataOverrides,
  buildHtmlShellForPng,
  STUB_PNG_BUFFER,
  _resetPuppeteerCacheForTests,
} = flyerRenderEngine;

const validPalette = {
  primaryHex: '#122647',
  secondaryHex: '#C89A4E',
  accentHex: '#F5E6CC',
  textHex: '#1A1A1A',
  bgHex: '#FFFFFF',
};
const validLayout = [
  { type: 'logo', x: 20, y: 20, width: 120, height: 60, src: 'https://cdn.example/logo.png' },
  { type: 'text', x: 20, y: 100, width: 400, height: 40, content: 'Summer Umrah 2026' },
  { type: 'price', x: 20, y: 500, width: 200, height: 40, content: '₹ 1,29,000 per person' },
  { type: 'cta', x: 20, y: 600, width: 200, height: 50, content: 'Book Now', href: 'https://example.com/book' },
];
const validAssets = {
  logo: 'https://cdn.example/logo.png',
  hero: 'https://cdn.example/hero.jpg',
};
const fullTemplate = { palette: validPalette, layout: validLayout, assets: validAssets };

// PDF magic bytes: %PDF (0x25 0x50 0x44 0x46) at file start.
function isPdfMagic(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 4 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46
  );
}

// PNG magic bytes: \x89PNG\r\n\x1a\n at file start.
function isPngMagic(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  );
}

beforeEach(() => {
  // Each test starts with a fresh puppeteer-resolution lookup so we're
  // not bleeding cache between cases.
  _resetPuppeteerCacheForTests();
});

describe('module shape', () => {
  test('exports renderFlyer + format metadata', () => {
    expect(typeof renderFlyer).toBe('function');
    expect(Array.isArray(SUPPORTED_FORMATS)).toBe(true);
    expect(typeof FORMAT_TABLE).toBe('object');
  });

  test('SUPPORTED_FORMATS contains exactly the 5 slice-S17 formats', () => {
    // SUPPORTED_FORMATS is Object.frozen — copy before sorting.
    expect([...SUPPORTED_FORMATS].sort()).toEqual(
      ['pdf-a4', 'pdf-a5', 'png-landscape-fb', 'png-portrait-ig', 'png-square']
    );
  });

  test('FORMAT_TABLE has the correct mime + dimensions per format', () => {
    expect(FORMAT_TABLE['pdf-a4'].mimeType).toBe('application/pdf');
    expect(FORMAT_TABLE['pdf-a4'].extension).toBe('pdf');
    expect(FORMAT_TABLE['pdf-a5'].mimeType).toBe('application/pdf');
    expect(FORMAT_TABLE['pdf-a5'].extension).toBe('pdf');

    expect(FORMAT_TABLE['png-square'].mimeType).toBe('image/png');
    expect(FORMAT_TABLE['png-square'].extension).toBe('png');
    expect(FORMAT_TABLE['png-square'].widthPx).toBe(1200);
    expect(FORMAT_TABLE['png-square'].heightPx).toBe(1200);

    expect(FORMAT_TABLE['png-portrait-ig'].widthPx).toBe(1080);
    expect(FORMAT_TABLE['png-portrait-ig'].heightPx).toBe(1920);

    expect(FORMAT_TABLE['png-landscape-fb'].widthPx).toBe(1920);
    expect(FORMAT_TABLE['png-landscape-fb'].heightPx).toBe(1080);
  });
});

describe('renderFlyer — invalid format handling', () => {
  test('throws INVALID_FORMAT for an unrecognised string', async () => {
    let err = null;
    try {
      await renderFlyer({ template: fullTemplate, format: 'gif-animated' });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe('INVALID_FORMAT');
    expect(err.status).toBe(400);
    expect(err.message).toContain('format must be one of');
  });

  test('throws INVALID_FORMAT when format is missing', async () => {
    let err = null;
    try {
      await renderFlyer({ template: fullTemplate });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe('INVALID_FORMAT');
    expect(err.status).toBe(400);
  });

  test('throws INVALID_FORMAT when format is non-string', async () => {
    let err = null;
    try {
      await renderFlyer({ template: fullTemplate, format: 42 });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe('INVALID_FORMAT');
  });

  test('throws INVALID_FORMAT when invoked with no args', async () => {
    let err = null;
    try {
      await renderFlyer();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe('INVALID_FORMAT');
  });
});

describe('renderFlyer — pdf-a4 format', () => {
  test('returns a valid PDF buffer with pdfkit engine label', async () => {
    const result = await renderFlyer({ template: fullTemplate, format: 'pdf-a4' });
    expect(result.mimeType).toBe('application/pdf');
    expect(result.extension).toBe('pdf');
    expect(result.engine).toBe('pdfkit');
    expect(isPdfMagic(result.buffer)).toBe(true);
    // pdfkit's xref table + default font subset alone push past 500 bytes.
    expect(result.buffer.length).toBeGreaterThan(500);
    // PDF outputs do NOT advertise pixel dimensions.
    expect(result.widthPx).toBeNull();
    expect(result.heightPx).toBeNull();
  });

  test('still renders a valid PDF even with an empty template', async () => {
    const result = await renderFlyer({ template: {}, format: 'pdf-a4' });
    expect(isPdfMagic(result.buffer)).toBe(true);
  });
});

describe('renderFlyer — pdf-a5 format', () => {
  test('returns a valid PDF buffer with pdfkit engine label', async () => {
    const result = await renderFlyer({ template: fullTemplate, format: 'pdf-a5' });
    expect(result.mimeType).toBe('application/pdf');
    expect(result.extension).toBe('pdf');
    expect(result.engine).toBe('pdfkit');
    expect(isPdfMagic(result.buffer)).toBe(true);
    expect(result.widthPx).toBeNull();
    expect(result.heightPx).toBeNull();
  });
});

describe('renderFlyer — png-square format (Puppeteer absent → stub fallback)', () => {
  test('returns the deterministic 1×1 stub PNG when Puppeteer is not installed', async () => {
    const result = await renderFlyer({ template: fullTemplate, format: 'png-square' });
    expect(result.mimeType).toBe('image/png');
    expect(result.extension).toBe('png');
    // Puppeteer is NOT in package.json as of slice S17 — fallback branch.
    expect(result.engine).toBe('stub-1x1');
    expect(isPngMagic(result.buffer)).toBe(true);
    // Stub PNG should match the canonical buffer byte-for-byte (deterministic).
    expect(Buffer.compare(result.buffer, STUB_PNG_BUFFER)).toBe(0);
    expect(result.widthPx).toBe(1200);
    expect(result.heightPx).toBe(1200);
  });
});

describe('renderFlyer — png-portrait-ig format', () => {
  test('returns stub PNG with 1080×1920 advertised dimensions', async () => {
    const result = await renderFlyer({ template: fullTemplate, format: 'png-portrait-ig' });
    expect(result.mimeType).toBe('image/png');
    expect(result.engine).toBe('stub-1x1');
    expect(isPngMagic(result.buffer)).toBe(true);
    expect(result.widthPx).toBe(1080);
    expect(result.heightPx).toBe(1920);
  });
});

describe('renderFlyer — png-landscape-fb format', () => {
  test('returns stub PNG with 1920×1080 advertised dimensions', async () => {
    const result = await renderFlyer({ template: fullTemplate, format: 'png-landscape-fb' });
    expect(result.mimeType).toBe('image/png');
    expect(result.engine).toBe('stub-1x1');
    expect(isPngMagic(result.buffer)).toBe(true);
    expect(result.widthPx).toBe(1920);
    expect(result.heightPx).toBe(1080);
  });
});

describe('applyDataOverrides — Hassan clone-and-tweak transform', () => {
  test('priceOverride replaces the first price block content', () => {
    const updated = applyDataOverrides(fullTemplate, { priceOverride: '₹78,000' });
    const priceBlock = updated.layout.find((b) => b.type === 'price');
    expect(priceBlock.content).toBe('₹78,000');
    // Original is untouched (no mutation).
    const originalPrice = fullTemplate.layout.find((b) => b.type === 'price');
    expect(originalPrice.content).toBe('₹ 1,29,000 per person');
  });

  test('titleOverride replaces the first text block content', () => {
    const updated = applyDataOverrides(fullTemplate, { titleOverride: 'Ramadan Umrah Special' });
    const titleBlock = updated.layout.find((b) => b.type === 'text');
    expect(titleBlock.content).toBe('Ramadan Umrah Special');
  });

  test('ctaOverride replaces the first cta block content', () => {
    const updated = applyDataOverrides(fullTemplate, { ctaOverride: 'Reserve Your Spot' });
    const ctaBlock = updated.layout.find((b) => b.type === 'cta');
    expect(ctaBlock.content).toBe('Reserve Your Spot');
  });

  test('dateOverride appends to the existing title with em-dash', () => {
    const updated = applyDataOverrides(fullTemplate, { dateOverride: 'May 18' });
    const titleBlock = updated.layout.find((b) => b.type === 'text');
    expect(titleBlock.content).toBe('Summer Umrah 2026 — May 18');
  });

  test('titleOverride + dateOverride together compose correctly', () => {
    const updated = applyDataOverrides(fullTemplate, {
      titleOverride: 'Ramadan Umrah',
      dateOverride: 'June 2',
    });
    const titleBlock = updated.layout.find((b) => b.type === 'text');
    expect(titleBlock.content).toBe('Ramadan Umrah — June 2');
  });

  test('missing data leaves template unchanged', () => {
    const updated = applyDataOverrides(fullTemplate, {});
    expect(updated.layout).toEqual(fullTemplate.layout);
  });

  test('null data returns the original template', () => {
    const updated = applyDataOverrides(fullTemplate, null);
    expect(updated).toBe(fullTemplate);
  });

  test('unknown override keys are silently ignored (forward-compat)', () => {
    const updated = applyDataOverrides(fullTemplate, { discountBadgeOverride: '25% off' });
    expect(updated.layout).toEqual(fullTemplate.layout);
  });

  test('renderFlyer threads data overrides into the PDF render', async () => {
    // Smoke: renderFlyer with a data block doesn't throw + still produces
    // a valid PDF. Asserting the title text landed IN the PDF bytes
    // would require a PDF parser dep; the unit test for the transform
    // itself lives above.
    const result = await renderFlyer({
      template: fullTemplate,
      data: { priceOverride: '₹78,000', dateOverride: 'May 18' },
      format: 'pdf-a4',
    });
    expect(isPdfMagic(result.buffer)).toBe(true);
  });
});

describe('buildHtmlShellForPng — the future Puppeteer-real-render document', () => {
  test('builds a valid HTML5 document at the requested dimensions', () => {
    const html = buildHtmlShellForPng(fullTemplate, 1200, 1200);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html>');
    expect(html).toContain('</html>');
    expect(html).toContain('width: 1200px');
    expect(html).toContain('height: 1200px');
  });

  test('embeds the template title + price + CTA text', () => {
    const html = buildHtmlShellForPng(fullTemplate, 1080, 1920);
    expect(html).toContain('Summer Umrah 2026');
    expect(html).toContain('Book Now');
    expect(html).toContain('1,29,000');
  });

  test('uses primary palette colour for the strip + CTA backgrounds', () => {
    const html = buildHtmlShellForPng(fullTemplate, 1200, 1200);
    expect(html).toContain('#122647');
  });

  test('escapes HTML special characters in text content', () => {
    const evilTemplate = {
      ...fullTemplate,
      layout: [
        { type: 'text', content: '<script>alert(1)</script>' },
        { type: 'price', content: '₹100 & up' },
        { type: 'cta', content: '"Click"' },
      ],
    };
    const html = buildHtmlShellForPng(evilTemplate, 1200, 1200);
    // <script> tag from content must be encoded, not rendered as a real tag.
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  test('renders a readable shell when palette / layout / assets are missing', () => {
    const html = buildHtmlShellForPng({}, 1200, 1200);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('Untitled Flyer');
    expect(html).toContain('Price on request');
    expect(html).toContain('Book Now');
  });
});
