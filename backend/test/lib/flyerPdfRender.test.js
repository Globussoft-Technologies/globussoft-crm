/**
 * PRD_TRAVEL_MARKETING_FLYER #908 slice 11 — flyerPdfRender lib tests.
 *
 * Pure-function tests of the pdfkit-backed renderer at
 * backend/lib/flyerPdfRender.js. The renderer takes a parsed
 * { palette, layout, assets } template shape plus `{ aspect, hash }`
 * opts and returns a Promise<Buffer> — these tests check the contract
 * the route layer relies on:
 *
 *   - Returns a valid PDF Buffer (magic bytes `%PDF`, non-empty).
 *   - Aspect respects the PAPER_SIZES mapping (a4 vs us_letter; we
 *     can't easily inspect pdfkit page-size at the Buffer level without
 *     a real parser, so we assert that different aspects produce
 *     different byte streams — proxy for "size was honoured").
 *   - Malformed/empty templates still render a placeholder PDF rather
 *     than throwing (route layer separately gates malformed templates
 *     via the validator; the renderer's degraded behaviour pins the
 *     "garbage in → readable placeholder out" contract).
 *   - pickBlock unit-tests the layout-block selector (first match by
 *     type, null on miss / non-array input).
 *   - safeHex unit-tests the colour-coercion helper (falls back to
 *     default when input is missing / malformed).
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  renderFlyerPdf,
  pickBlock,
  safeHex,
  DEFAULT_PALETTE,
  PAPER_SIZES,
} = requireCJS('../../lib/flyerPdfRender.js');

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

// PDF magic bytes: %PDF (0x25 0x50 0x44 0x46) at file start.
function isPdfMagic(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 4 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46
  );
}

describe('renderFlyerPdf — happy path + Buffer contract', () => {
  test('returns a Buffer with %PDF magic bytes for a fully-populated template (a4)', async () => {
    const buf = await renderFlyerPdf(
      { palette: validPalette, layout: validLayout, assets: validAssets },
      { aspect: 'a4', hash: 'a'.repeat(64) },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isPdfMagic(buf)).toBe(true);
    // A real PDF body even with minimal content exceeds 500 bytes — the
    // xref table + pdfkit's default font subset alone bloat past that.
    expect(buf.length).toBeGreaterThan(500);
  });

  test('returns a Buffer with %PDF magic bytes for us_letter aspect', async () => {
    const buf = await renderFlyerPdf(
      { palette: validPalette, layout: validLayout, assets: validAssets },
      { aspect: 'us_letter', hash: 'b'.repeat(64) },
    );
    expect(isPdfMagic(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
  });

  test('a4 and us_letter produce different byte streams (page size honoured)', async () => {
    const a4 = await renderFlyerPdf(
      { palette: validPalette, layout: validLayout, assets: validAssets },
      { aspect: 'a4', hash: 'c'.repeat(64) },
    );
    const letter = await renderFlyerPdf(
      { palette: validPalette, layout: validLayout, assets: validAssets },
      { aspect: 'us_letter', hash: 'c'.repeat(64) },
    );
    expect(a4.equals(letter)).toBe(false);
  });

  test('unknown aspect folds to a4 (no throw, valid PDF)', async () => {
    const buf = await renderFlyerPdf(
      { palette: validPalette, layout: validLayout, assets: validAssets },
      { aspect: 'square', hash: 'd'.repeat(64) },
    );
    // Renderer doesn't reject unknown aspect — route layer validates
    // upstream. Degraded behaviour pin: still produces a valid PDF.
    expect(isPdfMagic(buf)).toBe(true);
  });
});

describe('renderFlyerPdf — degraded inputs', () => {
  test('empty template (no palette / layout / assets) still renders a placeholder PDF', async () => {
    const buf = await renderFlyerPdf({}, { aspect: 'a4' });
    expect(isPdfMagic(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
  });

  test('null template renders a placeholder PDF (degraded)', async () => {
    const buf = await renderFlyerPdf(null, { aspect: 'a4' });
    expect(isPdfMagic(buf)).toBe(true);
  });

  test('opts omitted entirely renders an a4 placeholder PDF', async () => {
    const buf = await renderFlyerPdf({});
    expect(isPdfMagic(buf)).toBe(true);
  });

  test('palette with malformed hex codes folds to defaults (no throw)', async () => {
    const buf = await renderFlyerPdf(
      {
        palette: {
          primaryHex: 'not-a-hex',
          secondaryHex: '##bad##',
          accentHex: '#F5E6CC',
          textHex: null,
          bgHex: 42,
        },
        layout: validLayout,
        assets: validAssets,
      },
      { aspect: 'a4' },
    );
    expect(isPdfMagic(buf)).toBe(true);
  });

  test('layout is a non-array (object) — folds to empty layout, placeholder content', async () => {
    const buf = await renderFlyerPdf(
      { palette: validPalette, layout: { not: 'an array' }, assets: validAssets },
      { aspect: 'a4' },
    );
    expect(isPdfMagic(buf)).toBe(true);
  });
});

describe('pickBlock', () => {
  test('returns the first block matching a given type', () => {
    const layout = [
      { type: 'logo', content: 'l' },
      { type: 'text', content: 'first' },
      { type: 'text', content: 'second' },
    ];
    expect(pickBlock(layout, 'text')).toMatchObject({ content: 'first' });
    expect(pickBlock(layout, 'logo')).toMatchObject({ content: 'l' });
  });

  test('returns null when no block matches', () => {
    expect(pickBlock([{ type: 'logo' }], 'cta')).toBeNull();
  });

  test('returns null when layout is not an array', () => {
    expect(pickBlock(null, 'text')).toBeNull();
    expect(pickBlock(undefined, 'text')).toBeNull();
    expect(pickBlock({}, 'text')).toBeNull();
    expect(pickBlock('layout-string', 'text')).toBeNull();
  });

  test('skips malformed block entries (null/non-object) and matches the next valid one', () => {
    const layout = [null, undefined, 'not-an-object', { type: 'text', content: 'real' }];
    expect(pickBlock(layout, 'text')).toMatchObject({ content: 'real' });
  });
});

describe('safeHex', () => {
  test('passes through a valid hex string verbatim', () => {
    expect(safeHex('#122647', '#000000')).toBe('#122647');
    expect(safeHex('#FFF', '#000000')).toBe('#FFF');
    expect(safeHex('#abcdefab', '#000000')).toBe('#abcdefab');
  });

  test('falls back to the fallback when input is malformed', () => {
    expect(safeHex('not-a-hex', '#000000')).toBe('#000000');
    expect(safeHex('##abc', '#FF0000')).toBe('#FF0000');
    expect(safeHex('122647', '#FF0000')).toBe('#FF0000'); // missing hash
  });

  test('falls back when input is the wrong type', () => {
    expect(safeHex(null, '#000000')).toBe('#000000');
    expect(safeHex(undefined, '#000000')).toBe('#000000');
    expect(safeHex(42, '#000000')).toBe('#000000');
    expect(safeHex({ hex: '#FFFFFF' }, '#000000')).toBe('#000000');
  });
});

describe('module exports', () => {
  test('exports DEFAULT_PALETTE as the wellness-vertical fallback palette', () => {
    expect(DEFAULT_PALETTE).toMatchObject({
      primaryHex: expect.stringMatching(/^#[0-9A-Fa-f]{3,8}$/),
      secondaryHex: expect.stringMatching(/^#[0-9A-Fa-f]{3,8}$/),
    });
    // Frozen — callers can't mutate the default by accident.
    expect(Object.isFrozen(DEFAULT_PALETTE)).toBe(true);
  });

  test('exports PAPER_SIZES mapping aspect → pdfkit token', () => {
    expect(PAPER_SIZES).toMatchObject({ a4: 'A4', us_letter: 'LETTER' });
  });
});
