// @ts-check
/**
 * Arc 2 #901 slice 13 — docType-aware travel invoice PDF rendering.
 *
 * Pins `services/pdfRenderer.js#generateTravelInvoicePdf` (alias for
 * `renderTravelInvoicePdf`) extension that flips the header title strip
 * and adds a per-docType legal-text footer line based on
 * `invoice.docType` ∈ {Proforma, TaxInvoice, CreditNote, DebitNote,
 * TravelVoucher} (added in slice 11, commit 7c54451c).
 *
 * Contract pinned:
 *   - TaxInvoice docType → "TAX INVOICE" header + tax-invoice legal line
 *   - Null/missing docType (back-compat) → falls back to TaxInvoice
 *   - Proforma → "PROFORMA INVOICE" header + proforma legal line
 *   - CreditNote → "CREDIT NOTE" header + credit-note legal line
 *   - DebitNote → "DEBIT NOTE" header + debit-note legal line
 *   - TravelVoucher → "TRAVEL VOUCHER" header + voucher legal line
 *   - Unknown docType ("Foo" etc.) → defensive fallback to TaxInvoice
 *   - Lines render regardless of docType (description/qty visible in PDF)
 *   - Buffer is a valid PDF (starts with "%PDF-" magic bytes)
 *   - Buffer is non-trivially sized (>2KB — a branded multi-element page)
 *   - Body fields (invoice number, currency total, status) render
 *
 * PDF text-extraction approach: pdfkit FlateDecode-compresses each
 * content stream and emits text inside `[…] TJ` operators as hex-encoded
 * strings (or `(literal) Tj`). We inflate every stream and decode the
 * hex back to ASCII. Mirrors `extractPdfText` from
 * pdfRenderer-pos-receipt.test.js — the canonical text-extraction
 * pattern in this repo (pdf-parse is NOT a dependency, so we don't
 * import it).
 *
 * Run: `cd backend && npx vitest run test/services/travel-invoice-pdf-doctype.test.js`
 */

import { describe, test, expect } from 'vitest';
import zlib from 'node:zlib';
import pdfR from '../../services/pdfRenderer.js';

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
    id: 100,
    invoiceNum: 'TINV-2026-0042',
    subBrand: 'tmc',
    status: 'Issued',
    totalAmount: '45000.00',
    currency: 'INR',
    issuedDate: new Date('2026-05-25T10:00:00Z'),
    dueDate: new Date('2026-06-08T10:00:00Z'),
    contactName: 'Priya Sharma',
    contactEmail: 'priya@example.com',
    contactPhone: '+919876500000',
    ...overrides,
  };
}

function sampleLines() {
  return [
    {
      id: 1, description: 'Adult package',
      quantity: 2, unitPrice: 15000, amount: 30000,
      currency: 'INR',
    },
    {
      id: 2, description: 'GST 5%',
      quantity: 1, unitPrice: 1500, amount: 1500,
      currency: 'INR',
    },
  ];
}

// ── Tests ───────────────────────────────────────────────────────────

describe('renderTravelInvoicePdf — docType-aware header + legal footer', () => {
  test('docType=TaxInvoice → "TAX INVOICE" header + tax-invoice legal line', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ docType: 'TaxInvoice' }),
      lines: sampleLines(),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    const text = extractPdfText(buf);
    expect(text).toMatch(/TAX INVOICE/);
    expect(text).toMatch(/This is a Tax Invoice as per GST Rules/);
    // Negative-checks: no other docType's header/legal line should appear.
    expect(text).not.toMatch(/PROFORMA INVOICE/);
    expect(text).not.toMatch(/CREDIT NOTE/);
  });

  test('docType=null (back-compat with pre-slice-11 rows) → defaults to TaxInvoice', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ docType: null }),
      lines: sampleLines(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/TAX INVOICE/);
    expect(text).toMatch(/This is a Tax Invoice as per GST Rules/);
  });

  test('docType absent entirely (undefined) → defaults to TaxInvoice', async () => {
    // Mirrors the pre-slice-11 invoice shape that has no docType field
    // at all (the Prisma column was non-existent before the migration).
    const inv = invoiceFixture();
    delete inv.docType;
    const buf = await generateTravelInvoicePdf({
      invoice: inv,
      lines: sampleLines(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/TAX INVOICE/);
    expect(text).toMatch(/This is a Tax Invoice as per GST Rules/);
  });

  test('docType=Proforma → "PROFORMA INVOICE" header + proforma legal line', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ docType: 'Proforma' }),
      lines: sampleLines(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/PROFORMA INVOICE/);
    expect(text).toMatch(/This is a Proforma Invoice/);
    expect(text).toMatch(/not a tax invoice/);
    expect(text).toMatch(/No GST credit allowed/);
    // The strict-Tax-Invoice legal line MUST NOT appear on a Proforma —
    // would be a tax-status misrepresentation.
    expect(text).not.toMatch(/This is a Tax Invoice as per GST Rules/);
  });

  // NOTE on regex shape: pdfkit's default Helvetica font emits the
  // em-dash (`—`, U+2014) in a way our latin1 text-extractor decodes
  // back as either a literal `—` or as the surrounding whitespace
  // (depending on the glyph-encoding path). Tests match on the
  // surrounding non-dash text + use `\W+` for the dash position so
  // both extraction outcomes are accepted.

  test('docType=CreditNote → "CREDIT NOTE" header + credit-note legal line', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ docType: 'CreditNote' }),
      lines: sampleLines(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/CREDIT NOTE/);
    expect(text).toMatch(/Credit Note\W+reduces customer payable/);
    expect(text).not.toMatch(/TAX INVOICE/);
  });

  test('docType=DebitNote → "DEBIT NOTE" header + debit-note legal line', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ docType: 'DebitNote' }),
      lines: sampleLines(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/DEBIT NOTE/);
    expect(text).toMatch(/Debit Note\W+increases customer payable/);
    expect(text).not.toMatch(/CREDIT NOTE/);
  });

  test('docType=TravelVoucher → "TRAVEL VOUCHER" header + voucher legal line', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ docType: 'TravelVoucher' }),
      lines: sampleLines(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/TRAVEL VOUCHER/);
    expect(text).toMatch(/Voucher\W+non-billable/);
    expect(text).toMatch(/document of service entitlement/);
  });

  test('unknown docType ("Foo") → defensive fallback to TaxInvoice shape', async () => {
    // Defensive: a future schema-enum expansion might land a value here
    // before the renderer learns to format it. We don't crash; we fall
    // back to the strictest legal interpretation (TaxInvoice) rather
    // than to an empty/missing-header doc that could be ambiguous.
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ docType: 'Foo' }),
      lines: sampleLines(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/TAX INVOICE/);
    expect(text).toMatch(/This is a Tax Invoice as per GST Rules/);
    // The unknown string itself must not be promoted to the header
    // (would be a UI bug — operators shouldn't see "FOO INVOICE").
    expect(text).not.toMatch(/FOO/);
  });

  test('line items render regardless of docType (Proforma example)', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({ docType: 'Proforma' }),
      lines: sampleLines(),
    });
    const text = extractPdfText(buf);
    // Both line descriptions show; both quantities and the totals row.
    expect(text).toMatch(/Adult package/);
    expect(text).toMatch(/GST 5%/);
  });

  test('PDF is a valid binary (starts with %PDF- magic bytes) for every docType', async () => {
    for (const dt of ['TaxInvoice', 'Proforma', 'CreditNote', 'DebitNote', 'TravelVoucher', 'Foo', null]) {
      const buf = await generateTravelInvoicePdf({
        invoice: invoiceFixture({ docType: dt }),
        lines: sampleLines(),
      });
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    }
  });

  test('rendered buffer is non-trivially sized (>2KB) across all docTypes', async () => {
    // pdfkit's empty doc is ~1KB; a branded multi-element invoice page
    // is well over 2KB. This sanity-checks the layout primitives
    // executed end-to-end rather than crashing mid-render.
    for (const dt of ['TaxInvoice', 'Proforma', 'CreditNote', 'DebitNote', 'TravelVoucher']) {
      const buf = await generateTravelInvoicePdf({
        invoice: invoiceFixture({ docType: dt }),
        lines: sampleLines(),
      });
      expect(buf.length).toBeGreaterThan(2048);
    }
  });

  test('audit-related body fields (invoice number, currency, totals, status) render', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: invoiceFixture({
        docType: 'CreditNote',
        invoiceNum: 'TCRN-2026-0007',
        status: 'Issued',
        totalAmount: '12345.67',
        currency: 'INR',
      }),
      lines: sampleLines(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/TCRN-2026-0007/);
    expect(text).toMatch(/Issued/);
    // INR currency glyph plus the trailing total (formatted as
    // ₹12345.67 by the renderer's fmt helper).
    expect(text).toMatch(/12345\.67/);
  });
});
