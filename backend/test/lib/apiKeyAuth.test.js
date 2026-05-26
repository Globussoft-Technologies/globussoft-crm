// Unit tests for backend/lib/apiKeyAuth.js
//
// Closes #930 — shared sub-brand scoping helper extracted from inline
// duplication in voyagrAuth.js + externalAuth.js.
//
// Contract pinned here:
//   - installSubBrandHelpers(req, apiKey) wires three properties on req:
//       req.apiKeySubBrand, req.requireSubBrandMatch, req.requireSubBrandMatchOrSend.
//   - subBrand=null on apiKey → tenant-wide key, accepts any target.
//   - subBrand=set + target equal → returns true, no throw.
//   - subBrand=set + target different → throws Error{status:403, code:'SUB_BRAND_MISMATCH'}.
//   - requireSubBrandMatchOrSend on mismatch writes 403+{error, code:SUB_BRAND_MISMATCH}
//     to res and returns false (does NOT throw — that's the whole point of the OrSend variant).
//
// Both consuming middlewares (voyagrAuth.js, externalAuth.js) import + call
// installSubBrandHelpers(req, apiKey) per #930. These tests pin the helper
// itself; the middleware-integration behaviour is pinned by the
// integrations-api spec + the wellness-onboarding-flow-api spec.
import { describe, test, expect, vi } from 'vitest';
const { installSubBrandHelpers } = require('../../lib/apiKeyAuth');

describe('apiKeyAuth — installSubBrandHelpers', () => {
  test('wires req.apiKeySubBrand from apiKey.subBrand', () => {
    const req = {};
    installSubBrandHelpers(req, { subBrand: 'tmc' });
    expect(req.apiKeySubBrand).toBe('tmc');
    expect(typeof req.requireSubBrandMatch).toBe('function');
    expect(typeof req.requireSubBrandMatchOrSend).toBe('function');
  });

  test('apiKey.subBrand=null coerces to null (tenant-wide key)', () => {
    const req = {};
    installSubBrandHelpers(req, { subBrand: null });
    expect(req.apiKeySubBrand).toBeNull();
    // Tenant-wide key accepts any target without throwing.
    expect(req.requireSubBrandMatch('tmc')).toBe(true);
    expect(req.requireSubBrandMatch('rfu')).toBe(true);
    expect(req.requireSubBrandMatch('anything')).toBe(true);
  });

  test('apiKey.subBrand=undefined coerces to null (defensive)', () => {
    const req = {};
    installSubBrandHelpers(req, {});
    expect(req.apiKeySubBrand).toBeNull();
    expect(req.requireSubBrandMatch('tmc')).toBe(true);
  });

  test('requireSubBrandMatch: matching target returns true', () => {
    const req = {};
    installSubBrandHelpers(req, { subBrand: 'tmc' });
    expect(req.requireSubBrandMatch('tmc')).toBe(true);
  });

  test('requireSubBrandMatch: mismatching target throws SUB_BRAND_MISMATCH', () => {
    const req = {};
    installSubBrandHelpers(req, { subBrand: 'tmc' });
    let caught;
    try {
      req.requireSubBrandMatch('rfu');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('SUB_BRAND_MISMATCH');
    expect(caught.status).toBe(403);
    expect(caught.expected).toBe('tmc');
    expect(caught.actual).toBe('rfu');
  });

  test('requireSubBrandMatchOrSend: matching target returns true (does not call res)', () => {
    const req = {};
    installSubBrandHelpers(req, { subBrand: 'tmc' });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    expect(req.requireSubBrandMatchOrSend('tmc', res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  test('requireSubBrandMatchOrSend: mismatching target writes 403 and returns false (does NOT throw)', () => {
    const req = {};
    installSubBrandHelpers(req, { subBrand: 'tmc' });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const result = req.requireSubBrandMatchOrSend('rfu', res);
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "API key scoped to 'tmc' cannot post for sub-brand 'rfu'",
      code: 'SUB_BRAND_MISMATCH',
    });
  });

  test('requireSubBrandMatchOrSend: tenant-wide key (null) accepts any target via OrSend variant', () => {
    const req = {};
    installSubBrandHelpers(req, { subBrand: null });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    expect(req.requireSubBrandMatchOrSend('tmc', res)).toBe(true);
    expect(req.requireSubBrandMatchOrSend('rfu', res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});
