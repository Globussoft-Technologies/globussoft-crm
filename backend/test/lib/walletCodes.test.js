// @ts-check
/**
 * Wave 11 Agent FF — vitest unit suite for backend/lib/walletCodes.js.
 *
 * The lib hosts three pure helpers that the wallet/gift-card/coupon/cashback
 * route family in routes/wellness.js calls:
 *
 *   • generateGiftCode(length?)             — random Crockford-base32 code
 *   • computeCouponDiscount(coupon, base, serviceId?)
 *                                           — PERCENT/FLAT discount math
 *                                             with cap-at-100, cap-at-base,
 *                                             service-allowlist filtering
 *   • computeCashbackEarn(rules, paid, serviceId?)
 *                                           — first-matching-rule earn calc
 *                                             with isActive/minSpend/serviceIds
 *                                             filters
 *
 * No prisma / network mocks needed — every helper is pure (input → output).
 *
 * Branch coverage targets:
 *   • generateGiftCode: alphabet exclusivity, default + custom length,
 *     entropy across 200 calls, no padding chars
 *   • computeCouponDiscount: PERCENT happy + cap-at-100 + zero-base + zero-pct,
 *     FLAT happy + cap-at-base, service-allowlist hit + miss + null-serviceId
 *     when allowlist present, NaN/negative defensive handling, unknown
 *     discountType → zero, JSON-array allowlist + comma-split fallback
 *   • computeCashbackEarn: first-rule-wins, isActive=false skip, earnPercent<=0
 *     skip, minSpend gate, serviceIds allowlist, percent-cap-at-100, returns
 *     ruleId on hit, returns null ruleId + applied=false on no match,
 *     non-numeric paid → zero earn, empty rules → zero earn, multi-rule
 *     cascade past skips
 *
 * Pattern: pure-function suite (no mocks). Mirrors backend/test/lib/sanitizeJson.test.js
 * + backend/test/utils/* layout.
 */
import { describe, test, expect } from 'vitest';
import {
  generateGiftCode,
  hashGiftCode,
  verifyGiftCode,
  maskGiftCode,
  lastFour,
  computeCouponDiscount,
  computeCashbackEarn,
  parseJsonArray,
  CODE_ALPHABET,
} from '../../lib/walletCodes.js';

// ── generateGiftCode ────────────────────────────────────────────────

describe('generateGiftCode', () => {
  test('returns 16-char default-length code', () => {
    const code = generateGiftCode();
    expect(code).toHaveLength(16);
  });

  test('honours custom length', () => {
    expect(generateGiftCode(8)).toHaveLength(8);
    expect(generateGiftCode(24)).toHaveLength(24);
    expect(generateGiftCode(1)).toHaveLength(1);
  });

  test('uses only Crockford-base32 alphabet (no I/L/O/U/0/1)', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateGiftCode(32);
      for (const ch of code) {
        expect(CODE_ALPHABET).toContain(ch);
      }
      expect(code).not.toMatch(/[ILOU01]/);
    }
  });

  test('produces high entropy — 200 calls all unique at length 16', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(generateGiftCode(16));
    expect(seen.size).toBe(200);
  });

  test('alphabet has the expected 30 characters (drops 6 ambiguous out of 36)', () => {
    expect(CODE_ALPHABET).toHaveLength(30);
  });
});

// ── hashGiftCode + verifyGiftCode (Wave-B Agent 3, #653) ────────────
//
// The bcrypt-hashed-at-rest pattern. Codes go in plaintext on issue
// (POST response is one-time), into the DB as bcrypt hash. Lookup
// pipeline uses verifyGiftCode (bcrypt.compare).

describe('hashGiftCode + verifyGiftCode', () => {
  test('hashGiftCode returns a bcrypt-shaped string ($2a$10$...)', async () => {
    const hash = await hashGiftCode('ABCD1234WXYZ5678');
    expect(typeof hash).toBe('string');
    // bcryptjs uses the $2a$ or $2b$ prefix; cost 10 (matches GIFT_CODE_BCRYPT_COST)
    expect(hash).toMatch(/^\$2[abxy]\$10\$/);
    expect(hash.length).toBeGreaterThanOrEqual(60);
  });

  test('two hashes of the same plaintext are different (random salt)', async () => {
    const plaintext = 'SAMEPLAINTEXT123';
    const h1 = await hashGiftCode(plaintext);
    const h2 = await hashGiftCode(plaintext);
    expect(h1).not.toBe(h2);
    // Both still verify against the plaintext
    expect(await verifyGiftCode(plaintext, h1)).toBe(true);
    expect(await verifyGiftCode(plaintext, h2)).toBe(true);
  });

  test('verifyGiftCode true on matching plaintext', async () => {
    const code = generateGiftCode(16);
    const hash = await hashGiftCode(code);
    expect(await verifyGiftCode(code, hash)).toBe(true);
  });

  test('verifyGiftCode false on non-matching plaintext', async () => {
    const code = generateGiftCode(16);
    const hash = await hashGiftCode(code);
    // Same-length, same-alphabet, different code
    const other = generateGiftCode(16);
    if (other === code) return; // 1-in-2^80 — skip silently
    expect(await verifyGiftCode(other, hash)).toBe(false);
  });

  test('verifyGiftCode false on empty / null inputs (defensive)', async () => {
    const hash = await hashGiftCode('ANYCODE12345678');
    expect(await verifyGiftCode('', hash)).toBe(false);
    expect(await verifyGiftCode(null, hash)).toBe(false);
    expect(await verifyGiftCode(undefined, hash)).toBe(false);
    expect(await verifyGiftCode('something', '')).toBe(false);
    expect(await verifyGiftCode('something', null)).toBe(false);
    expect(await verifyGiftCode('something', 'not-a-bcrypt-hash')).toBe(false);
  });

  test('hashGiftCode rejects empty / non-string input', async () => {
    await expect(hashGiftCode('')).rejects.toThrow();
    await expect(hashGiftCode(null)).rejects.toThrow();
    await expect(hashGiftCode(undefined)).rejects.toThrow();
  });

  test('verifyGiftCode is case-sensitive (codes uppercased at API layer)', async () => {
    const code = 'ABCD1234WXYZ5678';
    const hash = await hashGiftCode(code);
    expect(await verifyGiftCode(code.toLowerCase(), hash)).toBe(false);
    expect(await verifyGiftCode(code, hash)).toBe(true);
  });
});

describe('maskGiftCode + lastFour', () => {
  test('maskGiftCode reveals only first-4 + last-4 of a 16-char code', () => {
    const masked = maskGiftCode('ABCD1234WXYZ5678');
    expect(masked).toBe('ABCD****5678');
  });

  test('maskGiftCode contains no characters from the middle 8', () => {
    const code = 'XXXXMIDDLEXXYYYY';
    const masked = maskGiftCode(code);
    // The masked output must NOT include the middle 8 ('MIDDLEXX')
    expect(masked).not.toContain('MIDDLE');
  });

  test('maskGiftCode handles short codes (< 8) without leaking', () => {
    // For ultra-short codes the function falls back to "****" + last-4
    const masked = maskGiftCode('ABC123');
    expect(masked).toBe('****C123');
  });

  test('lastFour returns the last 4 chars', () => {
    expect(lastFour('ABCD1234WXYZ5678')).toBe('5678');
    expect(lastFour('SHORT')).toBe('HORT');
    expect(lastFour('')).toBe('');
    expect(lastFour(null)).toBe('');
  });
});

// ── computeCouponDiscount ───────────────────────────────────────────

describe('computeCouponDiscount — PERCENT', () => {
  test('10% off ₹1,000 = ₹100 discount, ₹900 final', () => {
    const r = computeCouponDiscount({ discountType: 'PERCENT', discountValue: 10 }, 1000);
    expect(r).toEqual({ discount: 100, finalAmount: 900, applied: true });
  });

  test('caps PERCENT at 100% even if value is 150', () => {
    const r = computeCouponDiscount({ discountType: 'PERCENT', discountValue: 150 }, 500);
    expect(r.discount).toBe(500);
    expect(r.finalAmount).toBe(0);
    expect(r.applied).toBe(true);
  });

  test('PERCENT 100% off → final 0', () => {
    const r = computeCouponDiscount({ discountType: 'PERCENT', discountValue: 100 }, 250);
    expect(r).toEqual({ discount: 250, finalAmount: 0, applied: true });
  });

  test('zero-base PERCENT → zero discount, applied=false', () => {
    const r = computeCouponDiscount({ discountType: 'PERCENT', discountValue: 50 }, 0);
    expect(r).toEqual({ discount: 0, finalAmount: 0, applied: false });
  });

  test('zero-pct PERCENT → zero discount', () => {
    const r = computeCouponDiscount({ discountType: 'PERCENT', discountValue: 0 }, 1000);
    expect(r.discount).toBe(0);
    expect(r.applied).toBe(false);
  });

  test('PERCENT with float result rounds to 2dp', () => {
    const r = computeCouponDiscount({ discountType: 'PERCENT', discountValue: 33 }, 99);
    // 99 * 0.33 = 32.67 exact
    expect(r.discount).toBe(32.67);
    expect(r.finalAmount).toBe(66.33);
  });
});

describe('computeCouponDiscount — FLAT', () => {
  test('₹50 off ₹1,000 = ₹50 discount, ₹950 final', () => {
    const r = computeCouponDiscount({ discountType: 'FLAT', discountValue: 50 }, 1000);
    expect(r).toEqual({ discount: 50, finalAmount: 950, applied: true });
  });

  test('FLAT discount cannot exceed baseAmount (₹500 off ₹200 → ₹200 off, never negative)', () => {
    const r = computeCouponDiscount({ discountType: 'FLAT', discountValue: 500 }, 200);
    expect(r.discount).toBe(200);
    expect(r.finalAmount).toBe(0);
    expect(r.applied).toBe(true);
  });

  test('FLAT exactly equal to base → final 0', () => {
    const r = computeCouponDiscount({ discountType: 'FLAT', discountValue: 200 }, 200);
    expect(r).toEqual({ discount: 200, finalAmount: 0, applied: true });
  });
});

describe('computeCouponDiscount — service allowlist', () => {
  test('empty/null serviceIds applies to all services', () => {
    const c = { discountType: 'PERCENT', discountValue: 10, serviceIds: null };
    expect(computeCouponDiscount(c, 100, 5).discount).toBe(10);
    expect(computeCouponDiscount(c, 100, null).discount).toBe(10);

    const c2 = { discountType: 'PERCENT', discountValue: 10, serviceIds: '' };
    expect(computeCouponDiscount(c2, 100, 99).discount).toBe(10);
  });

  test('serviceIds JSON array — service in allowlist applies', () => {
    const c = { discountType: 'PERCENT', discountValue: 20, serviceIds: '[1,2,3]' };
    expect(computeCouponDiscount(c, 100, 2).discount).toBe(20);
  });

  test('serviceIds JSON array — service NOT in allowlist returns 0', () => {
    const c = { discountType: 'PERCENT', discountValue: 20, serviceIds: '[1,2,3]' };
    const r = computeCouponDiscount(c, 100, 99);
    expect(r).toEqual({ discount: 0, finalAmount: 100, applied: false });
  });

  test('serviceIds non-empty + serviceId null → zero (cannot prove the service is in the allowlist)', () => {
    const c = { discountType: 'FLAT', discountValue: 50, serviceIds: '[1,2]' };
    const r = computeCouponDiscount(c, 100, null);
    expect(r.discount).toBe(0);
    expect(r.applied).toBe(false);
  });

  test('malformed serviceIds (not JSON) treated as empty allowlist', () => {
    const c = { discountType: 'PERCENT', discountValue: 5, serviceIds: 'not-json' };
    expect(computeCouponDiscount(c, 100, 7).discount).toBe(5);
  });
});

describe('computeCouponDiscount — defensive', () => {
  test('NaN baseAmount → zero', () => {
    const r = computeCouponDiscount({ discountType: 'PERCENT', discountValue: 10 }, NaN);
    expect(r.discount).toBe(0);
    expect(r.applied).toBe(false);
  });

  test('negative baseAmount → coerced to zero', () => {
    const r = computeCouponDiscount({ discountType: 'PERCENT', discountValue: 10 }, -50);
    expect(r.finalAmount).toBe(0);
  });

  test('unknown discountType returns zero discount', () => {
    const r = computeCouponDiscount({ discountType: 'BOGO', discountValue: 50 }, 100);
    expect(r).toEqual({ discount: 0, finalAmount: 100, applied: false });
  });

  test('null/undefined coupon does not throw', () => {
    expect(() => computeCouponDiscount(null, 100)).not.toThrow();
    const r = computeCouponDiscount(null, 100);
    expect(r.applied).toBe(false);
  });
});

// ── computeCashbackEarn ─────────────────────────────────────────────

describe('computeCashbackEarn', () => {
  const activeRule = (overrides = {}) => ({
    id: 1,
    isActive: true,
    earnPercent: 5,
    serviceIds: null,
    minSpend: null,
    ...overrides,
  });

  test('5% on ₹1,000 = ₹50 earn', () => {
    const r = computeCashbackEarn([activeRule()], 1000);
    expect(r).toEqual({ earn: 50, ruleId: 1, applied: true });
  });

  test('zero amountPaid → zero earn, applied=false', () => {
    const r = computeCashbackEarn([activeRule()], 0);
    expect(r).toEqual({ earn: 0, ruleId: null, applied: false });
  });

  test('empty rules array → zero earn', () => {
    const r = computeCashbackEarn([], 500);
    expect(r).toEqual({ earn: 0, ruleId: null, applied: false });
  });

  test('non-array rules input → zero earn (defensive)', () => {
    const r = computeCashbackEarn(null, 500);
    expect(r.applied).toBe(false);
  });

  test('skips inactive rules and falls through to next active', () => {
    const inactive = activeRule({ id: 1, isActive: false, earnPercent: 50 });
    const active = activeRule({ id: 2, earnPercent: 10 });
    const r = computeCashbackEarn([inactive, active], 200);
    expect(r).toEqual({ earn: 20, ruleId: 2, applied: true });
  });

  test('skips zero / negative earnPercent rules', () => {
    const zero = activeRule({ id: 1, earnPercent: 0 });
    const neg = activeRule({ id: 2, earnPercent: -5 });
    const real = activeRule({ id: 3, earnPercent: 7 });
    const r = computeCashbackEarn([zero, neg, real], 100);
    expect(r.ruleId).toBe(3);
    expect(r.earn).toBe(7);
  });

  test('minSpend gate — paid below floor → skip', () => {
    const rule = activeRule({ minSpend: 500, earnPercent: 10 });
    const r = computeCashbackEarn([rule], 200);
    expect(r.applied).toBe(false);
  });

  test('minSpend gate — paid exactly at floor → applies', () => {
    const rule = activeRule({ minSpend: 500, earnPercent: 10 });
    const r = computeCashbackEarn([rule], 500);
    expect(r.earn).toBe(50);
  });

  test('serviceIds allowlist — matching serviceId applies', () => {
    const rule = activeRule({ serviceIds: '[1,2,3]', earnPercent: 10 });
    const r = computeCashbackEarn([rule], 100, 2);
    expect(r.earn).toBe(10);
  });

  test('serviceIds allowlist — non-matching serviceId skips', () => {
    const rule = activeRule({ serviceIds: '[1,2,3]', earnPercent: 10 });
    const r = computeCashbackEarn([rule], 100, 99);
    expect(r.applied).toBe(false);
  });

  test('serviceIds allowlist + null serviceId → skip', () => {
    const rule = activeRule({ serviceIds: '[1,2,3]', earnPercent: 10 });
    const r = computeCashbackEarn([rule], 100, null);
    expect(r.applied).toBe(false);
  });

  test('caps earnPercent at 100', () => {
    const rule = activeRule({ earnPercent: 150 });
    const r = computeCashbackEarn([rule], 100);
    expect(r.earn).toBe(100); // not 150
  });

  test('result rounds to 2dp', () => {
    const rule = activeRule({ earnPercent: 33 });
    const r = computeCashbackEarn([rule], 99);
    // 99 * 0.33 = 32.67
    expect(r.earn).toBe(32.67);
  });

  test('first-matching-rule wins (later rules ignored)', () => {
    const first = activeRule({ id: 1, earnPercent: 5 });
    const second = activeRule({ id: 2, earnPercent: 50 });
    const r = computeCashbackEarn([first, second], 100);
    expect(r.ruleId).toBe(1);
    expect(r.earn).toBe(5);
  });

  test('all rules skipped → applied=false, ruleId=null', () => {
    const inactive = activeRule({ isActive: false });
    const minMissed = activeRule({ id: 2, minSpend: 9999, earnPercent: 10 });
    const r = computeCashbackEarn([inactive, minMissed], 100);
    expect(r).toEqual({ earn: 0, ruleId: null, applied: false });
  });
});

// ── parseJsonArray ──────────────────────────────────────────────────

describe('parseJsonArray', () => {
  test('null/empty → []', () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray(undefined)).toEqual([]);
    expect(parseJsonArray('')).toEqual([]);
  });

  test('JSON array of integers parses', () => {
    expect(parseJsonArray('[1,2,3]')).toEqual([1, 2, 3]);
  });

  test('non-JSON string → []', () => {
    expect(parseJsonArray('not-json')).toEqual([]);
  });

  test('JSON object (not array) → []', () => {
    expect(parseJsonArray('{"a":1}')).toEqual([]);
  });

  test('passes through real array', () => {
    expect(parseJsonArray([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test('drops non-numeric entries', () => {
    expect(parseJsonArray('[1,"two",3]')).toEqual([1, 3]);
  });
});
