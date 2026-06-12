// @ts-check
/**
 * backend/services/passportOcrClient.js — local OCR pipeline.
 *
 * We inject the OCR step via the `ocr` seam (extractPassport({..., ocr})) so
 * these tests are deterministic and never invoke tesseract.js / download
 * traineddata in CI. The seam returns canned OCR text; the assertions pin the
 * envelope contract, the MRZ→fields mapping, confidence behaviour, the PII
 * boundary (no place-of-birth/issue from MRZ), and the graceful-failure paths.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractPassport, isEnabledForTenant } from '../../services/passportOcrClient.js';

// Canonical ICAO specimen MRZ (valid check digits).
const MRZ_TEXT = [
  'UNITED ARAB EMIRATES',
  'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
  'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
].join('\n');

const IMG = Buffer.from('fake-image-bytes'); // resolveImageInput accepts a Buffer

const okOcr = (text = MRZ_TEXT, confidence = 92) => async () => ({ text, confidence });

beforeEach(() => {
  delete process.env.PASSPORT_OCR_DISABLED;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PASSPORT_OCR_DISABLED;
});

describe('isEnabledForTenant', () => {
  test('false without a tenant, false when disabled, true otherwise', () => {
    expect(isEnabledForTenant(null)).toBe(false);
    expect(isEnabledForTenant(1)).toBe(true);
    process.env.PASSPORT_OCR_DISABLED = '1';
    expect(isEnabledForTenant(1)).toBe(false);
  });
});

describe('extractPassport — enablement', () => {
  test('throws PASSPORT_OCR_NOT_YET_ENABLED without a tenant', async () => {
    await expect(extractPassport({ fileBuffer: IMG, ocr: okOcr() })).rejects.toMatchObject({
      code: 'PASSPORT_OCR_NOT_YET_ENABLED',
    });
  });

  test('throws PASSPORT_OCR_NOT_YET_ENABLED when PASSPORT_OCR_DISABLED=1', async () => {
    process.env.PASSPORT_OCR_DISABLED = '1';
    await expect(extractPassport({ tenantId: 1, fileBuffer: IMG, ocr: okOcr() })).rejects.toMatchObject({
      code: 'PASSPORT_OCR_NOT_YET_ENABLED',
    });
  });
});

describe('extractPassport — happy path (MRZ extracted)', () => {
  test('maps the MRZ into the extraction envelope', async () => {
    const res = await extractPassport({ tenantId: 1, fileBuffer: IMG, ocr: okOcr() });
    expect(res.provider).toBe('local-mrz-v1');
    expect(res.mrzFound).toBe(true);
    expect(res.extraction.passportNumber).toBe('L898902C3');
    expect(res.extraction.surname).toBe('ERIKSSON');
    expect(res.extraction.givenNames).toBe('ANNA MARIA');
    expect(res.extraction.nationality).toBe('UTO');
    expect(res.extraction.dateOfBirth).toBe('1974-08-12');
    expect(res.extraction.sex).toBe('F');
    expect(res.extraction.dateOfExpiry).toBe('2012-04-15');
    expect(res.extraction.mrz).toContain('L898902C36UTO');
    // All check digits valid → high confidence.
    expect(res.confidence).toBeGreaterThan(0.85);
    expect(res.checks?.passportNumber).toBe(true);
  });

  test('PII boundary: fields not present in the MRZ stay null', async () => {
    const res = await extractPassport({ tenantId: 1, fileBuffer: IMG, ocr: okOcr() });
    expect(res.extraction.placeOfBirth).toBeNull();
    expect(res.extraction.placeOfIssue).toBeNull();
    expect(res.extraction.dateOfIssue).toBeNull();
  });

  test('lower OCR confidence nudges, valid check digits dominate', async () => {
    const high = await extractPassport({ tenantId: 1, fileBuffer: IMG, ocr: okOcr(MRZ_TEXT, 99) });
    const low = await extractPassport({ tenantId: 1, fileBuffer: IMG, ocr: okOcr(MRZ_TEXT, 10) });
    expect(high.confidence).toBeGreaterThanOrEqual(low.confidence);
    expect(low.confidence).toBeGreaterThan(0.7); // check digits keep it high
  });
});

describe('extractPassport — graceful failure paths (upload still lands)', () => {
  test('no MRZ in the OCR text → mrzFound:false, null fields, confidence 0', async () => {
    const res = await extractPassport({ tenantId: 1, fileBuffer: IMG, ocr: okOcr('no machine readable zone here') });
    expect(res.mrzFound).toBe(false);
    expect(res.confidence).toBe(0);
    expect(res.extraction.passportNumber).toBeNull();
    expect(res.provider).toBe('local-mrz-v1');
    expect(res.note).toMatch(/machine-readable zone/i);
  });

  test('OCR engine throwing is non-fatal', async () => {
    const res = await extractPassport({
      tenantId: 1, fileBuffer: IMG,
      ocr: async () => { throw new Error('engine boom'); },
    });
    expect(res.mrzFound).toBe(false);
    expect(res.confidence).toBe(0);
    expect(res.note).toMatch(/failed/i);
  });

  test('no readable image → mrzFound:false, OCR not attempted', async () => {
    const ocr = vi.fn(okOcr());
    const res = await extractPassport({ tenantId: 1, ocr }); // no buffer, no path
    expect(res.mrzFound).toBe(false);
    expect(ocr).not.toHaveBeenCalled();
  });

  test('PDF uploads are not auto-extracted (no OCR attempt)', async () => {
    const ocr = vi.fn(okOcr());
    const res = await extractPassport({ tenantId: 1, fileBuffer: IMG, fileName: 'passport.pdf', ocr });
    expect(res.mrzFound).toBe(false);
    expect(res.note).toMatch(/PDF/i);
    expect(ocr).not.toHaveBeenCalled();
  });
});

describe('extractPassport — image input resolution', () => {
  test('passes the OCR seam the provided buffer', async () => {
    const ocr = vi.fn(okOcr());
    await extractPassport({ tenantId: 1, fileBuffer: IMG, ocr });
    expect(ocr).toHaveBeenCalledWith(IMG);
  });
});

describe('extractPassport — MRZ + VIZ hybrid (malformed MRZ rescued by the printed zone)', () => {
  // Mirrors the real UAE specimen: the MRZ second line uses FULL dates instead
  // of the ICAO YYMMDD+check-digit layout, so every MRZ check digit fails and
  // the positional dates/nationality come out wrong. The printed visual zone,
  // however, has the correct values under labels.
  const BAD_MRZ = [
    'P<BINNASSER<<HUDA<AL<<<<<<<<<<<<<<<<<<<<<<<<',
    'P90S12345ARE27071987F12012021<<<<<<<<<<<<<<8',
  ].join('\n');
  const VIZ = [
    'UNITED ARAB EMIRATES',
    'Passport No P90S12345',
    'Names HUDA BIN NASSER',
    'Nationality United Arab Emirates',
    'Date of Birth 27/07/1987   Sex F',
    'Date of Expiry 12/01/2021   Date of Issue 12/01/2016',
  ].join('\n');

  test('prefers the VIZ values for the fields the MRZ check digits reject', async () => {
    const res = await extractPassport({
      tenantId: 1, fileBuffer: IMG,
      ocr: async () => ({ mrzText: BAD_MRZ, vizText: VIZ, confidence: 70 }),
    });
    // Correct values now come from the printed zone, not the broken MRZ.
    expect(res.extraction.passportNumber).toBe('P90S12345');
    expect(res.extraction.dateOfBirth).toBe('1987-07-27');
    expect(res.extraction.dateOfExpiry).toBe('2021-01-12'); // not the garbled MRZ date
    expect(res.extraction.nationality).toBe('ARE'); // not "RE2"
    // Name comes from the VIZ (MRZ line-1 filler was misread as K/L runs).
    expect(res.extraction.givenNames).toMatch(/HUDA BIN NASSER/);
    // Flagged for operator double-check since the MRZ didn't validate.
    expect(res.mrzFound).toBe(true);
    expect(res.vizFound).toBe(true);
    expect(res.note).toMatch(/printed page/i);
    expect(res.confidence).toBeGreaterThan(0.4);
  });
});
