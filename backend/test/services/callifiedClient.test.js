// Unit tests for backend/services/callifiedClient.js
//
// What this module does:
//   Stub-mode wrapper for Callified.ai outbound AI calling integration. Real
//   API call lands when Q1 creds (Yasin handover) drop. Fourth consumer of
//   the cross-cutting per-tenant budget-cap pattern (after llmRouter +
//   adsGptClient + ratehawkClient). Adds two new wrinkles on top of the
//   shared cap pattern:
//     - Per-call duration ceiling (90s — DC-1)
//     - Per-tenant feature flag via TenantSetting key
//       `featureFlag_ai_calling_enabled` (default ON when row absent — DC-7)
//     - Sub-brand persona resolution via Tenant.subBrandConfigJson key
//       `callifiedPersona_<subBrand>` (DC-3)
//
//   Exports:
//     - INTEGRATION                  — short token ('ai_calling') for the cap helper
//     - FEATURE_FLAG_KEY             — TenantSetting key for the on/off toggle
//     - MAX_CALL_DURATION_SECONDS    — 90s ceiling (DC-1)
//     - checkBudgetCap(tenantId)     — pre-call cap check; throws AI_CALLING_BUDGET_EXCEEDED
//     - computeMonthlySpendCents(t)  — stub returns 0 (real will sum CallSession rows)
//     - isEnabledForTenant(t)        — reads FEATURE_FLAG_KEY; defaults true
//     - resolveSubBrandPersona(t,sb) — looks up persona from Tenant.subBrandConfigJson
//     - initiateCall({...})          — stub canned shape, runs flag + cap pre-checks
//     - fetchCallResult({...})       — stub canned shape with durationSeconds: 0
//
// Surface area covered:
//   1. Module shape — exports + constants
//   2. initiateCall happy path returns stub envelope with maxDurationSeconds: 90
//   3. initiateCall throws AI_CALLING_DISABLED when feature flag is set to "false"
//   4. initiateCall throws AI_CALLING_BUDGET_EXCEEDED when stubbed spend exceeds cap
//   5. checkBudgetCap returns alertThreshold:true at 80% spend
//   6. resolveSubBrandPersona returns persona from subBrandConfigJson when present
//   7. resolveSubBrandPersona returns null when subBrand absent / config missing / malformed JSON
//   8. fetchCallResult happy path returns canned shape with durationSeconds: 0
//
// Pin the contract the REAL implementation MUST honour when the stub is
// swapped — downstream consumers (auto-dial workflow, lead routing, RFU
// counsel-session orchestration) depend on the returned envelope.

import { describe, test, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Hoisted Prisma mock — the cap helper does
// `prisma.tenantSetting.findUnique(...)` to read per-tenant cap rows AND
// per-tenant feature-flag rows. resolveSubBrandPersona also does
// `prisma.tenant.findUnique(...)`. Installed into Node's Module._cache the
// same way as the ratehawkClient / adsGptClient tests (vitest's ESM-level
// vi.mock can't intercept CJS require()).
const prismaMock = vi.hoisted(() => {
  const mock = {
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue(null), // default → DEFAULTS or fallback
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const Module = require('node:module');
  const requireFromCwd = Module.createRequire(process.cwd() + '/');
  const prismaLibPath = requireFromCwd.resolve('./lib/prisma');
  Module._cache[prismaLibPath] = {
    id: prismaLibPath,
    filename: prismaLibPath,
    loaded: true,
    exports: mock,
    children: [],
    paths: [],
  };
  return mock;
});

afterEach(() => {
  vi.restoreAllMocks();
  prismaMock.tenantSetting.findUnique.mockReset();
  prismaMock.tenantSetting.findUnique.mockResolvedValue(null);
  prismaMock.tenant.findUnique.mockReset();
  prismaMock.tenant.findUnique.mockResolvedValue(null);
});

function loadClient() {
  // Reload fresh between tests so the spend-stub mock + module state are
  // pristine. Same pattern as ratehawkClient.test.js / adsGptClient.test.js.
  delete requireCjs.cache[requireCjs.resolve('../../services/callifiedClient.js')];
  // Also reload tenantSettings so its imported prisma binding re-resolves
  // to the mocked module in Module._cache. (The helper module captures
  // `prisma` at require-time; reloading it ensures the mock is in scope.)
  delete requireCjs.cache[requireCjs.resolve('../../lib/tenantSettings.js')];
  return requireCjs('../../services/callifiedClient.js');
}

describe('callifiedClient — module shape', () => {
  test('exports the contract surface + constants', () => {
    const c = loadClient();
    expect(typeof c.initiateCall).toBe('function');
    expect(typeof c.fetchCallResult).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(typeof c.isEnabledForTenant).toBe('function');
    expect(typeof c.resolveSubBrandPersona).toBe('function');
    expect(c.INTEGRATION).toBe('ai_calling');
    expect(c.FEATURE_FLAG_KEY).toBe('featureFlag_ai_calling_enabled');
    expect(c.MAX_CALL_DURATION_SECONDS).toBe(90);
  });
});

describe('initiateCall', () => {
  test('happy path: returns stub envelope with maxDurationSeconds: 90 and persona "default"', async () => {
    // No tenantSetting rows → feature flag defaults to true, cap falls back
    // to DEFAULTS (10000 cents = $100); stub spend = 0 → withinCap = true.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.initiateCall({
      tenantId: 42,
      toPhone: '+919999000001',
      leadId: 'lead-7',
      intent: 'umrah-followup',
    });

    expect(out).toMatchObject({
      stub: true,
      callId: null,
      tenantId: 42,
      subBrand: null,
      toPhone: '+919999000001',
      leadId: 'lead-7',
      intent: 'umrah-followup',
      persona: 'default',
      maxDurationSeconds: 90,
      status: 'pending-cred-drop',
    });
    // Note must mention Q1 creds + Yasin so downstream UI can show
    // "integration pending" messaging deterministically.
    expect(out.note).toMatch(/Q1 creds/);
    expect(out.note).toMatch(/Yasin/);

    logSpy.mockRestore();
  });

  test('throws AI_CALLING_DISABLED when featureFlag is set to "false"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Conditional findUnique: return {value:'false'} when asked for the
    // feature-flag key; null otherwise (so cap check would still fall to
    // DEFAULTS — but we never reach it because the flag check throws first).
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (where && where.tenantId_key && where.tenantId_key.key === 'featureFlag_ai_calling_enabled') {
        return Promise.resolve({ value: 'false' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    let caught;
    try {
      await c.initiateCall({ tenantId: 99, toPhone: '+919999000002' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('AI_CALLING_DISABLED');
    expect(caught.message).toMatch(/AI calling disabled/);

    logSpy.mockRestore();
  });

  test('throws AI_CALLING_BUDGET_EXCEEDED when stubbed spend exceeds cap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Cap row: 10000 cents ($100, the DC-1 default — explicit here for clarity).
    // Feature flag absent → defaults to true (don't short-circuit). The cap
    // findUnique fires AFTER the flag check.
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (where && where.tenantId_key && where.tenantId_key.key === 'budgetCap_ai_calling_monthly_usd_cents') {
        return Promise.resolve({ value: '10000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // Override computeMonthlySpendCents to return cap + 1 = 10001 cents
    // (over cap → evaluateCap.withinCap = false → throw). Spy works because
    // the SUT resolves the call via module.exports (CJS self-mocking seam —
    // 3rd instance of this pattern).
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(10001);

    let caught;
    try {
      await c.initiateCall({ tenantId: 7, toPhone: '+919999000003' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('AI_CALLING_BUDGET_EXCEEDED');
    expect(caught.message).toMatch(/Monthly AI calling spend cap reached/);
    expect(caught.spentCents).toBe(10001);
    expect(caught.capCents).toBe(10000);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('persona arg overrides default + sub-brand lookup', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.initiateCall({
      tenantId: 42,
      toPhone: '+919999000004',
      subBrand: 'rfu',
      persona: 'caller-explicit-override',
    });

    expect(out.persona).toBe('caller-explicit-override');
    expect(out.subBrand).toBe('rfu');

    logSpy.mockRestore();
  });
});

describe('checkBudgetCap', () => {
  test('returns alertThreshold:true when stubbed spend is ≥80% of cap (10000c cap, 8500c spend)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Cap row: 10000 cents ($100, the DC-1 default — explicit for clarity).
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (where && where.tenantId_key && where.tenantId_key.key === 'budgetCap_ai_calling_monthly_usd_cents') {
        return Promise.resolve({ value: '10000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // 8500 / 10000 = 85% → alertThreshold true, withinCap still true.
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(8500);

    const evaluation = await c.checkBudgetCap(7);
    expect(evaluation).toMatchObject({
      spentCents: 8500,
      capCents: 10000,
      withinCap: true,
      alertThreshold: true,
    });
    expect(evaluation.percent).toBeCloseTo(0.85, 5);

    // 80%-threshold warning was emitted with tenant + amounts visible.
    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).toMatch(/tenant 7/);
    expect(warnMsgs).toMatch(/85%/);
    expect(warnMsgs).toMatch(/AI calling/);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('resolveSubBrandPersona', () => {
  test('returns persona from Tenant.subBrandConfigJson when key is present', async () => {
    prismaMock.tenant.findUnique.mockResolvedValueOnce({
      subBrandConfigJson: JSON.stringify({
        callifiedPersona_rfu: 'umrah-counsellor-v2',
        callifiedPersona_tmc: 'school-trip-advisor',
      }),
    });

    const c = loadClient();
    const persona = await c.resolveSubBrandPersona(42, 'rfu');
    expect(persona).toBe('umrah-counsellor-v2');
  });

  test('returns null when subBrand is absent / config missing / JSON malformed', async () => {
    const c = loadClient();

    // No subBrand passed at all → short-circuit return null (no DB read).
    expect(await c.resolveSubBrandPersona(42, null)).toBeNull();
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();

    // Tenant exists but no subBrandConfigJson set.
    prismaMock.tenant.findUnique.mockResolvedValueOnce({ subBrandConfigJson: null });
    expect(await c.resolveSubBrandPersona(42, 'rfu')).toBeNull();

    // Tenant config JSON is malformed (parse throws) → null, not crash.
    prismaMock.tenant.findUnique.mockResolvedValueOnce({ subBrandConfigJson: '{not valid json' });
    expect(await c.resolveSubBrandPersona(42, 'rfu')).toBeNull();

    // Tenant config JSON valid but doesn't contain the requested key.
    prismaMock.tenant.findUnique.mockResolvedValueOnce({
      subBrandConfigJson: JSON.stringify({ callifiedPersona_tmc: 'x' }),
    });
    expect(await c.resolveSubBrandPersona(42, 'rfu')).toBeNull();
  });
});

describe('fetchCallResult', () => {
  test('happy path: returns canned shape with durationSeconds:0 and outcome "pending-cred-drop"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.fetchCallResult({ tenantId: 42, callId: 'cl_abc123' });

    expect(out).toMatchObject({
      stub: true,
      callId: 'cl_abc123',
      tenantId: 42,
      durationSeconds: 0,
      recordingUrl: null,
      transcript: null,
      summary: null,
      outcome: 'pending-cred-drop',
    });
    expect(out.note).toMatch(/Q1 creds/);

    logSpy.mockRestore();
  });

  test('throws when tenantId or callId missing', async () => {
    const c = loadClient();
    await expect(c.fetchCallResult({ callId: 'cl_xyz' })).rejects.toThrow(/tenantId required/);
    await expect(c.fetchCallResult({ tenantId: 1 })).rejects.toThrow(/callId required/);
  });
});
