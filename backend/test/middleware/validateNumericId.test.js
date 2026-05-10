// Unit tests for backend/middleware/validateNumericId.js — Wave 10 inspection.
//
// Why this file exists (Wave 10 coverage extension):
//   • Pre-Wave-10 the module was 0% covered. Coverage probe in
//     `backend/.tmp-uncovered2.js` flagged it as one of the truly-zero lib /
//     middleware modules (5 lines, no tests).
//   • It's pure (no Prisma / network) so a unit test is the right tier.
//   • The middleware is mounted at app level via app.param('id', ...) so a
//     unit test asserts the param-callback contract — the integration side
//     is covered by the route specs that exercise GET /api/<resource>/abc
//     and expect 400 INVALID_ID.
//
// Coverage targets (per the source's branch matrix at lines 53-69):
//   • happy path — positive integer string → next() called
//   • non-string value → 400 INVALID_ID
//   • leading-zero value ("01") → 400 INVALID_ID
//   • value "0" → 400 INVALID_ID (Prisma auto-inc starts at 1)
//   • negative integer string → 400 INVALID_ID
//   • decimal string ("1.5") → 400 INVALID_ID
//   • "1abc" mixed string → 400 INVALID_ID (parseInt would have accepted)
//   • empty string → 400 INVALID_ID
//   • whitespace string → 400 INVALID_ID
//   • error envelope shape — { error: "Invalid <name>: ...", code: "INVALID_ID" }
//   • dynamic name interpolation — uses the name arg in the error message
//   • name fallback — defaults to "id" when name is undefined
//   • validateNumericNamedId is an alias of validateNumericId
//   • does NOT mutate req.params (downstream handlers parseInt themselves)
//
// Pattern: pure-function suite (no mocks needed).
import { describe, test, expect, vi } from 'vitest';
import { validateNumericId, validateNumericNamedId } from '../../middleware/validateNumericId.js';

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn(function (c) { this.statusCode = c; return this; }),
    json: vi.fn(function (data) { this.body = data; return this; }),
  };
  return res;
}

describe('middleware/validateNumericId — module shape', () => {
  test('exports validateNumericId + validateNumericNamedId as functions', () => {
    expect(typeof validateNumericId).toBe('function');
    expect(typeof validateNumericNamedId).toBe('function');
  });

  test('validateNumericNamedId is identical to validateNumericId (alias contract)', () => {
    expect(validateNumericNamedId).toBe(validateNumericId);
  });
});

describe('middleware/validateNumericId — accepts positive integers', () => {
  test('"1" passes through — calls next() without writing response', () => {
    const req = { params: { id: '1' } };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '1', 'id');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  test('"42" — typical resource id passes', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '42', 'id');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('large integer "99999999" passes', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '99999999', 'id');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('middleware/validateNumericId — rejects invalid forms', () => {
  test('"0" → 400 INVALID_ID (Prisma auto-inc starts at 1, 0 is invalid)', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '0', 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(res.body.error).toMatch(/Invalid id: must be a positive integer/);
  });

  test('"01" → 400 (no leading zeros)', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '01', 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('"-1" → 400 (no signed forms)', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '-1', 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('"+1" → 400 (no signed forms)', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '+1', 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('"1.5" → 400 (no decimals)', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '1.5', 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('"1abc" → 400 (parseInt would have silently accepted; we don\'t)', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '1abc', 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('"abc" → 400 (the original issue #423 reproducer)', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, 'abc', 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('empty string "" → 400', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, '', 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('whitespace " 1 " → 400 (no leading/trailing whitespace tolerated)', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, ' 1 ', 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('non-string value (number 1) → 400 (typeof guard)', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    // Express won't normally pass non-string to param callback, but the
    // typeof guard exists — pin it.
    validateNumericId(req, res, next, 1, 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('null value → 400', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, null, 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('undefined value → 400', () => {
    const req = { params: {} };
    const res = makeRes();
    const next = vi.fn();
    validateNumericId(req, res, next, undefined, 'id');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });
});

describe('middleware/validateNumericId — error envelope', () => {
  test('envelope has { error, code:"INVALID_ID" } shape', () => {
    const req = { params: {} };
    const res = makeRes();
    validateNumericId(req, res, vi.fn(), 'xx', 'id');
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('code', 'INVALID_ID');
  });

  test('uses param name in error message (dealId variant)', () => {
    const req = { params: {} };
    const res = makeRes();
    validateNumericId(req, res, vi.fn(), 'xx', 'dealId');
    expect(res.body.error).toMatch(/Invalid dealId/);
  });

  test('falls back to "id" when name is undefined', () => {
    const req = { params: {} };
    const res = makeRes();
    validateNumericId(req, res, vi.fn(), 'xx', undefined);
    expect(res.body.error).toMatch(/Invalid id/);
  });

  test('falls back to "id" when name is empty string', () => {
    const req = { params: {} };
    const res = makeRes();
    validateNumericId(req, res, vi.fn(), 'xx', '');
    expect(res.body.error).toMatch(/Invalid id/);
  });

  test('error message does NOT echo the raw value back (log-injection / XSS guard)', () => {
    const req = { params: {} };
    const res = makeRes();
    const malicious = '<script>alert(1)</script>';
    validateNumericId(req, res, vi.fn(), malicious, 'id');
    expect(res.body.error).not.toContain('<script>');
    expect(res.body.error).not.toContain(malicious);
  });
});

describe('middleware/validateNumericId — non-mutation contract', () => {
  test('on success, does NOT mutate req.params (handler parseInts itself)', () => {
    const req = { params: { id: '42' } };
    const res = makeRes();
    validateNumericId(req, res, vi.fn(), '42', 'id');
    // Pin the standing convention from the source comment at lines 70-73:
    // "we don't mutate req.params... every existing handler already does
    // `parseInt(req.params.id)`. Mutating it to a Number would break
    // that call".
    expect(req.params.id).toBe('42');
    expect(typeof req.params.id).toBe('string');
  });
});
