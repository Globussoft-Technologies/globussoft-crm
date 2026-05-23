/**
 * Callified.ai integration client — STUB MODE.
 *
 * STUB: Callified.ai integration pending Q1 creds. Yasin owes the handover
 * (API key + endpoint URL + agent spec + recording-storage decision). When
 * creds arrive, swap the placeholder fetch() / mock-response with real call;
 * the cap + feature-flag + observability scaffold stays unchanged.
 *
 * PRD_AI_CALLING_CALLIFIED DC-1 [RESOLVED 2026-05-24]: $100/mo cap + 90s
 * per-call ceiling via cross-cutting TenantSetting pattern.
 * DC-2 [RESOLVED]: lead-source whitelist gating in auto-mode (operator
 * decides which sources auto-trigger calls).
 * DC-3 [RESOLVED]: persona/script per sub-brand via Tenant.subBrandConfigJson.
 * DC-5 [RESOLVED]: TRAI disclosure copy batched into single counsel session.
 * DC-7 [RESOLVED]: per-tenant disable toggle via TenantSetting.
 *
 * Fourth consumer of the cap helper (after llmRouter cb0901f + adsGptClient
 * 9f35040 + ratehawkClient 2852b82). Cred chase: docs/CREDS_TRACKER.md Cat 1
 * Q1 row. Sandbox mock for end-to-end-only flow lives at
 * backend/scripts/sandbox/callified-mock.js (issue #137) and is unrelated
 * to this client — that mock simulates Callified pushing inbound payloads
 * to /api/v1/external; this client is the OUTBOUND swap point.
 */

const prisma = require('../lib/prisma');
const { getBudgetCap, getSetting, evaluateCap, KEYS } = require('../lib/tenantSettings');

const INTEGRATION = 'ai_calling';
const FEATURE_FLAG_KEY = 'featureFlag_ai_calling_enabled';
const MAX_CALL_DURATION_SECONDS = 90; // DC-1 per-call ceiling

// Touch KEYS so the imported binding isn't flagged unused — also makes
// the canonical-keys dependency explicit for future readers grep-tracing
// the cap pattern across consumers.
void KEYS;

async function isEnabledForTenant(tenantId) {
  return await getSetting(tenantId, FEATURE_FLAG_KEY, {
    coerce: (v) => v === 'true' || v === '1',
    fallback: true,
  });
}

async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  // Resolve via module.exports so vi.spyOn(client, 'computeMonthlySpendCents')
  // in unit tests intercepts the call. Direct local-binding reference would
  // bypass the spy (closure-captured at module load). This is the THIRD
  // instance of the CJS self-mocking seam pattern (first: tick #47
  // safeEmitEvent; second: ratehawkClient checkBudgetCap). Worth promoting
  // to a standing rule on this third instance — see commit body / wave
  // report for the recommendation.
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly AI calling spend cap reached for this tenant.');
    err.code = 'AI_CALLING_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(`[callifiedClient] tenant ${tenantId} at ${Math.round(evaluation.percent * 100)}% of monthly AI calling cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`);
  }
  return evaluation;
}

async function computeMonthlySpendCents(_tenantId) {
  // STUB: real implementation will sum CallSession.costEstimate (Decimal USD)
  // filtered by tenantId + createdAt >= startOfMonth. Mirror the LlmCallLog
  // spend-sum pattern in backend/lib/llmRouter.js (dollar→cent conversion
  // via * 100). For now returns 0 — stub never writes spend rows.
  return 0;
}

async function resolveSubBrandPersona(tenantId, subBrand) {
  if (!subBrand) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subBrandConfigJson: true },
  });
  if (!tenant || !tenant.subBrandConfigJson) return null;
  try {
    const config = JSON.parse(tenant.subBrandConfigJson);
    return config[`callifiedPersona_${subBrand}`] || null;
  } catch {
    return null;
  }
}

/**
 * Initiate an outbound AI call.
 *
 * STUB: returns a canned envelope. When creds arrive, replace with real
 * fetch() to Callified.ai's outbound-call endpoint. Cap + feature-flag +
 * persona resolution stays unchanged across the swap.
 */
async function initiateCall({ tenantId, subBrand, toPhone, leadId, intent, persona }) {
  if (!tenantId) throw new Error('tenantId required');
  if (!toPhone) throw new Error('toPhone required');

  if (!(await module.exports.isEnabledForTenant(tenantId))) {
    const err = new Error('AI calling disabled for this tenant.');
    err.code = 'AI_CALLING_DISABLED';
    throw err;
  }

  await module.exports.checkBudgetCap(tenantId);

  const resolvedPersona =
    persona || (await module.exports.resolveSubBrandPersona(tenantId, subBrand)) || 'default';

  console.log(`[callifiedClient STUB] initiateCall: tenantId=${tenantId} subBrand=${subBrand} toPhone=${toPhone} leadId=${leadId} intent=${intent} persona=${resolvedPersona} maxDurationSeconds=${MAX_CALL_DURATION_SECONDS}`);

  return {
    stub: true,
    callId: null,
    tenantId,
    subBrand: subBrand || null,
    toPhone,
    leadId: leadId || null,
    intent: intent || null,
    persona: resolvedPersona,
    maxDurationSeconds: MAX_CALL_DURATION_SECONDS,
    status: 'pending-cred-drop',
    note: 'Callified.ai integration pending Q1 creds (Yasin handover). Real call invocation will populate once the swap is done.',
  };
}

/**
 * Fetch call recording / transcript / summary post-call.
 *
 * STUB: returns a canned envelope. When creds arrive, replace with real
 * fetch() to Callified.ai's call-result endpoint.
 */
async function fetchCallResult({ tenantId, callId }) {
  if (!tenantId) throw new Error('tenantId required');
  if (!callId) throw new Error('callId required');

  console.log(`[callifiedClient STUB] fetchCallResult: tenantId=${tenantId} callId=${callId}`);

  return {
    stub: true,
    callId,
    tenantId,
    durationSeconds: 0,
    recordingUrl: null,
    transcript: null,
    summary: null,
    outcome: 'pending-cred-drop',
    note: 'Callified.ai integration pending Q1 creds. Real call result will populate once the swap is done.',
  };
}

module.exports = {
  initiateCall,
  fetchCallResult,
  checkBudgetCap,
  computeMonthlySpendCents,
  isEnabledForTenant,
  resolveSubBrandPersona,
  INTEGRATION,
  FEATURE_FLAG_KEY,
  MAX_CALL_DURATION_SECONDS,
};
