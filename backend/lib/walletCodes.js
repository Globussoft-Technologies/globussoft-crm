// Wave 11 Agent FF — gift-card / coupon code generator + discount calculator
// + cashback computer.
//
// Three pure helpers extracted from the wellness wallet/gift-card/coupon/
// cashback route family so they can be unit-tested without spinning up
// Prisma. The route handlers wrap these in the usual try/catch/audit
// envelope; this file is shape-only.
//
// Why a dedicated lib (not inline in routes/wellness.js): each helper has
// a non-trivial branch matrix (PERCENT vs FLAT, cap-at-baseAmount, minSpend
// gating, percent-cap-at-100, allowlist filtering) that benefits from the
// 10-30 vitest cases below. Mocking Prisma to test these branches inline
// would be heavier than the helpers themselves.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Wave-B Agent 3 (#653) — bcrypt cost for gift-card / coupon code hashing.
// 10 mirrors the password-hash cost in routes/auth.js + routes/portal.js
// (~80-100ms per hash on demo's box, acceptable on the issue path).
const GIFT_CODE_BCRYPT_COST = 10;

// ── Code generator ──────────────────────────────────────────────────
//
// Crockford-base32 alphabet (excludes I, L, O, U, 0, 1) so codes are
// readable when typed from a printed gift-card. 16 chars = 80 bits of
// entropy = collision-free for any realistic tenant volume.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a random gift-card / coupon code.
 *
 * @param {number} length — code length, defaults to 16
 * @returns {string} — uppercase Crockford-base32 code, no separators
 */
function generateGiftCode(length = 16) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

// ── Gift-card code hashing (Wave-B Agent 3, #653) ──────────────────
//
// Gift-card codes were previously stored in cleartext. A DB dump leaked
// every active code in plaintext — anyone with the dump could redeem.
// We now bcrypt-hash codes at rest and ONLY return the plaintext to the
// issuing operator in the POST response (one-time). Subsequent lookups
// hash-compare the incoming code rather than plaintext-match.
//
// Pattern matches how the codebase already handles passwords (see
// backend/routes/auth.js, portal.js, auth_2fa.js). bcryptjs is a
// pre-existing dependency.

/**
 * Bcrypt-hash a gift-card code so it can be stored at rest.
 *
 * @param {string} plaintext — the raw code returned by generateGiftCode()
 * @returns {Promise<string>} bcrypt hash (60-char `$2a$10$...` string)
 */
async function hashGiftCode(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('hashGiftCode requires a non-empty string');
  }
  return bcrypt.hash(plaintext, GIFT_CODE_BCRYPT_COST);
}

/**
 * Verify a candidate plaintext code against a stored bcrypt hash.
 *
 * @param {string} plaintext — code submitted by the redemption request
 * @param {string} hash — value previously produced by hashGiftCode()
 * @returns {Promise<boolean>}
 */
async function verifyGiftCode(plaintext, hash) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return false;
  if (typeof hash !== 'string' || hash.length === 0) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * Mask a plaintext gift-card code for safe storage / display.
 * Returns "ABCD****WXYZ" for an N-char code with N≥8; for shorter codes,
 * falls back to "***" + last-4 to avoid leaking the prefix on tiny codes.
 *
 * @param {string} plaintext
 * @returns {string}
 */
function maskGiftCode(plaintext) {
  const s = String(plaintext || '');
  if (s.length < 8) return '****' + s.slice(-4);
  return s.slice(0, 4) + '****' + s.slice(-4);
}

/**
 * Last-4 of a plaintext code, used for the codeLast4 index column.
 *
 * @param {string} plaintext
 * @returns {string}
 */
function lastFour(plaintext) {
  return String(plaintext || '').slice(-4);
}

// ── Coupon discount calculator ──────────────────────────────────────

/**
 * Compute the discount that a coupon applies to a given baseAmount.
 *
 * Cap rules:
 *   • PERCENT discountValue is capped at 100 (a 150% coupon caps at 100% off).
 *   • FLAT  discountValue is capped at baseAmount (a ₹500 coupon on a ₹200
 *     bill discounts ₹200, never inverts the bill into negative).
 *   • baseAmount and discountValue are coerced to non-negative numbers; NaN
 *     / Infinity / negative inputs degrade to a zero discount (defensive).
 *
 * Service-id allowlist:
 *   • If `coupon.serviceIds` is a non-empty JSON array AND `serviceId` is
 *     supplied AND not in the allowlist, the discount is zero. Empty / null
 *     allowlist = no restriction.
 *
 * Returns { discount, finalAmount, applied } so the call site can render
 * "₹50 off, you pay ₹950" without re-deriving math.
 *
 * @param {{ discountType: 'PERCENT'|'FLAT', discountValue: number, serviceIds?: string|null }} coupon
 * @param {number} baseAmount
 * @param {number|null} [serviceId]
 * @returns {{ discount: number, finalAmount: number, applied: boolean }}
 */
function computeCouponDiscount(coupon, baseAmount, serviceId = null) {
  const base = Number.isFinite(Number(baseAmount)) ? Math.max(0, Number(baseAmount)) : 0;
  const valueRaw = Number.isFinite(Number(coupon?.discountValue)) ? Number(coupon.discountValue) : 0;
  if (base <= 0 || valueRaw <= 0) {
    return { discount: 0, finalAmount: base, applied: false };
  }

  // Service allowlist — null/empty = applies to all. If a non-empty allowlist
  // is set we MUST be able to prove the service is in it; a null serviceId
  // can't prove the match, so we refuse to apply (safe default — better to
  // surface "service-not-eligible" than to silently grant a service-restricted
  // coupon to the whole catalog).
  const allowlist = parseJsonArray(coupon?.serviceIds);
  if (allowlist.length > 0) {
    if (serviceId == null) {
      return { discount: 0, finalAmount: base, applied: false };
    }
    const sid = parseInt(serviceId, 10);
    if (!allowlist.includes(sid)) {
      return { discount: 0, finalAmount: base, applied: false };
    }
  }

  let discount = 0;
  if (coupon.discountType === 'PERCENT') {
    const pct = Math.min(100, valueRaw);
    discount = (base * pct) / 100;
  } else if (coupon.discountType === 'FLAT') {
    discount = Math.min(valueRaw, base);
  } else {
    // Unknown discountType — refuse to compute (zero discount). Route
    // handler returns 400 INVALID_DISCOUNT_TYPE before we get here, so
    // this is purely defensive.
    return { discount: 0, finalAmount: base, applied: false };
  }

  // Round to 2 decimal places to avoid floating-point dust like 199.99999.
  discount = round2(discount);
  const finalAmount = round2(Math.max(0, base - discount));
  return { discount, finalAmount, applied: discount > 0 };
}

// ── Cashback earn computer ──────────────────────────────────────────

/**
 * Compute the cashback wallet credit to earn for a completed visit, given
 * a list of CashbackRule rows. Multiple rules may apply — the function
 * picks the FIRST matching active rule (most-specific-wins is too clever;
 * routes/wellness.js orders rules deterministically before passing them
 * in — see /apply-cashback handler).
 *
 * Match conditions (rule applies iff ALL hold):
 *   • rule.isActive === true
 *   • rule.minSpend == null OR amountPaid >= rule.minSpend
 *   • rule.serviceIds == null/empty OR serviceId is in the allowlist
 *
 * Earn formula: amountPaid * (rule.earnPercent / 100), capped so we never
 * earn more than amountPaid (a 150%-earn rule caps at the visit total).
 *
 * Returns { earn, ruleId, applied }. earn is rounded to 2dp.
 *
 * @param {Array<{ id:number, isActive:boolean, earnPercent:number, serviceIds?:string|null, minSpend?:number|null }>} rules
 * @param {number} amountPaid
 * @param {number|null} [serviceId]
 * @returns {{ earn: number, ruleId: number|null, applied: boolean }}
 */
function computeCashbackEarn(rules, amountPaid, serviceId = null) {
  const amt = Number.isFinite(Number(amountPaid)) ? Math.max(0, Number(amountPaid)) : 0;
  if (amt <= 0 || !Array.isArray(rules) || rules.length === 0) {
    return { earn: 0, ruleId: null, applied: false };
  }

  for (const rule of rules) {
    if (!rule || rule.isActive !== true) continue;
    const pct = Number.isFinite(Number(rule.earnPercent)) ? Number(rule.earnPercent) : 0;
    if (pct <= 0) continue;
    const min = rule.minSpend == null ? 0 : Number(rule.minSpend);
    if (Number.isFinite(min) && min > 0 && amt < min) continue;

    const allowlist = parseJsonArray(rule.serviceIds);
    if (allowlist.length > 0) {
      if (serviceId == null) continue;
      const sid = parseInt(serviceId, 10);
      if (!allowlist.includes(sid)) continue;
    }

    const cappedPct = Math.min(100, pct);
    const earn = round2((amt * cappedPct) / 100);
    if (earn <= 0) continue;
    return { earn, ruleId: rule.id ?? null, applied: true };
  }

  return { earn: 0, ruleId: null, applied: false };
}

// ── Internals ───────────────────────────────────────────────────────

function parseJsonArray(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((v) => parseInt(v, 10)).filter(Number.isFinite);
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => parseInt(v, 10)).filter(Number.isFinite);
  } catch {
    return [];
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  generateGiftCode,
  hashGiftCode,
  verifyGiftCode,
  maskGiftCode,
  lastFour,
  computeCouponDiscount,
  computeCashbackEarn,
  // Exported for tests + future call-sites that need the same parsing.
  parseJsonArray,
  CODE_ALPHABET,
};
