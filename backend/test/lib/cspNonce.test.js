// Unit tests for backend/lib/cspNonce.js
//
// Module under test: generateNonce() + attachNonce(req, res, next).
// What this pins
// --------------
// generateNonce:
//   - Returns a base64-encoded string.
//   - Each call returns a distinct value (entropy check — 100 iterations,
//     all unique; with 16 bytes / 128 bits of entropy a collision would be
//     a wildly improbable event, but the test catches a regression to
//     Math.random() / a static value).
//   - Length is consistent — base64 of 16 bytes is exactly 24 chars
//     (including the trailing `==` padding). Stable length is important for
//     downstream callers (CSP source-list entry, HTML `nonce=` attribute).
//
// attachNonce middleware:
//   - Sets res.locals.cspNonce to a freshly-minted nonce.
//   - Calls next() (no early-return, no error path).
//   - Defensive: if res.locals is missing on the incoming res, the
//     middleware creates it before assignment instead of throwing — guards
//     against test-harness / non-Express callers.
//   - Each invocation generates a NEW nonce (does not memoize across
//     requests).
//
// These tests intentionally avoid mocking crypto.randomBytes — we want to
// verify the real entropy source so a regression to a predictable RNG
// surfaces here, not in production. The entropy check is statistical
// (100 unique values out of 100); the chance of a 128-bit collision in 100
// draws is effectively zero (~3 × 10^-37).
import { describe, test, expect, vi } from 'vitest';
import { generateNonce, attachNonce } from '../../lib/cspNonce.js';

describe('generateNonce', () => {
  test('returns a string', () => {
    expect(typeof generateNonce()).toBe('string');
  });

  test('returns a valid base64 string (decodable round-trip)', () => {
    const nonce = generateNonce();
    // Buffer.from('...', 'base64') silently truncates on invalid chars, so
    // the canonical check is "re-encode the decoded buffer and compare".
    const decoded = Buffer.from(nonce, 'base64');
    expect(decoded.length).toBe(16); // 128 bits per CSP3 recommendation
    expect(decoded.toString('base64')).toBe(nonce);
  });

  test('returns a 24-character string (base64 of 16 bytes incl. == padding)', () => {
    // 16 bytes → ceil(16/3)*4 = 24 chars. Length stability matters because
    // downstream callers length-check the CSP header / HTML attr.
    for (let i = 0; i < 10; i++) {
      expect(generateNonce()).toHaveLength(24);
    }
  });

  test('each call returns a distinct value (100 iterations, all unique)', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      seen.add(generateNonce());
    }
    expect(seen.size).toBe(100);
  });

  test('uses only base64 alphabet characters', () => {
    // [A-Za-z0-9+/=] — no URL-safe variant, no whitespace.
    const base64Re = /^[A-Za-z0-9+/]+={0,2}$/;
    for (let i = 0; i < 10; i++) {
      expect(generateNonce()).toMatch(base64Re);
    }
  });
});

describe('attachNonce', () => {
  function makeReqRes(overrides = {}) {
    const req = {};
    const res = { locals: {}, ...overrides };
    const next = vi.fn();
    return { req, res, next };
  }

  test('sets res.locals.cspNonce to a non-empty string', () => {
    const { req, res, next } = makeReqRes();
    attachNonce(req, res, next);
    expect(typeof res.locals.cspNonce).toBe('string');
    expect(res.locals.cspNonce.length).toBeGreaterThan(0);
  });

  test('the attached nonce is the same shape generateNonce returns', () => {
    const { req, res, next } = makeReqRes();
    attachNonce(req, res, next);
    // Same length + base64 alphabet as generateNonce — guards against a
    // future regression where attachNonce silently changes encoding.
    expect(res.locals.cspNonce).toHaveLength(24);
    expect(res.locals.cspNonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test('calls next() exactly once with no arguments', () => {
    const { req, res, next } = makeReqRes();
    attachNonce(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test('defensive: initialises res.locals when missing (does not throw)', () => {
    // A test harness or non-Express caller may pass a bare {} as res.
    // The middleware must NOT throw — it should create res.locals first.
    const req = {};
    const res = {}; // no locals
    const next = vi.fn();
    expect(() => attachNonce(req, res, next)).not.toThrow();
    expect(res.locals).toBeDefined();
    expect(typeof res.locals.cspNonce).toBe('string');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('each request gets a different nonce (no memoization)', () => {
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const { req, res, next } = makeReqRes();
      attachNonce(req, res, next);
      seen.add(res.locals.cspNonce);
    }
    expect(seen.size).toBe(20);
  });

  test('preserves existing res.locals keys (additive, not destructive)', () => {
    // Some upstream middleware may have populated res.locals already.
    // attachNonce should ADD cspNonce, not replace the whole locals object.
    const req = {};
    const res = { locals: { user: { id: 42 }, requestId: 'abc' } };
    const next = vi.fn();
    attachNonce(req, res, next);
    expect(res.locals.user).toEqual({ id: 42 });
    expect(res.locals.requestId).toBe('abc');
    expect(typeof res.locals.cspNonce).toBe('string');
  });
});
