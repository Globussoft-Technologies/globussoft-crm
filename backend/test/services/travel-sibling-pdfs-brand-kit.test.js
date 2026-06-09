// @ts-check
/**
 * S52 — Brand-kit adoption sweep for sibling travel PDF helpers.
 * S65 — Extends the S51 logo-embed pattern to those same 5 sibling helpers.
 *
 * Pins the contract that the 5 sibling travel PDF helpers
 * (renderTravelItineraryPdf / renderTravelQuotePdf / renderTravelDiagnosticPdf
 * / renderTmcReadinessReport / renderTravelStallPersonalisedPdf) now read
 * their header color from the SAME shared brand-kit selector S34 shipped
 * for renderTravelInvoicePdf. A single admin POST to
 * `tenant.subBrandConfigJson` cascades into ALL travel-vertical PDFs.
 *
 * S65 additions (5 new image-embed pins at the bottom of the file):
 *   - For each of the 5 sibling renderers, spy `pdfR.fetchLogoBuffer`
 *     with a tiny valid PNG buffer, set `branding.thumbnailUrl` via
 *     per-render override, assert `/Subtype /Image` appears in the PDF
 *     body. Same `pdfContainsImageXObject` helper S51 used for the
 *     invoice renderer.
 *   - For `renderTravelQuotePdf` specifically, also pin that the pre-S65
 *     `[Logo: <url>]` text-placeholder is GONE from the rendered PDF
 *     (it was replaced by the embedded image).
 *   - back-compat: when `branding.thumbnailUrl` is null AND no inline
 *     override is set, `fetchLogoBuffer` is NEVER called and no /Image
 *     XObject appears (pre-S65 logo-less output is byte-shape preserved).
 *
 * Pre-S52 the header band was filled with `SUB_BRAND_ACCENT[sub]`:
 *
 *     SUB_BRAND_ACCENT = {
 *       tmc:         "#0B4F6C",
 *       rfu:         "#2F7A4D",
 *       travelstall: "#122647",
 *       visasure:    "#7A2F5C",
 *     };
 *
 * Post-S52 the fallback comes from `INVOICE_BRAND_KIT_FALLBACKS` (the
 * S13-aligned palette S34 introduced):
 *
 *     INVOICE_BRAND_KIT_FALLBACKS = {
 *       tmc:         { headerColor: "#1F4E79", ... },
 *       rfu:         { headerColor: "#0B5345", ... },
 *       travelstall: { headerColor: "#922B21", ... },
 *       visasure:    { headerColor: "#283747", ... },
 *       _generic:    { headerColor: "#1F4E79", ... },
 *     };
 *
 * The hex values DIFFER between the two — that color shift is the INTENDED
 * outcome of the sweep (the four travel sub-brands now share one curated
 * palette across invoice / itinerary / quote / diagnostic / tmc-readiness
 * / travelstall-personalised PDFs).
 *
 * Backward compat:
 *   - Wellness invoices (renderBrandedInvoicePdf) are untouched — that path
 *     doesn't read subBrand and doesn't consult the selector. Asserted here
 *     so any future commit that accidentally absorbs the wellness path into
 *     the travel selector is flagged on push.
 *   - Legacy single-arg call sites (renderTravelItineraryPdf(itinerary,
 *     contact) WITHOUT opts) keep working — opts defaults to {} and the
 *     resolver falls through to INVOICE_BRAND_KIT_FALLBACKS.
 *   - renderTravelQuotePdf preserves the pre-S52 `quote.brandKit.accent`
 *     inline-override path (precedence layer 1) so existing quote-template
 *     callers continue to bypass the resolver if they want to.
 *
 * Color assertion approach: same `pdfContainsHexColor` helper S34 used —
 * inflates flate-encoded streams in the PDF body, greps for the float
 * triplet pdfkit emits for each `.fill()` / `.fillColor()` op.
 *
 * Run: `cd backend && npx vitest run test/services/travel-sibling-pdfs-brand-kit.test.js`
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import pdfR from '../../services/pdfRenderer.js';

const {
  renderTravelItineraryPdf,
  renderTravelQuotePdf,
  renderTravelDiagnosticPdf,
  renderTmcReadinessReport,
  renderTravelStallPersonalisedPdf,
  renderBrandedInvoicePdf,
  INVOICE_BRAND_KIT_FALLBACKS,
  resolveTravelHeaderBrandKit,
  resolveTravelBrandKit,
  parseTravelSubBrandConfig,
} = pdfR;

// ── Helpers (lifted from travel-invoice-pdf-brand-kit.test.js) ─────────

/** Convert a 6-char hex string ("#RRGGBB") into the 7-char float prefixes
 * pdfkit emits per channel. Truncating to 7 chars tolerates pdfkit
 * float-encoding variance across versions. */
function hexToFloatPrefixes(hex) {
  const h = hex.replace(/^#/, '');
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;
  return [r.toString().slice(0, 7), g.toString().slice(0, 7), b.toString().slice(0, 7)];
}

/** Inflate flate-encoded PDF streams and search for the float triplet that
 * pdfkit emits for the given hex color. Returns true iff all three channel
 * prefixes appear in either the raw or inflated body. */
function pdfContainsHexColor(buf, hex) {
  const [r, g, b] = hexToFloatPrefixes(hex);
  const zlib = require('node:zlib');
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
  const haystack = inflated || str;
  return haystack.includes(r) && haystack.includes(g) && haystack.includes(b);
}

// ── Fixtures ───────────────────────────────────────────────────────────

function itineraryFixture(overrides = {}) {
  return {
    id: 555,
    subBrand: 'tmc',
    version: 1,
    currency: 'INR',
    destination: 'Mussoorie',
    startDate: new Date('2026-07-01T00:00:00Z'),
    endDate: new Date('2026-07-04T00:00:00Z'),
    totalAmount: 80000,
    items: [
      { itemType: 'Stay', description: 'Hotel x 3 nights', unitCost: 12000, markup: 2000, totalPrice: 42000, position: 1 },
      { itemType: 'Transport', description: 'AC Bus', unitCost: 8000, markup: 1500, totalPrice: 9500, position: 2 },
    ],
    ...overrides,
  };
}

function contactFixture(overrides = {}) {
  return {
    name: 'Asha Mehta',
    email: 'asha@example.com',
    phone: '+919876543210',
    ...overrides,
  };
}

function quoteFixture(overrides = {}) {
  return {
    id: 901,
    quoteNumber: 'TQ-2026-0901',
    subBrand: 'rfu',
    status: 'Sent',
    currency: 'INR',
    issuedDate: new Date('2026-06-01T00:00:00Z'),
    validUntil: new Date('2026-06-30T00:00:00Z'),
    customerName: 'Hassan Ali',
    customerEmail: 'hassan@example.com',
    items: [
      { description: 'Umrah package — 7 nights', quantity: 1, unitPrice: 65000, totalPrice: 65000 },
    ],
    subtotal: 65000,
    totalAmount: 65000,
    ...overrides,
  };
}

function diagnosticFixture(overrides = {}) {
  return {
    id: 12,
    subBrand: 'visasure',
    classificationLabel: 'High readiness',
    classification: 'high',
    score: 0.84,
    recommendedTier: 'Standard',
    answersJson: JSON.stringify({ q1: 'a' }),
    createdAt: new Date('2026-05-15T10:00:00Z'),
    ...overrides,
  };
}

function bankFixture(overrides = {}) {
  return {
    version: 3,
    questionsJson: JSON.stringify({
      questions: [{ id: 'q1', text: 'How ready are you?', options: [{ value: 'a', label: 'Very ready' }] }],
    }),
    ...overrides,
  };
}

function travelStallPayloadFixture(overrides = {}) {
  return {
    contact: contactFixture(),
    destinations: ['Goa', 'Kerala', 'Andaman'],
    budget: 250000,
    durationDays: 7,
    diagnostic: { classificationLabel: 'Premium family', recommendedTier: 'Premium' },
    proseText: 'A bespoke 7-day journey across India\'s coastal gems.',
    generatedAt: '2026-06-09T10:00:00Z',
    ...overrides,
  };
}

function tmcReadinessPayloadFixture(overrides = {}) {
  return {
    engineOutput: { state: 'strong_match', icpTier: 'premium', flags: [] },
    narrative: {
      ambition_restatement: 'Build a year-round residential trip programme.',
      readiness_profile: 'Strong faculty buy-in, governance pack in place.',
      what_becomes_possible: 'Structured experiential learning each term.',
      cost_of_waiting: 'Delaying loses calendar slots for Q4.',
      institutional_benefit: 'NEP 2020 alignment + parent communications wins.',
      assurance_framing: 'Vendor + transport vetting documented.',
    },
    standingFacts: {
      trust: {
        schools_served_since_2015: 'over 50',
        students_moved_since_2015: 'more than 100,000',
        students_moved_last_year: 14018,
        day_students_last_year: 12055,
        overnight_students_last_year: 1658,
        international_students_last_year: 305,
      },
      assurance: {
        supervision_ratio: '1:15',
        tour_directors: 'Trained TDs, 2-year minimum tenure',
        safety_record_line: 'Zero serious incidents last 24 months',
      },
    },
    boardHook: 'CBSE NEP 2020 art-integrated learning § 4.6',
    runwayDisplay: '14-21 weeks',
    schoolAnswers: {
      school_profile: { school_name: 'Lotus Valley International' },
      contact: { contact_name: 'Mrs. Ananya Rao', contact_role: 'Head of School' },
    },
    bookingUrl: 'https://meet.google.com/abc-defg-hij',
    catalogueMatched: [],
    ...overrides,
  };
}

// ── resolveTravelHeaderBrandKit / aliases ──────────────────────────────

describe('S52 — exported alias surface', () => {
  test('parseTravelSubBrandConfig is identical to parseInvoiceSubBrandConfig', () => {
    expect(parseTravelSubBrandConfig('{"tmc":{"headerColor":"#abc"}}')).toEqual({
      tmc: { headerColor: '#abc' },
    });
    // null / malformed → {}, same contract as the S34 parser
    expect(parseTravelSubBrandConfig(null)).toEqual({});
    expect(parseTravelSubBrandConfig('{bad-json')).toEqual({});
  });

  test('resolveTravelBrandKit is identical to resolveInvoiceBrandKit', () => {
    const { fields, source } = resolveTravelBrandKit({}, 'rfu');
    expect(source).toBe('fallback');
    expect(fields).toEqual(INVOICE_BRAND_KIT_FALLBACKS.rfu);
  });

  test('resolveTravelHeaderBrandKit (null opts) → fallback for known sub-brand', () => {
    const { branding, source } = resolveTravelHeaderBrandKit('tmc');
    expect(source).toBe('fallback');
    expect(branding.headerColor).toBe('#1F4E79');
    expect(branding.primaryColor).toBe('#1F4E79');
    expect(branding.accentColor).toBe('#F2B544');
  });

  test('resolveTravelHeaderBrandKit (opts.tenant cfg) → resolves from subBrandConfigJson', () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({
        rfu: { headerColor: '#001122' },
      }),
    };
    const { branding, source } = resolveTravelHeaderBrandKit('rfu', { tenant });
    expect(source).toBe('subBrandConfig');
    expect(branding.headerColor).toBe('#001122');
    // Other fields backfill from the rfu fallback
    expect(branding.accentColor).toBe(INVOICE_BRAND_KIT_FALLBACKS.rfu.accentColor);
  });

  test('resolveTravelHeaderBrandKit (opts.branding) wins over tenant cfg', () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({
        tmc: { headerColor: '#AAAAAA' },
      }),
    };
    const { branding } = resolveTravelHeaderBrandKit('tmc', {
      tenant,
      branding: { headerColor: '#0000FF' },
    });
    expect(branding.headerColor).toBe('#0000FF');
  });

  test('resolveTravelHeaderBrandKit handles malformed subBrandConfigJson gracefully', () => {
    const tenant = { subBrandConfigJson: '{not-json' };
    const { branding, source } = resolveTravelHeaderBrandKit('tmc', { tenant });
    expect(source).toBe('fallback');
    expect(branding.headerColor).toBe(INVOICE_BRAND_KIT_FALLBACKS.tmc.headerColor);
  });
});

// ── renderTravelItineraryPdf ───────────────────────────────────────────

describe('renderTravelItineraryPdf — S52 brand-kit selector', () => {
  test('TMC sub-brand + no tenant → TMC fallback header (#1F4E79, S13-aligned palette)', async () => {
    const buf = await renderTravelItineraryPdf(itineraryFixture({ subBrand: 'tmc' }), contactFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(true);
    // Pre-S52 legacy SUB_BRAND_ACCENT.tmc (#0B4F6C) must NOT appear
    expect(pdfContainsHexColor(buf, '#0B4F6C')).toBe(false);
    // RFU's distinctive green is NOT in a TMC itinerary
    expect(pdfContainsHexColor(buf, '#0B5345')).toBe(false);
  });

  test('RFU sub-brand + no tenant → RFU fallback header (#0B5345)', async () => {
    const buf = await renderTravelItineraryPdf(itineraryFixture({ subBrand: 'rfu' }), contactFixture());
    expect(pdfContainsHexColor(buf, '#0B5345')).toBe(true);
    // Pre-S52 legacy SUB_BRAND_ACCENT.rfu (#2F7A4D) must NOT appear
    expect(pdfContainsHexColor(buf, '#2F7A4D')).toBe(false);
  });

  test('explicit tenant.subBrandConfigJson cascades into itinerary header', async () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ tmc: { headerColor: '#FF00FF', primaryColor: '#FF00FF' } }),
    };
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ subBrand: 'tmc' }),
      contactFixture(),
      { tenant },
    );
    // Fallback teal (#1F4E79) MUST NOT appear when admin override is in effect
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(false);
  });

  test('legacy two-arg call (no opts) still renders cleanly — back-compat', async () => {
    // Existing route handlers call renderTravelItineraryPdf(full, contact)
    // without an opts arg. Must keep working.
    const buf = await renderTravelItineraryPdf(itineraryFixture(), contactFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });
});

// ── renderTravelQuotePdf ───────────────────────────────────────────────

describe('renderTravelQuotePdf — S52 brand-kit selector', () => {
  test('Travel Stall sub-brand + no tenant → travelstall fallback header (#922B21)', async () => {
    const buf = await renderTravelQuotePdf(quoteFixture({ subBrand: 'travelstall' }));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(pdfContainsHexColor(buf, '#922B21')).toBe(true);
    // Pre-S52 legacy SUB_BRAND_ACCENT.travelstall (#122647) must NOT appear
    expect(pdfContainsHexColor(buf, '#122647')).toBe(false);
  });

  test('Visa Sure sub-brand + no tenant → visasure fallback header (#283747)', async () => {
    const buf = await renderTravelQuotePdf(quoteFixture({ subBrand: 'visasure' }));
    expect(pdfContainsHexColor(buf, '#283747')).toBe(true);
    // Pre-S52 legacy SUB_BRAND_ACCENT.visasure (#7A2F5C) must NOT appear
    expect(pdfContainsHexColor(buf, '#7A2F5C')).toBe(false);
  });

  test('explicit tenant cascade overrides fallback', async () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ rfu: { headerColor: '#123456' } }),
    };
    const buf = await renderTravelQuotePdf(quoteFixture({ subBrand: 'rfu' }), { tenant });
    expect(pdfContainsHexColor(buf, '#123456')).toBe(true);
    expect(pdfContainsHexColor(buf, '#0B5345')).toBe(false);
  });

  test('legacy q.brandKit.accent override still wins (precedence layer 1)', async () => {
    // Pre-S52 quote-template callers can pass `quote.brandKit.accent` to
    // bypass the resolver entirely. S52 preserves this path.
    // NB: choose hex values whose float-channel prefixes are non-trivial
    // (not "1" or "0" alone — every PDF contains those by default).
    // RFU's fallback is #0B5345 → ["0.04313", "0.32549", "0.27058"].
    const tenant = {
      subBrandConfigJson: JSON.stringify({ rfu: { headerColor: '#345678' } }),
    };
    const buf = await renderTravelQuotePdf(
      quoteFixture({ subBrand: 'rfu', brandKit: { accent: '#876543' } }),
      { tenant },
    );
    // brandKit.accent (#876543) is highest precedence — RFU fallback
    // (#0B5345 = "0.04313..., 0.32549..., 0.27058...") MUST NOT leak.
    expect(pdfContainsHexColor(buf, '#0B5345')).toBe(false);
  });

  test('legacy single-arg call (no opts) still renders cleanly — back-compat', async () => {
    const buf = await renderTravelQuotePdf(quoteFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });
});

// ── renderTravelDiagnosticPdf ──────────────────────────────────────────

describe('renderTravelDiagnosticPdf — S52 brand-kit selector', () => {
  test('Visa Sure sub-brand + no tenant → visasure fallback header (#283747)', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ subBrand: 'visasure' }),
      contactFixture(),
      bankFixture(),
    );
    expect(pdfContainsHexColor(buf, '#283747')).toBe(true);
    // Pre-S52 SUB_BRAND_ACCENT.visasure (#7A2F5C) must NOT appear
    expect(pdfContainsHexColor(buf, '#7A2F5C')).toBe(false);
  });

  test('TMC sub-brand + no tenant → TMC fallback header (#1F4E79)', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ subBrand: 'tmc' }),
      contactFixture(),
      bankFixture(),
    );
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(true);
    // Pre-S52 SUB_BRAND_ACCENT.tmc (#0B4F6C) must NOT appear
    expect(pdfContainsHexColor(buf, '#0B4F6C')).toBe(false);
  });

  test('explicit tenant cascade overrides fallback for diagnostic header', async () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ visasure: { headerColor: '#445566' } }),
    };
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ subBrand: 'visasure' }),
      contactFixture(),
      bankFixture(),
      { tenant },
    );
    expect(pdfContainsHexColor(buf, '#445566')).toBe(true);
    expect(pdfContainsHexColor(buf, '#283747')).toBe(false);
  });

  test('legacy three-arg call (no opts) still renders cleanly — back-compat', async () => {
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture(),
      contactFixture(),
      bankFixture(),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });

  test('opts.logoBuffer (pre-S52 contract) still draws header logo', async () => {
    // The S3-resolved logo path passes opts.logoBuffer to the renderer; S52
    // preserves that consumer. Tiny valid PNG (same magic bytes pdfkit's
    // PNG parser accepts).
    const TINY_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    );
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ subBrand: 'tmc' }),
      contactFixture(),
      bankFixture(),
      { logoBuffer: TINY_PNG },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    // /Image XObject appears in the PDF body when doc.image() succeeds
    expect(/\/Subtype\s*\/Image/.test(buf.toString('latin1'))).toBe(true);
  });
});

// ── renderTmcReadinessReport ───────────────────────────────────────────

describe('renderTmcReadinessReport — S52 brand-kit selector', () => {
  test('no tenant → TMC fallback header (#1F4E79, S13-aligned palette)', async () => {
    const buf = await renderTmcReadinessReport(tmcReadinessPayloadFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(true);
    // Pre-S52 SUB_BRAND_ACCENT.tmc (#0B4F6C) must NOT appear — the TMC
    // readiness report previously hard-coded that legacy color.
    expect(pdfContainsHexColor(buf, '#0B4F6C')).toBe(false);
  });

  test('explicit tenant cascade overrides fallback (admin-curated TMC palette)', async () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ tmc: { headerColor: '#778899' } }),
    };
    const buf = await renderTmcReadinessReport({
      ...tmcReadinessPayloadFixture(),
      tenant,
    });
    expect(pdfContainsHexColor(buf, '#778899')).toBe(true);
    // Fallback teal (#1F4E79) MUST NOT appear when admin override fires
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(false);
  });

  test('explicit branding override wins over tenant cfg (precedence layer 1)', async () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ tmc: { headerColor: '#AAAAAA' } }),
    };
    const buf = await renderTmcReadinessReport({
      ...tmcReadinessPayloadFixture(),
      tenant,
      branding: { headerColor: '#00FFFF' },
    });
    expect(pdfContainsHexColor(buf, '#00FFFF')).toBe(true);
    expect(pdfContainsHexColor(buf, '#AAAAAA')).toBe(false);
  });

  test('legacy single-arg call (no tenant / branding) still renders cleanly — back-compat', async () => {
    const buf = await renderTmcReadinessReport(tmcReadinessPayloadFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(2000);
  });

  test('malformed subBrandConfigJson on tenant → silent fall-through (no throw)', async () => {
    const tenant = { subBrandConfigJson: '{this-is-not-json' };
    const buf = await renderTmcReadinessReport({
      ...tmcReadinessPayloadFixture(),
      tenant,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Falls back to TMC palette
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(true);
  });
});

// ── renderTravelStallPersonalisedPdf ───────────────────────────────────

describe('renderTravelStallPersonalisedPdf — S52 brand-kit selector', () => {
  test('no tenant → travelstall fallback header (#922B21, S13-aligned palette)', async () => {
    const buf = await renderTravelStallPersonalisedPdf(travelStallPayloadFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(pdfContainsHexColor(buf, '#922B21')).toBe(true);
    // Pre-S52 SUB_BRAND_ACCENT.travelstall (#122647 navy) must NOT appear
    expect(pdfContainsHexColor(buf, '#122647')).toBe(false);
  });

  test('explicit tenant cascade overrides fallback', async () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ travelstall: { headerColor: '#654321' } }),
    };
    const buf = await renderTravelStallPersonalisedPdf({
      ...travelStallPayloadFixture(),
      tenant,
    });
    expect(pdfContainsHexColor(buf, '#654321')).toBe(true);
    expect(pdfContainsHexColor(buf, '#922B21')).toBe(false);
  });

  test('explicit branding override wins over tenant cfg', async () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ travelstall: { headerColor: '#AAAAAA' } }),
    };
    const buf = await renderTravelStallPersonalisedPdf({
      ...travelStallPayloadFixture(),
      tenant,
      branding: { headerColor: '#00FF00' },
    });
    expect(pdfContainsHexColor(buf, '#00FF00')).toBe(true);
    expect(pdfContainsHexColor(buf, '#AAAAAA')).toBe(false);
  });

  test('legacy single-arg call (no tenant / branding) still renders cleanly — back-compat', async () => {
    const buf = await renderTravelStallPersonalisedPdf(travelStallPayloadFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });
});

// ── Backward compat — wellness path is fully orthogonal ────────────────

describe('S52 — wellness invoice path is untouched (renderBrandedInvoicePdf)', () => {
  test('renderBrandedInvoicePdf does NOT consume the travel brand-kit selector', async () => {
    // Wellness invoices have no subBrand and the renderer never calls
    // resolveTravelHeaderBrandKit. Asserted via a render with a tenant
    // whose subBrandConfigJson tries to inject a TMC color — the wellness
    // PDF must NOT contain that color because the wellness path never
    // touches subBrandConfigJson at all.
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'WINV-2026-99', amount: 5000, status: 'PAID' },
      { name: 'Patient Y' },
      { name: 'Enhanced Wellness', phone: '+911234567890', email: 'hi@wellness.in' },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    // The wellness renderer uses its own #111 / #555 / #f4f6f8 palette.
    // None of the travel brand-kit colors must leak into the output —
    // pre-S52 they didn't either, this assertion catches any future
    // commit that accidentally absorbs the wellness path into the
    // travel selector.
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(false); // TMC fallback
    expect(pdfContainsHexColor(buf, '#0B5345')).toBe(false); // RFU fallback
    expect(pdfContainsHexColor(buf, '#922B21')).toBe(false); // travelstall fallback
    expect(pdfContainsHexColor(buf, '#283747')).toBe(false); // visasure fallback
  });
});

// ── S65 — sibling-renderer logo embed pins ─────────────────────────────
//
// Tiny 1x1 PNG (same magic bytes pdfkit's PNG parser accepts). Re-used
// by every embed pin below so we don't hit the network.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

/** True iff the PDF buffer contains an `/XObject /Subtype /Image` dictionary.
 * That marker is uncompressed in the PDF body even when the image stream
 * itself is flate-encoded — so a simple latin1-substring grep against the
 * raw buffer is sufficient. Lifted verbatim from S51's invoice test. */
function pdfContainsImageXObject(buf) {
  const str = buf.toString('latin1');
  return /\/Subtype\s*\/Image/.test(str);
}

describe('S65 — sibling-renderer logo URL embedding', () => {
  beforeEach(() => {
    // Module-level cache nuke so spies/cache don't bleed between cases.
    pdfR._resetLogoCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('S65 (a) — renderTravelItineraryPdf: thumbnailUrl set + fetch succeeds → /Image XObject', async () => {
    // Spy the CJS self-mock seam (module.exports.fetchLogoBuffer) so we
    // never touch axios. The renderer awaits the spy then calls
    // doc.image() → pdfkit serialises an /XObject /Subtype /Image dict.
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockResolvedValue(TINY_PNG);
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ subBrand: 'tmc' }),
      contactFixture(),
      { branding: { thumbnailUrl: 'https://cdn.example.com/tmc-itin.png' } },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://cdn.example.com/tmc-itin.png');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(pdfContainsImageXObject(buf)).toBe(true);
  });

  test('S65 (b) — renderTravelQuotePdf: thumbnailUrl set + fetch succeeds → /Image XObject', async () => {
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockResolvedValue(TINY_PNG);
    const buf = await renderTravelQuotePdf(
      quoteFixture({ subBrand: 'rfu' }),
      { branding: { thumbnailUrl: 'https://cdn.example.com/rfu-quote.png' } },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://cdn.example.com/rfu-quote.png');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(pdfContainsImageXObject(buf)).toBe(true);
  });

  test('S65 (c) — renderTravelQuotePdf: text-placeholder `[Logo: ...]` is GONE post-S65', async () => {
    // Pre-S65 the quote renderer emitted a literal `[Logo: <url>]` string
    // into the header band whenever `q.brandKit.logoUrl` was set. S65
    // replaces that with the real embedded image. Pin the removal so
    // no future regression re-introduces the placeholder.
    vi.spyOn(pdfR, 'fetchLogoBuffer').mockResolvedValue(TINY_PNG);
    const logoUrl = 'https://cdn.example.com/rfu-quote-placeholder-check.png';
    const buf = await renderTravelQuotePdf(
      quoteFixture({ subBrand: 'rfu', brandKit: { logoUrl } }),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    // The legacy `[Logo: <url>]` placeholder string must NOT appear in
    // either the raw PDF or any inflated stream. The renderer's text
    // ops land in (potentially flate-encoded) content streams; the
    // pdfContainsHexColor helper already inflates those for the color
    // checks, so we re-use the same inflation logic here via the str
    // search after inflate.
    const zlib = require('node:zlib');
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
    const haystack = inflated || str;
    expect(haystack).not.toContain('[Logo:');
    expect(haystack).not.toContain(logoUrl);
    // /Image XObject DOES appear (the real embed replaced the placeholder).
    expect(pdfContainsImageXObject(buf)).toBe(true);
  });

  test('S65 (d) — renderTravelDiagnosticPdf: branding.thumbnailUrl + fetch succeeds → /Image XObject', async () => {
    // Diagnostic renderer's logo precedence: opts.logoBuffer (pre-S65) →
    // branding.thumbnailUrl (S65) → loadTravelHeaderLogo() bundled asset →
    // drawn emblem badge. We exercise the new S65 layer here — no
    // opts.logoBuffer, but branding.thumbnailUrl is set.
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockResolvedValue(TINY_PNG);
    const buf = await renderTravelDiagnosticPdf(
      diagnosticFixture({ subBrand: 'visasure' }),
      contactFixture(),
      bankFixture(),
      { branding: { thumbnailUrl: 'https://cdn.example.com/visasure-diag.png' } },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://cdn.example.com/visasure-diag.png');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(pdfContainsImageXObject(buf)).toBe(true);
  });

  test('S65 (e) — renderTmcReadinessReport: thumbnailUrl set + fetch succeeds → /Image XObject', async () => {
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockResolvedValue(TINY_PNG);
    const buf = await renderTmcReadinessReport({
      ...tmcReadinessPayloadFixture(),
      branding: { thumbnailUrl: 'https://cdn.example.com/tmc-readiness.png' },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://cdn.example.com/tmc-readiness.png');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(pdfContainsImageXObject(buf)).toBe(true);
  });

  test('S65 (f) — renderTravelStallPersonalisedPdf: thumbnailUrl set + fetch succeeds → /Image XObject', async () => {
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockResolvedValue(TINY_PNG);
    const buf = await renderTravelStallPersonalisedPdf({
      ...travelStallPayloadFixture(),
      branding: { thumbnailUrl: 'https://cdn.example.com/travelstall.png' },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://cdn.example.com/travelstall.png');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(pdfContainsImageXObject(buf)).toBe(true);
  });

  test('S65 (g) — back-compat: no thumbnailUrl → fetchLogoBuffer NEVER called, no /Image XObject', async () => {
    // All 5 renderers must preserve pre-S65 byte-shape when no logo URL
    // is configured. Fail-loud spy: throws on call, so any commit that
    // strips the null guard reds this test instantly.
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockImplementation(() => {
      throw new Error('fetchLogoBuffer must NOT be called when no logo URL is configured');
    });
    const itinBuf = await renderTravelItineraryPdf(itineraryFixture(), contactFixture());
    const quoteBuf = await renderTravelQuotePdf(quoteFixture()); // no brandKit.logoUrl either
    const stallBuf = await renderTravelStallPersonalisedPdf(travelStallPayloadFixture());
    const tmcBuf = await renderTmcReadinessReport(tmcReadinessPayloadFixture());
    // Diagnostic intentionally NOT included here — its renderer's S52
    // logoBuffer test (already in this file) covers the opts.logoBuffer
    // path; without thumbnailUrl AND without opts.logoBuffer it falls
    // through to loadTravelHeaderLogo() which may or may not find a
    // bundled asset on disk. We assert fetchLogoBuffer wasn't called.
    const diagBuf = await renderTravelDiagnosticPdf(
      diagnosticFixture(), contactFixture(), bankFixture(),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(Buffer.isBuffer(itinBuf)).toBe(true);
    expect(Buffer.isBuffer(quoteBuf)).toBe(true);
    expect(Buffer.isBuffer(stallBuf)).toBe(true);
    expect(Buffer.isBuffer(tmcBuf)).toBe(true);
    expect(Buffer.isBuffer(diagBuf)).toBe(true);
    // Itinerary / quote / stall headers have no other XObject source,
    // so /Image XObject MUST be absent. (TMC readiness and diagnostic
    // can carry one via bundled asset — we don't pin its absence here.)
    expect(pdfContainsImageXObject(itinBuf)).toBe(false);
    expect(pdfContainsImageXObject(quoteBuf)).toBe(false);
    expect(pdfContainsImageXObject(stallBuf)).toBe(false);
  });
});
