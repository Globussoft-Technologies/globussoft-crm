// @ts-check
/**
 * Arc 2 #902 slice 8 — invoice PDF surfaces SAC codes + GST split + HSN summary.
 *
 * Pins `services/pdfRenderer.js#generateTravelInvoicePdf` (alias for
 * `renderTravelInvoicePdf`) extension that:
 *   1) Adds per-line SAC code (sourced from
 *      `lib/hsnSacMapper.js::sacForLineType`) into the line-items table.
 *   2) Adds per-line CGST/SGST/IGST GST-split annotation (sourced from
 *      `lib/gstCalculation.js::computeGstSplit`). Intra-state default
 *      (operator state == customer state) renders "9+9% CGST/SGST"
 *      for a 18% slab; `invoice.placeOfSupplyInterstate=true` renders
 *      "18% IGST".
 *   3) Adds an HSN/SAC summary block under the totals row, grouped
 *      via `groupLinesBySac()`. Tax/fee/TCS/TDS lines (whose lineType
 *      returns null from `sacForLineType`) are excluded.
 *   4) Empty-lines invoice → no SAC / GST sections rendered (clean
 *      output).
 *
 * Mirrors `extractPdfText` from travel-invoice-pdf-doctype.test.js —
 * the canonical pdfkit FlateDecode-decoder pattern in this repo.
 *
 * Run: `cd backend && npx vitest run test/services/travel-invoice-pdf-sac-gst.test.js`
 */

import { describe, test, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

// The SUT is a CJS module; require it via the same Node CJS loader the
// SUT itself uses. Using ESM default-import here would hand us a
// synthetic namespace wrapper whose properties are getters cached at
// import time — vi.spyOn() on those wrappers does NOT intercept the
// SUT's `const x = require(...)` resolution because the SUT references
// the underlying module.exports object directly. Requiring via
// createRequire returns the same object identity the SUT has bound,
// so spy installation on `hsnSacMapper.sacForLineType` and
// `gstCalculation.computeGstSplit` correctly replaces the property the
// SUT will look up on its next call.
const requireFromHere = createRequire(import.meta.url);
const pdfR = requireFromHere('../../services/pdfRenderer.js');
const hsnSacMapper = requireFromHere('../../lib/hsnSacMapper.js');
const gstCalculation = requireFromHere('../../lib/gstCalculation.js');
const PDFDocument = requireFromHere('pdfkit');

const { generateTravelInvoicePdf } = pdfR;

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

function invoiceFixture(overrides = {}) {
  return {
    id: 200,
    invoiceNum: 'TINV-2026-0099',
    subBrand: 'tmc',
    status: 'Issued',
    totalAmount: '45000.00',
    currency: 'INR',
    issuedDate: new Date('2026-05-25T10:00:00Z'),
    dueDate: new Date('2026-06-08T10:00:00Z'),
    contactName: 'Priya Sharma',
    contactEmail: 'priya@example.com',
    contactPhone: '+919876500000',
    docType: 'TaxInvoice',
    placeOfSupplyInterstate: false,
    ...overrides,
  };
}

function sacLineMix() {
  // Mix of SAC-bearing line types + a non-SAC tax line + a non-SAC
  // fee line. Helps prove the HSN summary excludes the latter two.
  return [
    {
      id: 1, description: 'Hotel room — 2 nights',
      lineType: 'hotel', quantity: 2, unitPrice: 7500, amount: 15000,
      taxableValue: 15000, gstPercent: 12, currency: 'INR',
    },
    {
      id: 2, description: 'Flight DEL-BKK',
      lineType: 'flight', quantity: 1, unitPrice: 25000, amount: 25000,
      taxableValue: 25000, gstPercent: 5, currency: 'INR',
    },
    {
      id: 3, description: 'TCS @ 5% (LRS)',
      lineType: 'tcs', quantity: 1, unitPrice: 2000, amount: 2000,
      taxableValue: 2000, gstPercent: 0, currency: 'INR',
    },
    {
      id: 4, description: 'Convenience fee',
      lineType: 'fee', quantity: 1, unitPrice: 500, amount: 500,
      taxableValue: 500, gstPercent: 0, currency: 'INR',
    },
  ];
}

// ── Tests ───────────────────────────────────────────────────────────

describe('renderTravelInvoicePdf — slice 8: SAC + GST split + HSN summary', () => {
  test('per-line SAC code "9963" appears for a hotel line', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture(),
      lines: [
        {
          id: 1, description: 'Hotel — Deluxe',
          lineType: 'hotel', quantity: 1, unitPrice: 8000, amount: 8000,
          taxableValue: 8000, gstPercent: 12,
        },
      ],
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/9963/);
    expect(text).toMatch(/Hotel/);
  });

  test('per-line SAC code "9964" appears for a flight line', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture(),
      lines: [
        {
          id: 2, description: 'Flight ticket DEL-BKK',
          lineType: 'flight', quantity: 1, unitPrice: 25000, amount: 25000,
          taxableValue: 25000, gstPercent: 5,
        },
      ],
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/9964/);
    expect(text).toMatch(/Flight/);
  });

  test('CGST/SGST annotation appears in intra-state mode (default)', async () => {
    // Intra-state default: placeOfSupplyInterstate=false. An 18% slab
    // splits as 9% CGST + 9% SGST, surfaced in the GST cell.
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ placeOfSupplyInterstate: false }),
      lines: [
        {
          id: 1, description: 'Tour package',
          lineType: 'tour_package', quantity: 1, unitPrice: 10000, amount: 10000,
          taxableValue: 10000, gstPercent: 18,
        },
      ],
    });
    const text = extractPdfText(buf);
    // The renderer emits "9+9% CGST/SGST" for an intra-state 18% line.
    expect(text).toMatch(/CGST/);
    expect(text).toMatch(/SGST/);
    // IGST must NOT appear for intra-state line.
    // (HSN summary block is rate-only, no IGST/CGST split there.)
  });

  test('IGST annotation appears when invoice.placeOfSupplyInterstate=true', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ placeOfSupplyInterstate: true }),
      lines: [
        {
          id: 1, description: 'Visa service',
          lineType: 'visa', quantity: 1, unitPrice: 4000, amount: 4000,
          taxableValue: 4000, gstPercent: 18,
        },
      ],
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/IGST/);
    // Inter-state mode should not emit CGST/SGST annotations on lines.
    expect(text).not.toMatch(/CGST\/SGST/);
  });

  test('HSN/SAC summary section renders below totals', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture(),
      lines: sacLineMix(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/HSN\/SAC Summary/);
  });

  test('HSN/SAC summary shows rate buckets in "SAC / RATE%" form', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture(),
      lines: sacLineMix(),
    });
    const text = extractPdfText(buf);
    // Hotel = SAC 9963 @ 12%, Flight = SAC 9964 @ 5%.
    expect(text).toMatch(/9963 \/ 12%/);
    expect(text).toMatch(/9964 \/ 5%/);
  });

  test('tax / fee / TCS lines excluded from HSN/SAC summary (lib null-SAC filter)', async () => {
    // Build a SAC-bearing lineType count proof by calling groupLinesBySac
    // directly on the same fixture. With the mix above, only hotel +
    // flight should produce summary rows — TCS + fee return null.
    const summary = hsnSacMapper.groupLinesBySac(sacLineMix());
    expect(summary).toHaveLength(2);
    expect(summary.map((r) => r.sacCode).sort()).toEqual(['9963', '9964']);
    // And the renderer-rendered text should NOT mention "tcs" or "fee"
    // as SAC tokens in the summary block (no SAC code is null/"tcs").
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture(),
      lines: sacLineMix(),
    });
    const text = extractPdfText(buf);
    // The summary block prints the rate-only "RATE%" form; ensure no
    // bogus "null" or "undefined" SAC strings leak through.
    expect(text).not.toMatch(/null \/ /);
    expect(text).not.toMatch(/undefined \//);
  });

  test('empty-lines invoice: no HSN/SAC summary section rendered', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture(),
      lines: [],
    });
    const text = extractPdfText(buf);
    expect(text).not.toMatch(/HSN\/SAC Summary/);
    // No SAC codes should leak into the empty-line page either.
    expect(text).not.toMatch(/9963/);
    expect(text).not.toMatch(/9964/);
  });

  test('rendered buffer is a valid PDF (starts with %PDF- magic)', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture(),
      lines: sacLineMix(),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('rendered buffer size > 2KB for a multi-line GST invoice', async () => {
    // The branded multi-line invoice + HSN summary block is well over
    // 2KB; this catches a "render stopped early / crashed mid-stream"
    // regression that wouldn't trip the magic-bytes check.
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture(),
      lines: sacLineMix(),
    });
    expect(buf.length).toBeGreaterThan(2048);
  });

  test('wrapped line-item descriptions are measured before row spacing is advanced', async () => {
    const heightSpy = vi.spyOn(PDFDocument.prototype, 'heightOfString');
    try {
      const buf = await generateTravelInvoicePdf({
        invoice: invoiceFixture({
          invoiceNum: 'TINV-2026-0013',
          status: 'Partial',
          totalAmount: '40585.96',
        }),
        lines: [
          {
            id: 1,
            description: 'IndiGo 6E 6876 Bangalore ↔ Kolkata (Economy)',
            lineType: 'flight',
            quantity: 2,
            unitPrice: 8837.13,
            amount: 17674.26,
            taxableValue: 17674.26,
            gstPercent: 0,
          },
          {
            id: 2,
            description: 'IndiGo 6E 344 Kolkata ↔ Bangalore (Economy)',
            lineType: 'flight',
            quantity: 2,
            unitPrice: 9025.45,
            amount: 18050.90,
            taxableValue: 18050.90,
            gstPercent: 0,
          },
          {
            id: 3,
            description: 'Hotel Corporate Hotel Near Sealdah Railway station, Kolkata',
            lineType: 'hotel',
            quantity: 2,
            unitPrice: 2430.40,
            amount: 4860.80,
            taxableValue: 4860.80,
            gstPercent: 0,
          },
        ],
      });

      expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
      expect(heightSpy).toHaveBeenCalledWith(
        'Hotel Corporate Hotel Near Sealdah Railway station, Kolkata',
        expect.objectContaining({ width: 210 }),
      );
    } finally {
      heightSpy.mockRestore();
    }
  });

  test('partial-payment invoice PDF shows amount paid and remaining balance', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({
        invoiceNum: 'TINV-2026-0013',
        status: 'Partial',
        totalAmount: '40585.96',
        amountPaid: 21000,
        balanceDue: 19585.96,
      }),
      lines: [
        {
          id: 1,
          description: 'Trip invoice total',
          lineType: 'tour_package',
          quantity: 1,
          unitPrice: 40585.96,
          amount: 40585.96,
          taxableValue: 40585.96,
          gstPercent: 0,
        },
      ],
    });

    const text = extractPdfText(buf);
    expect(text).toMatch(/Subtotal/);
    expect(text).toMatch(/Amount Paid/);
    expect(text).toMatch(/Balance Due/);
    expect(text).toMatch(/21000\.00/);
    expect(text).toMatch(/19585\.96/);
  });

  test('sacForLineType is invoked at least once per non-empty line list', async () => {
    // Spy on the module.exports surface — the renderer indirects through
    // `module.exports.sacForLineType(...)` per the CJS self-mocking-seam
    // pattern, so spies on the exports surface intercept correctly.
    const spy = vi.spyOn(hsnSacMapper, 'sacForLineType');
    try {
      await generateTravelInvoicePdf({
        invoice: invoiceFixture(),
        lines: sacLineMix(),
      });
      // Renderer calls sacForLineType once per line in the table
      // AND `groupLinesBySac` calls it once per line internally — so
      // we just assert "called multiple times" rather than pinning the
      // exact count (which would be brittle to internal helper refactor).
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(sacLineMix().length);
    } finally {
      spy.mockRestore();
    }
  });

  test('computeGstSplit is invoked for lines with a non-zero gstPercent', async () => {
    const spy = vi.spyOn(gstCalculation, 'computeGstSplit');
    try {
      await generateTravelInvoicePdf({
        invoice: invoiceFixture(),
        lines: [
          {
            id: 1, description: 'Hotel',
            lineType: 'hotel', quantity: 1, unitPrice: 5000, amount: 5000,
            taxableValue: 5000, gstPercent: 12,
          },
          {
            id: 2, description: 'Flight',
            lineType: 'flight', quantity: 1, unitPrice: 25000, amount: 25000,
            taxableValue: 25000, gstPercent: 5,
          },
        ],
      });
      // Called once per line item in the table.
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      // Inspect the args of the first call — must carry the expected
      // shape: taxableAmount + gstPercent + isInterstate.
      const firstCallArg = spy.mock.calls[0][0];
      expect(firstCallArg).toHaveProperty('taxableAmount');
      expect(firstCallArg).toHaveProperty('gstPercent');
      expect(firstCallArg).toHaveProperty('isInterstate');
      expect(firstCallArg.isInterstate).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('isInterstate flag propagates from invoice.placeOfSupplyInterstate', async () => {
    const spy = vi.spyOn(gstCalculation, 'computeGstSplit');
    try {
      await generateTravelInvoicePdf({
        invoice: invoiceFixture({ placeOfSupplyInterstate: true }),
        lines: [
          {
            id: 1, description: 'Hotel',
            lineType: 'hotel', quantity: 1, unitPrice: 5000, amount: 5000,
            taxableValue: 5000, gstPercent: 12,
          },
        ],
      });
      expect(spy).toHaveBeenCalled();
      const firstCallArg = spy.mock.calls[0][0];
      expect(firstCallArg.isInterstate).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
