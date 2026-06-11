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
 *   - PNG branch (Puppeteer mocked): returns the screenshot buffer
 *     produced by puppeteer.launch().newPage().screenshot(), tagged
 *     `engine: 'puppeteer'`. The real Chrome launch is replaced by
 *     `vi.mock('puppeteer', ...)` so tests stay fast + hermetic.
 *   - `data` overrides flow into the layout block content (Hassan
 *     clone-and-tweak flow) — assert via the helper export
 *     `applyDataOverrides` so we're testing the transform without
 *     spelunking inside the PDF/PNG bytes.
 *   - `buildHtmlShellForPng` helper produces a valid HTML5 document
 *     containing absolute-positioned blocks scaled from the editor's
 *     540×720 canvas to the requested output dimensions.
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest';

// Mocking strategy — dependency-injection via _setPuppeteerImplForTests.
//
// Puppeteer v25 exports are ESM-frozen + non-configurable, so the usual
// require-cache monkey-patch (used elsewhere for @google/generative-ai
// in test/cron/leadScoringEngine.test.js) throws "Cannot redefine
// property". And vi.mock('puppeteer', factory) is silently bypassed by
// the SUT's CJS `require('puppeteer')` in this vitest setup. So the
// service exposes a `_setPuppeteerImplForTests({ launch })` hook —
// tests install a fake before exercising renderFlyer; production code
// uses the lazy `require('puppeteer')` default.
const puppeteerMockState = {
  screenshotBuffer: null,
  lastViewport: null,
  lastHtml: null,
  lastWaitUntil: null,
  launchArgs: null,
  closeCount: 0,
  launchShouldThrow: null,
};

const { createRequire } = await import('node:module');
const requireCJS = createRequire(import.meta.url);
const flyerRenderEngine = requireCJS('../../services/flyerRenderEngine.js');
const {
  renderFlyer,
  SUPPORTED_FORMATS,
  FORMAT_TABLE,
  applyDataOverrides,
  buildHtmlShellForPng,
  _setPuppeteerImplForTests,
} = flyerRenderEngine;

// Install the fake puppeteer impl that records call args + returns the
// configured screenshot buffer. Real Chrome is never launched.
_setPuppeteerImplForTests({
  launch: async (args) => {
    if (puppeteerMockState.launchShouldThrow) {
      const e = puppeteerMockState.launchShouldThrow;
      puppeteerMockState.launchShouldThrow = null;
      throw e;
    }
    puppeteerMockState.launchArgs = args;
    return {
      newPage: async () => ({
        setViewport: async (vp) => { puppeteerMockState.lastViewport = vp; },
        setContent: async (html, opts) => {
          puppeteerMockState.lastHtml = html;
          puppeteerMockState.lastWaitUntil = opts && opts.waitUntil;
        },
        screenshot: async () => puppeteerMockState.screenshotBuffer,
      }),
      close: async () => { puppeteerMockState.closeCount += 1; },
    };
  },
});

afterAll(() => {
  // Restore the lazy default so any later tests in the same process
  // (or a watch-mode re-run) get real puppeteer back.
  _setPuppeteerImplForTests(null);
});

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

// Hand-built minimal-valid PNG (the well-known 67-byte 1×1 transparent
// pixel). Used as the mocked Chrome screenshot buffer so the assertion
// surface is "engine returned what Chrome handed back", not the bytes.
const MOCK_PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

beforeEach(() => {
  puppeteerMockState.screenshotBuffer = MOCK_PNG_BUFFER;
  puppeteerMockState.lastViewport = null;
  puppeteerMockState.lastHtml = null;
  puppeteerMockState.lastWaitUntil = null;
  puppeteerMockState.launchArgs = null;
  puppeteerMockState.closeCount = 0;
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

  test('S75 — pdf-a5 produces a different byte stream than pdf-a4 (real A5 page size)', async () => {
    // Pre-S75 carry-over: flyerRenderEngine passed `aspect: 'a4'` for
    // BOTH pdf-a4 and pdf-a5, so the two formats returned identical PDFs
    // modulo non-determinism in the ISO timestamp footer. After S75, the
    // engine's renderPdfBranch maps formatMeta.pdfPageSize → lib aspect
    // verbatim (A4→a4, A5→a5, LETTER→us_letter), so pdf-a5 truly renders
    // at A5 dimensions. Pin via byte-stream inequality.
    const a4 = await renderFlyer({ template: fullTemplate, format: 'pdf-a4' });
    const a5 = await renderFlyer({ template: fullTemplate, format: 'pdf-a5' });
    expect(a4.buffer.equals(a5.buffer)).toBe(false);
  });
});

describe('renderFlyer — png-square format (Puppeteer mocked)', () => {
  test('launches Chrome, screenshots at 1200×1200, returns engine=puppeteer', async () => {
    const result = await renderFlyer({ template: fullTemplate, format: 'png-square' });
    expect(result.mimeType).toBe('image/png');
    expect(result.extension).toBe('png');
    expect(result.engine).toBe('puppeteer');
    // The buffer is whatever Chrome's page.screenshot() returned — the
    // mock hands back a valid PNG with magic bytes.
    expect(isPngMagic(result.buffer)).toBe(true);
    expect(result.widthPx).toBe(1200);
    expect(result.heightPx).toBe(1200);
    // Viewport matches output dimensions, so the screenshot fills the page.
    expect(puppeteerMockState.lastViewport).toEqual({
      width: 1200,
      height: 1200,
      deviceScaleFactor: 1,
    });
    // setContent waited for networkidle0 — pinned so DALL-E / uploaded
    // image URLs get loaded before the screenshot fires.
    expect(puppeteerMockState.lastWaitUntil).toBe('networkidle0');
    // HTML payload contains the operator's title text.
    expect(puppeteerMockState.lastHtml).toContain('Summer Umrah 2026');
    // Browser was closed exactly once — no leaked Chrome process.
    expect(puppeteerMockState.closeCount).toBe(1);
  });
});

describe('renderFlyer — png-portrait-ig format', () => {
  test('viewport is 1080×1920 and engine=puppeteer', async () => {
    const result = await renderFlyer({ template: fullTemplate, format: 'png-portrait-ig' });
    expect(result.mimeType).toBe('image/png');
    expect(result.engine).toBe('puppeteer');
    expect(isPngMagic(result.buffer)).toBe(true);
    expect(result.widthPx).toBe(1080);
    expect(result.heightPx).toBe(1920);
    expect(puppeteerMockState.lastViewport).toEqual({
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1,
    });
  });
});

describe('renderFlyer — png-landscape-fb format', () => {
  test('viewport is 1920×1080 and engine=puppeteer', async () => {
    const result = await renderFlyer({ template: fullTemplate, format: 'png-landscape-fb' });
    expect(result.mimeType).toBe('image/png');
    expect(result.engine).toBe('puppeteer');
    expect(isPngMagic(result.buffer)).toBe(true);
    expect(result.widthPx).toBe(1920);
    expect(result.heightPx).toBe(1080);
    expect(puppeteerMockState.lastViewport).toEqual({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    });
  });
});

describe('renderFlyer — Chrome-launch failure surfaces as a real error', () => {
  test('puppeteer.launch rejection bubbles up (no stub fallback)', async () => {
    puppeteerMockState.launchShouldThrow = new Error('Chrome binary not found');
    let err = null;
    try {
      await renderFlyer({ template: fullTemplate, format: 'png-square' });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.message).toContain('Chrome binary not found');
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

describe('buildHtmlShellForPng — Chrome-rendered document', () => {
  test('builds a valid HTML5 document at the requested dimensions', () => {
    const html = buildHtmlShellForPng(fullTemplate, 1200, 1200);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html>');
    expect(html).toContain('</html>');
    expect(html).toContain('width: 1200px');
    expect(html).toContain('height: 1200px');
  });

  test('embeds the template title text inside an absolute-positioned block', () => {
    const html = buildHtmlShellForPng(fullTemplate, 1080, 1920);
    expect(html).toContain('Summer Umrah 2026');
    expect(html).toContain('Book Now');
    expect(html).toContain('1,29,000');
    // Absolute positioning is the contract — operator's composition
    // lands at the same proportional positions in the output.
    expect(html).toContain('position:absolute');
  });

  test('scales block x/y from editor canvas (540×720) to output dimensions', () => {
    // A block at canvas position (x=20, y=100) renders at:
    //   left = round(20 * 1080/540)  = 40
    //   top  = round(100 * 1920/720) = 267
    // (using png-portrait-ig dimensions for clean integer math).
    const html = buildHtmlShellForPng(fullTemplate, 1080, 1920);
    expect(html).toContain('left:40px');
    expect(html).toContain('top:267px');
  });

  test('renders image blocks as <img> with object-fit:cover', () => {
    const tpl = {
      palette: validPalette,
      layout: [
        { type: 'image', x: 24, y: 24, width: 320, height: 320, src: 'https://cdn.example/bali.jpg' },
      ],
    };
    const html = buildHtmlShellForPng(tpl, 1200, 1200);
    expect(html).toContain('<img');
    expect(html).toContain('https://cdn.example/bali.jpg');
    expect(html).toContain('object-fit:cover');
  });

  test('uses primary palette colour in the body styling', () => {
    const html = buildHtmlShellForPng(fullTemplate, 1200, 1200);
    expect(html).toContain('#122647');
  });

  test('escapes HTML special characters in text content', () => {
    const evilTemplate = {
      ...fullTemplate,
      layout: [
        { type: 'text', x: 10, y: 10, width: 100, height: 30, content: '<script>alert(1)</script>' },
        { type: 'price', x: 10, y: 50, width: 100, height: 30, content: '₹100 & up' },
        { type: 'cta', x: 10, y: 100, width: 100, height: 30, content: '"Click"' },
      ],
    };
    const html = buildHtmlShellForPng(evilTemplate, 1200, 1200);
    // <script> tag from content must be encoded, not rendered as a real tag.
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  test('renders a readable shell when palette / layout are missing', () => {
    const html = buildHtmlShellForPng({}, 1200, 1200);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    // Empty layout still produces a valid body (just the page background).
    expect(html).toContain('<body');
    expect(html).toContain('</body>');
  });

  test('drops image blocks with no src (no broken <img> tags)', () => {
    const tpl = {
      palette: validPalette,
      layout: [
        { type: 'image', x: 10, y: 10, width: 100, height: 100, src: '' },
      ],
    };
    const html = buildHtmlShellForPng(tpl, 1200, 1200);
    expect(html).not.toContain('<img');
  });
});
