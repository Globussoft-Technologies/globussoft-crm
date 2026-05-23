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

module.exports = { fetchAdReport, checkBudgetCap, computeMonthlySpendCents, INTEGRATION };
