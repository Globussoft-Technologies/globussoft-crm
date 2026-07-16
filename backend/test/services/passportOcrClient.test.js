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
import { extractPassport, isEnabledForTenant, withTimeout } from '../../services/passportOcrClient.js';

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

describe('extractPassport — VIZ cross-check catches MRZ digit/letter slips', () => {
  // The MRZ check digit can pass even when a digit is misread as a letter
  // (G at position 3 has the same modulo-10 weight as 6). The printed page
  // usually shows the correct passport number, so we use it as a tie-breaker
  // when it is consistent with the MRZ check digit.
  const UAE_MRZ = [
    'P<ARESHAMSI<<MAJID<AL<<<<<<<<<<<<<<<<<<<<<<<<<',
    'Q34G567890ARE2303196M2604206<<<<<<<<<<<<<<08',
  ].join('\n');
  const UAE_VIZ = [
    'UNITED ARAB EMIRATES',
    'Passport No Q34656789',
    'Names SHAMSI MAJID AL',
  ].join('\n');

  test('prefers VIZ passport number when MRZ digit/letter confusion passes check digit', async () => {
    const res = await extractPassport({
      tenantId: 1, fileBuffer: IMG,
      ocr: async () => ({ mrzText: UAE_MRZ, vizText: UAE_VIZ, confidence: 80 }),
    });
    expect(res.extraction.passportNumber).toBe('Q34656789');
    expect(res.extraction.dateOfBirth).toBe('2023-03-19');
    expect(res.extraction.dateOfExpiry).toBe('2026-04-20');
    expect(res.note).toMatch(/disagreed/i);
  });
});

describe('withTimeout — worker leak fix (2026-07-15)', () => {
  // Regression test for a memory leak: withTimeout() used to be a bare
  // Promise.race, which does NOT cancel the losing side. When a slow OCR
  // call outran the timeout, the abandoned runOcr() call kept its Tesseract
  // worker (WASM + loaded traineddata) alive in the background indefinitely
  // — and withOcrSlot()'s concurrency gate released immediately on timeout,
  // so leaked workers were never even counted against the concurrency cap.
  // The fix threads a workerRef out-param through so the timeout path can
  // terminate the worker directly instead of merely losing the race.
  test('terminates the in-flight worker via workerRef when the timeout fires', async () => {
    const worker = { terminate: vi.fn().mockResolvedValue(undefined) };
    const workerRef = { current: worker };
    const slowPromise = new Promise(() => {}); // never resolves — simulates a stuck OCR call

    await expect(withTimeout(slowPromise, 10, workerRef)).rejects.toMatchObject({ code: 'OCR_TIMEOUT' });

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(workerRef.current).toBeNull();
  });

  test('does not touch the worker when the promise settles before the timeout', async () => {
    const worker = { terminate: vi.fn().mockResolvedValue(undefined) };
    const workerRef = { current: worker };

    const result = await withTimeout(Promise.resolve('done'), 5000, workerRef);

    expect(result).toBe('done');
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  test('is a no-op when no worker has been assigned yet (workerRef.current is null)', async () => {
    const workerRef = { current: null };
    const slowPromise = new Promise(() => {});

    await expect(withTimeout(slowPromise, 10, workerRef)).rejects.toMatchObject({ code: 'OCR_TIMEOUT' });
    // Nothing to assert on termination — just confirms no throw on a null worker.
  });

  test('still rejects with OCR_TIMEOUT when no workerRef is passed (back-compat)', async () => {
    const slowPromise = new Promise(() => {});
    await expect(withTimeout(slowPromise, 10)).rejects.toMatchObject({ code: 'OCR_TIMEOUT' });
  });
});

describe('extractPassport — non-ICAO full-date MRZ (e.g. UAE)', () => {
  // Some passports use full DDMMYYYY dates and omit ICAO check digits. The
  // parser detects this layout and reads the fields positionally from the MRZ.
  const UAE_MRZ = [
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

  test('reads positional fields from the non-ICAO MRZ layout', async () => {
    const res = await extractPassport({
      tenantId: 1, fileBuffer: IMG,
      ocr: async () => ({ mrzText: UAE_MRZ, vizText: VIZ, confidence: 70 }),
    });
    expect(res.extraction.passportNumber).toBe('P90S12345');
    expect(res.extraction.dateOfBirth).toBe('1987-07-27');
    expect(res.extraction.dateOfExpiry).toBe('2021-01-12');
    expect(res.extraction.nationality).toBe('ARE');
    expect(res.extraction.surname).toBe('BINNASSER');
    expect(res.extraction.givenNames).toBe('HUDA AL');
    expect(res.extraction.sex).toBe('F');
    // VIZ-only fields still come from the printed page.
    expect(res.extraction.dateOfIssue).toBe('2016-01-12');
    expect(res.mrzFound).toBe(true);
    expect(res.vizFound).toBe(true);
    expect(res.note).toMatch(/non-ICAO/i);
    expect(res.confidence).toBeGreaterThan(0.6);
  });
});
