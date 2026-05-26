// Unit tests for backend/services/pdfRenderer.js → generatePosReceiptPdf
//
// D17 POS New Sale slice 6 — receipt PDF rendering helper. This file
// only covers `generatePosReceiptPdf`; the broader pdfRenderer surface
// (prescription / consent / branded invoice / travel-quote) is covered
// by backend/test/services/pdfRenderer.test.js.
//
// The helper is pure: caller passes a `sale`, `lines`, `payments`,
// `patient`, `tenant` object — we return a Promise<Buffer> of PDF bytes.
// Assertions are mostly structural (Buffer + %PDF magic-bytes) plus
// inflate-then-grep of the pdfkit text stream to confirm that key
// labels (invoice number, patient name, payment methods, etc.) actually
// landed in the rendered document.
//
// PDF text-extraction: pdfkit FlateDecode-compresses content streams and
// emits text inside `[…] TJ` operators as hex-encoded strings (or
// occasionally `(literal) Tj`). We inflate every stream and decode the
// hex back to ASCII. Mirrors extractPdfText from pdfRenderer.test.js.
//
// Run: `cd backend && npx vitest run test/services/pdfRenderer-pos-receipt.test.js`
import { describe, test, expect } from 'vitest';
import zlib from 'node:zlib';
import pdfR from '../../services/pdfRenderer.js';

const { generatePosReceiptPdf } = pdfR;

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

function saleFixture(overrides = {}) {
  return {
    id: 42,
    completedAt: '2026-05-25T10:00:00Z',
    subtotal: 2000,
    discount: 200,
    tax: 180,
    grandTotal: 1980,
    currency: 'INR',
    ...overrides,
  };
}

function tenantFixture(overrides = {}) {
  return {
    name: 'Enhanced Wellness',
    addressLine: '12 Park Avenue',
    city: 'Mumbai',
    state: 'MH',
    pincode: '400001',
    phone: '+919999000011',
    email: 'hello@enhancedwellness.in',
    ...overrides,
  };
}

function patientFixture(overrides = {}) {
  return {
    name: 'Priya Sharma',
    phone: '+919876500000',
    ...overrides,
  };
}

// ── Module shape ────────────────────────────────────────────────────

describe('module exports generatePosReceiptPdf', () => {
  test('helper is a function on the module exports surface', () => {
    expect(typeof generatePosReceiptPdf).toBe('function');
  });
});

// ── generatePosReceiptPdf ───────────────────────────────────────────

describe('generatePosReceiptPdf — happy path', () => {
  test('full sale (2 lines, 1 payment) produces a non-empty PDF Buffer with %PDF magic bytes', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [
        { description: 'Hair PRP session', qty: 1, unitPrice: 1500, lineTotal: 1500 },
        { description: 'Topical serum (30ml)', qty: 1, unitPrice: 500, lineTotal: 500 },
      ],
      payments: [{ method: 'CARD', amount: 1980 }],
      patient: patientFixture(),
      tenant: tenantFixture(),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    // PDF magic bytes — every conforming PDF starts with the literal
    // ASCII "%PDF" at offset 0.
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('rendered PDF contains invoice number, tenant name, patient name', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ id: 1234 }),
      lines: [{ description: 'Consult', qty: 1, unitPrice: 500, lineTotal: 500 }],
      payments: [{ method: 'CASH', amount: 500 }],
      patient: patientFixture(),
      tenant: tenantFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('INV-1234');
    expect(txt).toContain('Enhanced Wellness');
    expect(txt).toContain('Priya Sharma');
    expect(txt).toContain('RECEIPT');
  });

  test('footer renders the "Thank you" line + "Powered by Globussoft CRM"', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'Consult', qty: 1, unitPrice: 500, lineTotal: 500 }],
      payments: [{ method: 'CASH', amount: 500 }],
      patient: patientFixture(),
      tenant: tenantFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Thank you for your visit');
    expect(txt).toContain('Powered by Globussoft CRM');
  });
});

// ── Split-tender (multi-payment) coverage ───────────────────────────

describe('generatePosReceiptPdf — split-tender / multi-payment', () => {
  test('all payment methods render when sale was paid via 3 tenders', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ id: 77, grandTotal: 3000 }),
      lines: [{ description: 'Combo package', qty: 1, unitPrice: 3000, lineTotal: 3000 }],
      payments: [
        { method: 'CASH', amount: 1000 },
        { method: 'CARD', amount: 1500 },
        { method: 'WALLET', amount: 500 },
      ],
      patient: patientFixture(),
      tenant: tenantFixture(),
    });
    const txt = extractPdfText(buf);
    // Each method label should appear in the payments section.
    expect(txt).toContain('CASH');
    expect(txt).toContain('CARD');
    expect(txt).toContain('WALLET');
    // "Payments" section header should be present.
    expect(txt).toContain('Payments');
  });
});

// ── Edge cases: zero discount / zero tax ────────────────────────────

describe('generatePosReceiptPdf — zero discount + zero tax', () => {
  test('discount row + tax row are hidden when both are 0', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({
        id: 5,
        subtotal: 1000,
        discount: 0,
        tax: 0,
        grandTotal: 1000,
      }),
      lines: [{ description: 'Walk-in service', qty: 1, unitPrice: 1000, lineTotal: 1000 }],
      payments: [{ method: 'CASH', amount: 1000 }],
      patient: patientFixture(),
      tenant: tenantFixture(),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    const txt = extractPdfText(buf);
    // Subtotal + Grand Total always render; Discount / Tax labels are
    // hidden when their amounts are 0 to keep the receipt tight.
    expect(txt).toContain('Subtotal');
    expect(txt).toContain('Grand Total');
    expect(txt).not.toContain('Discount');
    expect(txt).not.toContain('Tax');
  });

  test('discount row hidden / tax row rendered when only tax > 0', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({
        id: 6,
        subtotal: 1000,
        discount: 0,
        tax: 90,
        grandTotal: 1090,
      }),
      lines: [{ description: 'GST-eligible service', qty: 1, unitPrice: 1000, lineTotal: 1000 }],
      payments: [{ method: 'CASH', amount: 1090 }],
      patient: patientFixture(),
      tenant: tenantFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Tax');
    expect(txt).not.toContain('Discount');
  });
});

// ── Edge cases: missing optional input shapes ───────────────────────

describe('generatePosReceiptPdf — missing optional fields', () => {
  test('patient with no phone — renders without crashing', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'Consult', qty: 1, unitPrice: 500, lineTotal: 500 }],
      payments: [{ method: 'CASH', amount: 500 }],
      patient: { name: 'Anonymous Walk-in' }, // no phone field
      tenant: tenantFixture(),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    const txt = extractPdfText(buf);
    expect(txt).toContain('Anonymous Walk-in');
  });

  test('tenant with no addressLine / city / contact — renders without crashing', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'Consult', qty: 1, unitPrice: 500, lineTotal: 500 }],
      payments: [{ method: 'CASH', amount: 500 }],
      patient: patientFixture(),
      tenant: { name: 'Stub Clinic' }, // no address / city / phone / email
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    const txt = extractPdfText(buf);
    // Tenant name still renders even with no surrounding metadata.
    expect(txt).toContain('Stub Clinic');
  });

  test('null patient + null tenant — falls back gracefully', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'Anonymous sale', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [{ method: 'CASH', amount: 100 }],
      patient: null,
      tenant: null,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    const txt = extractPdfText(buf);
    // Tenant fallback label is "Clinic" per safeClinic / module default.
    expect(txt).toContain('Clinic');
  });
});
