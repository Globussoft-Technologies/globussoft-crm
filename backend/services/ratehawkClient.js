/**
 * RateHawk integration client — STUB MODE.
 *
 * STUB: RateHawk integration pending Q19 creds. Yasin owes the partner
 * onboarding (API key ID + email + endpoint URL + RateHawk B2B agreement).
 * When creds arrive, swap the placeholder fetch() / mock-response with the
 * real HTTP call; the budget-cap + observability scaffold stays unchanged.
 *
 * PRD_RATEHAWK_INTEGRATION DC-1 [RESOLVED 2026-05-24]: per-call cap (cents
 * per search query) via the cross-cutting TenantSetting pattern. This module
 * is the third consumer of the cap helper (after llmRouter cb0901f +
 * adsGptClient 9f35040).
 *
 * Cred chase: docs/CREDS_TRACKER.md Cat 1 Q19 row + docs/PRD_RATEHAWK_INTEGRATION.md §5.
 * NOTE: tick #74 audit flagged this as the only Cat-1 cred-blocked item with
 * NO stub written. This commit lands the skeleton; real-mode swap is ~1 day
 * post-cred (mirror digilockerClient/googleDriveClient pattern).
 *
 * Mirror clients for swap-when-cred pattern:
 *   - backend/services/digilockerClient.js (commit 1babe1b — original)
 *   - backend/services/googleDriveClient.js (commit 192de86 — same pattern)
 *   - backend/services/adsGptClient.js (commit 9f35040 — second cap consumer)
 *
 * Per-tenant credential resolution (S68 — 2026-06-10):
 *   `getRatehawkCreds(tenantId)` mirrors S67's `getAdsGptKey` shape but
 *   returns a multi-field object `{ keyId, apiKey }` instead of a single
 *   string — RateHawk authenticates with TWO fields (the API ID / key-id
 *   AND the API key). The SupplierCredential row uses BOTH encrypted
 *   columns: `loginIdEncrypted` (key-id) AND `passwordEncrypted` (api-key).
 *   Checks SupplierCredential category `'ratehawk-cred'` for the given
 *   tenant; falls back to `process.env.RATEHAWK_API_ID` +
 *   `process.env.RATEHAWK_API_KEY` on miss. Returns null when either field
 *   is missing on both sides — partial creds are treated as a miss because
 *   the upstream API requires both. NOTE: the env-var names match the
 *   public PRD §5.1 column + docs/TRAVEL_API_KEYS_TO_REQUEST.md row 49
 *   (`RATEHAWK_API_ID` = key-id, `RATEHAWK_API_KEY` = api-key); finalise
 *   with Yasin's Q19 handover. Adopted ahead of cred-drop so the cred
 *   wiring (operator seeds row → call uses it; no operator seeded → falls
 *   back to ENV) is in place from day-1.
 */

const { getBudgetCap, evaluateCap, KEYS } = require('../lib/tenantSettings');

const INTEGRATION = 'ratehawk';

// Touch KEYS so the imported binding isn't flagged unused — also makes
// the canonical-keys dependency explicit for future readers grep-tracing
// the cap pattern across consumers.
void KEYS;

/**
 * Pre-call cap check. Returns { withinCap, capCents, spentCents, percent, alertThreshold }.
 * Throws { code: 'RATEHAWK_BUDGET_EXCEEDED', error, spentCents, capCents } if over cap.
 *
 * Spend source: future RatehawkSearchLog model (one row per search call,
 * costEstimate in Decimal USD). In stub mode, returns 0 spend (no rows
 * ever written by the stub).
 */
async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  // Resolve via module.exports so vi.spyOn(client, 'computeMonthlySpendCents')
  // in unit tests intercepts the call. Direct local-binding reference would
  // bypass the spy (closure-captured at module load). This is the SECOND
  // instance of the CJS self-mocking seam pattern (first: tick #47
  // safeEmitEvent); worth promoting on next instance.
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly RateHawk spend cap reached for this tenant.');
    err.code = 'RATEHAWK_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(`[ratehawkClient] tenant ${tenantId} at ${Math.round(evaluation.percent * 100)}% of monthly RateHawk cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`);
  }
  return evaluation;
}

async function computeMonthlySpendCents(_tenantId) {
  // STUB: real implementation will sum a future RatehawkSearchLog model
  // (one row per search call, costEstimate in Decimal USD) — mirror the
  // LlmCallLog spend-sum pattern in backend/lib/llmRouter.js (dollar→cent
  // conversion via * 100). For now returns 0.
  // TODO post-cred: RatehawkSearchLog schema + sum filtered by tenantId +
  // createdAt >= startOfMonth.
  return 0;
}

/**
 * Resolve the RateHawk credentials for a tenant. Multi-field shape
 * (`{ keyId, apiKey }`) — RateHawk authenticates with BOTH the API ID
 * (a.k.a. key-id) AND the API key. Returns null when either field is
 * absent on both sides (partial creds are treated as a miss because the
 * upstream HTTP call would fail without both):
 *
 *   1. Without `tenantId`        → ENV-only. If BOTH env vars set, returns
 *                                  `{ keyId, apiKey }`; otherwise null.
 *   2. With `tenantId`           → check SupplierCredential row first
 *                                  (category 'ratehawk-cred', any
 *                                  supplierName); both `loginIdEncrypted`
 *                                  + `passwordEncrypted` must decrypt to
 *                                  truthy plaintext or we fall back to ENV.
 *   3. Both missing              → return null. Caller decides whether to
 *                                  raise an "integration disabled" path
 *                                  (real-mode swap will throw
 *                                  RATEHAWK_NOT_YET_ENABLED).
 *
 * Best-effort: any Prisma / decrypt error is logged and treated as a
 * miss (caller falls through to ENV). NEVER throws.
 *
 * Placeholder env-vars: `RATEHAWK_API_ID` (key-id) +
 * `RATEHAWK_API_KEY` (api-key). Names match PRD §5.1 + the
 * docs/TRAVEL_API_KEYS_TO_REQUEST.md row.
 *
 * @param {number} [tenantId] — optional. Omit for ENV-only behaviour.
 * @returns {Promise<{keyId: string, apiKey: string}|null>}
 */
async function getRatehawkCreds(tenantId) {
  // Placeholder env-var names — finalises with Yasin's Q19 handover.
  const envKeyId = process.env.RATEHAWK_API_ID || null;
  const envApiKey = process.env.RATEHAWK_API_KEY || null;
  const envFallback = (envKeyId && envApiKey)
    ? { keyId: envKeyId, apiKey: envApiKey }
    : null;

  // No tenant scope → ENV only.
  if (!tenantId) {
    return envFallback;
  }

  try {
    const prisma = require('../lib/prisma');
    if (
      !prisma.supplierCredential ||
      typeof prisma.supplierCredential.findFirst !== 'function'
    ) {
      return envFallback;
    }
    const row = await prisma.supplierCredential.findFirst({
      where: { tenantId, category: 'ratehawk-cred' },
      select: { loginIdEncrypted: true, passwordEncrypted: true },
    });
    if (row && row.loginIdEncrypted && row.passwordEncrypted) {
      // Lazy require to avoid circular bombs in test harnesses that
      // hand-roll the crypto layer (matches getLlmKey + getAdsGptKey shape).
      const { decrypt } = require('../lib/fieldEncryption');
      const keyId = decrypt(row.loginIdEncrypted);
      const apiKey = decrypt(row.passwordEncrypted);
      // BOTH must decrypt to truthy plaintext — partial decrypt failure
      // (e.g. WELLNESS_FIELD_KEY rotated, only one column re-encrypted)
      // is treated as a miss because the upstream auth needs both.
      if (keyId && apiKey) return { keyId, apiKey };
    }
  } catch (e) {
    console.error(
      `[ratehawkClient] getRatehawkCreds supplierCredential lookup failed (non-fatal, falling back to ENV): ${e.message}`,
    );
  }

  return envFallback;
}

/**
 * Hotel search — primary RateHawk operation for RFU unified-search flow.
 *
 * STUB: returns canned shape matching the contract described in
 * PRD_RATEHAWK_INTEGRATION §3.1 (destination city, check-in/out, guests,
 * rooms → hotels[] with name, address, rating, room types with rate).
 * When creds arrive, replace stub body with real fetch().
 */
async function searchHotels({ tenantId, destinationCity, checkInDate, checkOutDate, guests = 2, rooms = 1 }) {
  if (!tenantId) throw new Error('tenantId required');
  await checkBudgetCap(tenantId);

  // Resolve creds via the per-tenant SupplierCredential resolver (S68).
  // In stub mode the creds aren't actually used by the canned response, but
  // we resolve here so:
  //   (a) the cred-drop swap-in is a one-line change (just consume `keyId`
  //       + `apiKey` in the real fetch() body that replaces this stub);
  //   (b) operators with a SupplierCredential row seeded ahead of cred-drop
  //       get the row's hit emitted in observability immediately;
  //   (c) the `module.exports.getRatehawkCreds` indirection keeps the CJS
  //       self-mocking seam intact for vitest.
  // We deliberately do NOT throw on null — the stub must continue to
  // return the canned shape regardless, so downstream UI keeps rendering
  // the "integration pending" placeholder. Real implementation post-cred
  // will branch: `if (!creds) throw new Error('RATEHAWK_NOT_YET_ENABLED')`.
  const creds = await module.exports.getRatehawkCreds(tenantId);
  void creds; // unused in stub mode — consumed in post-cred swap-in.

  console.log(`[ratehawkClient STUB] searchHotels: tenantId=${tenantId} city=${destinationCity} dates=${checkInDate}..${checkOutDate} guests=${guests} rooms=${rooms}`);

  // STUB response — canned shape matching PRD §3.1
  return {
    stub: true,
    tenantId,
    query: { destinationCity, checkInDate, checkOutDate, guests, rooms },
    hotels: [],
    note: 'RateHawk integration pending Q19 creds (Yasin partner onboarding). Real hotel inventory will populate once the swap is done.',
  };
}

/**
 * Book a hotel — POST to RateHawk reservation endpoint.
 *
 * STUB: returns a canned booking confirmation shape. Caller is the
 * Itinerary write path (PRD §3.2 lowest-rate auto-pick + manual override).
 */
async function bookHotel({ tenantId, hotelId, roomType, checkInDate, checkOutDate, guestNames }) {
  if (!tenantId) throw new Error('tenantId required');
  await checkBudgetCap(tenantId);

  // See searchHotels for the rationale on resolving here (S68).
  const creds = await module.exports.getRatehawkCreds(tenantId);
  void creds;

  console.log(`[ratehawkClient STUB] bookHotel: tenantId=${tenantId} hotelId=${hotelId} roomType=${roomType} dates=${checkInDate}..${checkOutDate} guests=${(guestNames || []).length}`);

  return {
    stub: true,
    bookingId: null,
    status: 'pending-cred-drop',
    tenantId,
    query: { hotelId, roomType, checkInDate, checkOutDate, guestNames: guestNames || [] },
    note: 'RateHawk integration pending Q19 creds (Yasin partner onboarding). Real booking confirmation will populate once the swap is done.',
  };
}

/**
 * Cancel a hotel booking — DELETE to RateHawk cancellation endpoint.
 */
async function cancelBooking({ tenantId, bookingId, reason }) {
  if (!tenantId) throw new Error('tenantId required');
  await checkBudgetCap(tenantId);

  // See searchHotels for the rationale on resolving here (S68).
  const creds = await module.exports.getRatehawkCreds(tenantId);
  void creds;

  console.log(`[ratehawkClient STUB] cancelBooking: tenantId=${tenantId} bookingId=${bookingId} reason=${reason}`);

  return {
    stub: true,
    bookingId,
    status: 'pending-cred-drop',
    tenantId,
    reason: reason || null,
    note: 'RateHawk integration pending Q19 creds (Yasin partner onboarding). Real cancellation will be processed once the swap is done.',
  };
}

module.exports = { searchHotels, bookHotel, cancelBooking, checkBudgetCap, computeMonthlySpendCents, getRatehawkCreds, INTEGRATION };
