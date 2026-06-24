// @ts-check
/**
 * Arc 2 #902 slice 9 — quote PDF surfaces SAC codes + GST split + HSN summary.
 *
 * Pins `services/pdfRenderer.js#generateTravelQuotePdf` (alias for
 * `renderTravelQuotePdf`) extension that:
 *   1) Adds per-line SAC code (sourced from
 *      `lib/hsnSacMapper.js::sacForLineType`) into the line-items
 *      table. Mirrors invoice slice 8 (commit `a81da046`).
 *   2) Adds per-line CGST/SGST/IGST GST-split annotation (sourced from
 *      `lib/gstCalculation.js::computeGstSplit`). Intra-state default
 *      (`placeOfSupplyInterstate=false`) renders "9+9% CGST/SGST" for
 *      an 18% slab; `placeOfSupplyInterstate=true` renders "18% IGST".
 *   3) Adds an HSN/SAC summary block under the totals row, grouped
 *      via `groupLinesBySac()`. Tax/fee/TCS/TDS lines (whose lineType
 *      returns null from `sacForLineType`) are excluded.
 *   4) Empty-lines quote → no SAC / GST sections rendered (clean
 *      output).
 *
 * Mirrors `extractPdfText` from travel-invoice-pdf-sac-gst.test.js —
 * the canonical pdfkit FlateDecode-decoder pattern in this repo.
 *
 * The renderer accepts BOTH legacy `q.items` (qty + totalPrice keys)
 * AND Prisma-hydrated `q.lines` (quantity + amount keys). Slice 9
 * also adds a per-line `lineType` + `gstPercent` + `taxableValue`
 * shim — items without these defaults gracefully (lineType `null` →
 * SAC `null`, gstPercent `0` → no GST annotation).
 *
 * Run: `cd backend && npx vitest run test/services/travel-quote-pdf-sac-gst.test.js`
 */

import { describe, test, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

// CJS-loader require — see travel-invoice-pdf-sac-gst.test.js for the
// CJS self-mocking-seam rationale (vi.spyOn on the exports surface
// only intercepts when the test holds the same object identity the
// SUT bound at require-time).
const requireFromHere = createRequire(import.meta.url);
const pdfR = requireFromHere('../../services/pdfRenderer.js');
const hsnSacMapper = requireFromHere('../../lib/hsnSacMapper.js');
const gstCalculation = requireFromHere('../../lib/gstCalculation.js');

const { generateTravelQuotePdf } = pdfR;

// ── Helpers ─────────────────────────────────────────────────────────

function extractPdfText(buf) {
  const str = buf.toString('latin1');
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  let allOps = '';
  while ((m = streamRe.exec(str)) !== null) {
    const raw = Buffer.from(m[1], 'latin1');
    try {
      allOps += zlib.inflateSync(raw).toString('latin1');
    } catch {
      allOps += raw.toString('latin1');
    }
  }
  let out = '';
  const tjArrayRe = /\[([^\]]*)\]\s*TJ/g;
  let s;
  while ((s = tjArrayRe.exec(allOps)) !== null) {
    const inner = s[1];
    const hexRe = /<([0-9a-fA-F\s]+)>/g;
    let h;
    while ((h = hexRe.exec(inner)) !== null) {
      const hex = h[1].replace(/\s+/g, '');
      for (let i = 0; i + 1 < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      }
    }
    out += ' ';
  }
  const tjLiteralRe = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  while ((s = tjLiteralRe.exec(allOps)) !== null) {
    out += s[1].replace(/\\(.)/g, '$1') + ' ';
  }
  return out;
}

function quoteFixture(overrides = {}) {
  return {
    id: 99,
    quoteNumber: 'TQ-2026-0099',
    subBrand: 'tmc',
    customerName: 'Anita Roy',
    customerEmail: 'anita@example.com',
    status: 'Sent',
    issuedDate: new Date('2026-05-25T10:00:00Z'),
    validUntil: new Date('2026-06-25T10:00:00Z'),
    currency: 'INR',
    taxTreatment: 'exclusive',
    placeOfSupplyInterstate: false,
    ...overrides,
  };
}

function sacItemMix() {
  // Mix of SAC-bearing line types + a non-SAC tax line + a non-SAC
  // fee line. Helps prove the HSN summary excludes the latter two.
  // Uses the legacy quote-item shape (qty + totalPrice) PLUS the new
  // lineType + gstPercent + taxableValue fields slice 9 reads.
  return [
    {
      description: 'Hotel room — 2 nights',
      lineType: 'hotel', qty: 2, unitPrice: 7500, totalPrice: 15000,
      taxableValue: 15000, gstPercent: 12,
    },
    {
      description: 'Flight DEL-BKK',
      lineType: 'flight', qty: 1, unitPrice: 25000, totalPrice: 25000,
      taxableValue: 25000, gstPercent: 5,
    },
    {
      description: 'TCS @ 5% (LRS)',
      lineType: 'tcs', qty: 1, unitPrice: 2000, totalPrice: 2000,
      taxableValue: 2000, gstPercent: 0,
    },
    {
      description: 'Convenience fee',
      lineType: 'fee', qty: 1, unitPrice: 500, totalPrice: 500,
      taxableValue: 500, gstPercent: 0,
    },
  ];
}

// ── Tests ───────────────────────────────────────────────────────────

describe('renderTravelQuotePdf — slice 9: SAC + GST split + HSN summary', () => {
  test('per-line SAC code "9963" appears for a hotel line', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({
      items: [
        {
          description: 'Hotel — Deluxe',
          lineType: 'hotel', qty: 1, unitPrice: 8000, totalPrice: 8000,
          taxableValue: 8000, gstPercent: 12,
        },
      ],
    }));
    const text = extractPdfText(buf);
    expect(text).toMatch(/9963/);
    expect(text).toMatch(/Hotel/);
  });

  test('per-line SAC code "9964" appears for a flight line', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({
      items: [
        {
          description: 'Flight ticket DEL-BKK',
          lineType: 'flight', qty: 1, unitPrice: 25000, totalPrice: 25000,
          taxableValue: 25000, gstPercent: 5,
        },
      ],
    }));
    const text = extractPdfText(buf);
    expect(text).toMatch(/9964/);
    expect(text).toMatch(/Flight/);
  });

  test('CGST/SGST annotation appears in intra-state mode (default)', async () => {
    // Intra-state default: placeOfSupplyInterstate=false. An 18% slab
    // splits as 9% CGST + 9% SGST, surfaced in the GST cell.
    const buf = await generateTravelQuotePdf(quoteFixture({
      placeOfSupplyInterstate: false,
      items: [
        {
          description: 'Tour package',
          lineType: 'tour_package', qty: 1, unitPrice: 10000, totalPrice: 10000,
          taxableValue: 10000, gstPercent: 18,
        },
      ],
    }));
    const text = extractPdfText(buf);
    expect(text).toMatch(/CGST/);
    expect(text).toMatch(/SGST/);
  });

  test('IGST annotation appears when quote.placeOfSupplyInterstate=true', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({
      placeOfSupplyInterstate: true,
      items: [
        {
          description: 'Visa service',
          lineType: 'visa', qty: 1, unitPrice: 4000, totalPrice: 4000,
          taxableValue: 4000, gstPercent: 18,
        },
      ],
    }));
    const text = extractPdfText(buf);
    expect(text).toMatch(/IGST/);
    // Inter-state mode does NOT emit the combined CGST/SGST annotation.
    expect(text).not.toMatch(/CGST\/SGST/);
  });

  test('HSN/SAC summary section renders below totals', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({
      items: sacItemMix(),
    }));
    const text = extractPdfText(buf);
    // Heading renders as "HSN / SAC Summary" (spaced) after the quote-PDF
    // restyle — tolerate optional spacing around the slash.
    expect(text).toMatch(/HSN ?\/ ?SAC Summary/);
  });

  test('HSN/SAC summary shows rate buckets in "SAC / RATE%" form', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({
      items: sacItemMix(),
    }));
    const text = extractPdfText(buf);
    // Hotel = SAC 9963 @ 12%, Flight = SAC 9964 @ 5%. SAC + RATE now render in
    // their own summary columns (the combined "SAC / RATE%" sub-caption was
    // dropped in the compact-to-one-page redesign).
    expect(text).toMatch(/9963/);
    expect(text).toMatch(/12%/);
    expect(text).toMatch(/9964/);
    expect(text).toMatch(/5%/);
  });

  test('tax / fee / TCS lines excluded from HSN/SAC summary (lib null-SAC filter)', async () => {
    // Direct helper call — same fixture, prove the lib filters first.
    const summary = hsnSacMapper.groupLinesBySac(sacItemMix());
    expect(summary).toHaveLength(2);
    expect(summary.map((r) => r.sacCode).sort()).toEqual(['9963', '9964']);
    // Then prove the renderer doesn't leak "null" / "undefined" SAC
    // tokens into the rendered summary either.
    const buf = await generateTravelQuotePdf(quoteFixture({
      items: sacItemMix(),
    }));
    const text = extractPdfText(buf);
    expect(text).not.toMatch(/null \/ /);
    expect(text).not.toMatch(/undefined \//);
  });

  test('empty-items quote: no HSN/SAC summary section rendered', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({ items: [] }));
    const text = extractPdfText(buf);
    expect(text).not.toMatch(/HSN\/SAC Summary/);
    expect(text).not.toMatch(/9963/);
    expect(text).not.toMatch(/9964/);
  });

  test('rendered buffer is a valid PDF (starts with %PDF- magic)', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({ items: sacItemMix() }));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('rendered buffer size > 2KB for a multi-line GST quote', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({ items: sacItemMix() }));
    expect(buf.length).toBeGreaterThan(2048);
  });

  test('service lineType maps to SAC 9985 (support services to travel)', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({
      items: [
        {
          description: 'Travel concierge service',
          lineType: 'service', qty: 1, unitPrice: 1500, totalPrice: 1500,
          taxableValue: 1500, gstPercent: 18,
        },
      ],
    }));
    const text = extractPdfText(buf);
    expect(text).toMatch(/9985/);
    // Rate renders in the summary's RATE column.
    expect(text).toMatch(/18%/);
  });

  test('visa lineType maps to SAC 9982 (legal and accounting services)', async () => {
    const buf = await generateTravelQuotePdf(quoteFixture({
      items: [
        {
          description: 'Schengen visa application',
          lineType: 'visa', qty: 1, unitPrice: 9000, totalPrice: 9000,
          taxableValue: 9000, gstPercent: 18,
        },
      ],
    }));
    const text = extractPdfText(buf);
    expect(text).toMatch(/9982/);
    expect(text).toMatch(/18%/);
  });

  test('groupLinesBySac is invoked at least once per render', async () => {
    // Spy on the module.exports surface — the renderer indirects via
    // `module.exports.groupLinesBySac(...)` per the CJS self-mocking
    // seam pattern, so spies on the exports surface intercept correctly.
    const spy = vi.spyOn(hsnSacMapper, 'groupLinesBySac');
    try {
      await generateTravelQuotePdf(quoteFixture({ items: sacItemMix() }));
      expect(spy).toHaveBeenCalled();
      // First call's arg should be a non-empty array of line objects.
      const firstCallArg = spy.mock.calls[0][0];
      expect(Array.isArray(firstCallArg)).toBe(true);
      // 4 input items → 4 normalised entries (the helper does the
      // null-SAC filter internally; we feed it everything).
      expect(firstCallArg.length).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  test('isInterstate flag propagates from quote.placeOfSupplyInterstate to computeGstSplit', async () => {
    const spy = vi.spyOn(gstCalculation, 'computeGstSplit');
    try {
      await generateTravelQuotePdf(quoteFixture({
        placeOfSupplyInterstate: true,
        items: [
          {
            description: 'Hotel',
            lineType: 'hotel', qty: 1, unitPrice: 5000, totalPrice: 5000,
            taxableValue: 5000, gstPercent: 12,
          },
        ],
      }));
      expect(spy).toHaveBeenCalled();
      const firstCallArg = spy.mock.calls[0][0];
      expect(firstCallArg.isInterstate).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
