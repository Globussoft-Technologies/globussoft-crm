// PRD_TRAVEL_SUPPLIER_MASTER G036 — renderSupplierPo unit tests.
//
// Pins the contract for the supplier purchase-order PDF helper at
// backend/services/pdfRenderer.js#renderSupplierPo. The helper is pure:
// caller passes a `purchaseOrder`, `supplier`, `lines`, `tenant` object
// and we return a Promise<Buffer> of PDF bytes.
//
// Assertions are structural (Buffer + %PDF magic-bytes) plus inflate-then-
// grep of the pdfkit text stream to confirm the headers, supplier name,
// PO number, line descriptions, and totals all land in the rendered PDF.
//
// PDF text-extraction: same pattern as pdfRenderer-pos-receipt.test.js —
// FlateDecode-inflate every stream then decode hex-encoded TJ tokens.
//
// Run: `cd backend && npx vitest run test/services/pdfRenderer-supplier-po.test.js`

import { describe, test, expect } from 'vitest';
import zlib from 'node:zlib';
import pdfR from '../../services/pdfRenderer.js';

const { renderSupplierPo } = pdfR;

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

function poFixture(overrides = {}) {
  return {
    id: 17,
    poNumber: 'TPO-2026-0001',
    status: 'sent',
    currency: 'INR',
    subtotal: '10000.00',
    taxAmount: '1800.00',
    totalAmount: '11800.00',
    createdAt: new Date('2026-06-12T10:00:00Z'),
    sentAt: new Date('2026-06-12T11:00:00Z'),
    bookingId: null,
    notes: 'Supplier dispatch via Air India agent portal',
    ...overrides,
  };
}

function supplierFixture(overrides = {}) {
  return {
    id: 100,
    name: 'Air India',
    subBrand: 'tmc',
    supplierCategory: 'flight',
    contactPerson: 'A. Receivables',
    phone: '+91 22 22796666',
    email: 'agents@airindia.in',
    gstin: '27AAACR4849R1ZW',
    addressLine: 'Airlines House, 113 Gurudwara Rakabganj Road, New Delhi 110001',
    paymentTermsDays: 30,
    ...overrides,
  };
}

function lineFixture(overrides = {}) {
  return {
    id: 1,
    lineType: 'service',
    description: 'BLR-DEL Q-class economy ticket',
    quantity: '10.00',
    unitPrice: '1000.00',
    lineTotal: '10000.00',
    pnr: 'AB12CD',
    bookingRef: 'TKT-90210',
    sortOrder: 0,
    ...overrides,
  };
}

function tenantFixture(overrides = {}) {
  return {
    id: 1,
    name: 'TMC Nexus Travel',
    subBrandConfigJson: null,
    ...overrides,
  };
}

describe('renderSupplierPo — structure', () => {
  test('returns a Buffer that begins with %PDF', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture(),
      supplier: supplierFixture(),
      lines: [lineFixture()],
      tenant: tenantFixture(),
      tenantSubBrand: 'tmc',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('renders with minimal opts (no lines, no notes)', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture({ notes: null, totalAmount: '0.00', subtotal: '0.00', taxAmount: '0.00' }),
      supplier: supplierFixture(),
      lines: [],
      tenant: tenantFixture(),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    const text = extractPdfText(buf);
    expect(text).toMatch(/No lines on this PO/);
  });

  test('handles null tenant gracefully', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture(),
      supplier: supplierFixture(),
      lines: [lineFixture()],
      tenant: null,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
  });
});

describe('renderSupplierPo — content', () => {
  test('renders the PO number in the meta block', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture({ poNumber: 'TPO-2026-0042' }),
      supplier: supplierFixture(),
      lines: [lineFixture()],
      tenant: tenantFixture(),
      tenantSubBrand: 'tmc',
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/TPO-2026-0042/);
  });

  test('renders the supplier name + contact details', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture(),
      supplier: supplierFixture({ name: 'IndiGo Sales Desk' }),
      lines: [lineFixture()],
      tenant: tenantFixture(),
      tenantSubBrand: 'tmc',
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/IndiGo Sales Desk/);
    expect(text).toMatch(/agents@airindia\.in/);
    expect(text).toMatch(/GSTIN/);
  });

  test('renders the line description + PNR reconciliation cue', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture(),
      supplier: supplierFixture(),
      lines: [
        lineFixture({
          description: 'Mumbai-Singapore business class',
          pnr: 'XYZ789',
          bookingRef: 'CONF-123',
        }),
      ],
      tenant: tenantFixture(),
      tenantSubBrand: 'tmc',
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/Mumbai-Singapore/);
    expect(text).toMatch(/XYZ789/);
    expect(text).toMatch(/CONF-123/);
  });

  test('renders multiple line types (service + tax + fee + discount)', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture(),
      supplier: supplierFixture(),
      lines: [
        lineFixture({ id: 1, lineType: 'service', description: 'Hotel block 25-28 May', lineTotal: '50000.00' }),
        lineFixture({ id: 2, lineType: 'tax', description: 'GST 18%', lineTotal: '9000.00', pnr: null, bookingRef: null }),
        lineFixture({ id: 3, lineType: 'fee', description: 'Convenience fee', lineTotal: '500.00', pnr: null, bookingRef: null }),
        lineFixture({ id: 4, lineType: 'discount', description: 'Volume discount', lineTotal: '-2000.00', pnr: null, bookingRef: null }),
      ],
      tenant: tenantFixture(),
      tenantSubBrand: 'tmc',
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/Hotel block/);
    expect(text).toMatch(/GST 18%/);
    expect(text).toMatch(/Convenience fee/);
    expect(text).toMatch(/Volume discount/);
  });

  test('renders the PO Total label with cached totalAmount', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture({ totalAmount: '23456.00' }),
      supplier: supplierFixture(),
      lines: [lineFixture()],
      tenant: tenantFixture(),
      tenantSubBrand: 'tmc',
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/PO Total/);
    expect(text).toMatch(/23456/);
  });

  test('renders payment-terms footer driven by supplier.paymentTermsDays', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture(),
      supplier: supplierFixture({ paymentTermsDays: 45 }),
      lines: [lineFixture()],
      tenant: tenantFixture(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/Payment Terms/);
    expect(text).toMatch(/Net 45 days/);
  });

  test('falls back to "As agreed with supplier" when paymentTermsDays missing', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture(),
      supplier: supplierFixture({ paymentTermsDays: null }),
      lines: [lineFixture()],
      tenant: tenantFixture(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/As agreed with supplier/);
  });

  test('renders notes block when notes set', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture({ notes: 'Please confirm by EOD Friday — group travels Monday.' }),
      supplier: supplierFixture(),
      lines: [lineFixture()],
      tenant: tenantFixture(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/Please confirm by EOD Friday/);
  });

  test('renders status in meta block', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture({ status: 'acknowledged' }),
      supplier: supplierFixture(),
      lines: [lineFixture()],
      tenant: tenantFixture(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/acknowledged/);
  });
});

describe('renderSupplierPo — currency rendering', () => {
  test('USD currency renders $ prefix in totals', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture({ currency: 'USD', totalAmount: '5000.00' }),
      supplier: supplierFixture(),
      lines: [lineFixture({ unitPrice: '500.00', lineTotal: '5000.00' })],
      tenant: tenantFixture(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/\$5000/);
  });

  test('GBP currency renders £ prefix in totals', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture({ currency: 'GBP', totalAmount: '3000.00' }),
      supplier: supplierFixture(),
      lines: [lineFixture({ unitPrice: '300.00', lineTotal: '3000.00' })],
      tenant: tenantFixture(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/£3000/);
  });

  test('Other currency renders code prefix', async () => {
    const buf = await renderSupplierPo({
      purchaseOrder: poFixture({ currency: 'AED', totalAmount: '1234.00' }),
      supplier: supplierFixture(),
      lines: [lineFixture({ unitPrice: '123.40', lineTotal: '1234.00' })],
      tenant: tenantFixture(),
    });
    const text = extractPdfText(buf);
    expect(text).toMatch(/AED/);
  });
});
