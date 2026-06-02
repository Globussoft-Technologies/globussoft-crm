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

const { renderPrescriptionPdf, renderConsentPdf, renderBrandedInvoicePdf, renderPatientSummaryPdf, scrubZyluText, scrubZyluSource, parsePhotoUrls } = pdfR;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract human-readable text from a pdfkit-produced Buffer. Inflates
 * any FlateDecode'd content streams, then concatenates the characters
 * found inside hex-string TJ-array operators and parenthesised Tj
 * literals. Good enough to grep substrings; not a full PDF parser.
 */
function extractPdfText(buf) {
  const str = buf.toString('latin1');
  let allOps = '';
  // Slice each stream body by its declared `/Length` rather than scanning
  // for the next `endstream`. FlateDecode binary can legitimately contain
  // the literal bytes `\nendstream`, which truncated the old non-greedy
  // `stream...endstream` regex — that varied by the platform's zlib output,
  // so this test passed on Windows but failed on Linux CI. `/Length` is the
  // PDF-spec-authoritative byte count (pdfkit emits it as a direct integer).
  const lenRe = /\/Length\s+(\d+)\b[^>]*>>\s*stream\r?\n/g;
  let m;
  while ((m = lenRe.exec(str)) !== null) {
    const len = parseInt(m[1], 10);
    const start = lenRe.lastIndex; // latin1 is 1 byte/char → char idx == byte offset
    const raw = buf.subarray(start, start + len);
    try {
      allOps += zlib.inflateSync(raw).toString('latin1');
    } catch {
      allOps += raw.toString('latin1');
    }
  }
  // Fallback to the legacy scan if no /Length-declared streams matched
  // (defensive — keeps any non-pdfkit PDF shape working).
  if (!allOps) {
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let s;
    while ((s = streamRe.exec(str)) !== null) {
      const raw = Buffer.from(s[1], 'latin1');
      try {
        allOps += zlib.inflateSync(raw).toString('latin1');
      } catch {
        allOps += raw.toString('latin1');
      }
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
    // Reference-aligned table uses uppercase column headers — "Medications"
    // appears as the section title (substring matches both), "FREQUENCY"
    // as the column header. Case-insensitive checks intentionally so the
    // contract pins the labels' presence, not their exact casing.
    expect(txt.toUpperCase()).toContain('MEDICATION');
    expect(txt.toUpperCase()).toContain('FREQUENCY');
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
    // The signature label is rendered Title-Case in the new comprehensive
    // Rx layout ("Doctor's Signature") — matches the rest of the section
    // labels (Patient Information, Doctor Information, etc.).
    expect(txt).toContain("Doctor's Signature");
  });

  test('omits prescriber name when no doctor object passed', async () => {
    const buf = await renderPrescriptionPdf(
      { drugs: [] },
      patientFixture(),
      clinicFixture(),
      undefined,
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain("Doctor's Signature");
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

  test('renders the no-clinical-notes placeholder when no instructions supplied', async () => {
    // The new comprehensive Rx layout always renders a Medications table
    // (with an "Instructions" column header) and a Notes section, so the
    // previous absence-check on the literal word "Instructions" no longer
    // matches a meaningful contract. The semantic equivalent is: when the
    // caller supplies no instructions, the Notes section surfaces the
    // canonical "No clinical notes recorded." placeholder rather than any
    // user-supplied free-form text.
    const buf = await renderPrescriptionPdf(
      { drugs: [] },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('No clinical notes recorded.');
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

// Zylu mask — the renderer must NOT leak upstream-POS markers into any
// customer-facing PDF (patient summary download). The helpers are
// exported so the unit-level rules stay tight without going through the
// expensive renderPatientSummaryPdf path.
describe('scrubZyluText', () => {
  test('returns empty string for null / undefined / non-string input', () => {
    expect(scrubZyluText(null)).toBe('');
    expect(scrubZyluText(undefined)).toBe('');
    expect(scrubZyluText(42)).toBe(42); // non-string passes through as-is
  });

  test('passes ordinary notes through unchanged', () => {
    expect(scrubZyluText('Patient arrived early.')).toBe('Patient arrived early.');
  });

  test('strips "Zylu booking #N" tokens (case-insensitive, hash optional)', () => {
    expect(scrubZyluText('Zylu booking #15029981 followed up.')).toBe('followed up.');
    expect(scrubZyluText('zylu booking 14514296')).toBe('');
    expect(scrubZyluText('Visit notes. ZYLU booking #99.')).toMatch(/^Visit notes\.?\s*$/);
  });

  test('strips the [ZYLU-#N] / [zylu-N] tag form used by imported Rx', () => {
    expect(scrubZyluText('[ZYLU-#260] Hair fall consult.')).toBe('Hair fall consult.');
    expect(scrubZyluText('[zylu-1234] more text')).toBe('more text');
  });

  test('collapses run-of-whitespace + extra blank lines after scrubbing', () => {
    const cleaned = scrubZyluText('First.   Zylu booking #1   Second line.');
    // Two spaces are NOT collapsed by the helper, but 2+ consecutive
    // spaces created by the strip get reduced to one.
    expect(cleaned).toBe('First. Second line.');
  });
});

describe('scrubZyluSource', () => {
  test('returns null for falsy + zylu-prefixed sources', () => {
    expect(scrubZyluSource(null)).toBe(null);
    expect(scrubZyluSource('')).toBe(null);
    expect(scrubZyluSource('zylu-import')).toBe(null);
    expect(scrubZyluSource('ZYLU-WEBHOOK')).toBe(null);
    expect(scrubZyluSource('  zylu-import  ')).toBe(null);
  });
  test('passes other source values through unchanged', () => {
    expect(scrubZyluSource('walk-in')).toBe('walk-in');
    expect(scrubZyluSource('Instagram')).toBe('Instagram');
    expect(scrubZyluSource('referral')).toBe('referral');
  });
});

// ── parsePhotoUrls ──────────────────────────────────────────────────
//
// Visit.photosBefore / photosAfter are `String? @db.Text` JSON arrays in
// Prisma; the helper has to tolerate every shape that can show up in the
// raw row (null, missing column, malformed JSON, non-array JSON, already-
// decoded array) without throwing — a malformed value on one visit must
// not blow up the whole patient summary PDF.

describe('parsePhotoUrls', () => {
  test('returns [] for null / undefined / empty inputs', () => {
    expect(parsePhotoUrls(null)).toEqual([]);
    expect(parsePhotoUrls(undefined)).toEqual([]);
    expect(parsePhotoUrls('')).toEqual([]);
  });
  test('parses a JSON-stringified array of URLs', () => {
    const raw = JSON.stringify([
      '/api/wellness/visits/12/photos/before-1.jpg',
      '/api/wellness/visits/12/photos/before-2.png',
    ]);
    expect(parsePhotoUrls(raw)).toEqual([
      '/api/wellness/visits/12/photos/before-1.jpg',
      '/api/wellness/visits/12/photos/before-2.png',
    ]);
  });
  test('accepts an already-decoded array (defensive)', () => {
    const arr = ['/api/wellness/visits/3/photos/a.png'];
    expect(parsePhotoUrls(arr)).toEqual(arr);
  });
  test('drops non-string entries from a parsed JSON array', () => {
    const raw = JSON.stringify([
      '/api/wellness/visits/9/photos/ok.jpg',
      null,
      42,
      { url: 'nope' },
      '/api/wellness/visits/9/photos/also-ok.png',
    ]);
    expect(parsePhotoUrls(raw)).toEqual([
      '/api/wellness/visits/9/photos/ok.jpg',
      '/api/wellness/visits/9/photos/also-ok.png',
    ]);
  });
  test('returns [] for malformed JSON without throwing', () => {
    expect(parsePhotoUrls('not json')).toEqual([]);
    expect(parsePhotoUrls('{')).toEqual([]);
    expect(parsePhotoUrls('[unterminated')).toEqual([]);
  });
  test('returns [] for JSON that decodes to a non-array', () => {
    expect(parsePhotoUrls('"a string"')).toEqual([]);
    expect(parsePhotoUrls('42')).toEqual([]);
    expect(parsePhotoUrls('{"url":"x"}')).toEqual([]);
    expect(parsePhotoUrls('null')).toEqual([]);
  });
  test('drops empty string entries', () => {
    const raw = JSON.stringify(['/api/wellness/visits/1/photos/x.jpg', '', '/api/wellness/visits/1/photos/y.jpg']);
    expect(parsePhotoUrls(raw)).toEqual([
      '/api/wellness/visits/1/photos/x.jpg',
      '/api/wellness/visits/1/photos/y.jpg',
    ]);
  });
});

// ── renderPatientSummaryPdf — visit photo strip ─────────────────────
//
// The renderer is the only surface that decides what the customer-facing
// PDF actually shows. The unit tests below pin the contract the route
// relies on: (a) the visit-photo strip renders when buffers are supplied,
// (b) it gracefully degrades when buffers are missing, (c) the section is
// suppressed entirely when no photos are uploaded, (d) overflow surfaces
// a "+N more" caption, and (e) malformed photosBefore / photosAfter JSON
// does not crash the whole document.

// A 1×1 transparent PNG — minimum valid PNG that pdfkit can embed
// without an image library. Used so the embed path is real (no mock).
const TINY_PNG_BUF = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
);

function patientWithPhotos({ beforeUrls = [], afterUrls = [] } = {}) {
  return {
    id: 50,
    name: 'Anita Gupta',
    dob: '1979-11-23',
    gender: 'F',
    phone: '+919897241522',
    email: 'patient48@example.in',
    visits: [
      {
        id: 99,
        visitDate: '2026-05-19T00:00:00Z',
        service: { name: 'Carbon Peel (Laser)' },
        doctor: { name: 'Dr Priyambada' },
        status: 'booked',
        amount: 5091,
        photosBefore: beforeUrls.length ? JSON.stringify(beforeUrls) : null,
        photosAfter: afterUrls.length ? JSON.stringify(afterUrls) : null,
      },
    ],
    prescriptions: [],
    consents: [],
    treatmentPlans: [],
  };
}

describe('renderPatientSummaryPdf — visit photos', () => {
  test('returns a non-empty Buffer when no photos are present', async () => {
    const buf = await renderPatientSummaryPdf({
      patient: patientWithPhotos(),
      tenant: { name: 'Enhanced Wellness' },
      clinic: { name: 'Ranchi Clinic', addressLine: 'The Ikon, Tagore Hill Rd', city: 'Ranchi' },
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    const txt = extractPdfText(buf);
    expect(txt).toContain('Patient Summary');
    expect(txt).toContain('Anita Gupta');
    // No photos uploaded → the BEFORE / AFTER strip headings must not appear.
    expect(txt).not.toMatch(/BEFORE \(/);
    expect(txt).not.toMatch(/AFTER \(/);
  });

  test('renders BEFORE / AFTER strip when buffers are supplied', async () => {
    const beforeUrl = '/api/wellness/visits/99/photos/before-1.png';
    const afterUrl = '/api/wellness/visits/99/photos/after-1.png';
    const photoBuffers = new Map([
      [beforeUrl, TINY_PNG_BUF],
      [afterUrl, TINY_PNG_BUF],
    ]);
    const buf = await renderPatientSummaryPdf({
      patient: patientWithPhotos({ beforeUrls: [beforeUrl], afterUrls: [afterUrl] }),
      tenant: { name: 'Enhanced Wellness' },
      clinic: { name: 'Ranchi Clinic' },
      photoBuffers,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('BEFORE (1)');
    expect(txt).toContain('AFTER (1)');
  });

  test('renders "+N more" caption when a side exceeds the per-side cap', async () => {
    const beforeUrls = [
      '/api/wellness/visits/99/photos/b1.png',
      '/api/wellness/visits/99/photos/b2.png',
      '/api/wellness/visits/99/photos/b3.png',
      '/api/wellness/visits/99/photos/b4.png',
      '/api/wellness/visits/99/photos/b5.png',
    ];
    const photoBuffers = new Map(beforeUrls.map((u) => [u, TINY_PNG_BUF]));
    const buf = await renderPatientSummaryPdf({
      patient: patientWithPhotos({ beforeUrls }),
      tenant: { name: 'Enhanced Wellness' },
      clinic: { name: 'Ranchi Clinic' },
      photoBuffers,
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('BEFORE (5)');
    // Renderer caps at 1 hero thumbnail per side (matches the reference
    // Dr. Haror's visit-card design where each BEFORE / AFTER side gets
    // ONE large image, not a strip); 5 − 1 = 4 surplus surfaced as caption.
    expect(txt).toContain('+4 more');
  });

  test('falls back to placeholder when a buffer is missing for an URL', async () => {
    const beforeUrl = '/api/wellness/visits/99/photos/missing.webp';
    // photoBuffers Map intentionally does NOT contain the URL — simulates
    // an undecodable / not-on-disk photo. The renderer must still produce
    // a valid PDF and surface the BEFORE label.
    const buf = await renderPatientSummaryPdf({
      patient: patientWithPhotos({ beforeUrls: [beforeUrl] }),
      tenant: { name: 'Enhanced Wellness' },
      clinic: { name: 'Ranchi Clinic' },
      photoBuffers: new Map(),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('BEFORE (1)');
    expect(txt).toContain('(image)'); // placeholder text-label
  });

  test('does not crash when photosBefore is malformed JSON', async () => {
    const patient = patientWithPhotos();
    // Hand-write a malformed string column value.
    patient.visits[0].photosBefore = '[not-json';
    patient.visits[0].photosAfter = 'totally garbage';
    const buf = await renderPatientSummaryPdf({
      patient,
      tenant: { name: 'Enhanced Wellness' },
      clinic: { name: 'Ranchi Clinic' },
      photoBuffers: new Map(),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    const txt = extractPdfText(buf);
    expect(txt).toContain('Patient Summary');
    // Malformed JSON → parsePhotoUrls returns [] → no strip rendered.
    expect(txt).not.toMatch(/BEFORE \(/);
  });

  test('photos strip is skipped when photoBuffers is omitted entirely', async () => {
    // Even if the visit row has photo URLs, the renderer must skip the
    // strip when the caller didn't preload buffers (e.g. caller chose
    // not to embed photos this run). No partial render, no crash.
    const buf = await renderPatientSummaryPdf({
      patient: patientWithPhotos({ beforeUrls: ['/api/wellness/visits/99/photos/x.png'] }),
      tenant: { name: 'Enhanced Wellness' },
      clinic: { name: 'Ranchi Clinic' },
      // photoBuffers intentionally omitted.
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).not.toMatch(/BEFORE \(/);
    expect(txt).not.toMatch(/AFTER \(/);
  });
});
