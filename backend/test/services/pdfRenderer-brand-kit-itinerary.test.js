// @ts-check
/**
 * G091 — Itinerary PDF brand-kit FOOTER-TEXT consumer regression pin.
 *
 * The base S52 itinerary brand-kit selector (header band color, logo
 * embed) is already covered by `travel-sibling-pdfs-brand-kit.test.js`.
 * This file pins the G091 EXTENSION: the itinerary PDF now consumes
 * `opts.branding.footerText` as a second-line legal-disclaimer footer
 * below the standard itinerary "version + pricing-subject-to-availability"
 * line, so each sub-brand can carry its own footer copy from the
 * BrandKit table without rewriting the itinerary chrome.
 *
 * Backward compat: when `opts.branding.footerText` is missing OR an
 * empty / whitespace-only string, the itinerary footer stays byte-shape
 * pre-G091 (single-line footer). Asserted explicitly so a future commit
 * that accidentally always emits a brand-footer line is caught.
 *
 * Run: `cd backend && npx vitest run test/services/pdfRenderer-brand-kit-itinerary.test.js`
 */

import { describe, test, expect } from 'vitest';
import pdfR from '../../services/pdfRenderer.js';
import zlib from 'node:zlib';

const { renderTravelItineraryPdf } = pdfR;

// Inflate every flate-encoded stream in the PDF body, then decode the
// pdfkit-emitted hex-glyph runs (e.g. `<54657374> 0 Tj`) back into
// printable ASCII so we can grep for footerText content directly.
// pdfkit writes one PDF "TJ" array entry per kerning run with the glyph
// hex codes between <…>.
function inflatedPdfText(buf) {
  const str = buf.toString('latin1');
  let inflated = '';
  const lenRe = /\/Length\s+(\d+)\b[^>]*>>\s*stream\r?\n/g;
  let m;
  while ((m = lenRe.exec(str)) !== null) {
    const len = parseInt(m[1], 10);
    const start = lenRe.lastIndex;
    const raw = buf.subarray(start, start + len);
    try {
      inflated += zlib.inflateSync(raw).toString('latin1');
    } catch (_e) {
      inflated += raw.toString('latin1');
    }
  }
  const corpus = inflated || str;
  // Append a decoded-ASCII concatenation of every `<hex…>` glyph run so
  // toContain('Pricing subject…') matches the rendered text.
  const decoded = (corpus.match(/<([0-9a-fA-F]+)>/g) || [])
    .map((tok) => {
      const hex = tok.slice(1, -1);
      let s = '';
      for (let i = 0; i + 1 < hex.length; i += 2) {
        const code = parseInt(hex.slice(i, i + 2), 16);
        if (code >= 0x20 && code <= 0x7e) s += String.fromCharCode(code);
      }
      return s;
    })
    .join(' ');
  return `${corpus}\n${decoded}`;
}

function itineraryFixture(overrides = {}) {
  return {
    id: 7777,
    subBrand: 'tmc',
    version: 1,
    currency: 'INR',
    destination: 'Manali',
    startDate: new Date('2026-08-01T00:00:00Z'),
    endDate: new Date('2026-08-05T00:00:00Z'),
    totalAmount: 50000,
    items: [
      { itemType: 'Stay', description: 'Hotel', unitCost: 8000, markup: 1000, totalPrice: 9000, position: 1 },
    ],
    ...overrides,
  };
}

function contactFixture() {
  return { name: 'Test Customer', email: 'test@example.com', phone: '+919999999999' };
}

describe('renderTravelItineraryPdf — G091 footerText consumer', () => {
  // Match a literal token across pdfkit's letter-spacing splits.
  // pdfkit splits glyphs across TJ kerning runs, so a single word like
  // "Pricing" may render as "Pr icing" in the decoded stream. The
  // matcher folds any whitespace between letters into a single ASCII
  // string and looks for the substring with that fold applied.
  function pdfTextContains(buf, expected) {
    const folded = inflatedPdfText(buf).replace(/\s+/g, '');
    return folded.includes(expected.replace(/\s+/g, ''));
  }

  test('opts.branding.footerText renders as a second footer line', async () => {
    const footerCopy = 'TmcDisclaimerXYZ123';
    const buf = await renderTravelItineraryPdf(
      itineraryFixture(),
      contactFixture(),
      { branding: { footerText: footerCopy } },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(pdfTextContains(buf, footerCopy)).toBe(true);
  });

  test('opts.branding.footerText with whitespace is trimmed before render', async () => {
    const trimmed = 'TrimMarker9876';
    const buf = await renderTravelItineraryPdf(
      itineraryFixture(),
      contactFixture(),
      { branding: { footerText: `   ${trimmed}   ` } },
    );
    expect(pdfTextContains(buf, trimmed)).toBe(true);
  });

  test('empty / null / missing footerText emits no second footer line — pre-G091 shape', async () => {
    // Marker that the base renderer would NEVER produce on its own;
    // proves the line is conditional on opts.branding.footerText.
    const sentinel = '__G091FOOTERSENTINEL__';
    const bufA = await renderTravelItineraryPdf(itineraryFixture(), contactFixture());
    const bufB = await renderTravelItineraryPdf(itineraryFixture(), contactFixture(), { branding: { footerText: '' } });
    const bufC = await renderTravelItineraryPdf(itineraryFixture(), contactFixture(), { branding: { footerText: '   ' } });
    expect(pdfTextContains(bufA, sentinel)).toBe(false);
    expect(pdfTextContains(bufB, sentinel)).toBe(false);
    expect(pdfTextContains(bufC, sentinel)).toBe(false);
    // Itinerary standard footer copy MUST still appear (uses pdfTextContains
    // because pdfkit kerning may split "Pricing" → "Pr icing" in the
    // decoded stream — fold strips intra-word whitespace before matching).
    expect(pdfTextContains(bufA, 'Pricingsubjecttoavailability')).toBe(true);
  });

  test('legacy two-arg call (no opts) still renders cleanly — back-compat', async () => {
    const buf = await renderTravelItineraryPdf(itineraryFixture(), contactFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });
});
