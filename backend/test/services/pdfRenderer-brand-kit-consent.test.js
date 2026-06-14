// @ts-check
/**
 * G091 — Consent PDF brand-kit consumer (PRD_TRAVEL_PER_SUBBRAND_BRANDING
 * FR-3.3.c). Travel-vertical consent forms (PRD_TRAVEL_BILLING liability
 * waivers, PRD_TRAVEL_VISA data-consent forms, PRD_TRAVEL_TMC parent
 * consents) opt into the same brand-kit header pattern the S52 sibling
 * renderers already use, via a 6th positional `opts` arg accepted by
 * `renderConsentPdf`.
 *
 * Pinned invariants:
 *   1. Wellness path (no opts.subBrand) renders the clinic-header band
 *      unchanged — pre-G091 byte-shape preserved.
 *   2. Travel path (opts.subBrand="tmc") renders the S52-aligned brand
 *      band color (#1F4E79 for TMC) instead of the clinic header.
 *   3. tenant.subBrandConfigJson cascades into the consent header band
 *      (admin override).
 *   4. opts.branding.thumbnailUrl triggers fetchLogoBuffer → /Image
 *      XObject in PDF body (S65 logo-embed pattern).
 *   5. opts.branding.footerText renders a brand-kit footer line ABOVE
 *      the signature block.
 *   6. Producer metadata stamps brandKit=subBrandConfig | fallback for
 *      observability (S34 pattern).
 *
 * Run: `cd backend && npx vitest run test/services/pdfRenderer-brand-kit-consent.test.js`
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import pdfR from '../../services/pdfRenderer.js';
import zlib from 'node:zlib';

const { renderConsentPdf, INVOICE_BRAND_KIT_FALLBACKS } = pdfR;

// ── Helpers ────────────────────────────────────────────────────────────

function hexToFloatPrefixes(hex) {
  const h = hex.replace(/^#/, '');
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;
  return [r.toString().slice(0, 7), g.toString().slice(0, 7), b.toString().slice(0, 7)];
}

function pdfContainsHexColor(buf, hex) {
  const [r, g, b] = hexToFloatPrefixes(hex);
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

function inflatedPdfText(buf) {
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
  const corpus = inflated || str;
  // pdfkit writes each text run as `<hex…>` inside a TJ array. Decode
  // those hex tokens back to printable ASCII so toContain('Test Clinic')
  // matches on the rendered text.
  const decoded = (corpus.match(/<([0-9a-fA-F]+)>/g) || [])
    .map((tok) => {
      const hex = tok.slice(1, -1);
      let s = '';
      for (let i = 0; i + 1 < hex.length; i += 2) {
        const code = parseInt(hex.slice(i, i + 2), 16);
        if (code >= 0x20 && code <= 0x7e) s += String.fromCharCode(code);
      }
      return s;
    })
    .join(' ');
  return `${corpus}\n${decoded}`;
}

// Match a literal token across pdfkit's letter-spacing splits. pdfkit
// splits glyphs across TJ kerning runs, so a single word like "Pricing"
// may render as "Pr icing" in the decoded stream. The matcher folds
// any whitespace between letters into a single ASCII string and looks
// for the substring with that fold applied.
function pdfTextContains(buf, expected) {
  const folded = inflatedPdfText(buf).replace(/\s+/g, '');
  return folded.includes(expected.replace(/\s+/g, ''));
}

// ── Fixtures ───────────────────────────────────────────────────────────

const consent = {
  id: 1,
  templateName: 'aesthetics-treatment',
  signedAt: new Date('2026-06-01T00:00:00Z'),
};

const patient = { name: 'Jane Pilgrim' };
const service = { name: 'Standard Aesthetics' };
const clinic = { name: 'Test Clinic', addressLine: '123 Main St', city: 'Mumbai', state: 'MH', pincode: '400001', phone: '+919999999999', email: 'clinic@example.com' };

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderConsentPdf — pre-G091 wellness back-compat', () => {
  test('5-arg legacy call (no opts) renders the clinic-header path unchanged', async () => {
    const buf = await renderConsentPdf(consent, patient, service, clinic, null);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    // Clinic name should appear (rendered by drawClinicHeader).
    expect(pdfTextContains(buf, 'TestClinic')).toBe(true);
    // No TMC brand band color should appear (legacy wellness path doesn't
    // consult the brand-kit selector).
    expect(pdfContainsHexColor(buf, INVOICE_BRAND_KIT_FALLBACKS.tmc.headerColor)).toBe(false);
  });

  test('6th opts arg with no subBrand still renders clinic-header path', async () => {
    const buf = await renderConsentPdf(consent, patient, service, clinic, null, {});
    expect(pdfTextContains(buf, 'TestClinic')).toBe(true);
    expect(pdfContainsHexColor(buf, INVOICE_BRAND_KIT_FALLBACKS.tmc.headerColor)).toBe(false);
  });
});

describe('renderConsentPdf — G091 travel brand-kit consumer', () => {
  test('opts.subBrand="tmc" renders the TMC brand band color (#1F4E79)', async () => {
    const buf = await renderConsentPdf(consent, patient, service, clinic, null, { subBrand: 'tmc' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(pdfContainsHexColor(buf, INVOICE_BRAND_KIT_FALLBACKS.tmc.headerColor)).toBe(true);
    // Clinic header is REPLACED — clinic name should NOT appear at top.
    // (It's not rendered anywhere in the travel-path body either.)
    expect(pdfTextContains(buf, 'TestClinic')).toBe(false);
  });

  test('opts.subBrand="rfu" renders the RFU brand band color (#0B5345)', async () => {
    const buf = await renderConsentPdf(consent, patient, service, clinic, null, { subBrand: 'rfu' });
    expect(pdfContainsHexColor(buf, INVOICE_BRAND_KIT_FALLBACKS.rfu.headerColor)).toBe(true);
  });

  test('tenant.subBrandConfigJson cascades into the consent header band', async () => {
    const tenant = {
      subBrandConfigJson: JSON.stringify({ tmc: { headerColor: '#FF00FF' } }),
    };
    const buf = await renderConsentPdf(consent, patient, service, clinic, null, {
      subBrand: 'tmc',
      tenant,
    });
    // Magenta should appear; TMC fallback color should NOT.
    expect(pdfContainsHexColor(buf, '#FF00FF')).toBe(true);
    expect(pdfContainsHexColor(buf, INVOICE_BRAND_KIT_FALLBACKS.tmc.headerColor)).toBe(false);
  });

  test('opts.branding.footerText renders above the signature block', async () => {
    const footerCopy = 'ConsentFooterTokenABCD';
    const buf = await renderConsentPdf(consent, patient, service, clinic, null, {
      subBrand: 'tmc',
      branding: { footerText: footerCopy },
    });
    expect(pdfTextContains(buf, footerCopy)).toBe(true);
  });

  test('opts.branding.thumbnailUrl triggers fetchLogoBuffer + embeds /Image', async () => {
    // 1×1 transparent PNG.
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer').mockResolvedValue(tinyPng);
    try {
      const buf = await renderConsentPdf(consent, patient, service, clinic, null, {
        subBrand: 'tmc',
        branding: { thumbnailUrl: 'https://example.com/logo.png' },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('https://example.com/logo.png');
      // /Image XObject appears in the PDF body when a logo embed lands.
      expect(buf.toString('latin1')).toContain('/Subtype /Image');
    } finally {
      spy.mockRestore();
    }
  });

  test('opts.branding.thumbnailUrl absent → fetchLogoBuffer NOT called', async () => {
    const spy = vi.spyOn(pdfR, 'fetchLogoBuffer');
    try {
      await renderConsentPdf(consent, patient, service, clinic, null, { subBrand: 'tmc' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // pdfkit stores Producer as an indirect object — `/Producer N 0 R`
  // points to a stand-alone object holding `(pdfkit/consent brandKit=…)`
  // as a parenthesized PDF string. We grep the full latin1 body for that
  // parenthesised form rather than the dict entry.
  test('Producer metadata stamps brand-kit resolution source = fallback', async () => {
    const buf = await renderConsentPdf(consent, patient, service, clinic, null, { subBrand: 'tmc' });
    expect(buf.toString('latin1')).toContain('(pdfkit/consent brandKit=fallback)');
  });

  test('Producer metadata stamps brand-kit resolution source = subBrandConfig', async () => {
    const tenant = { subBrandConfigJson: JSON.stringify({ tmc: { headerColor: '#001122' } }) };
    const buf = await renderConsentPdf(consent, patient, service, clinic, null, {
      subBrand: 'tmc',
      tenant,
    });
    expect(buf.toString('latin1')).toContain('(pdfkit/consent brandKit=subBrandConfig)');
  });

  test('Signature data URL still embedded under travel path (carries through)', async () => {
    const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
    const buf = await renderConsentPdf(consent, patient, service, clinic, sig, { subBrand: 'tmc' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    // PDF should still have at least one /Image XObject (the signature
    // image — independent of any brand logo). When no thumbnailUrl is
    // passed, that's the only image present.
    expect(buf.toString('latin1')).toContain('/Subtype /Image');
  });
});
