// Unit tests for backend/services/pdfRenderer.js — pdfkit-based PDFs for
// the wellness vertical (prescription, consent, branded invoice).
//
// The renderer functions are pure: each takes plain objects (already
// fetched by the caller via tenant-scoped prisma queries) and returns a
// Promise<Buffer>. We don't need to mock prisma here — we just feed in
// fixture rows and assert on the produced Buffer.
//
// Inspecting the rendered PDF: pdfkit FlateDecode-compresses content
// streams and emits text in PDF hex-string form (e.g. <48656c6c6f> for
// "Hello") inside `[…] TJ` operators. To assert on text content, we
// inflate every stream and decode the hex segments back to characters.
// See `extractPdfText` below — it isn't a full PDF parser, just enough
// to recover ASCII text our renderers emit.
import { describe, test, expect } from 'vitest';
import zlib from 'node:zlib';
import pdfR from '../../services/pdfRenderer.js';

const { renderPrescriptionPdf, renderConsentPdf, renderBrandedInvoicePdf } = pdfR;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract human-readable text from a pdfkit-produced Buffer. Inflates
 * any FlateDecode'd content streams, then concatenates the characters
 * found inside hex-string TJ-array operators and parenthesised Tj
 * literals. Good enough to grep substrings; not a full PDF parser.
 */
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
  // Hex-string TJ arrays: [<deadbeef> num <feedf00d>] TJ
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
  // Literal parenthesised strings: (text) Tj
  const tjLiteralRe = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  while ((s = tjLiteralRe.exec(allOps)) !== null) {
    out += s[1].replace(/\\(.)/g, '$1') + ' ';
  }
  return out;
}

function clinicFixture(overrides = {}) {
  return {
    name: 'Enhanced Wellness',
    addressLine: '12 Park Ave',
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
    gender: 'female',
    dob: '1985-04-12',
    ...overrides,
  };
}

// 1×1 transparent PNG (44 bytes) — a valid signature image we can hand
// to renderConsentPdf without hitting disk.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

// ── Module shape ────────────────────────────────────────────────────

describe('module shape', () => {
  test('exports the three renderers', () => {
    expect(typeof renderPrescriptionPdf).toBe('function');
    expect(typeof renderConsentPdf).toBe('function');
    expect(typeof renderBrandedInvoicePdf).toBe('function');
  });
});

// ── extractPdfText sanity (own-helper) ──────────────────────────────

describe('extractPdfText helper', () => {
  test('round-trips ASCII through hex-string TJ array (sanity)', async () => {
    // Use a known-text rendering to confirm the helper is sound before
    // relying on it for SUT assertions below.
    const buf = await renderPrescriptionPdf(
      { drugs: [] },
      { name: 'Sentinel Patient' },
      { name: 'Sentinel Clinic' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Sentinel Patient');
    expect(txt).toContain('Sentinel Clinic');
  });
});

// ── renderPrescriptionPdf ───────────────────────────────────────────

describe('renderPrescriptionPdf', () => {
  test('returns a non-empty PDF Buffer (happy path)', async () => {
    const buf = await renderPrescriptionPdf(
      {
        drugs: [
          { name: 'Minoxidil 5%', dosage: '1ml', frequency: 'BID', duration: '3 months' },
        ],
        instructions: 'Apply to scalp twice daily.',
        createdAt: '2026-04-15T10:00:00Z',
      },
      patientFixture(),
      clinicFixture(),
      { name: 'Dr. Harsh Mehta' },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('rendered PDF contains patient name + clinic name', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [], instructions: 'rest' },
      patientFixture(),
      clinicFixture(),
      { name: 'Dr. Harsh Mehta' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Priya Sharma');
    expect(txt).toContain('Enhanced Wellness');
    expect(txt).toContain('Prescription');
  });

  test('rendered PDF includes drug names from the drug list', async () => {
    const buf = await renderPrescriptionPdf(
      {
        drugs: [
          { name: 'Finasteride 1mg', dosage: '1 tab', frequency: 'OD', duration: '6 months' },
          { name: 'Biotin 5mg', dosage: '1 cap', frequency: 'OD', duration: '3 months' },
        ],
      },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Finasteride 1mg');
    expect(txt).toContain('Biotin 5mg');
    expect(txt).toContain('Medication');
    expect(txt).toContain('Frequency');
  });

  test('"no medications listed" placeholder when drugs list is empty', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [] },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('no medications listed');
  });

  test('handles drugs as JSON-string (caller stored as JSON)', async () => {
    const buf = await renderPrescriptionPdf(
      {
        drugs: JSON.stringify([
          { name: 'StringEncodedDrug', dosage: 'X', frequency: 'Y', duration: 'Z' },
        ]),
      },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('StringEncodedDrug');
  });

  test('handles drugs as a single object (not array)', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: { name: 'SingleDrug', dosage: '5mg' } },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('SingleDrug');
  });

  test('falls back gracefully when drugs is malformed JSON', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: '{not json' },
      patientFixture(),
      clinicFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('no medications listed');
  });

  test('honours alternate drug-name field "drug"', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [{ drug: 'AltKeyDrug' }] },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('AltKeyDrug');
  });

  test('produces a valid PDF when a drug row has only a name (other fields default to "—")', async () => {
    // The em-dash placeholder is outside WinAnsi-encoded Helvetica, so it
    // doesn't survive extraction — we just confirm the renderer doesn't
    // crash and the named drug ends up in the document.
    const buf = await renderPrescriptionPdf(
      { drugs: [{ name: 'JustAName' }] },
      patientFixture(),
      clinicFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    const txt = extractPdfText(buf);
    expect(txt).toContain('JustAName');
  });

  test('includes prescriber name under signature line when doctor passed', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [] },
      patientFixture(),
      clinicFixture(),
      { name: 'Dr. Harsh Mehta' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Dr. Harsh Mehta');
    expect(txt).toContain("Doctor's signature");
  });

  test('omits prescriber name when no doctor object passed', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [] },
      patientFixture(),
      clinicFixture(),
      undefined,
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain("Doctor's signature");
    expect(txt).not.toContain('Dr. Harsh Mehta');
  });

  test('handles patient with no DOB without throwing', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [] },
      { name: 'No DOB Patient', phone: '+910000', gender: 'other' },
      clinicFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('No DOB Patient');
  });

  test('handles entirely null patient/clinic objects without throwing', async () => {
    const buf = await renderPrescriptionPdf({ drugs: [] }, null, null);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(300);
    const txt = extractPdfText(buf);
    // Default clinic name kicks in via safeClinic().
    expect(txt).toContain('Clinic');
  });

  test('long drug list paginates (50 rows triggers an extra page)', async () => {
    const drugs = [];
    for (let i = 0; i < 50; i++) {
      drugs.push({
        name: `Drug-${i}`,
        dosage: '5mg',
        frequency: 'OD',
        duration: '30 days',
      });
    }
    const buf = await renderPrescriptionPdf(
      { drugs },
      patientFixture(),
      clinicFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    // /Count N in the Pages object is the only reliable raw-buf marker.
    const raw = buf.toString('latin1');
    expect(raw).toMatch(/\/Count\s+[2-9]/);
    const txt = extractPdfText(buf);
    expect(txt).toContain('Drug-0');
    expect(txt).toContain('Drug-49');
  });

  test('renders instructions block when supplied', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [], instructions: 'Avoid sun exposure for 7 days.' },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Instructions');
    expect(txt).toContain('Avoid sun exposure');
  });

  test('omits instructions block when none supplied', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [] },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).not.toContain('Instructions');
  });

  test('formats createdAt as en-IN long-form date in header', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [], createdAt: '2026-04-15T10:00:00Z' },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Apr 2026');
  });
});

// ── renderConsentPdf ────────────────────────────────────────────────

describe('renderConsentPdf', () => {
  test('returns a non-empty PDF Buffer (happy path)', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general', signedAt: '2026-04-15T10:00:00Z' },
      patientFixture(),
      { name: 'Hair Transplant' },
      clinicFixture(),
      null,
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(800);
  });

  test('title humanises template name (kebab → Title Case)', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'hair-transplant' },
      patientFixture(),
      null,
      clinicFixture(),
      null,
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Consent Form');
    expect(txt).toContain('Hair Transplant');
  });

  test('embeds patient name in declaration paragraph', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general' },
      patientFixture({ name: 'Anita Roy' }),
      null,
      clinicFixture(),
      null,
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Anita Roy');
    expect(txt).toContain('Declaration');
  });

  test('renders service name when supplied', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general' },
      patientFixture(),
      { name: 'GFC Hair Therapy' },
      clinicFixture(),
      null,
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('GFC Hair Therapy');
    expect(txt).toContain('Service:');
  });

  test('omits Service: line when service not provided', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general' },
      patientFixture(),
      null,
      clinicFixture(),
      null,
    );
    const txt = extractPdfText(buf);
    expect(txt).not.toContain('Service:');
  });

  test('falls back to general template when templateName missing', async () => {
    const buf = await renderConsentPdf(
      {},
      patientFixture(),
      null,
      clinicFixture(),
      null,
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('General');
  });

  test('falls back to general template when templateName unknown', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'this-is-not-a-real-template' },
      patientFixture(),
      null,
      clinicFixture(),
      null,
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(800);
    const txt = extractPdfText(buf);
    // Title humanisation still kicks in for the unknown name.
    expect(txt).toContain('This Is Not A Real Template');
  });

  test('embeds signature image when valid base64 PNG data URL provided', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general' },
      patientFixture(),
      null,
      clinicFixture(),
      TINY_PNG_DATA_URL,
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    // pdfkit emits the image as an XObject with /Subtype /Image.
    expect(buf.toString('latin1')).toContain('/Subtype /Image');
    const txt = extractPdfText(buf);
    expect(txt).toContain('Patient Signature');
  });

  test('falls back to signature line when signatureDataUrl is malformed', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general' },
      patientFixture(),
      null,
      clinicFixture(),
      'data:image/png;base64,@@@@notbase64@@@@',
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Falls through to the line-only signature placeholder.
    expect(buf.toString('latin1')).not.toContain('/Subtype /Image');
    const txt = extractPdfText(buf);
    expect(txt).toContain('Patient Signature');
  });

  test('falls back to signature line when signatureDataUrl is null', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general' },
      patientFixture(),
      null,
      clinicFixture(),
      null,
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('latin1')).not.toContain('/Subtype /Image');
    const txt = extractPdfText(buf);
    expect(txt).toContain('Patient Signature');
  });

  test('non-string signatureDataUrl is ignored (no throw)', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general' },
      patientFixture(),
      null,
      clinicFixture(),
      12345,
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test('supports each known consent template variant', async () => {
    for (const tpl of ['hair-transplant', 'botox-fillers', 'laser', 'chemical-peel', 'general']) {
      const buf = await renderConsentPdf(
        { templateName: tpl },
        patientFixture(),
        null,
        clinicFixture(),
        null,
      );
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(700);
    }
  });

  test('handles missing patient gracefully', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general' },
      null,
      null,
      clinicFixture(),
      null,
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test('renders signedAt date when provided', async () => {
    const buf = await renderConsentPdf(
      { templateName: 'general', signedAt: '2026-04-15' },
      patientFixture(),
      null,
      clinicFixture(),
      null,
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Signed:');
    expect(txt).toContain('Apr 2026');
  });
});

// ── renderBrandedInvoicePdf ─────────────────────────────────────────

describe('renderBrandedInvoicePdf', () => {
  test('returns a non-empty PDF Buffer (happy path)', async () => {
    const buf = await renderBrandedInvoicePdf(
      {
        invoiceNum: 'INV-2026-0042',
        amount: 12500,
        status: 'UNPAID',
        issuedDate: '2026-04-01',
        dueDate: '2026-04-15',
      },
      { name: 'Acme Corp', email: 'ap@acme.com', phone: '+1-555-0100', company: 'Acme Holdings' },
      clinicFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(800);
  });

  test('PDF text contains clinic name, invoice number, status, and contact', async () => {
    const buf = await renderBrandedInvoicePdf(
      {
        invoiceNum: 'INV-PROD-9001',
        amount: 5000,
        status: 'PAID',
        issuedDate: '2026-04-01',
        dueDate: '2026-04-15',
      },
      { name: 'Rishu Test', email: 'r@test.in' },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Enhanced Wellness');
    expect(txt).toContain('INV-PROD-9001');
    expect(txt).toContain('PAID');
    expect(txt).toContain('Rishu Test');
    expect(txt).toContain('INVOICE');
  });

  test('uses invoice.id when invoiceNum missing', async () => {
    const buf = await renderBrandedInvoicePdf(
      { id: 'fallback-id-123', amount: 100 },
      { name: 'X' },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('fallback-id-123');
  });

  test('falls back to UNPAID status when none supplied', async () => {
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'I-1', amount: 100 },
      { name: 'X' },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('UNPAID');
  });

  test('formats amount with two decimal places', async () => {
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'I-1', amount: 1234.5 },
      { name: 'X' },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('1234.50');
  });

  test('handles zero amount cleanly', async () => {
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'I-Z', amount: 0 },
      { name: 'X' },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('0.00');
  });

  test('handles non-numeric amount as 0', async () => {
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'I-NaN', amount: 'not-a-number' },
      { name: 'X' },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('0.00');
  });

  test('renders all contact fields (company, email, phone) when provided', async () => {
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'I-1', amount: 50 },
      {
        name: 'Jane Doe',
        company: 'Doe Holdings',
        email: 'jane@doe.co',
        phone: '+1-555-1212',
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Jane Doe');
    expect(txt).toContain('Doe Holdings');
    expect(txt).toContain('jane@doe.co');
    expect(txt).toContain('+1-555-1212');
  });

  test('renders without optional contact fields', async () => {
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'I-1', amount: 50 },
      { name: 'Solo Customer' },
      clinicFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('Solo Customer');
    expect(txt).toContain('Bill To');
  });

  test('handles minimal clinic + minimal contact (no crash)', async () => {
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'I-1', amount: 1 },
      {},
      {},
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    // safeClinic default kicks in.
    expect(txt).toContain('Clinic');
  });

  test('renders Terms section', async () => {
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'I-T', amount: 100 },
      { name: 'X' },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Terms');
    expect(txt).toContain('Payment is due');
  });

  test('renders footer with clinic phone + email when present', async () => {
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'I-T', amount: 100 },
      { name: 'X' },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('hello@enhancedwellness.in');
    expect(txt).toContain('+919999000011');
  });
});
