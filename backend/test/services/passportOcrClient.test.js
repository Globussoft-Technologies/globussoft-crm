// Unit tests for backend/services/passportOcrClient.js
//
// What this module does:
//   STUB-mode passport OCR client. Real-mode swap (vendor HTTP call) lands
//   when PC-1 vendor decision + cred drop arrives (docs/PRD_PASSPORT_OCR.md
//   §5). Stub returns canned extraction values so the upload route +
//   verification queue UI can ship + go green on CI / demo ahead of the
//   vendor decision.
//
// Exports pinned:
//   - INTEGRATION                   — short token ('passport-ocr')
//   - isEnabledForTenant(tenantId)  — env-var + tenantId presence check
//   - extractPassport({tenantId, imageDataUrl|fileBuffer, fileName})
//       → { extraction, confidence, provider, extractedAt }
//
// Surface area covered (6 cases):
//   1. exports the contract surface
//   2. isEnabledForTenant returns false when tenantId is falsy
//   3. isEnabledForTenant returns false when PASSPORT_OCR_DISABLED=1
//   4. extractPassport throws PASSPORT_OCR_NOT_YET_ENABLED when disabled
//   5. extractPassport returns canned envelope shape when enabled
//   6. extractPassport returned MRZ matches the canonical Indian passport
//      ICAO 9303 format (44 chars × 2 lines) — pins the contract the
//      operator UI's MRZ-checksum check depends on (PRD §2.4)
//
// Pin the contract the REAL implementation MUST honour when the stub is
// swapped — downstream consumers (upload route, verification queue UI,
// audit hooks) depend on the returned envelope.

import { describe, test, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

function loadClient() {
  delete requireCjs.cache[requireCjs.resolve('../../services/passportOcrClient.js')];
  return requireCjs('../../services/passportOcrClient.js');
}

afterEach(() => {
  delete process.env.PASSPORT_OCR_DISABLED;
});

describe('passportOcrClient — module shape', () => {
  test('exports the contract surface', () => {
    const c = loadClient();
    expect(typeof c.extractPassport).toBe('function');
    expect(typeof c.isEnabledForTenant).toBe('function');
    expect(c.INTEGRATION).toBe('passport-ocr');
  });
});

describe('isEnabledForTenant', () => {
  test('returns false when tenantId is falsy', () => {
    const c = loadClient();
    expect(c.isEnabledForTenant(null)).toBe(false);
    expect(c.isEnabledForTenant(undefined)).toBe(false);
    expect(c.isEnabledForTenant(0)).toBe(false);
  });

  test('returns false when PASSPORT_OCR_DISABLED=1 even with valid tenantId', () => {
    process.env.PASSPORT_OCR_DISABLED = '1';
    const c = loadClient();
    expect(c.isEnabledForTenant(42)).toBe(false);
  });

  test('returns true when tenantId is valid and not disabled', () => {
    const c = loadClient();
    expect(c.isEnabledForTenant(42)).toBe(true);
  });
});

describe('extractPassport — disabled-path', () => {
  test('throws PASSPORT_OCR_NOT_YET_ENABLED when vendor disabled', async () => {
    process.env.PASSPORT_OCR_DISABLED = '1';
    const c = loadClient();
    let caught;
    try {
      await c.extractPassport({ tenantId: 42, fileName: 'passport.jpg' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('PASSPORT_OCR_NOT_YET_ENABLED');
    expect(caught.message).toMatch(/Passport OCR vendor not yet enabled/);
  });

  test('throws PASSPORT_OCR_NOT_YET_ENABLED when tenantId is missing', async () => {
    const c = loadClient();
    await expect(c.extractPassport({ fileName: 'passport.jpg' })).rejects.toMatchObject({
      code: 'PASSPORT_OCR_NOT_YET_ENABLED',
    });
  });
});

describe('extractPassport — happy path (stub-mode)', () => {
  test('returns canned envelope with extraction + confidence + provider + extractedAt', async () => {
    const c = loadClient();
    const before = Date.now();
    const out = await c.extractPassport({
      tenantId: 42,
      fileName: 'jane-doe-passport.jpg',
      fileBuffer: Buffer.from('synthetic-image-bytes'),
    });
    const after = Date.now();

    // Envelope-level keys
    expect(out).toHaveProperty('extraction');
    expect(out).toHaveProperty('confidence');
    expect(out).toHaveProperty('provider');
    expect(out).toHaveProperty('extractedAt');

    // Provider token — pins the stub identifier so the verification UI
    // can render a "STUB MODE — pending PC-1 vendor decision" banner
    // unambiguously when provider starts with "stub-".
    expect(out.provider).toBe('stub-mode-v1');

    // Confidence is a scalar in [0, 1].
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence).toBeLessThanOrEqual(1);

    // extractedAt is a recent ISO timestamp.
    const extractedAtMs = new Date(out.extractedAt).getTime();
    expect(extractedAtMs).toBeGreaterThanOrEqual(before);
    expect(extractedAtMs).toBeLessThanOrEqual(after);

    // Required field shape (FR-2 in PRD).
    expect(out.extraction).toMatchObject({
      passportNumber: expect.any(String),
      surname: expect.any(String),
      givenNames: expect.any(String),
      dateOfBirth: expect.any(String),
      sex: expect.any(String),
      nationality: expect.any(String),
      placeOfBirth: expect.any(String),
      placeOfIssue: expect.any(String),
      dateOfIssue: expect.any(String),
      dateOfExpiry: expect.any(String),
      mrz: expect.any(String),
    });

    // Date fields are valid ISO YYYY-MM-DD strings.
    for (const k of ['dateOfBirth', 'dateOfIssue', 'dateOfExpiry']) {
      expect(out.extraction[k]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const t = new Date(out.extraction[k]).getTime();
      expect(Number.isFinite(t)).toBe(true);
    }
  });

  test('returned MRZ matches ICAO 9303 format (2 lines × 44 chars, line-1 starts with P)', async () => {
    // Regression pin for PRD §2.4 "MRZ vs VIZ mismatch" check — the
    // operator UI's MRZ checksum / format validator depends on this
    // shape. Future contract changes should bless this assertion.
    const c = loadClient();
    const out = await c.extractPassport({
      tenantId: 42,
      imageDataUrl: 'data:image/jpeg;base64,c3ludGhldGlj',
    });
    const lines = out.extraction.mrz.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].length).toBe(44);
    expect(lines[1].length).toBe(44);
    expect(lines[0]).toMatch(/^P</); // ICAO 9303: passport type "P" + filler "<"
  });
});
