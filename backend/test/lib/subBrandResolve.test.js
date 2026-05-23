// Unit tests for backend/lib/subBrandResolve.js
//
// Promotes resolveSubBrand from inline-in-3-routes (ratehawk / callified /
// booking_expedia) to a shared lib (tick #106 rule-of-3 promotion).
//
// Contract pinned here:
//   - API-key-scoped caller (req.apiKeySubBrand set) → effective pin to that
//     value; mismatching body → 403 SUB_BRAND_MISMATCH envelope.
//   - Operator JWT caller (req.apiKeySubBrand undefined or null) → body
//     subBrand passes through; null/empty body → effectiveSubBrand: null.
//   - Pure function: no Prisma, no logger, no side effects.
import { describe, test, expect } from 'vitest';
const { resolveSubBrand } = require('../../lib/subBrandResolve');

describe('resolveSubBrand — API-key-scoped caller (req.apiKeySubBrand set)', () => {
  test('returns effectiveSubBrand pinned to apiKey scope when no body supplied', () => {
    const req = { apiKeySubBrand: 'tmc' };
    const result = resolveSubBrand(req, undefined);
    expect(result).toEqual({ ok: true, effectiveSubBrand: 'tmc' });
  });

  test('returns effectiveSubBrand pinned to apiKey scope when body matches', () => {
    const req = { apiKeySubBrand: 'rfu' };
    const result = resolveSubBrand(req, 'rfu');
    expect(result).toEqual({ ok: true, effectiveSubBrand: 'rfu' });
  });

  test('returns 403 SUB_BRAND_MISMATCH envelope when body sub-brand differs from apiKey scope', () => {
    const req = { apiKeySubBrand: 'tmc' };
    const result = resolveSubBrand(req, 'rfu');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('SUB_BRAND_MISMATCH');
    expect(result.body.error).toContain("'tmc'");
    expect(result.body.error).toContain("'rfu'");
  });

  test('falsy supplied (empty string) does NOT trip mismatch — pins to apiKey scope', () => {
    const req = { apiKeySubBrand: 'travel-stall' };
    const result = resolveSubBrand(req, '');
    expect(result).toEqual({ ok: true, effectiveSubBrand: 'travel-stall' });
  });

  test('null supplied does NOT trip mismatch — pins to apiKey scope', () => {
    const req = { apiKeySubBrand: 'visa-sure' };
    const result = resolveSubBrand(req, null);
    expect(result).toEqual({ ok: true, effectiveSubBrand: 'visa-sure' });
  });
});

describe('resolveSubBrand — operator JWT caller (no req.apiKeySubBrand)', () => {
  test('body sub-brand passes through when req.apiKeySubBrand is undefined', () => {
    const req = {};
    const result = resolveSubBrand(req, 'tmc');
    expect(result).toEqual({ ok: true, effectiveSubBrand: 'tmc' });
  });

  test('body sub-brand passes through when req.apiKeySubBrand is null', () => {
    const req = { apiKeySubBrand: null };
    const result = resolveSubBrand(req, 'rfu');
    expect(result).toEqual({ ok: true, effectiveSubBrand: 'rfu' });
  });

  test('returns effectiveSubBrand=null when no body sub-brand and no apiKey scope', () => {
    const req = {};
    const result = resolveSubBrand(req, undefined);
    expect(result).toEqual({ ok: true, effectiveSubBrand: null });
  });

  test('falsy body sub-brand (empty string) coerces to null effectiveSubBrand', () => {
    const req = {};
    const result = resolveSubBrand(req, '');
    expect(result).toEqual({ ok: true, effectiveSubBrand: null });
  });

  test('null body sub-brand coerces to null effectiveSubBrand', () => {
    const req = { apiKeySubBrand: null };
    const result = resolveSubBrand(req, null);
    expect(result).toEqual({ ok: true, effectiveSubBrand: null });
  });
});

describe('resolveSubBrand — purity', () => {
  test('does not mutate req', () => {
    const req = { apiKeySubBrand: 'tmc', otherField: 42 };
    const snapshot = { ...req };
    resolveSubBrand(req, 'rfu');
    expect(req).toEqual(snapshot);
  });

  test('returns a fresh object each call (no shared state)', () => {
    const req = { apiKeySubBrand: 'tmc' };
    const a = resolveSubBrand(req, undefined);
    const b = resolveSubBrand(req, undefined);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  test('callable via require(...).resolveSubBrand (module.exports surface check)', () => {
    const mod = require('../../lib/subBrandResolve');
    expect(typeof mod.resolveSubBrand).toBe('function');
    const result = mod.resolveSubBrand({ apiKeySubBrand: 'tmc' }, undefined);
    expect(result).toEqual({ ok: true, effectiveSubBrand: 'tmc' });
  });
});
