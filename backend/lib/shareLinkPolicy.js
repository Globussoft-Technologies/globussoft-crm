// Share-link expiry/revocation policy — PRD §4.7 "Document security model"
// (gap A3). Pure helpers, no I/O — unit-tested in
// backend/test/lib/shareLinkPolicy.test.js and consumed by
// routes/travel_itineraries.js (share mint / public view / revoke).
//
// Policy (TRAVEL_CRM_PRD.md §4.7):
//   - Share links expire after a default of 7 days; the advisor may pick
//     1..30 days at mint time. Anything outside that window is CLAMPED,
//     never rejected (a bad expiryDays must not block a share).
//   - Links are revocable at any time. Revocation wins over every other
//     state — a link that is both revoked and expired reports `revoked`.
//   - Legacy links (rows minted before shareExpiresAt existed → both
//     columns null) are treated as ACTIVE and non-expiring. Old WhatsApp
//     links must keep working; expiry only applies to links minted (or
//     re-minted) after this policy shipped.

const SHARE_EXPIRY_DEFAULT_DAYS = 7;
const SHARE_EXPIRY_MIN_DAYS = 1;
const SHARE_EXPIRY_MAX_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// clampExpiryDays(value) → integer in [1, 30].
//
// Accepts anything the request body might carry (number, numeric string,
// null, undefined, garbage). Non-numeric / missing → the 7-day default.
// Fractional values floor first (2.9 → 2), THEN clamp (0.4 → 0 → 1), so
// the result is always a whole number of days inside the policy window.
function clampExpiryDays(value) {
  if (value == null || value === "") return SHARE_EXPIRY_DEFAULT_DAYS;
  const n = Number(value);
  if (!Number.isFinite(n)) return SHARE_EXPIRY_DEFAULT_DAYS;
  const floored = Math.floor(n);
  return Math.min(SHARE_EXPIRY_MAX_DAYS, Math.max(SHARE_EXPIRY_MIN_DAYS, floored));
}

// computeShareExpiresAt(expiryDays, now?) → Date.
//
// `expiryDays` is run through clampExpiryDays first, so callers can pass
// the raw body value straight in. `now` is injectable for tests.
function computeShareExpiresAt(expiryDays, now = new Date()) {
  const days = clampExpiryDays(expiryDays);
  return new Date(now.getTime() + days * MS_PER_DAY);
}

// shareLinkState({ shareExpiresAt, shareRevokedAt }, now?) →
//   { state: 'active' | 'revoked' | 'expired', code: null | 'SHARE_REVOKED' | 'SHARE_EXPIRED' }
//
// Precedence: revoked > expired > active. The `code` field is the exact
// error code the public route surfaces on its 410 response, so route +
// tests share one source of truth.
//
// null/undefined shareExpiresAt → never expires (legacy-link back-compat).
// Boundary: a link expires strictly AFTER shareExpiresAt — at the exact
// instant `now === shareExpiresAt` the link is still active.
function shareLinkState(itin, now = new Date()) {
  const row = itin || {};
  if (row.shareRevokedAt != null) {
    return { state: "revoked", code: "SHARE_REVOKED" };
  }
  if (row.shareExpiresAt != null) {
    const expMs = new Date(row.shareExpiresAt).getTime();
    if (Number.isFinite(expMs) && now.getTime() > expMs) {
      return { state: "expired", code: "SHARE_EXPIRED" };
    }
  }
  return { state: "active", code: null };
}

module.exports = {
  SHARE_EXPIRY_DEFAULT_DAYS,
  SHARE_EXPIRY_MIN_DAYS,
  SHARE_EXPIRY_MAX_DAYS,
  clampExpiryDays,
  computeShareExpiresAt,
  shareLinkState,
};
