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

// ─── EXTENSION: +8 cases (tick of test-writing cron) ──────────────────
//
// Coverage targets the 4 under-pinned axes identified against the 165-LOC
// SUT (existing 10 cases left these holes):
//   • CJS self-mocking seam — regression pins for the THREE inter-function
//     calls inside initiateCall that route via module.exports indirection
//     (isEnabledForTenant, checkBudgetCap, resolveSubBrandPersona). This
//     was the 2026-05-24 cron-learning that triggered the rule-of-3
//     promotion (4th instance of CJS-self-mocking-seam pattern). If a
//     refactor accidentally regresses these to local-binding calls, the
//     unit tests' spy strategy silently breaks — these tests detect it.
//   • initiateCall input guard fail-fast — missing tenantId / toPhone
//     throws BEFORE the flag check fires (no prisma reads).
//   • isEnabledForTenant fallback semantics — defaults true when row
//     absent; coerces "1" as truthy (DC-7 admin-toggle contract).
//   • checkBudgetCap at-cap boundary — withinCap is STRICT inequality
//     (spent < cap), so spent === cap REJECTS. Pin the boundary.
//   • computeMonthlySpendCents stub returns 0 — contract pin (the real
//     impl must preserve the return TYPE while changing the value).
//   • initiateCall persona resolution: when no explicit persona arg and
//     sub-brand has a configured persona, initiateCall MUST use the
//     subBrandConfigJson value (not "default" fallback).

describe('callifiedClient — extension', () => {
  test('CJS seam: initiateCall routes checkBudgetCap call via module.exports (NOT local binding)', async () => {
    // Regression pin for the 2026-05-24 cron-learning. If somebody
    // refactors line 108 of callifiedClient.js from
    //   `await module.exports.checkBudgetCap(tenantId);`
    // back to the local-binding form
    //   `await checkBudgetCap(tenantId);`
    // the vi.spyOn here STOPS intercepting and the test fails — caught
    // at unit-test time rather than waiting for production cap-breach.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap').mockResolvedValue({
      spentCents: 0,
      capCents: 10000,
      percent: 0,
      withinCap: true,
      alertThreshold: false,
    });

    await c.initiateCall({ tenantId: 42, toPhone: '+919999000010' });

    expect(capSpy).toHaveBeenCalledTimes(1);
    expect(capSpy).toHaveBeenCalledWith(42);

    capSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('CJS seam: initiateCall routes isEnabledForTenant call via module.exports', async () => {
    // Sibling regression pin: line 102 must call
    // `module.exports.isEnabledForTenant(tenantId)`, NOT the local
    // binding. Force-return false via spy → if the call routes through
    // the spy we get AI_CALLING_DISABLED; if it bypasses the spy we'd
    // hit the live prisma path (default → true) and the test passes
    // silently for the wrong reason. So we ALSO assert the spy fired.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const flagSpy = vi.spyOn(c, 'isEnabledForTenant').mockResolvedValue(false);

    let caught;
    try {
      await c.initiateCall({ tenantId: 7, toPhone: '+919999000011' });
    } catch (e) {
      caught = e;
    }

    expect(flagSpy).toHaveBeenCalledTimes(1);
    expect(flagSpy).toHaveBeenCalledWith(7);
    expect(caught).toBeDefined();
    expect(caught.code).toBe('AI_CALLING_DISABLED');

    flagSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('CJS seam: initiateCall routes resolveSubBrandPersona call via module.exports', async () => {
    // Third regression pin for the same pattern — line 111. Force-return
    // a known persona via spy and assert it lands in the envelope. If
    // the call bypasses module.exports, the spy never fires and the
    // envelope falls back to 'default' — test fails on both the spy
    // assertion AND the persona-value assertion.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const personaSpy = vi
      .spyOn(c, 'resolveSubBrandPersona')
      .mockResolvedValue('spy-injected-persona-v9');

    const out = await c.initiateCall({
      tenantId: 42,
      toPhone: '+919999000012',
      subBrand: 'rfu',
    });

    expect(personaSpy).toHaveBeenCalledTimes(1);
    expect(personaSpy).toHaveBeenCalledWith(42, 'rfu');
    expect(out.persona).toBe('spy-injected-persona-v9');

    personaSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('initiateCall throws on missing tenantId / toPhone BEFORE any prisma read', async () => {
    // Fail-fast guard — protects against accidental flag/cap reads with
    // tenantId=undefined which would either no-op (current getSetting
    // behaviour returns the fallback for falsy tenantId) or, worse,
    // silently apply tenant 0's settings if a future refactor coerces.
    const c = loadClient();

    await expect(
      c.initiateCall({ toPhone: '+919999000013' }),
    ).rejects.toThrow(/tenantId required/);

    await expect(
      c.initiateCall({ tenantId: 42 }),
    ).rejects.toThrow(/toPhone required/);

    // Neither failing path should have touched prisma.
    expect(prismaMock.tenantSetting.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
  });

  test('isEnabledForTenant: defaults TRUE when no TenantSetting row exists', async () => {
    // DC-7 contract: feature is ON unless an admin explicitly toggles
    // it off. A missing row must NOT default to disabled.
    const c = loadClient();
    // prismaMock.tenantSetting.findUnique already returns null by
    // default → the fallback:true branch fires.
    const enabled = await c.isEnabledForTenant(42);
    expect(enabled).toBe(true);
  });

  test('isEnabledForTenant: coerces "1" as truthy + "0"/other as falsy', async () => {
    const c = loadClient();

    // "1" → enabled (explicit on)
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '1' });
    expect(await c.isEnabledForTenant(42)).toBe(true);

    // "0" → disabled (explicit off)
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '0' });
    expect(await c.isEnabledForTenant(42)).toBe(false);

    // "anything-else" → disabled (only "true"/"1" coerce truthy per
    // the SUT's coerce: v === 'true' || v === '1'). Pins the coercer
    // contract so a future refactor to Boolean() doesn't silently
    // make "anything-else" truthy.
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: 'enabled' });
    expect(await c.isEnabledForTenant(42)).toBe(false);
  });

  test('checkBudgetCap: AT-cap (spent === cap) REJECTS (strict-less-than boundary)', async () => {
    // evaluateCap pins withinCap as `spent < cap`, not `spent <= cap`.
    // The contract is "at cap blocks" — the budget is fully consumed at
    // the moment spent equals cap. Test the boundary explicitly so a
    // future change to `<=` is caught.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'budgetCap_ai_calling_monthly_usd_cents'
      ) {
        return Promise.resolve({ value: '10000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(10000);

    let caught;
    try {
      await c.checkBudgetCap(7);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught.code).toBe('AI_CALLING_BUDGET_EXCEEDED');
    expect(caught.spentCents).toBe(10000);
    expect(caught.capCents).toBe(10000);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('initiateCall: when no explicit persona arg + sub-brand has configured persona, envelope reflects subBrandConfigJson value', async () => {
    // Integration of the persona-resolution chain through initiateCall.
    // The existing test #4 covers the persona-override path (explicit
    // arg wins); this test covers the OTHER branch — when persona arg
    // is undefined AND subBrand has a configured persona, the envelope
    // should resolve to the JSON-configured value (NOT 'default').
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // tenant row returns subBrandConfigJson with rfu persona configured.
    prismaMock.tenant.findUnique.mockResolvedValueOnce({
      subBrandConfigJson: JSON.stringify({
        callifiedPersona_rfu: 'umrah-counsellor-v3',
      }),
    });

    const c = loadClient();
    const out = await c.initiateCall({
      tenantId: 42,
      toPhone: '+919999000014',
      subBrand: 'rfu',
      // persona NOT supplied — must resolve from subBrandConfigJson
    });

    expect(out.persona).toBe('umrah-counsellor-v3');
    expect(out.subBrand).toBe('rfu');

    logSpy.mockRestore();
  });
});
