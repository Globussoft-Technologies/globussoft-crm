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
 *
 * Per-tenant API-key resolution (S69 — 2026-06-10):
 *   `getCallifiedKey(tenantId)` mirrors `getLlmKey` (S45 commit dd654e4f)
 *   and `getAdsGptKey` (S67 commit 996bb4f2). Checks SupplierCredential
 *   category 'ai-calling-key' for the given tenant; falls back to
 *   process.env.CALLIFIED_API_KEY on miss. Returns null if both miss.
 *   The placeholder env-var name `CALLIFIED_API_KEY` matches the documented
 *   setup in docs/CALLIFIED_INTEGRATION_SETUP.md §5 — finalises with
 *   Yasin's handover. Adopted ahead of cred-drop so the cred wiring
 *   (operator seeds row → call uses it; no operator seeded → ENV fallback)
 *   is in place from day-1.
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

/**
 * Resolve the Callified.ai API key for a tenant. Mirrors `getLlmKey` from
 * backend/lib/llmRouter.js (S45) and `getAdsGptKey` from adsGptClient.js
 * (S67) so operator UX stays consistent across integrations:
 *
 *   1. Without `tenantId`        → ENV only (matches pre-S69 contract).
 *   2. With `tenantId`           → check SupplierCredential row first
 *                                  (category 'ai-calling-key', any supplierName);
 *                                  fall back to ENV on miss.
 *   3. Both missing              → return null. Caller decides whether to
 *                                  raise an "integration disabled" path.
 *
 * Best-effort: any Prisma / decrypt error is logged and treated as a
 * miss (caller falls through to ENV). NEVER throws.
 *
 * Placeholder env-var: `CALLIFIED_API_KEY` (matches docs/CALLIFIED_INTEGRATION_SETUP.md
 * §5). Yasin's handover (Q1 cred chase) may pick a different final name; when
 * it lands, just update the `process.env.<NAME>` read here — the
 * SupplierCredential lookup layer above stays unchanged.
 *
 * @param {number} [tenantId] — optional. Omit for ENV-only behaviour.
 * @returns {Promise<string|null>}
 */
async function getCallifiedKey(tenantId) {
  // Placeholder env-var name — finalises with Yasin's handover. See header.
  const envValue = process.env.CALLIFIED_API_KEY || null;

  // No tenant scope → ENV only.
  if (!tenantId) {
    return envValue;
  }

  try {
    const prismaLib = require('../lib/prisma');
    if (
      !prismaLib.supplierCredential ||
      typeof prismaLib.supplierCredential.findFirst !== 'function'
    ) {
      return envValue;
    }
    const row = await prismaLib.supplierCredential.findFirst({
      where: { tenantId, category: 'ai-calling-key' },
      select: { passwordEncrypted: true },
    });
    if (row && row.passwordEncrypted) {
      // Lazy require to avoid circular bombs in test harnesses that
      // hand-roll the crypto layer (matches llmRouter.getLlmKey /
      // adsGptClient.getAdsGptKey shape).
      const { decrypt } = require('../lib/fieldEncryption');
      const plaintext = decrypt(row.passwordEncrypted);
      if (plaintext) return plaintext;
    }
  } catch (e) {
    console.error(
      `[callifiedClient] getCallifiedKey supplierCredential lookup failed (non-fatal, falling back to ENV): ${e.message}`,
    );
  }

  return envValue;
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

  // Resolve API key via the per-tenant SupplierCredential resolver (S69).
  // In stub mode the key isn't actually used by the canned response, but
  // we resolve it here so:
  //   (a) the cred-drop swap-in is a one-line change (just consume the key
  //       in the real fetch() body that replaces this stub);
  //   (b) operators with a SupplierCredential row seeded ahead of cred-drop
  //       get the row-hit emitted in observability immediately;
  //   (c) the `module.exports.getCallifiedKey` indirection keeps the CJS
  //       self-mocking seam intact for vitest.
  // We deliberately do NOT throw on null — the stub must continue to
  // return the canned shape regardless, so downstream UI keeps rendering
  // the "integration pending" placeholder. Real implementation post-cred
  // will branch: `if (!apiKey) throw new Error('CALLIFIED_NOT_YET_ENABLED')`.
  const apiKey = await module.exports.getCallifiedKey(tenantId);
  void apiKey; // unused in stub mode — consumed in post-cred swap-in.

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

  // Per-tenant key resolution (S69 swap-point — mirror of initiateCall).
  // Stub-mode discards the resolved value; post-cred swap-in will use it
  // in the real fetch() body. The `module.exports.getCallifiedKey`
  // indirection keeps the CJS self-mocking seam intact for vitest.
  const apiKey = await module.exports.getCallifiedKey(tenantId);
  void apiKey;

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
  getCallifiedKey,
  INTEGRATION,
  FEATURE_FLAG_KEY,
  MAX_CALL_DURATION_SECONDS,
};
