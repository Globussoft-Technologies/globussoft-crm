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

const {
  renderPrescriptionPdf,
  renderConsentPdf,
  renderBrandedInvoicePdf,
  generateTravelQuotePdf,
  renderFullPatientReportPdf,
  renderTravelDiagnosticPdf,
  renderTravelItineraryPdf,
  renderTravelStallPersonalisedPdf,
  renderTravelInvoicePdf,
  generateTravelInvoicePdf,
  generatePosReceiptPdf,
  voucherSubtypeForLine,
  formatVoucherServiceRange,
  extractTravellerListFromInvoice,
} = pdfR;

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
    // #839 — the top-level instructions paragraph now renders under the
    // "Advice / Notes" header (renamed for clinician-Rx readability).
    // "Instructions" remains the column header in the medications table.
    const buf = await renderPrescriptionPdf(
      { drugs: [], instructions: 'Avoid sun exposure for 7 days.' },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Advice');
    expect(txt).toContain('Avoid sun exposure');
  });

  test('omits Advice block when no top-level instructions supplied', async () => {
    // #839 — "Advice / Notes" section is omitted when prescription.instructions
    // is absent. The string "Instructions" still appears as the medications
    // table column header (always present), so we check the section heading
    // ("Advice") instead.
    const buf = await renderPrescriptionPdf(
      { drugs: [] },
      patientFixture(),
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).not.toContain('Advice');
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

  // ── #839 — redesigned clinical-prescription layout ────────────────
  //
  // The bug report rated the pre-fix PDF "unprofessional / not suitable
  // to hand to a pharmacy". These tests pin the new layout's contract:
  // patient ID, doctor letterhead (qualification + reg number + contact),
  // vitals row, symptoms/diagnosis, per-drug Instructions column,
  // Advice/Notes, follow-up date, signature block, and footer.

  describe('#839 — redesigned clinical layout', () => {
    test('renders Patient ID in the patient block', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [] },
        patientFixture({ id: 8421 }),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('Patient ID:');
      expect(txt).toContain('8421');
    });

    test('renders patient email when supplied', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [] },
        patientFixture({ email: 'priya@example.com' }),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('Email:');
      expect(txt).toContain('priya@example.com');
    });

    test('renders doctor letterhead with qualification + registration number', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [] },
        patientFixture(),
        clinicFixture(),
        {
          name: 'Harsh Mehta',
          qualification: 'MBBS, MD (Derm)',
          registrationNumber: 'MCI-123456',
        },
      );
      const txt = extractPdfText(buf);
      // Doctor letterhead near top
      expect(txt).toContain('Dr. Harsh Mehta');
      expect(txt).toContain('MBBS, MD');
      expect(txt).toContain('MCI-123456');
      expect(txt).toContain('Reg. No.');
    });

    test('renders doctor contact (phone + email) in letterhead when present', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [] },
        patientFixture(),
        clinicFixture(),
        {
          name: 'Harsh Mehta',
          phone: '+919999111122',
          email: 'drharsh@enhancedwellness.in',
        },
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('+919999111122');
      expect(txt).toContain('drharsh@enhancedwellness.in');
    });

    test('renders Vitals row when at least one vital supplied', async () => {
      const buf = await renderPrescriptionPdf(
        {
          drugs: [],
          vitals: { bp: '120/80', pulse: 72, weight: 65, height: 170, temperature: 98.6, spo2: 98 },
        },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('Vitals');
      expect(txt).toContain('BP:');
      expect(txt).toContain('120/80');
      expect(txt).toContain('Pulse:');
      expect(txt).toContain('72');
      expect(txt).toContain('Weight:');
      expect(txt).toContain('65 kg');
    });

    test('omits Vitals section entirely when no vitals supplied', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [] },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).not.toContain('Vitals');
      expect(txt).not.toContain('BP:');
    });

    test('omits Vitals section when vitals object is empty', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [], vitals: {} },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).not.toContain('Vitals');
    });

    test('renders Symptoms section when supplied', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [], symptoms: 'Hair thinning at crown for 6 months' },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('Symptoms');
      expect(txt).toContain('Hair thinning at crown');
    });

    test('renders Diagnosis section when supplied', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [], diagnosis: 'Androgenetic alopecia, Norwood-Hamilton stage III' },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('Diagnosis');
      expect(txt).toContain('Androgenetic alopecia');
    });

    test('omits Symptoms + Diagnosis blocks when not supplied', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [] },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).not.toContain('Symptoms');
      expect(txt).not.toContain('Diagnosis');
    });

    test('medications table includes Instructions column header', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [{ name: 'Finasteride 1mg', dosage: '1 tab', frequency: 'OD', duration: '6 months' }] },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('Medication');
      expect(txt).toContain('Dosage');
      expect(txt).toContain('Frequency');
      expect(txt).toContain('Duration');
      expect(txt).toContain('Instructions');
    });

    test('per-drug instructions render in the Instructions column', async () => {
      const buf = await renderPrescriptionPdf(
        {
          drugs: [
            {
              name: 'Metformin 500mg',
              dosage: '1 tab',
              frequency: 'BID',
              duration: '30 days',
              instructions: 'with food',
            },
          ],
        },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('Metformin 500mg');
      expect(txt).toContain('with food');
    });

    test('per-drug notes field is honoured as fallback for instructions', async () => {
      const buf = await renderPrescriptionPdf(
        {
          drugs: [
            { name: 'Vitamin D3', dosage: '60k IU', frequency: 'weekly', duration: '8 weeks', notes: 'after breakfast' },
          ],
        },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('after breakfast');
    });

    test('Advice / Notes section renders top-level instructions', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [], instructions: 'Avoid sun exposure for 7 days; report rash immediately' },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('Advice');
      expect(txt).toContain('Notes');
      expect(txt).toContain('Avoid sun exposure');
    });

    test('Follow-up date renders when supplied', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [], followUpAt: '2026-06-15' },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).toContain('Next follow-up');
      expect(txt).toContain('Jun 2026');
    });

    test('omits follow-up line when not supplied', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [] },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      expect(txt).not.toContain('Next follow-up');
    });

    test('signature block stacks doctor name + qualification + registration', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [] },
        patientFixture(),
        clinicFixture(),
        {
          name: 'Harsh Mehta',
          qualification: 'MBBS, MD',
          registrationNumber: 'MCI-789',
        },
      );
      const txt = extractPdfText(buf);
      // Doctor letterhead + signature both render "Dr. Harsh Mehta" + the
      // qualification + the reg number — assert at least one occurrence
      // each (extractor is order-preserving but doesn't track position).
      expect(txt).toContain("Doctor's signature");
      // Doctor name appears in BOTH the letterhead AND the signature
      // block — verify it appears at least twice in the extracted text.
      const drMatches = (txt.match(/Dr\. Harsh Mehta/g) || []).length;
      expect(drMatches).toBeGreaterThanOrEqual(2);
    });

    test('footer renders clinic phone + email', async () => {
      const buf = await renderPrescriptionPdf(
        { drugs: [] },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      // Clinic contact strip appears in BOTH the clinic header AND the
      // page footer — verify both phone + email survive.
      expect(txt).toContain('+919999000011');
      expect(txt).toContain('hello@enhancedwellness.in');
    });

    test('long drug list paginates with re-rendered table headers on each page', async () => {
      const drugs = [];
      for (let i = 0; i < 60; i++) {
        drugs.push({
          name: `Drug-${i}`,
          dosage: '5mg',
          frequency: 'OD',
          duration: '30 days',
          instructions: 'with water',
        });
      }
      const buf = await renderPrescriptionPdf(
        { drugs },
        patientFixture(),
        clinicFixture(),
      );
      const txt = extractPdfText(buf);
      // First + last drugs both made it across the page break
      expect(txt).toContain('Drug-0');
      expect(txt).toContain('Drug-59');
      // Multi-page output — /Count >= 2 in the Pages object
      const raw = buf.toString('latin1');
      expect(raw).toMatch(/\/Count\s+[2-9]/);
      // Table header reappears on each page — "Medication" should occur
      // at least twice when content spans 2+ pages.
      const medMatches = (txt.match(/Medication/g) || []).length;
      expect(medMatches).toBeGreaterThanOrEqual(2);
    });

    test('5+ medications scenario from acceptance criteria renders cleanly', async () => {
      const buf = await renderPrescriptionPdf(
        {
          drugs: [
            { name: 'Finasteride 1mg', dosage: '1 tab', frequency: 'OD', duration: '6 months', instructions: 'morning' },
            { name: 'Minoxidil 5%', dosage: '1ml', frequency: 'BID', duration: '6 months', instructions: 'apply to scalp' },
            { name: 'Biotin 10mg', dosage: '1 cap', frequency: 'OD', duration: '3 months' },
            { name: 'Vitamin D3 60k', dosage: '1 sachet', frequency: 'weekly', duration: '8 weeks' },
            { name: 'Zinc 50mg', dosage: '1 tab', frequency: 'OD', duration: '3 months' },
            { name: 'Iron 100mg', dosage: '1 tab', frequency: 'OD', duration: '3 months', instructions: 'with vit C' },
          ],
          instructions: 'Follow scalp-care protocol; report any unusual shedding within 4 weeks.',
          followUpAt: '2026-07-01',
        },
        patientFixture({ id: 1234, email: 'priya@example.com' }),
        clinicFixture(),
        { name: 'Harsh Mehta', qualification: 'MBBS, MD (Derm)', registrationNumber: 'MCI-789' },
      );
      const txt = extractPdfText(buf);
      // Every medication present
      expect(txt).toContain('Finasteride');
      expect(txt).toContain('Minoxidil');
      expect(txt).toContain('Biotin');
      expect(txt).toContain('Vitamin D3');
      expect(txt).toContain('Zinc');
      expect(txt).toContain('Iron');
      // Top-level fields all present
      expect(txt).toContain('Patient ID:');
      expect(txt).toContain('1234');
      expect(txt).toContain('Advice');
      expect(txt).toContain('Next follow-up');
      expect(txt).toContain('MCI-789');
    });

    test('long advice notes from acceptance criteria render without breaking layout', async () => {
      const longAdvice =
        'Patient should follow a strict scalp-care regimen: gentle shampoo every other day, ' +
        'avoid hot water, no chemical treatments for 12 weeks. Apply prescribed topicals as ' +
        'directed; do not exceed dosage. Report any signs of allergic reaction including ' +
        'redness, itching, swelling, or shortness of breath immediately. Avoid direct sun ' +
        'exposure on treated areas for at least 14 days post-procedure. Maintain a balanced ' +
        'diet rich in iron, zinc, and B-complex vitamins. Hydrate well — minimum 2L water/day. ' +
        'Sleep on a clean pillowcase; rotate every 2 days. Stress management is critical — ' +
        'consider meditation or yoga. Schedule the follow-up exactly as advised; missed ' +
        'follow-ups may delay assessment of treatment efficacy.';
      const buf = await renderPrescriptionPdf(
        { drugs: [{ name: 'X', dosage: 'Y', frequency: 'Z', duration: 'W' }], instructions: longAdvice },
        patientFixture(),
        clinicFixture(),
      );
      expect(Buffer.isBuffer(buf)).toBe(true);
      const txt = extractPdfText(buf);
      expect(txt).toContain('strict scalp-care regimen');
      expect(txt).toContain('follow-ups may delay');
    });
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

// ── generateTravelQuotePdf (DD-5.6) ─────────────────────────────────
//
// Travel-quote PDF — sub-brand-aware header, currency-aware money
// rendering (DD-5.4), tax-treatment branching (DD-5.3, 'inclusive' →
// "Includes GST" footnote; 'exclusive' → GST line item), validity-date
// footer. No DB calls (pure function over a quote-object).

function travelQuoteFixture(overrides = {}) {
  return {
    id: 42,
    quoteNumber: 'TQ-2026-0042',
    subBrand: 'tmc',
    customerName: 'Anita Roy',
    customerEmail: 'anita@example.com',
    customerPhone: '+919876543210',
    status: 'Sent',
    issuedDate: '2026-05-20',
    validUntil: '2026-06-20',
    items: [
      { description: 'School trip — Delhi 5D/4N', qty: 30, unitPrice: 18500, totalPrice: 555000 },
      { description: 'Travel insurance (per pax)', qty: 30, unitPrice: 350, totalPrice: 10500 },
    ],
    subtotal: 565500,
    gstAmount: 28275,
    totalAmount: 593775,
    currency: 'INR',
    taxTreatment: 'exclusive',
    ...overrides,
  };
}

describe('generateTravelQuotePdf', () => {
  test('returns a non-empty PDF Buffer (happy path)', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(800);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('renders quote number, customer name, and status in the document', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture());
    const txt = extractPdfText(buf);
    expect(txt).toContain('TQ-2026-0042');
    expect(txt).toContain('Anita Roy');
    expect(txt).toContain('Sent');
    expect(txt).toContain('QUOTE');
  });

  test('sub-brand label appears in branded header (tmc → "TMC")', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({ subBrand: 'tmc' }));
    const txt = extractPdfText(buf);
    // SUB_BRAND_LABEL.tmc = "TMC — School Trips"; the em-dash is outside
    // WinAnsi so the extractor splits the label, but "TMC" + "School Trips"
    // both survive intact.
    expect(txt).toContain('TMC');
    expect(txt).toContain('School Trips');
  });

  test('sub-brand label switches per quote.subBrand (rfu → "RFU" + "Umrah")', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({ subBrand: 'rfu' }));
    const txt = extractPdfText(buf);
    expect(txt).toContain('RFU');
    expect(txt).toContain('Umrah');
  });

  test('sub-brand fallback for unknown sub-brand → "Travel CRM"', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({ subBrand: 'unknown-brand' }));
    const txt = extractPdfText(buf);
    expect(txt).toContain('Travel CRM');
  });

  test('DD-5.3 inclusive → "Includes GST" footnote present; no GST line item', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      taxTreatment: 'inclusive',
      gstAmount: 0,
      totalAmount: 565500,
    }));
    const txt = extractPdfText(buf);
    expect(txt).toContain('Includes GST');
    // Subtotal and Total are always shown; with inclusive treatment the
    // standalone "GST" line item must NOT appear between them. We check
    // that "GST" only appears inside the "Includes GST" footnote — the
    // bare "GST" line label is absent. A targeted check: count "GST"
    // occurrences; exactly one (the footnote) is expected.
    const gstHits = txt.match(/GST/g) || [];
    expect(gstHits.length).toBe(1);
  });

  test('DD-5.3 exclusive → standalone GST line item shown after subtotal', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      taxTreatment: 'exclusive',
      subtotal: 100000,
      gstAmount: 18000,
      totalAmount: 118000,
    }));
    const txt = extractPdfText(buf);
    expect(txt).toContain('Subtotal');
    expect(txt).toContain('GST');
    // The GST amount line should render — verify the value made it in.
    expect(txt).toContain('18000.00');
    // Exclusive treatment must NOT render the "Includes GST" footnote.
    expect(txt).not.toContain('Includes GST');
  });

  test('DD-5.4 currency=INR renders ₹ symbol', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      currency: 'INR',
      items: [{ description: 'INR item', qty: 1, unitPrice: 1234.5, totalPrice: 1234.5 }],
      subtotal: 1234.5,
      gstAmount: 0,
      totalAmount: 1234.5,
      taxTreatment: 'inclusive',
    }));
    // The ₹ glyph (U+20B9) is outside the latin1 range pdfkit's WinAnsi
    // encoding handles; we verify the amount renders + the currency-
    // mapping path was taken by checking the formatted value is present
    // and the USD-style "$" prefix is absent.
    const txt = extractPdfText(buf);
    expect(txt).toContain('1234.50');
    expect(txt).not.toContain('$1234.50');
  });

  test('DD-5.4 currency=USD renders $ symbol verbatim', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      currency: 'USD',
      items: [{ description: 'USD item', qty: 2, unitPrice: 500, totalPrice: 1000 }],
      subtotal: 1000,
      gstAmount: 0,
      totalAmount: 1000,
      taxTreatment: 'inclusive',
    }));
    const txt = extractPdfText(buf);
    // $ is ASCII so it survives extraction intact.
    expect(txt).toContain('$1000.00');
    expect(txt).toContain('$500.00');
  });

  test('DD-5.4 unknown currency code (EUR) prefixed verbatim', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      currency: 'EUR',
      items: [{ description: 'EUR item', qty: 1, unitPrice: 750, totalPrice: 750 }],
      subtotal: 750,
      gstAmount: 0,
      totalAmount: 750,
      taxTreatment: 'inclusive',
    }));
    const txt = extractPdfText(buf);
    expect(txt).toContain('EUR 750.00');
  });

  test('renders all item descriptions in the items table', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture());
    const txt = extractPdfText(buf);
    expect(txt).toContain('School trip');
    expect(txt).toContain('Travel insurance');
  });

  test('renders "Valid until <date>" footer line', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      validUntil: '2026-06-20',
    }));
    const txt = extractPdfText(buf);
    expect(txt).toContain('Valid until');
    expect(txt).toContain('Jun 2026');
  });

  test('renders signature block placeholder', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture());
    const txt = extractPdfText(buf);
    expect(txt).toContain('Authorised signature');
  });

  test('BrandKit.logoUrl renders as a text placeholder (no fetch)', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      brandKit: { logoUrl: 'https://cdn.example.com/tmc-logo.png', accent: '#0B4F6C' },
    }));
    const txt = extractPdfText(buf);
    expect(txt).toContain('Logo:');
    expect(txt).toContain('tmc-logo.png');
    // Sanity: PDF has no /Subtype /Image (we did NOT fetch + embed).
    expect(buf.toString('latin1')).not.toContain('/Subtype /Image');
  });

  test('handles empty items list without throwing', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      items: [],
      subtotal: 0,
      gstAmount: 0,
      totalAmount: 0,
    }));
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('No line items');
  });

  test('falls back to "Draft" status when none supplied', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({ status: undefined }));
    const txt = extractPdfText(buf);
    expect(txt).toContain('Draft');
  });

  test('handles null quote input gracefully (no throw)', async () => {
    const buf = await generateTravelQuotePdf(null);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(300);
  });

  test('computes subtotal from items when not provided explicitly', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      items: [{ description: 'A', qty: 2, unitPrice: 100, totalPrice: 200 }],
      subtotal: undefined,
      gstAmount: 0,
      totalAmount: undefined,
      taxTreatment: 'inclusive',
      currency: 'USD',
    }));
    const txt = extractPdfText(buf);
    // Total = 200 (sum of items.totalPrice), rendered as $200.00.
    expect(txt).toContain('$200.00');
  });

  test('default taxTreatment is exclusive when field absent', async () => {
    const buf = await generateTravelQuotePdf(travelQuoteFixture({
      taxTreatment: undefined,
      subtotal: 100,
      gstAmount: 18,
      totalAmount: 118,
      currency: 'USD',
    }));
    const txt = extractPdfText(buf);
    // Exclusive path → GST line item should appear (not the footnote).
    expect(txt).not.toContain('Includes GST');
    expect(txt).toContain('GST');
    expect(txt).toContain('$18.00');
  });
});

// ── Pure helpers — voucher subtype / service-range / traveller list ──
//
// These three helpers are exported off the module for unit-level
// coverage of the slice-18 voucher-detail contract. They're pure
// (no PDF stream, no I/O), so we can hit every branch quickly.

describe('voucherSubtypeForLine', () => {
  test('per_night and per_room both map to "Hotel"', () => {
    expect(voucherSubtypeForLine('per_night')).toBe('Hotel');
    expect(voucherSubtypeForLine('per_room')).toBe('Hotel');
  });

  test('per_pax maps to "Activity"', () => {
    expect(voucherSubtypeForLine('per_pax')).toBe('Activity');
  });

  test('per_trip maps to "Transfer"', () => {
    expect(voucherSubtypeForLine('per_trip')).toBe('Transfer');
  });

  test('addon maps to "Add-on"', () => {
    expect(voucherSubtypeForLine('addon')).toBe('Add-on');
  });

  test('other maps to "Service"', () => {
    expect(voucherSubtypeForLine('other')).toBe('Service');
  });

  test('unknown lineType (defensive) returns the literal string', () => {
    expect(voucherSubtypeForLine('per_visa')).toBe('per_visa');
  });

  test('null / undefined lineType falls back to "Service"', () => {
    expect(voucherSubtypeForLine(null)).toBe('Service');
    expect(voucherSubtypeForLine(undefined)).toBe('Service');
  });
});

describe('formatVoucherServiceRange', () => {
  test('start + end same day collapses to single date', () => {
    const range = formatVoucherServiceRange('2026-06-01', '2026-06-01');
    expect(range).toContain('Jun');
    expect(range).not.toContain('→');
  });

  test('multi-day range renders with arrow separator', () => {
    const range = formatVoucherServiceRange('2026-06-01', '2026-06-07');
    expect(range).toContain('→');
    expect(range).toContain('Jun');
  });

  test('start only renders the start date verbatim', () => {
    const range = formatVoucherServiceRange('2026-06-01', null);
    expect(range).toContain('Jun');
    expect(range).not.toContain('→');
  });

  test('end only renders the end date verbatim', () => {
    const range = formatVoucherServiceRange(null, '2026-06-07');
    expect(range).toContain('Jun');
    expect(range).not.toContain('→');
  });

  test('both null returns em-dash placeholder', () => {
    expect(formatVoucherServiceRange(null, null)).toBe('—');
    expect(formatVoucherServiceRange(undefined, undefined)).toBe('—');
  });
});

describe('extractTravellerListFromInvoice', () => {
  test('honours invoice.travellerList as array (joined with ", ")', () => {
    const out = extractTravellerListFromInvoice(
      { travellerList: ['Alice', 'Bob', 'Charlie'] },
      [],
    );
    expect(out).toBe('Alice, Bob, Charlie');
  });

  test('honours invoice.travellerList as string verbatim', () => {
    const out = extractTravellerListFromInvoice(
      { travellerList: 'X, Y, Z' },
      [],
    );
    expect(out).toBe('X, Y, Z');
  });

  test('falls back to parsing line.notes "Travellers: ..." (case-insensitive)', () => {
    const out = extractTravellerListFromInvoice(
      {},
      [{ notes: 'Travellers: Dave, Erin' }],
    );
    expect(out).toBe('Dave, Erin');
  });

  test('handles singular "Traveller: ..." form', () => {
    const out = extractTravellerListFromInvoice(
      {},
      [{ notes: 'Traveller: Solo Pax' }],
    );
    expect(out).toBe('Solo Pax');
  });

  test('first match wins when multiple lines repeat the list', () => {
    const out = extractTravellerListFromInvoice(
      {},
      [
        { notes: 'Travellers: First, Match' },
        { notes: 'Travellers: Second, Match' },
      ],
    );
    expect(out).toBe('First, Match');
  });

  test('skips lines without notes and lines whose notes do not match the regex', () => {
    const out = extractTravellerListFromInvoice(
      {},
      [
        { notes: '' },
        null,
        { notes: 'no traveller marker here' },
        { notes: 'Travellers: Found, It' },
      ],
    );
    expect(out).toBe('Found, It');
  });

  test('empty array travellerList falls through to em-dash when no notes match', () => {
    const out = extractTravellerListFromInvoice(
      { travellerList: [] },
      [],
    );
    expect(out).toBe('—');
  });

  test('trims whitespace-only string travellerList and falls through', () => {
    const out = extractTravellerListFromInvoice(
      { travellerList: '   ' },
      [],
    );
    expect(out).toBe('—');
  });

  test('returns em-dash when nothing supplies a traveller list', () => {
    expect(extractTravellerListFromInvoice(null, null)).toBe('—');
    expect(extractTravellerListFromInvoice({}, [])).toBe('—');
  });
});

// ── renderFullPatientReportPdf ──────────────────────────────────────
//
// Consolidated patient record (header + profile + visits + Rx + consents
// + treatment plans + photos + inventory). Largest renderer in the file
// after the travel-invoice path — six sections + per-section empty/full
// branches + page-break logic.

describe('renderFullPatientReportPdf', () => {
  test('returns a non-empty PDF Buffer with %PDF magic (happy path empty)', async () => {
    const buf = await renderFullPatientReportPdf({}, clinicFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(800);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('handles null payload gracefully (no throw, default sections empty)', async () => {
    const buf = await renderFullPatientReportPdf(null, clinicFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('Patient Record');
    // All six empty-state placeholders render.
    expect(txt).toContain('no visits on file');
    expect(txt).toContain('no prescriptions on file');
    expect(txt).toContain('no consents on file');
    expect(txt).toContain('no treatment plans on file');
    expect(txt).toContain('no photos on file');
    expect(txt).toContain('no inventory consumed');
  });

  test('renders patient profile fields (name / phone / email / gender / blood group / source)', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: {
          name: 'Anita Roy',
          phone: '+919876500000',
          email: 'anita@example.com',
          dob: '1985-04-12',
          gender: 'female',
          bloodGroup: 'O+',
          source: 'instagram',
          createdAt: '2024-01-15',
        },
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Anita Roy');
    expect(txt).toContain('+919876500000');
    expect(txt).toContain('anita@example.com');
    expect(txt).toContain('female');
    expect(txt).toContain('O+');
    expect(txt).toContain('instagram');
  });

  test('renders Allergies block when patient.allergies present', async () => {
    const buf = await renderFullPatientReportPdf(
      { patient: { name: 'X', allergies: 'penicillin, sulfa drugs' } },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Allergies');
    expect(txt).toContain('penicillin');
  });

  test('omits Allergies block when not provided', async () => {
    const buf = await renderFullPatientReportPdf(
      { patient: { name: 'X' } },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).not.toContain('Allergies');
  });

  test('renders operator name in header and footer when provided', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        operator: { name: 'Dr. Operator' },
        generatedAt: '2026-04-15T10:00:00Z',
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Dr. Operator');
    expect(txt).toContain('Apr 2026');
  });

  test('renders visits with doctor, charge, and notes', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        visits: [
          {
            visitDate: '2026-04-01',
            service: { name: 'Hair Consultation' },
            status: 'completed',
            doctor: { name: 'Dr. Harsh' },
            amountCharged: 1500,
            notes: 'Initial assessment done.',
          },
        ],
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Hair Consultation');
    expect(txt).toContain('completed');
    expect(txt).toContain('Dr. Harsh');
    expect(txt).toContain('Initial assessment');
  });

  test('renders prescriptions with drugs (array form) and instructions', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        prescriptions: [
          {
            createdAt: '2026-04-15',
            doctor: { name: 'Dr. R' },
            drugs: [{ name: 'Minoxidil 5%', dosage: '1ml', frequency: 'BID', duration: '3m' }],
            instructions: 'Apply to scalp',
          },
        ],
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Minoxidil');
    expect(txt).toContain('Apply to scalp');
  });

  test('renders prescriptions placeholder when drugs list is empty', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        prescriptions: [{ createdAt: '2026-04-15', drugs: [] }],
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('no medications listed');
  });

  test('renders consents with template name and service', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        consents: [
          {
            signedAt: '2026-04-10',
            templateName: 'hair-transplant',
            service: { name: 'FUE Procedure' },
          },
        ],
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('hair transplant');
    expect(txt).toContain('FUE Procedure');
  });

  test('consent signatureSvg with valid data-URL renders without throwing', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        consents: [
          {
            signedAt: '2026-04-10',
            templateName: 'general',
            signatureSvg: TINY_PNG_DATA_URL,
          },
        ],
      },
      clinicFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Image XObject embedded.
    expect(buf.toString('latin1')).toContain('/Subtype /Image');
  });

  test('consent signatureSvg with corrupt base64 is swallowed (no throw)', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        consents: [
          {
            signedAt: '2026-04-10',
            templateName: 'general',
            signatureSvg: 'data:image/png;base64,@@@invalid@@@',
          },
        ],
      },
      clinicFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test('renders treatment plans with session progress + plan total', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        treatmentPlans: [
          {
            name: 'GFC 6-session Plan',
            status: 'active',
            completedSessions: 2,
            totalSessions: 6,
            startedAt: '2026-01-15',
            nextDueAt: '2026-05-15',
            totalPrice: 60000,
          },
        ],
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('GFC 6-session Plan');
    expect(txt).toContain('active');
    expect(txt).toContain('Sessions:');
    expect(txt).toContain('2/6');
  });

  test('treatment plan falls back to service.name and default "active" status', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        treatmentPlans: [
          { service: { name: 'Fallback Service Name' } },
        ],
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Fallback Service Name');
    expect(txt).toContain('active');
  });

  test('renders photos counts with before/after URLs', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        photos: [
          {
            visitDate: '2026-04-01',
            before: ['https://cdn.example.com/before1.jpg', 'https://cdn.example.com/before2.jpg'],
            after: ['https://cdn.example.com/after1.jpg'],
          },
        ],
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Before:');
    expect(txt).toContain('After:');
    expect(txt).toContain('before1.jpg');
    expect(txt).toContain('after1.jpg');
  });

  test('renders inventory table with grand total summed from qty*unitCost', async () => {
    const buf = await renderFullPatientReportPdf(
      {
        patient: { name: 'X' },
        consumptions: [
          { visitDate: '2026-04-01', productName: 'PRP Kit', qty: 2, unitCost: 1500 },
          { visitDate: '2026-04-02', productName: 'Numbing Gel', qty: 1, unitCost: 500 },
        ],
      },
      clinicFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('PRP Kit');
    expect(txt).toContain('Numbing Gel');
    expect(txt).toContain('Total:');
    // grand total = 2*1500 + 1*500 = 3500
    expect(txt).toContain('3500');
  });

  test('long visits list paginates (50 visits triggers second page)', async () => {
    const visits = [];
    for (let i = 0; i < 50; i++) {
      visits.push({
        visitDate: '2026-04-01',
        service: { name: `Visit-${i}` },
        notes: 'lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      });
    }
    const buf = await renderFullPatientReportPdf(
      { patient: { name: 'X' }, visits },
      clinicFixture(),
    );
    const raw = buf.toString('latin1');
    expect(raw).toMatch(/\/Count\s+[2-9]/);
  });
});

// ── renderTravelDiagnosticPdf ───────────────────────────────────────

function diagnosticFixture(overrides = {}) {
  return {
    subBrand: 'tmc',
    score: 78.5,
    classification: 'TIER_A',
    classificationLabel: 'Tier A — School + Cultural',
    recommendedTier: 'Premium',
    answersJson: JSON.stringify({ q1: 'a', q2: ['x', 'y'] }),
    createdAt: '2026-05-10',
    ...overrides,
  };
}

function diagnosticBankFixture(overrides = {}) {
  return {
    version: 3,
    questionsJson: JSON.stringify({
      questions: [
        { id: 'q1', text: 'Group size?', options: [{ value: 'a', label: '10-20 students' }] },
        { id: 'q2', text: 'Preferred regions?', options: [{ value: 'x', label: 'North India' }, { value: 'y', label: 'West India' }] },
      ],
    }),
    ...overrides,
  };
}

describe('renderTravelDiagnosticPdf', () => {
  test('returns a non-empty PDF Buffer (happy path)', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture(),
      { name: 'Test User', email: 't@example.com', phone: '+91999' },
      diagnosticBankFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('renders contact name + email + phone in header block', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture(),
      { name: 'Anita Roy', email: 'anita@example.com', phone: '+919876500000' },
      diagnosticBankFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Anita Roy');
    expect(txt).toContain('anita@example.com');
    expect(txt).toContain('+919876500000');
  });

  test('renders classificationLabel and recommendedTier in result band', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ classificationLabel: 'Tier A', recommendedTier: 'Premium' }),
      { name: 'X' },
      diagnosticBankFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Tier A');
    expect(txt).toContain('Recommended tier');
    expect(txt).toContain('Premium');
  });

  test('falls back to classification when classificationLabel missing', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ classification: 'TIER_B', classificationLabel: undefined }),
      { name: 'X' },
      diagnosticBankFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('TIER_B');
  });

  test('renders score formatted to 2 decimal places', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ score: 42 }),
      { name: 'X' },
      diagnosticBankFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('42.00');
  });

  test('handles missing bank gracefully ("No question bank snapshot available")', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture(),
      { name: 'X' },
      null,
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('No question bank snapshot available');
  });

  test('handles malformed bank.questionsJson without throwing', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture(),
      { name: 'X' },
      { version: 1, questionsJson: '{not json' },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('No question bank snapshot available');
  });

  test('handles malformed answersJson without throwing', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ answersJson: '{not json' }),
      { name: 'X' },
      diagnosticBankFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test('resolves multi-select answer (array) via option label lookup', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({
        answersJson: JSON.stringify({ q2: ['x', 'y'] }),
      }),
      { name: 'X' },
      diagnosticBankFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('North India');
    expect(txt).toContain('West India');
  });

  test('renders questions with their text + numbered prefix', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture(),
      { name: 'X' },
      diagnosticBankFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Group size?');
    expect(txt).toContain('Preferred regions?');
  });

  test('sub-brand fallback for unknown sub-brand → "Travel CRM"', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ subBrand: 'unknown-brand' }),
      { name: 'X' },
      diagnosticBankFixture(),
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Travel CRM');
  });

  test('renders bank version (v?) when bank.version undefined', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture(),
      { name: 'X' },
      { questionsJson: '{"questions":[]}' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Bank version');
    // Unknown version renders as "?".
    expect(txt).toContain('v?');
  });
});

// ── renderTravelItineraryPdf ────────────────────────────────────────

function itineraryFixture(overrides = {}) {
  return {
    id: 99,
    subBrand: 'rfu',
    version: 2,
    destination: 'Makkah & Madinah',
    startDate: '2026-08-01',
    endDate: '2026-08-15',
    totalAmount: 350000,
    currency: 'INR',
    items: [
      { itemType: 'flight', description: 'BOM-JED return', position: 1, unitCost: 60000, markup: 5000, totalPrice: 65000 },
      { itemType: 'hotel', description: 'Makkah 5-star (7 nights)', position: 2, unitCost: 80000, markup: 8000, totalPrice: 88000 },
    ],
    ...overrides,
  };
}

describe('renderTravelItineraryPdf', () => {
  test('returns a non-empty PDF Buffer (happy path)', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture(),
      { name: 'Pilgrim One', email: 'p@example.com', phone: '+919876500000' },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('renders sub-brand label (rfu → "RFU" + "Umrah")', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ subBrand: 'rfu' }),
      { name: 'X' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('RFU');
    expect(txt).toContain('Umrah');
  });

  test('renders itinerary version in header band', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ version: 7 }),
      { name: 'X' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Itinerary v7');
  });

  test('renders destination + date range in trip-summary block', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({
        destination: 'Bali',
        startDate: '2026-09-01',
        endDate: '2026-09-08',
      }),
      { name: 'X' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Bali');
    // formatDate renders en-IN long-form: "Sep" or "Sept" depending on
    // ICU/locale data; accept either form.
    expect(txt).toMatch(/Sept?\s+2026/);
  });

  test('renders all item descriptions, sorted by position', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({
        items: [
          { itemType: 'activity', description: 'ZZZ-Last', position: 99, totalPrice: 100 },
          { itemType: 'flight', description: 'AAA-First', position: 1, totalPrice: 200 },
        ],
      }),
      { name: 'X' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('AAA-First');
    expect(txt).toContain('ZZZ-Last');
    // Sorted ascending — AAA-First appears in output before ZZZ-Last.
    expect(txt.indexOf('AAA-First')).toBeLessThan(txt.indexOf('ZZZ-Last'));
  });

  test('placeholder when items list is empty (quote pending)', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ items: [] }),
      { name: 'X' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('No items on this itinerary yet');
    expect(txt).toContain('quote pending');
  });

  test('items with missing prices render as em-dash', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({
        items: [{ itemType: 'visa', description: 'Visa fee TBD', position: 1 }],
      }),
      { name: 'X' },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('Visa fee TBD');
  });

  test('renders Grand total band when totalAmount supplied', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ totalAmount: 350000, currency: 'USD' }),
      { name: 'X' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Grand total');
    expect(txt).toContain('$350000.00');
  });

  test('omits Grand total band when totalAmount missing', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ totalAmount: null, totalPrice: null }),
      { name: 'X' },
    );
    const txt = extractPdfText(buf);
    expect(txt).not.toContain('Grand total');
  });

  test('falls back to "Destination TBD" when destination missing', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ destination: undefined }),
      { name: 'X' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Destination TBD');
  });

  test('renders footer with itinerary ID + version', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ id: 555, version: 3 }),
      { name: 'X' },
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('555');
    // Version reappears in footer text.
    expect(txt).toContain('v3');
  });

  test('falls back to "Customer" when contact has no name', async () => {
    const buf = await renderTravelItineraryPdf(
      itineraryFixture(),
      null,
    );
    const txt = extractPdfText(buf);
    expect(txt).toContain('Customer');
  });

  test('long item list paginates (40 items triggers extra page)', async () => {
    const items = [];
    for (let i = 0; i < 40; i++) {
      items.push({
        itemType: 'hotel',
        description: `Item-${i}`,
        position: i,
        unitCost: 1000,
        totalPrice: 1000,
      });
    }
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ items }),
      { name: 'X' },
    );
    const raw = buf.toString('latin1');
    expect(raw).toMatch(/\/Count\s+[2-9]/);
  });
});

// ── renderTravelStallPersonalisedPdf ────────────────────────────────

describe('renderTravelStallPersonalisedPdf', () => {
  test('returns a non-empty PDF Buffer (happy path)', async () => {
    const buf = await renderTravelStallPersonalisedPdf({
      contact: { name: 'Family One', email: 'f@example.com' },
      destinations: ['Bali', 'Phuket', 'Maldives'],
      budget: 200000,
      durationDays: 7,
      proseText: 'Personalised paragraph here.',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('renders Travel Stall sub-brand label', async () => {
    const buf = await renderTravelStallPersonalisedPdf({
      contact: { name: 'X' },
      destinations: ['A'],
      proseText: 'p',
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Travel Stall');
    expect(txt).toContain('Personalised Recommendations');
  });

  test('renders trip parameters band (duration / budget / tier)', async () => {
    const buf = await renderTravelStallPersonalisedPdf({
      contact: { name: 'X' },
      destinations: ['A'],
      budget: 150000,
      durationDays: 5,
      diagnostic: { recommendedTier: 'Premium' },
      proseText: 'p',
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('5 day');
    expect(txt).toContain('150000');
    expect(txt).toContain('Premium');
  });

  test('clamps destinations to 5 visible (10 in → 5 rendered, rest dropped)', async () => {
    const dests = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const buf = await renderTravelStallPersonalisedPdf({
      contact: { name: 'X' },
      destinations: dests,
      proseText: 'p',
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('A');
    expect(txt).toContain('E');
    expect(txt).not.toContain('Destination F');
  });

  test('handles empty destinations list (no throw)', async () => {
    const buf = await renderTravelStallPersonalisedPdf({
      contact: { name: 'X' },
      destinations: [],
      proseText: 'p',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test('handles null payload defensively', async () => {
    const buf = await renderTravelStallPersonalisedPdf(null);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test('day-1 (durationDays=1) pluralisation: "1 day" not "1 days"', async () => {
    const buf = await renderTravelStallPersonalisedPdf({
      contact: { name: 'X' },
      destinations: ['A'],
      durationDays: 1,
      proseText: 'p',
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('1 day');
    expect(txt).not.toContain('1 days');
  });

  test('omits params band when all trip params absent', async () => {
    const buf = await renderTravelStallPersonalisedPdf({
      contact: { name: 'X' },
      destinations: ['A'],
      proseText: 'p',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).not.toContain('Budget:');
    expect(txt).not.toContain('Tier:');
  });
});

// ── renderTravelInvoicePdf / generateTravelInvoicePdf ───────────────

function travelLineFixture(overrides = {}) {
  return {
    description: 'Default line',
    lineType: 'per_pax',
    quantity: 2,
    unitPrice: 5000,
    amount: 10000,
    gstPercent: 18,
    taxableValue: 10000,
    ...overrides,
  };
}

function travelInvoiceFixture(overrides = {}) {
  return {
    id: 7001,
    invoiceNum: 'TINV-2026-0042',
    subBrand: 'tmc',
    docType: 'TaxInvoice',
    contactName: 'Anita Roy',
    contactEmail: 'anita@example.com',
    contactPhone: '+919876500000',
    issuedDate: '2026-05-01',
    dueDate: '2026-05-15',
    status: 'Sent',
    currency: 'INR',
    totalAmount: 11800,
    placeOfSupplyInterstate: false,
    ...overrides,
  };
}

describe('renderTravelInvoicePdf', () => {
  test('returns a non-empty PDF Buffer (happy path TaxInvoice)', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture(),
      lines: [travelLineFixture()],
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('docType=TaxInvoice → header reads "TAX INVOICE" + GST footer line', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ docType: 'TaxInvoice' }),
      lines: [travelLineFixture()],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('TAX INVOICE');
    expect(txt).toContain('GST Rules');
  });

  test('docType=Proforma → header reads "PROFORMA INVOICE" + proforma legal text', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ docType: 'Proforma' }),
      lines: [travelLineFixture()],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('PROFORMA INVOICE');
    expect(txt).toContain('Proforma Invoice');
    expect(txt).toContain('not a tax invoice');
  });

  test('docType=CreditNote → header + footer text', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ docType: 'CreditNote' }),
      lines: [travelLineFixture()],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('CREDIT NOTE');
    expect(txt).toContain('reduces customer payable');
  });

  test('docType=DebitNote → header + footer text', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ docType: 'DebitNote' }),
      lines: [travelLineFixture()],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('DEBIT NOTE');
    expect(txt).toContain('increases customer payable');
  });

  test('docType=TravelVoucher → header + Voucher Details block rendered', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({
        docType: 'TravelVoucher',
        travellerList: ['Alice', 'Bob'],
      }),
      lines: [
        {
          description: 'Hotel 3 nights',
          lineType: 'per_night',
          bookingRef: 'HRB-12345',
          serviceStartDate: '2026-06-01',
          serviceEndDate: '2026-06-04',
          quantity: 3,
          unitPrice: 5000,
          amount: 15000,
          gstPercent: 18,
        },
      ],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('TRAVEL VOUCHER');
    expect(txt).toContain('Voucher Details');
    expect(txt).toContain('Travellers');
    expect(txt).toContain('Alice');
    expect(txt).toContain('Bob');
    expect(txt).toContain('Hotel');
    expect(txt).toContain('HRB-12345');
    expect(txt).toContain('non-billable');
  });

  test('TravelVoucher with no fulfillment lines shows placeholder text', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ docType: 'TravelVoucher' }),
      lines: [],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Voucher Details');
    expect(txt).toContain('No fulfillment lines yet');
  });

  test('TravelVoucher: tax-typed lines are NOT rendered in voucher rows', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ docType: 'TravelVoucher' }),
      lines: [
        { description: 'GST charge', lineType: 'tax', amount: 1800 },
        // Without any fulfillment line, the empty-state placeholder kicks in.
      ],
    });
    const txt = extractPdfText(buf);
    // Tax lines excluded → placeholder appears
    expect(txt).toContain('No fulfillment lines yet');
  });

  test('TravelVoucher: traveller list parsed from line notes when invoice.travellerList absent', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ docType: 'TravelVoucher' }),
      lines: [
        {
          description: 'Hotel',
          lineType: 'per_night',
          notes: 'Travellers: Charlie, Dana',
          bookingRef: 'B-1',
          serviceStartDate: '2026-06-01',
          serviceEndDate: '2026-06-03',
        },
      ],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Charlie');
    expect(txt).toContain('Dana');
  });

  test('docType absent (back-compat) defaults to TaxInvoice', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ docType: undefined }),
      lines: [travelLineFixture()],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('TAX INVOICE');
  });

  test('intra-state default → CGST/SGST split rendered in GST cell', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ placeOfSupplyInterstate: false }),
      lines: [travelLineFixture({ gstPercent: 18, taxableValue: 1000, amount: 1000 })],
    });
    const txt = extractPdfText(buf);
    // PDFKit may wrap "CGST/SGST" into "CGST/" + "SGST" across two
    // text-positioning operators when the GST cell is narrow; accept
    // either compact or wrapped forms.
    expect(txt).toMatch(/CGST\/\s*SGST/);
    expect(txt).toContain('9+9%');
  });

  test('inter-state → IGST line rendered in GST cell', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ placeOfSupplyInterstate: true }),
      lines: [travelLineFixture({ gstPercent: 18, taxableValue: 1000, amount: 1000 })],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('IGST');
    expect(txt).toContain('18%');
  });

  test('GST=0 line renders em-dash in GST cell (no split)', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture(),
      lines: [travelLineFixture({ gstPercent: 0 })],
    });
    const txt = extractPdfText(buf);
    // The em-dash is outside WinAnsi so it doesn't survive; we instead
    // confirm the GST split tokens are absent for this single line.
    expect(txt).not.toMatch(/CGST\/\s*SGST/);
    expect(txt).not.toContain('IGST');
  });

  test('GST=5% (odd half) renders CGST/SGST as "2.5+2.5%"', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ placeOfSupplyInterstate: false }),
      lines: [travelLineFixture({ gstPercent: 5 })],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('2.5+2.5%');
  });

  test('currency=USD renders "$" prefix in money cells', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ currency: 'USD', totalAmount: 1000 }),
      lines: [travelLineFixture({ amount: 1000, taxableValue: 1000, gstPercent: 0 })],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('$1000.00');
  });

  test('currency=GBP renders "£" pound-sign verbatim is replaced by "£" — verify amount survives', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ currency: 'GBP', totalAmount: 500 }),
      lines: [travelLineFixture({ amount: 500, taxableValue: 500, gstPercent: 0 })],
    });
    const txt = extractPdfText(buf);
    // £ is outside WinAnsi; verify the dollar prefix is NOT used and the
    // GBP amount made it through (500.00 substring suffices).
    expect(txt).toContain('500.00');
    expect(txt).not.toContain('$500.00');
  });

  test('unknown currency code falls back to "CODE NNN.NN" verbatim', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ currency: 'AED', totalAmount: 750 }),
      lines: [travelLineFixture({ amount: 750, taxableValue: 750, gstPercent: 0 })],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('AED 750.00');
  });

  test('Bill-To block renders contact name + email + phone', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture(),
      lines: [travelLineFixture()],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Bill To');
    expect(txt).toContain('Anita Roy');
    expect(txt).toContain('anita@example.com');
    expect(txt).toContain('+919876500000');
  });

  test('renders empty line items placeholder when no lines', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture(),
      lines: [],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('No line items on this invoice');
  });

  test('accepts invoice.lines form (row-with-attached-lines)', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: { ...travelInvoiceFixture(), lines: [travelLineFixture()] },
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    const txt = extractPdfText(buf);
    expect(txt).toContain('Default line');
  });

  test('renders Payment Terms section with dueDate-formatted message', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ dueDate: '2026-05-30', invoiceNum: 'PT-1' }),
      lines: [travelLineFixture()],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Payment Terms');
    expect(txt).toContain('Payment is due');
    expect(txt).toContain('May 2026');
  });

  test('falls back to generic Payment Terms when dueDate absent', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ dueDate: undefined }),
      lines: [travelLineFixture()],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Please quote the invoice number');
  });

  test('renders tenant name in footer when supplied', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture(),
      lines: [travelLineFixture()],
      tenant: { name: 'Globussoft Demo Tenant' },
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Globussoft Demo Tenant');
  });

  test('generateTravelInvoicePdf alias is the same function reference', () => {
    expect(generateTravelInvoicePdf).toBe(renderTravelInvoicePdf);
  });

  test('handles null opts defensively (no throw)', async () => {
    const buf = await renderTravelInvoicePdf(null);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test('falls back to invoice.id when invoiceNum missing', async () => {
    const buf = await renderTravelInvoicePdf({
      invoice: travelInvoiceFixture({ invoiceNum: undefined, id: 90210 }),
      lines: [travelLineFixture()],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('90210');
  });
});

// ── generatePosReceiptPdf ───────────────────────────────────────────

describe('generatePosReceiptPdf', () => {
  function saleFixture(overrides = {}) {
    return {
      id: 4242,
      currency: 'INR',
      subtotal: 1000,
      discount: 0,
      tax: 0,
      grandTotal: 1000,
      completedAt: '2026-04-15T10:00:00Z',
      ...overrides,
    };
  }

  test('returns a non-empty PDF Buffer (happy path)', async () => {
    const buf = generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'Service', qty: 1, unitPrice: 1000, lineTotal: 1000 }],
      payments: [{ method: 'cash', amount: 1000 }],
      patient: { name: 'Walk-in', phone: '+919876500000' },
      tenant: clinicFixture(),
    });
    // Note: generatePosReceiptPdf returns a Promise<Buffer> (the
    // internal streamToBuffer is awaitable), so await it.
    return buf.then((result) => {
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBeGreaterThan(500);
      expect(result.slice(0, 4).toString()).toBe('%PDF');
    });
  });

  test('renders RECEIPT header + invoice number "INV-{id}"', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ id: 9876 }),
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [{ method: 'card', amount: 100 }],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('RECEIPT');
    expect(txt).toContain('INV-9876');
  });

  test('renders tenant name + address + contact block', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Enhanced Wellness');
    expect(txt).toContain('Mumbai');
    expect(txt).toContain('hello@enhancedwellness.in');
  });

  test('renders Customer block when patient provided', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [],
      patient: { name: 'Test Patient', phone: '+919876500000' },
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Customer');
    expect(txt).toContain('Test Patient');
    expect(txt).toContain('+919876500000');
  });

  test('omits Customer block when patient missing', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).not.toContain('Customer');
  });

  test('renders line items table with description, qty, unit, total', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [
        { description: 'Haircut', qty: 1, unitPrice: 500, lineTotal: 500 },
        { description: 'Shampoo', qty: 2, unitPrice: 250, lineTotal: 500 },
      ],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Haircut');
    expect(txt).toContain('Shampoo');
    expect(txt).toContain('500.00');
  });

  test('renders Discount row only when sale.discount > 0', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ subtotal: 1000, discount: 200, tax: 0, grandTotal: 800 }),
      lines: [{ description: 'X', qty: 1, unitPrice: 1000, lineTotal: 1000 }],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Discount');
    expect(txt).toContain('200.00');
  });

  test('omits Discount row when discount = 0', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ discount: 0 }),
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).not.toContain('Discount');
  });

  test('renders Tax row only when sale.tax > 0', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ subtotal: 1000, tax: 180, discount: 0, grandTotal: 1180 }),
      lines: [{ description: 'X', qty: 1, unitPrice: 1000, lineTotal: 1000 }],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Tax');
    expect(txt).toContain('180.00');
  });

  test('split-tender renders one row per payment', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ grandTotal: 1000 }),
      lines: [{ description: 'X', qty: 1, unitPrice: 1000, lineTotal: 1000 }],
      payments: [
        { method: 'cash', amount: 500 },
        { method: 'card', amount: 300 },
        { method: 'upi', amount: 200 },
      ],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('cash');
    expect(txt).toContain('card');
    expect(txt).toContain('upi');
    expect(txt).toContain('500.00');
    expect(txt).toContain('300.00');
    expect(txt).toContain('200.00');
  });

  test('placeholder when no payments recorded', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('No payments recorded');
  });

  test('placeholder when no line items', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('No line items');
  });

  test('currency=USD renders $ prefix in money cells', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ currency: 'USD', subtotal: 100, grandTotal: 100 }),
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [{ method: 'card', amount: 100 }],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('$100.00');
  });

  test('unknown currency renders "CODE NNN.NN" prefix', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ currency: 'JPY', subtotal: 100, grandTotal: 100 }),
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [{ method: 'card', amount: 100 }],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('JPY 100.00');
  });

  test('renders Grand Total as bold last row', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ grandTotal: 1234.56 }),
      lines: [{ description: 'X', qty: 1, unitPrice: 1234.56, lineTotal: 1234.56 }],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Grand Total');
    expect(txt).toContain('1234.56');
  });

  test('computes grandTotal from subtotal-discount+tax when not supplied', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ subtotal: 1000, discount: 100, tax: 180, grandTotal: undefined }),
      lines: [{ description: 'X', qty: 1, unitPrice: 1000, lineTotal: 1000 }],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    // 1000 - 100 + 180 = 1080
    expect(txt).toContain('1080.00');
  });

  test('falls back to "Clinic" + "?" markers when tenant + sale.id missing', async () => {
    const buf = await generatePosReceiptPdf({
      sale: {},
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [],
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Clinic');
    expect(txt).toContain('INV-?');
  });

  test('renders thank-you + powered-by footer', async () => {
    const buf = await generatePosReceiptPdf({
      sale: saleFixture(),
      lines: [{ description: 'X', qty: 1, unitPrice: 100, lineTotal: 100 }],
      payments: [],
      tenant: clinicFixture(),
    });
    const txt = extractPdfText(buf);
    expect(txt).toContain('Thank you for your visit');
    expect(txt).toContain('Globussoft CRM');
  });

  test('handles null opts gracefully', async () => {
    const buf = await generatePosReceiptPdf(null);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  test('renders many lines without throwing (40 lines paginate)', async () => {
    const lines = [];
    for (let i = 0; i < 40; i++) {
      lines.push({ description: `Line-${i}`, qty: 1, unitPrice: 100, lineTotal: 100 });
    }
    const buf = await generatePosReceiptPdf({
      sale: saleFixture({ subtotal: 4000, grandTotal: 4000 }),
      lines,
      payments: [],
      tenant: clinicFixture(),
    });
    const raw = buf.toString('latin1');
    expect(raw).toMatch(/\/Count\s+[2-9]/);
  });
});
