/**
 * AdsGPT integration client — STUB MODE.
 *
 * STUB: AdsGPT integration pending Q1 creds. Yasin owes the handover
 * package (API key + endpoint URL + provider docs). When creds arrive,
 * swap the placeholder fetch() / mock-response with the real call;
 * the budget-cap + observability scaffold stays unchanged.
 *
 * PRD_ADSGPT_MARKETING_REPORTS DC-2 [RESOLVED 2026-05-24]: $50/mo monthly
 * cap per tenant via the cross-cutting TenantSetting pattern. This module
 * is the second consumer of the cap helper (first: backend/lib/llmRouter.js
 * at commit cb0901f).
 *
 * Per-tenant API-key resolution (S67 — 2026-06-10):
 *   `getAdsGptKey(tenantId)` mirrors `getLlmKey` from backend/lib/llmRouter.js
 *   (S45 commit dd654e4f). Checks SupplierCredential category 'adsgpt-key'
 *   for the given tenant; falls back to process.env.ADSGPT_API_KEY on miss.
 *   Returns null if both miss. NOTE: `process.env.ADSGPT_API_KEY` is the
 *   placeholder name — final env-var lands with Yasin's handover. Adopted
 *   ahead of cred-drop so the cred wiring (operator seeds row → call uses
 *   it; no operator seeded → falls back to ENV) is in place from day-1.
 *
 * Cred chase: docs/CREDS_TRACKER.md Cat 1 Q1 row + docs/PRD_ADSGPT_MARKETING_REPORTS.md §5.
 * Mirror clients for the swap-when-cred pattern:
 *   - backend/services/digilockerClient.js (commit 1babe1b — STUB to real swap reference)
 *   - backend/services/googleDriveClient.js (commit 192de86 — same pattern)
 */

const { getBudgetCap, evaluateCap, KEYS } = require('../lib/tenantSettings');

const INTEGRATION = 'adsgpt';

// Touch KEYS so the imported binding isn't flagged unused — also makes
// the canonical-keys dependency explicit for future readers grep-tracing
// the cap pattern across consumers.
void KEYS;

/**
 * Pre-call cap check. Returns { withinCap, capCents, spentCents, percent, alertThreshold }.
 * Throws { code: 'ADSGPT_BUDGET_EXCEEDED', error, spentCents, capCents } if over cap.
 *
 * Spend source: existing LlmCallLog model (filter by provider='adsgpt' once real).
 * In stub mode, returns 0 spend (no rows ever written by the stub).
 */
async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  // Resolve via module.exports so vi.spyOn(client, 'computeMonthlySpendCents')
  // in unit tests intercepts the call. Direct local-binding reference would
  // bypass the spy (closure-captured at module load).
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly AdsGPT spend cap reached for this tenant.');
    err.code = 'ADSGPT_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(`[adsGptClient] tenant ${tenantId} at ${Math.round(evaluation.percent * 100)}% of monthly AdsGPT cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`);
  }
  return evaluation;
}

async function computeMonthlySpendCents(_tenantId) {
  // STUB: real implementation will sum LlmCallLog.costEstimate (Decimal USD;
  // helper at backend/lib/llmRouter.js shows the same dollar→cent
  // conversion pattern — multiply by 100). For now returns 0.
  // TODO post-cred: real spend sum filtered by tenantId + provider='adsgpt' + createdAt >= startOfMonth.
  return 0;
}

/**
 * Resolve the AdsGPT API key for a tenant. Mirrors `getLlmKey` from
 * backend/lib/llmRouter.js (S45) so operator UX stays consistent across
 * integrations:
 *
 *   1. Without `tenantId`        → ENV only (matches pre-S67 contract).
 *   2. With `tenantId`           → check SupplierCredential row first
 *                                  (category 'adsgpt-key', any supplierName);
 *                                  fall back to ENV on miss.
 *   3. Both missing              → return null. Caller decides whether to
 *                                  raise an "integration disabled" path.
 *
 * Best-effort: any Prisma / decrypt error is logged and treated as a
 * miss (caller falls through to ENV). NEVER throws.
 *
 * Placeholder env-var: `ADSGPT_API_KEY`. Yasin's handover (Q1 cred chase)
 * may pick a different final name (e.g. `ADSGPT_KEY`); when it lands, just
 * update the `process.env.<NAME>` read here — the SupplierCredential
 * lookup layer above stays unchanged.
 *
 * @param {number} [tenantId] — optional. Omit for ENV-only behaviour.
 * @returns {Promise<string|null>}
 */
async function getAdsGptKey(tenantId) {
  // Placeholder env-var name — finalises with Yasin's handover. See header.
  const envValue = process.env.ADSGPT_API_KEY || null;

  // No tenant scope → ENV only.
  if (!tenantId) {
    return envValue;
  }

  try {
    const prisma = require('../lib/prisma');
    if (
      !prisma.supplierCredential ||
      typeof prisma.supplierCredential.findFirst !== 'function'
    ) {
      return envValue;
    }
    const row = await prisma.supplierCredential.findFirst({
      where: { tenantId, category: 'adsgpt-key' },
      select: { passwordEncrypted: true },
    });
    if (row && row.passwordEncrypted) {
      // Lazy require to avoid circular bombs in test harnesses that
      // hand-roll the crypto layer (matches llmRouter.getLlmKey shape).
      const { decrypt } = require('../lib/fieldEncryption');
      const plaintext = decrypt(row.passwordEncrypted);
      if (plaintext) return plaintext;
    }
  } catch (e) {
    console.error(
      `[adsGptClient] getAdsGptKey supplierCredential lookup failed (non-fatal, falling back to ENV): ${e.message}`,
    );
  }

  return envValue;
}

/**
 * Fetch ad-platform performance report from AdsGPT.
 *
 * STUB: returns canned shape matching the contract described in
 * PRD_ADSGPT_MARKETING_REPORTS §3.4 (per-platform spend / impressions /
 * clicks / conversions / CPA / ROAS for the requested date range).
 * When creds arrive, replace stub body with the real fetch().
 */
async function fetchAdReport({ tenantId, subBrand, fromDate, toDate, platform = 'all' }) {
  if (!tenantId) throw new Error('tenantId required');
  await checkBudgetCap(tenantId);

  // Resolve API key via the per-tenant SupplierCredential resolver (S67).
  // In stub mode the key isn't actually used by the canned response, but
  // we resolve it here so:
  //   (a) the cred-drop swap-in is a one-line change (just consume the key
  //       in the real fetch() body that replaces this stub);
  //   (b) operators with a SupplierCredential row seeded ahead of cred-drop
  //       get the row's row-row hit emitted in observability immediately;
  //   (c) the `module.exports.getAdsGptKey` indirection keeps the CJS
  //       self-mocking seam intact for vitest.
  // We deliberately do NOT throw on null — the stub must continue to
  // return the canned shape regardless, so downstream UI keeps rendering
  // the "integration pending" placeholder. Real implementation post-cred
  // will branch: `if (!apiKey) throw new Error('ADSGPT_NOT_YET_ENABLED')`.
  const apiKey = await module.exports.getAdsGptKey(tenantId);
  void apiKey; // unused in stub mode — consumed in post-cred swap-in.

  console.log(`[adsGptClient STUB] fetchAdReport called: tenantId=${tenantId} subBrand=${subBrand} platform=${platform} window=${fromDate}..${toDate}`);

  // STUB response — canned shape matching PRD §3.4
  return {
    stub: true,
    tenantId,
    subBrand: subBrand || null,
    platform,
    window: { fromDate, toDate },
    metrics: {
      spendUsdCents: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      cpaCents: 0,
      roas: 0,
    },
    rows: [],
    note: 'AdsGPT integration pending Q1 creds (Yasin handover). This is a placeholder; metrics will populate once the real client is wired.',
  };
}

module.exports = { fetchAdReport, checkBudgetCap, computeMonthlySpendCents, getAdsGptKey, INTEGRATION };
