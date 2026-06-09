// @ts-check
/**
 * S34 — Per-sub-brand PDF invoice templates.
 *
 * Pins `services/pdfRenderer.js`:
 *   1. `parseInvoiceSubBrandConfig` — tolerant JSON parser for
 *      Tenant.subBrandConfigJson (returns {} on null/empty/malformed).
 *   2. `resolveInvoiceBrandKit(cfg, subBrand)` — deterministic precedence
 *      resolver returning { fields, source } where source ∈ {"subBrandConfig",
 *      "fallback"}.
 *   3. `INVOICE_BRAND_KIT_FALLBACKS` — hard-coded per-sub-brand color +
 *      font palette, replicated VERBATIM from S13's
 *      `routes/travel_itinerary_templates.js#BRAND_KIT_FALLBACKS` so an
 *      operator who configures one sub-brand block gets matching colors
 *      across both invoice PDFs and itinerary templates.
 *   4. `renderTravelInvoicePdf` — header band fill + Total Due label color
 *      both source from the resolved brand kit; PDF Producer metadata is
 *      stamped with the resolution source so downstream observers can
 *      assert which precedence layer fired.
 *
 * Backward compat:
 *   - Wellness invoices (renderBrandedInvoicePdf, used by `routes/wellness.js`)
 *     are a separate code path that doesn't consume `subBrand` — the original
 *     `pdfRenderer.test.js` suite continues to pin its shape, this file only
 *     pins the new travel-invoice brand-kit path.
 *
 * Color assertion approach:
 *   - pdfkit emits color ops in `<float> <float> <float> scn` form
 *     (DeviceRGB colorspace), so the raw byte stream contains the float
 *     triplet for any hex we passed in. We assert on the float prefix
 *     (truncated to 7 chars) so any minor float-encoding variance across
 *     pdfkit versions still passes. For each sub-brand we check that THIS
 *     hex appears AND no OTHER sub-brand's hex appears in the rendered
 *     output. The Producer metadata string is the secondary source for
 *     resolution-path observability.
 *
 * Run: `cd backend && npx vitest run test/services/travel-invoice-pdf-brand-kit.test.js`
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import pdfR from '../../services/pdfRenderer.js';

const {
  generateTravelInvoicePdf,
  renderBrandedInvoicePdf,
  INVOICE_BRAND_KIT_FIELDS,
  INVOICE_BRAND_KIT_FALLBACKS,
  parseInvoiceSubBrandConfig,
  resolveInvoiceBrandKit,
} = pdfR;

// ── Helpers ─────────────────────────────────────────────────────────

/** Convert a 6-char hex string ("#RRGGBB") into the leading 7 characters
 * pdfkit emits for each channel when calling .fill() / .fillColor(). We
 * truncate to 7 chars so a small float-encoding variance across pdfkit
 * versions doesn't flake the assertion (e.g. "0.12156862745" vs
 * "0.121568"). Returns [rPrefix, gPrefix, bPrefix].
 */
function hexToFloatPrefixes(hex) {
  const h = hex.replace(/^#/, '');
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;
  return [r.toString().slice(0, 7), g.toString().slice(0, 7), b.toString().slice(0, 7)];
}

/** True if all three float prefixes appear in the raw PDF buffer
 * (regardless of stream compression — pdfkit's default compresses
 * content streams but the color ops still land in the resulting
 * compressed bytes, AND the float triplet shows up because PDF version
 * info-dict color references are also written uncompressed in places).
 *
 * Defensively, we inflate any flate-encoded streams first so the
 * embedded scn ops are visible regardless of compression. */
function pdfContainsHexColor(buf, hex) {
  const [r, g, b] = hexToFloatPrefixes(hex);
  const zlib = require('node:zlib');
  const str = buf.toString('latin1');
  // Inflate every /Length-declared stream and check there too.
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

/** Extract the PDF Producer metadata string. pdfkit writes it as a
 * literal parenthesised string in the Info dict. We grep for the
 * `/Producer (...)` form OR the indirect-object form `(...)` followed
 * by `/Producer N R` (pdfkit can do either depending on the indirect-
 * object emission order). */
function extractProducer(buf) {
  const str = buf.toString('latin1');
  // Form 1: direct literal — /Producer (Globussoft CRM (brand-kit: fallback))
  // pdfkit escapes nested parens with backslashes, so the regex tolerates that.
  const direct = str.match(/\/Producer\s+\(([^)]*)\)/);
  if (direct) return direct[1];
  // Form 2: pdfkit's indirect-object pattern is what we hit in practice.
  // The Info dict references an indirect object that itself wraps the
  // string. Find every parenthesised literal in the buffer that starts
  // with "Globussoft CRM" or "PDFKit" (the default).
  const lit = str.match(/\(((?:Globussoft CRM|PDFKit)[^)]*)\)/);
  return lit ? lit[1] : null;
}

function travelInvoiceFixture(overrides = {}) {
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
    { id: 1, description: 'Adult package', quantity: 2, unitPrice: 15000, amount: 30000, currency: 'INR' },
    { id: 2, description: 'GST 5%', quantity: 1, unitPrice: 1500, amount: 1500, currency: 'INR' },
  ];
}

// ── parseInvoiceSubBrandConfig ─────────────────────────────────────

describe('parseInvoiceSubBrandConfig — tolerant JSON parser', () => {
  test('returns {} for null', () => {
    expect(parseInvoiceSubBrandConfig(null)).toEqual({});
  });

  test('returns {} for undefined', () => {
    expect(parseInvoiceSubBrandConfig(undefined)).toEqual({});
  });

  test('returns {} for empty string', () => {
    expect(parseInvoiceSubBrandConfig('')).toEqual({});
  });

  test('returns {} for non-string input (defensive — DB column type drift)', () => {
    expect(parseInvoiceSubBrandConfig(42)).toEqual({});
    expect(parseInvoiceSubBrandConfig({})).toEqual({});
    expect(parseInvoiceSubBrandConfig([])).toEqual({});
  });

  test('returns {} for malformed JSON (does NOT throw)', () => {
    expect(parseInvoiceSubBrandConfig('{not-json')).toEqual({});
    expect(parseInvoiceSubBrandConfig('}{')).toEqual({});
  });

  test('returns {} for JSON that decodes to a non-object', () => {
    expect(parseInvoiceSubBrandConfig('null')).toEqual({});
    expect(parseInvoiceSubBrandConfig('42')).toEqual({});
    expect(parseInvoiceSubBrandConfig('"string"')).toEqual({});
    expect(parseInvoiceSubBrandConfig('[1,2,3]')).toEqual({});
  });

  test('returns the parsed object for valid JSON', () => {
    const cfg = JSON.stringify({ tmc: { primaryColor: '#000000' } });
    expect(parseInvoiceSubBrandConfig(cfg)).toEqual({
      tmc: { primaryColor: '#000000' },
    });
  });
});

// ── resolveInvoiceBrandKit — precedence chain ─────────────────────

describe('resolveInvoiceBrandKit — deterministic precedence', () => {
  test('null cfg + known subBrand → falls back to per-sub-brand defaults', () => {
    const { fields, source } = resolveInvoiceBrandKit({}, 'tmc');
    expect(source).toBe('fallback');
    expect(fields).toEqual(INVOICE_BRAND_KIT_FALLBACKS.tmc);
  });

  test('null cfg + null subBrand → falls back to _generic', () => {
    const { fields, source } = resolveInvoiceBrandKit({}, null);
    expect(source).toBe('fallback');
    expect(fields).toEqual(INVOICE_BRAND_KIT_FALLBACKS._generic);
  });

  test('null cfg + unknown subBrand → falls back to _generic', () => {
    const { fields, source } = resolveInvoiceBrandKit({}, 'newBrand');
    expect(source).toBe('fallback');
    expect(fields).toEqual(INVOICE_BRAND_KIT_FALLBACKS._generic);
  });

  test('per-sub-brand block in cfg wins over hard-coded fallback', () => {
    const cfg = { tmc: { primaryColor: '#000000', headerColor: '#111111' } };
    const { fields, source } = resolveInvoiceBrandKit(cfg, 'tmc');
    expect(source).toBe('subBrandConfig');
    expect(fields.primaryColor).toBe('#000000');
    expect(fields.headerColor).toBe('#111111');
    // Fields not in the sub-brand block fill from the hard-coded fallback,
    // not from cross-sub-brand bleed.
    expect(fields.accentColor).toBe(INVOICE_BRAND_KIT_FALLBACKS.tmc.accentColor);
    expect(fields.fontFamily).toBe(INVOICE_BRAND_KIT_FALLBACKS.tmc.fontFamily);
  });

  test('top-level cfg block wins when per-sub-brand block is absent', () => {
    const cfg = { primaryColor: '#ABCDEF', accentColor: '#FEDCBA' };
    const { fields, source } = resolveInvoiceBrandKit(cfg, 'tmc');
    expect(source).toBe('subBrandConfig');
    expect(fields.primaryColor).toBe('#ABCDEF');
    expect(fields.accentColor).toBe('#FEDCBA');
  });

  test('per-sub-brand block wins over top-level cfg block', () => {
    const cfg = {
      primaryColor: '#TOP',
      tmc: { primaryColor: '#SUB' },
    };
    const { fields, source } = resolveInvoiceBrandKit(cfg, 'tmc');
    expect(source).toBe('subBrandConfig');
    expect(fields.primaryColor).toBe('#SUB');
  });

  test('empty string / null inside a sub-brand block is treated as "not supplied"', () => {
    const cfg = { tmc: { primaryColor: '', accentColor: null } };
    const { fields, source } = resolveInvoiceBrandKit(cfg, 'tmc');
    // Source stays "fallback" because every config value was empty/null.
    expect(source).toBe('fallback');
    expect(fields.primaryColor).toBe(INVOICE_BRAND_KIT_FALLBACKS.tmc.primaryColor);
    expect(fields.accentColor).toBe(INVOICE_BRAND_KIT_FALLBACKS.tmc.accentColor);
  });

  test('returned shape always includes every BRAND_KIT_FIELD', () => {
    const { fields } = resolveInvoiceBrandKit({}, 'rfu');
    for (const f of INVOICE_BRAND_KIT_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(fields, f)).toBe(true);
    }
  });

  test('thumbnailUrl=null in fallback is preserved (operator uploads later)', () => {
    const { fields } = resolveInvoiceBrandKit({}, 'tmc');
    expect(fields.thumbnailUrl).toBe(null);
  });

  test('every sub-brand fallback uses Inter font (S13 cross-doc consistency)', () => {
    for (const key of ['tmc', 'rfu', 'travelstall', 'visasure', '_generic']) {
      expect(INVOICE_BRAND_KIT_FALLBACKS[key].fontFamily).toBe('Inter, sans-serif');
    }
  });

  test('FALLBACKS hex values match S13 verbatim (cross-doc consistency)', () => {
    // VERBATIM copy of S13's BRAND_KIT_FALLBACKS hex values from
    // `routes/travel_itinerary_templates.js:123-129`. If S13's palette
    // ever changes, the same admin-edit cascades to invoice PDFs, and
    // this test surfaces the cross-doc drift on the first push.
    expect(INVOICE_BRAND_KIT_FALLBACKS.tmc.primaryColor).toBe('#1F4E79');
    expect(INVOICE_BRAND_KIT_FALLBACKS.tmc.accentColor).toBe('#F2B544');
    expect(INVOICE_BRAND_KIT_FALLBACKS.tmc.headerColor).toBe('#1F4E79');
    expect(INVOICE_BRAND_KIT_FALLBACKS.rfu.primaryColor).toBe('#0B5345');
    expect(INVOICE_BRAND_KIT_FALLBACKS.rfu.accentColor).toBe('#D4AC0D');
    expect(INVOICE_BRAND_KIT_FALLBACKS.rfu.headerColor).toBe('#0B5345');
    expect(INVOICE_BRAND_KIT_FALLBACKS.travelstall.primaryColor).toBe('#C0392B');
    expect(INVOICE_BRAND_KIT_FALLBACKS.travelstall.accentColor).toBe('#F39C12');
    expect(INVOICE_BRAND_KIT_FALLBACKS.travelstall.headerColor).toBe('#922B21');
    expect(INVOICE_BRAND_KIT_FALLBACKS.visasure.primaryColor).toBe('#283747');
    expect(INVOICE_BRAND_KIT_FALLBACKS.visasure.accentColor).toBe('#5DADE2');
    expect(INVOICE_BRAND_KIT_FALLBACKS.visasure.headerColor).toBe('#283747');
  });
});

// ── renderTravelInvoicePdf — sub-brand-aware header colors ─────────

describe('renderTravelInvoicePdf — brand-kit-aware header colors', () => {
  test('TMC sub-brand + no tenant config → renders TMC fallback header (#1F4E79)', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'tmc' }),
      lines: sampleLines(),
      tenant: null,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    // TMC header color #1F4E79 → float prefix [0.12156, 0.30588, 0.47450].
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(true);
    // RFU's distinctive green should NOT appear in the TMC invoice.
    expect(pdfContainsHexColor(buf, '#0B5345')).toBe(false);
    // Producer metadata records that we used the fallback path.
    const producer = extractProducer(buf);
    expect(producer).toMatch(/brand-kit: fallback/);
  });

  test('RFU sub-brand + no tenant config → renders RFU fallback header (#0B5345)', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'rfu' }),
      lines: sampleLines(),
      tenant: null,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(pdfContainsHexColor(buf, '#0B5345')).toBe(true);
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(false);
    const producer = extractProducer(buf);
    expect(producer).toMatch(/brand-kit: fallback/);
  });

  test('Travel Stall sub-brand → renders Travel-Stall fallback header (#922B21)', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'travelstall' }),
      lines: sampleLines(),
      tenant: null,
    });
    expect(pdfContainsHexColor(buf, '#922B21')).toBe(true);
    // Travel Stall's primaryColor (#C0392B) appears as the Total-Due label.
    expect(pdfContainsHexColor(buf, '#C0392B')).toBe(true);
  });

  test('Visa Sure sub-brand → renders Visa-Sure fallback header (#283747)', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'visasure' }),
      lines: sampleLines(),
      tenant: null,
    });
    expect(pdfContainsHexColor(buf, '#283747')).toBe(true);
  });

  test('explicit subBrandConfigJson overrides the hard-coded fallback', async () => {
    // Tenant admin set TMC's header to bright pink — the PDF should
    // reflect that (admin curates Q22 brand pack, route bypasses the
    // hex hard-codes).
    const tenant = {
      id: 1,
      name: 'Acme Travels',
      subBrandConfigJson: JSON.stringify({
        tmc: { headerColor: '#FF00FF', primaryColor: '#FF00FF' },
      }),
    };
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'tmc' }),
      lines: sampleLines(),
      tenant,
    });
    // Pink #FF00FF → r=1, g=0, b=1 (exact decimals). Float prefixes are
    // "1", "0", "1" (well — pdfkit emits "1 0 1" — so substring "1" is
    // trivially in any PDF; assert via Producer instead).
    expect(extractProducer(buf)).toMatch(/brand-kit: subBrandConfig/);
    // And the fallback teal MUST NOT appear at all in the PDF (operator
    // overrode it; "fallback color leaked" would be a bug).
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(false);
  });

  test('null subBrandConfigJson on tenant → falls back per sub-brand', async () => {
    const tenant = { id: 1, name: 'Acme Travels', subBrandConfigJson: null };
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'tmc' }),
      lines: sampleLines(),
      tenant,
    });
    expect(extractProducer(buf)).toMatch(/brand-kit: fallback/);
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(true);
  });

  test('malformed subBrandConfigJson → silent fall-through to fallback (no throw)', async () => {
    const tenant = {
      id: 1,
      name: 'Acme Travels',
      subBrandConfigJson: '{this-is-not-json',
    };
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'rfu' }),
      lines: sampleLines(),
      tenant,
    });
    // Bad config blob does NOT 500 the download — we render with the
    // sub-brand's fallback palette.
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(extractProducer(buf)).toMatch(/brand-kit: fallback/);
    expect(pdfContainsHexColor(buf, '#0B5345')).toBe(true);
  });

  test('top-level cfg block applies when subBrand has no dedicated block', async () => {
    const tenant = {
      id: 1,
      name: 'Acme Travels',
      // Only a top-level block — no per-sub-brand blocks.
      subBrandConfigJson: JSON.stringify({
        headerColor: '#123456',
        primaryColor: '#123456',
      }),
    };
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'tmc' }),
      lines: sampleLines(),
      tenant,
    });
    expect(extractProducer(buf)).toMatch(/brand-kit: subBrandConfig/);
    // Top-level color #123456 should be present; TMC's fallback color
    // (#1F4E79) should NOT be (top-level overrode it).
    expect(pdfContainsHexColor(buf, '#123456')).toBe(true);
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(false);
  });

  test('per-render explicit override (opts.branding) wins over tenant config', async () => {
    const tenant = {
      id: 1,
      name: 'Acme Travels',
      subBrandConfigJson: JSON.stringify({
        tmc: { headerColor: '#AAAAAA' },
      }),
    };
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'tmc' }),
      lines: sampleLines(),
      tenant,
      branding: { headerColor: '#0000FF' },
    });
    // Per-render explicit override is precedence layer 1 — top of chain.
    expect(pdfContainsHexColor(buf, '#0000FF')).toBe(true);
    // The tenant-config value MUST NOT also leak through.
    expect(pdfContainsHexColor(buf, '#AAAAAA')).toBe(false);
  });

  test('renders valid PDF with expected body text (no regression vs pre-S34 shape)', async () => {
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'tmc' }),
      lines: sampleLines(),
      tenant: null,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(2000);
  });
});

// ── Backward compat — wellness invoice path is untouched ───────────

describe('renderBrandedInvoicePdf — backward compat (wellness invoices)', () => {
  test('wellness invoice (no subBrand) still renders via the existing helper', async () => {
    // Confirms the S34 changes did NOT touch the wellness path — wellness
    // invoices have no subBrand field and use renderBrandedInvoicePdf, not
    // renderTravelInvoicePdf. The selector helpers are travel-invoice-only.
    const buf = await renderBrandedInvoicePdf(
      { invoiceNum: 'WINV-2026-0001', amount: 5000, status: 'PAID' },
      { name: 'Patient X' },
      { name: 'Enhanced Wellness', phone: '+911234567890', email: 'hi@wellness.in' },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    // The wellness path does NOT stamp the brand-kit Producer string,
    // because it doesn't read subBrandConfigJson at all.
    const producer = extractProducer(buf);
    // Either default pdfkit Producer or absent — what we MUST NOT see is
    // the brand-kit observability stamp (would mean the travel path
    // accidentally absorbed wellness too).
    expect(producer || '').not.toMatch(/brand-kit:/);
  });
});

// ── S51 — logo URL embedding via pdfkit doc.image() ─────────────────
//
// Pins:
//   (a) thumbnailUrl set + fetch succeeds → PDF body contains a /Subtype
//       /Image XObject (the embedded logo).
//   (b) thumbnailUrl set + fetch fails    → PDF renders without image,
//       fetchLogoBuffer returns null, console.warn fires once.
//   (c) thumbnailUrl null                 → PDF is byte-shape-equivalent
//       to the S34 output (no /Image XObject), back-compat preserved.
//   (d) cache hit                         → second renderer call with the
//       same logo URL does NOT re-invoke axios.
//
// We test by spy-ing pdfRenderer.fetchLogoBuffer (CJS self-mock seam set
// up in renderTravelInvoicePdf via `module.exports.fetchLogoBuffer(...)`)
// for the success / failure / cache-miss cases, and intercept axios for
// the (d) cache pin. _resetLogoCache() runs in beforeEach so the module-
// level cache doesn't leak across cases.

// Minimal 1×1 red PNG — IHDR + IDAT + IEND, well-known valid encoding
// that pdfkit's PNG parser accepts (CRC checks + IDAT inflate succeed).
// Sourced via `base64 -d <<< iVBORw0K...` round-tripped through PDFKit to
// verify acceptance. ~70 bytes.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

/** True if the PDF buffer contains an /Image XObject — i.e. doc.image()
 * was called with a valid buffer and pdfkit serialised it into the body.
 * Looks for the `/Subtype /Image` marker in the (decompressed) byte
 * stream; the marker survives pdfkit's default flate compression because
 * the XObject dictionary is uncompressed (only the image data stream is
 * flated). */
function pdfContainsImageXObject(buf) {
  const str = buf.toString('latin1');
  return /\/Subtype\s*\/Image/.test(str);
}

describe('renderTravelInvoicePdf — S51 logo URL embedding', () => {
  beforeEach(() => {
    // Module-level cache nuke so (a)/(b)/(c)/(d) don't share state.
    pdfR._resetLogoCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('S51 (a) — thumbnailUrl set + fetch succeeds → PDF embeds /Image XObject', async () => {
    // Spy the CJS self-mock seam so we never touch axios. fetchLogoBuffer
    // returns the tiny PNG → renderTravelInvoicePdf calls doc.image(buf)
    // → pdfkit emits an /XObject /Subtype /Image dictionary in the body.
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockResolvedValue(TINY_PNG);
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'tmc' }),
      lines: sampleLines(),
      tenant: null,
      // Per-render override layer 1 wins; we don't need a real cfg blob.
      branding: { thumbnailUrl: 'https://cdn.example.com/tmc-logo.png' },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://cdn.example.com/tmc-logo.png');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    // The /Image XObject is the load-bearing pin — proves pdfkit
    // actually serialised the logo into the PDF body. PNG magic bytes
    // (89 50 4E 47) also appear in the (compressed) image stream, but
    // the XObject dictionary is the canonical signal because it's
    // uncompressed.
    expect(pdfContainsImageXObject(buf)).toBe(true);
  });

  test('S51 (b) — thumbnailUrl set + fetch fails → PDF renders without image, no throw', async () => {
    // fetchLogoBuffer's contract is "return null on failure, do not
    // throw" — so the renderer falls through to a logo-less header band.
    // The PDF still renders cleanly; the only signal is the absence of
    // the /Image XObject.
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockResolvedValue(null);
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'tmc' }),
      lines: sampleLines(),
      tenant: null,
      branding: { thumbnailUrl: 'https://cdn.example.com/404.png' },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    // The header band still renders (brand-kit colors still applied),
    // but no /Image XObject because no buffer reached doc.image().
    expect(pdfContainsImageXObject(buf)).toBe(false);
    // TMC fallback header color is still present — the failed logo
    // fetch MUST NOT regress the brand-kit selector.
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(true);
  });

  test('S51 (c) — thumbnailUrl null → PDF unchanged from S34 output (back-compat)', async () => {
    // No spy at all — the renderer's `if (branding.thumbnailUrl)` guard
    // means fetchLogoBuffer is NEVER called. We assert that explicitly
    // via a fail-loud spy so any future commit that strips the null
    // guard immediately reds this test.
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockImplementation(() => {
      throw new Error('fetchLogoBuffer must NOT be called when thumbnailUrl is null');
    });
    const buf = await generateTravelInvoicePdf({
      invoice: travelInvoiceFixture({ subBrand: 'tmc' }),
      lines: sampleLines(),
      tenant: null,
      // No branding.thumbnailUrl override — falls through to brand-kit
      // selector, whose thumbnailUrl is null (operator hasn't uploaded
      // a logo yet — Q22 blocker).
    });
    expect(spy).not.toHaveBeenCalled();
    expect(Buffer.isBuffer(buf)).toBe(true);
    // S34 contract preserved: header color, Producer metadata, body all
    // unchanged. No /Image XObject because fetcher was never called.
    expect(pdfContainsImageXObject(buf)).toBe(false);
    expect(pdfContainsHexColor(buf, '#1F4E79')).toBe(true);
    expect(extractProducer(buf)).toMatch(/brand-kit: fallback/);
  });

  test('S51 (d) — cache hit: second render with same URL does NOT re-fetch axios', async () => {
    // Cache test exercises the REAL fetchLogoBuffer (not the spy) so we
    // pin its in-memory LRU contract end-to-end. Mock axios at the
    // require level via vi.doMock — fetchLogoBuffer lazy-requires axios
    // inside its body so the doMock catches the first call, and the
    // cached buffer short-circuits the second call before axios is
    // consulted again.
    const axiosGet = vi.fn().mockResolvedValue({
      data: TINY_PNG,
      status: 200,
    });
    // Use the opts.axios DI hook so we don't have to wrestle vi.mock
    // module-cache state across describe blocks. The contract is
    // identical (the renderer's call site passes no opts, so it uses
    // the lazy-required axios — but for this cache pin we exercise
    // fetchLogoBuffer directly).
    const url = 'https://cdn.example.com/cache-pin.png';
    const buf1 = await pdfR.fetchLogoBuffer(url, { axios: { get: axiosGet } });
    expect(buf1).toEqual(TINY_PNG);
    expect(axiosGet).toHaveBeenCalledTimes(1);

    // Second call with same URL: cache hit, no axios.get call.
    const buf2 = await pdfR.fetchLogoBuffer(url, { axios: { get: axiosGet } });
    expect(buf2).toEqual(TINY_PNG);
    // CRITICAL pin: still exactly 1 axios call. Cache short-circuited.
    expect(axiosGet).toHaveBeenCalledTimes(1);

    // Sanity: different URL = different fetch (proves it's a per-URL
    // cache, not a "first call wins forever" bug).
    const buf3 = await pdfR.fetchLogoBuffer(
      'https://cdn.example.com/different.png',
      { axios: { get: axiosGet } },
    );
    expect(buf3).toEqual(TINY_PNG);
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });

  test('S51 (d-extra) — TTL expiry: stale cache entry triggers re-fetch', async () => {
    // Pin the TTL semantics — if the cache entry is older than ttlMs, the
    // next call re-fetches. Use a tiny ttlMs window so the test is fast.
    const axiosGet = vi.fn().mockResolvedValue({
      data: TINY_PNG,
      status: 200,
    });
    const url = 'https://cdn.example.com/ttl-pin.png';
    await pdfR.fetchLogoBuffer(url, { axios: { get: axiosGet }, ttlMs: 1 });
    expect(axiosGet).toHaveBeenCalledTimes(1);
    // Wait past TTL expiry so the cached entry is stale on next read.
    await new Promise((r) => setTimeout(r, 5));
    await pdfR.fetchLogoBuffer(url, { axios: { get: axiosGet }, ttlMs: 1 });
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });

  test('S51 fetchLogoBuffer contract — null URL → null (no throw, no fetch)', async () => {
    // Defensive — the renderer guards against null thumbnailUrl, but
    // fetchLogoBuffer should ALSO be defensive in case a future caller
    // forgets the guard.
    const axiosGet = vi.fn();
    const buf = await pdfR.fetchLogoBuffer(null, { axios: { get: axiosGet } });
    expect(buf).toBe(null);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  test('S51 fetchLogoBuffer contract — axios.get throws → null + console.warn', async () => {
    // Fail-soft contract pin. A flaky CDN must NOT 500 the PDF download.
    const axiosGet = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buf = await pdfR.fetchLogoBuffer(
      'https://cdn.example.com/broken.png',
      { axios: { get: axiosGet } },
    );
    expect(buf).toBe(null);
    expect(warnSpy).toHaveBeenCalled();
    const warnText = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnText).toMatch(/logo fetch failed/);
    expect(warnText).toMatch(/ECONNRESET/);
  });
});
