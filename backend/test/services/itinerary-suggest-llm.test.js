// Unit tests for backend/services/itinerarySuggestLLM.js
//
// What this module does:
//   Stub-mode wrapper for the `itinerary-suggest` LLM task class
//   (PRD_TRAVEL_ITINERARY_UPGRADES FR-3.6 + AI_SURFACES §3). Real
//   Gemini 2.5 Flash call lands when Q-IT-2 (overlapping Q11) key
//   drops. Exports:
//     - INTEGRATION                 — short token 'llm' (shares LLM monthly cap)
//     - TASK_NAME                   — 'itinerary-suggest' (matches llmRouter TASK_ROUTING)
//     - MODEL_PRIMARY               — 'gemini-2.5-flash' per FR-3.6
//     - GEMINI_KEY_ENV              — 'GEMINI_API_KEY' env-var name
//     - suggestItinerary({...}, {prisma}) — primary surface
//     - checkBudgetCap(tenantId)    — pre-call cap check
//     - computeMonthlySpendCents(t) — stub returns 0 (real sums LlmCallLog)
//     - realModeEnabled()           — env-var probe (sync)
//     - callGemini({...})           — real-mode swap point (throws today)
//     - buildStubSuggestion({...})  — deterministic stub shape
//
// Surface area covered (16 + S45 extension = 20+ cases):
//   1. Module shape pin (exports + constants)
//   2. Stub mode returns canned shape with documented keys + correct days
//   3. Real-mode flagged + key absent → falls back to stub
//   4. Real-mode flagged + key PRESENT + callGemini errors → falls back to stub
//   5. Real-mode flagged + key PRESENT + callGemini succeeds → returns 'gemini' source
//   6. suggestItinerary throws when tenantId missing (before budget check)
//   7. suggestItinerary throws when durationDays <= 0
//   8. Budget cap throws ITINERARY_SUGGEST_BUDGET_EXCEEDED when spend >= cap
//   9. Budget cap returns alertThreshold:true at 80%+
//  10. Budget cap silently passes under 80% (no warn emitted)
//  11. CJS self-mocking seam regression-pin (checkBudgetCap calls
//      computeMonthlySpendCents via module.exports indirection)
//  12. CJS self-mocking seam — suggestItinerary calls checkBudgetCap via
//      module.exports indirection
//  13. Deterministic stub: same inputs → identical output
//  14. realModeEnabled() returns false with no env key
//  15. realModeEnabled() returns true when env key is set
//  16. llmRouter.TASK_ROUTING registers 'itinerary-suggest' to gemini-flash
//  S45 17-20. realModeEnabled async + per-tenant SupplierCredential:
//             - SupplierCredential row present → true (no ENV needed)
//             - SupplierCredential overrides ENV
//             - no row + no ENV + tenantId → false
//             - CJS self-mocking seam still works through module.exports.realModeEnabled
//
// Pin the contract that S9 (visual editor) + S11 (POI seed) MUST be
// able to consume regardless of source — stub and real-mode return
// the SAME suggestionJson shape.

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Hoisted Prisma mock — the cap helper does
// `prisma.tenantSetting.findUnique(...)` to read per-tenant cap rows.
// Same Module._cache install pattern as the adsGptClient + llmRouter
// tests (vitest's ESM-level vi.mock can't intercept CJS require()).
const prismaMock = vi.hoisted(() => {
  const mock = {
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue(null), // default → DEFAULTS fallback
    },
    // S45: realModeEnabled now delegates to lib/llmRouter.getLlmKey
    // which checks SupplierCredential first then process.env. Default
    // null → DB miss → ENV fallback.
    supplierCredential: {
      findFirst: vi.fn().mockResolvedValue(null),
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

// Capture + restore the GEMINI_API_KEY env so the real-mode tests can
// flip the flag deterministically without poisoning sibling tests.
let originalGeminiKey;

beforeEach(() => {
  originalGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  if (originalGeminiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalGeminiKey;
  }
  vi.restoreAllMocks();
  prismaMock.tenantSetting.findUnique.mockReset();
  prismaMock.tenantSetting.findUnique.mockResolvedValue(null);
  prismaMock.supplierCredential.findFirst.mockReset();
  prismaMock.supplierCredential.findFirst.mockResolvedValue(null);
});

function loadClient() {
  // Reload fresh between tests so the spend-stub mock + module state are
  // pristine. Same pattern as adsGptClient.test.js / llmRouter.test.js.
  // S45: also reload llmRouter so its module-level cache + ENV_FOR_MODEL
  // capture is rebuilt — `realModeEnabled` now require()s llmRouter lazily
  // so a stale router would read stale env on the first invocation.
  delete requireCjs.cache[requireCjs.resolve('../../services/itinerarySuggestLLM.js')];
  delete requireCjs.cache[requireCjs.resolve('../../lib/llmRouter.js')];
  return requireCjs('../../services/itinerarySuggestLLM.js');
}

// ── 1. Module shape ──────────────────────────────────────────────────

describe('itinerarySuggestLLM — module shape', () => {
  test('exports the contract surface', () => {
    const c = loadClient();
    expect(typeof c.suggestItinerary).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(typeof c.realModeEnabled).toBe('function');
    expect(typeof c.callGemini).toBe('function');
    expect(typeof c.buildStubSuggestion).toBe('function');
    expect(c.INTEGRATION).toBe('llm');
    expect(c.TASK_NAME).toBe('itinerary-suggest');
    expect(c.MODEL_PRIMARY).toBe('gemini-2.5-flash');
    expect(c.GEMINI_KEY_ENV).toBe('GEMINI_API_KEY');
  });
});

// ── 2. Stub-mode canned shape ────────────────────────────────────────

describe('suggestItinerary — STUB mode (default; no Gemini key)', () => {
  test('returns canned suggestion shape with documented keys', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.suggestItinerary(
      {
        tenantId: 42,
        destination: 'Kyoto',
        durationDays: 3,
        themeJson: { culture: true, food: true },
        budgetTier: 'premium',
      },
      { prisma: prismaMock },
    );

    // Top-level envelope (S9 + S11 contract).
    expect(out.source).toBe('stub');
    expect(out.stub).toBe(true);
    expect(out.model).toBe('gemini-2.5-flash');
    expect(out.suggestionJson).toBeDefined();

    // suggestionJson shape — pin the keys S9/S11 will destructure.
    const sj = out.suggestionJson;
    expect(Array.isArray(sj.daySplit)).toBe(true);
    expect(Array.isArray(sj.poiSuggestions)).toBe(true);
    expect(typeof sj.thematicNotes).toBe('string');
    expect(typeof sj.summary).toBe('string');

    // daySplit length matches durationDays.
    expect(sj.daySplit).toHaveLength(3);
    sj.daySplit.forEach((day, idx) => {
      expect(day.dayNumber).toBe(idx + 1);
      expect(typeof day.theme).toBe('string');
      expect(Array.isArray(day.items)).toBe(true);
      day.items.forEach((it) => {
        expect(['activity', 'meal', 'transfer', 'accommodation']).toContain(it.itemType);
        expect(typeof it.description).toBe('string');
        // estimatedCost / latitude / longitude / suggestedSupplierName are
        // null in stub but the keys MUST be present (S9 reads them).
        expect(it).toHaveProperty('estimatedCost');
        expect(it).toHaveProperty('latitude');
        expect(it).toHaveProperty('longitude');
        expect(it).toHaveProperty('suggestedSupplierName');
      });
    });

    // poiSuggestions shape (S11 import target).
    sj.poiSuggestions.forEach((poi) => {
      expect(typeof poi.name).toBe('string');
      expect(poi).toHaveProperty('latitude');
      expect(poi).toHaveProperty('longitude');
      expect(poi).toHaveProperty('themeTag');
    });

    // Stub markers visible so operators don't ship synthetic content as real.
    expect(sj.thematicNotes).toMatch(/STUB-ITINERARY-SUGGEST/);

    logSpy.mockRestore();
  });

  test('durationDays=1 produces exactly one day in daySplit', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const out = await c.suggestItinerary({
      tenantId: 5,
      destination: 'Goa',
      durationDays: 1,
      budgetTier: 'standard',
    });
    expect(out.suggestionJson.daySplit).toHaveLength(1);
    expect(out.suggestionJson.daySplit[0].dayNumber).toBe(1);
    logSpy.mockRestore();
  });

  test('deterministic: same inputs → identical output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const args = {
      tenantId: 1,
      destination: 'Bali',
      durationDays: 4,
      themeJson: { wellness: true },
      budgetTier: 'economy',
    };
    const out1 = await c.suggestItinerary(args);
    const out2 = await c.suggestItinerary(args);
    expect(out1).toEqual(out2);
    logSpy.mockRestore();
  });
});

// ── 3. Real-mode swap path ───────────────────────────────────────────

describe('suggestItinerary — REAL mode swap', () => {
  test('GEMINI_API_KEY absent → realModeEnabled false → stub path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.GEMINI_API_KEY;

    const c = loadClient();
    // S45: realModeEnabled is async; call with the same tenantId used
    // by suggestItinerary below so the SupplierCredential lookup probes
    // the same key.
    expect(await c.realModeEnabled(1)).toBe(false);

    // callGemini spy MUST NOT fire when realModeEnabled() resolves false.
    const geminiSpy = vi.spyOn(c, 'callGemini');
    const out = await c.suggestItinerary({
      tenantId: 1,
      destination: 'Paris',
      durationDays: 2,
    });
    expect(out.source).toBe('stub');
    expect(out.stub).toBe(true);
    expect(geminiSpy).not.toHaveBeenCalled();

    geminiSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('GEMINI_API_KEY present + callGemini throws → falls back to stub (fail-soft)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GEMINI_API_KEY = 'test-key-value';

    const c = loadClient();
    expect(await c.realModeEnabled(1)).toBe(true);

    const geminiSpy = vi.spyOn(c, 'callGemini').mockRejectedValue(new Error('synthetic network failure'));

    const out = await c.suggestItinerary({
      tenantId: 1,
      destination: 'Rome',
      durationDays: 5,
    });
    expect(geminiSpy).toHaveBeenCalledTimes(1);
    // Fell through to stub — same shape, just source='stub'.
    expect(out.source).toBe('stub');
    expect(out.stub).toBe(true);
    expect(Array.isArray(out.suggestionJson.daySplit)).toBe(true);

    // The error MUST have been logged (so ops can find it) but not thrown.
    const errMsgs = errSpy.mock.calls.flat().map(String).join(' ');
    expect(errMsgs).toMatch(/real-mode call failed/);

    geminiSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('GEMINI_API_KEY present + callGemini succeeds → returns source=gemini', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.GEMINI_API_KEY = 'test-key-value';

    const c = loadClient();
    const fakeJson = {
      daySplit: [{ dayNumber: 1, theme: 'real', items: [] }],
      poiSuggestions: [],
      thematicNotes: 'real-mode notes',
      summary: 'real-mode summary',
    };
    const geminiSpy = vi.spyOn(c, 'callGemini').mockResolvedValue(fakeJson);

    const out = await c.suggestItinerary({
      tenantId: 1,
      destination: 'Dubai',
      durationDays: 1,
    });
    expect(out.source).toBe('gemini');
    expect(out.stub).toBe(false);
    expect(out.model).toBe('gemini-2.5-flash');
    expect(out.suggestionJson).toBe(fakeJson);
    expect(geminiSpy).toHaveBeenCalledTimes(1);
    expect(geminiSpy.mock.calls[0][0]).toMatchObject({
      destination: 'Dubai',
      durationDays: 1,
    });

    geminiSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('callGemini in stub-mode-as-shipped throws (real-mode wire-in pending Q-IT-2)', async () => {
    const c = loadClient();
    // Even with a fake key set, the shipped callGemini throws — real swap
    // is a follow-up gap (documented in module header). Tests that exercise
    // the real-mode path MUST mock callGemini.
    process.env.GEMINI_API_KEY = 'fake';
    await expect(c.callGemini({ destination: 'X', durationDays: 1 })).rejects.toThrow(/real-mode not yet wired/);
  });
});

// ── 4. Argument validation ───────────────────────────────────────────

describe('suggestItinerary — argument validation', () => {
  test('throws when tenantId is missing (before budget check)', async () => {
    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap');

    await expect(c.suggestItinerary({ destination: 'X', durationDays: 1 })).rejects.toThrow(/tenantId required/);
    expect(capSpy).not.toHaveBeenCalled();

    capSpy.mockRestore();
  });

  test('throws when durationDays is 0 or negative', async () => {
    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap').mockResolvedValue({ withinCap: true });

    await expect(c.suggestItinerary({ tenantId: 1, durationDays: 0 })).rejects.toThrow(/durationDays must be > 0/);
    await expect(c.suggestItinerary({ tenantId: 1, durationDays: -3 })).rejects.toThrow(/durationDays must be > 0/);

    capSpy.mockRestore();
  });
});

// ── 5. Budget cap ────────────────────────────────────────────────────

describe('checkBudgetCap', () => {
  test('throws ITINERARY_SUGGEST_BUDGET_EXCEEDED when stubbed spend exceeds cap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Cap row: 10000 cents ($100, the DEFAULTS LLM cap — explicit for clarity).
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '10000' });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(10001);

    let caught;
    try {
      await c.checkBudgetCap(99);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ITINERARY_SUGGEST_BUDGET_EXCEEDED');
    expect(caught.message).toMatch(/Monthly LLM spend cap reached/);
    expect(caught.spentCents).toBe(10001);
    expect(caught.capCents).toBe(10000);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('returns alertThreshold:true at ≥80% of cap (8500c / 10000c)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '10000' });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(8500);

    const evaluation = await c.checkBudgetCap(7);
    expect(evaluation.spentCents).toBe(8500);
    expect(evaluation.capCents).toBe(10000);
    expect(evaluation.withinCap).toBe(true);
    expect(evaluation.alertThreshold).toBe(true);

    // 80%-threshold warning emitted with tenant + amounts visible.
    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).toMatch(/tenant 7/);
    expect(warnMsgs).toMatch(/85%/);
    expect(warnMsgs).toMatch(/itinerarySuggestLLM/);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('silent pass under 80% (no warn emitted)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '10000' });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(1000);

    const evaluation = await c.checkBudgetCap(11);
    expect(evaluation.withinCap).toBe(true);
    expect(evaluation.alertThreshold).toBe(false);

    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).not.toMatch(/itinerarySuggestLLM/);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('falls back to LLM_MONTHLY_CAP default ($100 = 10000c) when no TenantSetting row exists', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce(null);

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(100);

    const evaluation = await c.checkBudgetCap(23);
    expect(evaluation.capCents).toBe(10000);
    expect(evaluation.spentCents).toBe(100);
    expect(evaluation.withinCap).toBe(true);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ── 6. CJS self-mocking seam regression pins ────────────────────────

describe('CJS self-mocking seam (regression-pin)', () => {
  test('checkBudgetCap calls computeMonthlySpendCents via module.exports indirection', async () => {
    // Per the 2026-05-24 cron-learning + module header note: checkBudgetCap
    // MUST call `module.exports.computeMonthlySpendCents(...)` not the local
    // closure binding. If a future refactor switches back to a direct
    // local-name call, this test reds — protecting the budget-cap tests
    // that depend on vi.spyOn(client, 'computeMonthlySpendCents').
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '10000' });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(123);

    await c.checkBudgetCap(17);

    expect(spendSpy).toHaveBeenCalledTimes(1);
    expect(spendSpy).toHaveBeenCalledWith(17);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('suggestItinerary calls checkBudgetCap via module.exports indirection', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap').mockResolvedValue({ withinCap: true });

    await c.suggestItinerary({ tenantId: 88, destination: 'X', durationDays: 1 });

    expect(capSpy).toHaveBeenCalledTimes(1);
    expect(capSpy).toHaveBeenCalledWith(88);

    capSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('suggestItinerary calls realModeEnabled via module.exports indirection', async () => {
    // The real-mode dispatch path resolves realModeEnabled() via the same
    // exports indirection — so callers can stub the env-probe without
    // touching process.env. S45: realModeEnabled is async — use
    // mockResolvedValue (not mockReturnValue) so the awaited call resolves.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const enabledSpy = vi.spyOn(c, 'realModeEnabled').mockResolvedValue(false);

    await c.suggestItinerary({ tenantId: 1, destination: 'X', durationDays: 1 });

    expect(enabledSpy).toHaveBeenCalled();

    enabledSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ── 7. realModeEnabled env probe ────────────────────────────────────

describe('realModeEnabled', () => {
  test('returns false when GEMINI_API_KEY is unset (no tenantId)', async () => {
    delete process.env.GEMINI_API_KEY;
    const c = loadClient();
    expect(await c.realModeEnabled()).toBe(false);
  });

  test('returns true when GEMINI_API_KEY is set to a truthy value', async () => {
    process.env.GEMINI_API_KEY = 'AIza...fake';
    const c = loadClient();
    expect(await c.realModeEnabled()).toBe(true);
  });

  test('returns false when GEMINI_API_KEY is set to empty string', async () => {
    process.env.GEMINI_API_KEY = '';
    const c = loadClient();
    expect(await c.realModeEnabled()).toBe(false);
  });

  // ── S45: per-tenant SupplierCredential resolution ──
  test('returns true when SupplierCredential row present (no ENV needed)', async () => {
    delete process.env.GEMINI_API_KEY;
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce({
      passwordEncrypted: 'tenant-42-gemini-key',
    });
    const c = loadClient();
    expect(await c.realModeEnabled(42)).toBe(true);
  });

  test('SupplierCredential row takes precedence over ENV', async () => {
    process.env.GEMINI_API_KEY = 'ENV-key-also-set';
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce({
      passwordEncrypted: 'tenant-specific-overrides-env',
    });
    const c = loadClient();
    expect(await c.realModeEnabled(42)).toBe(true);
    expect(prismaMock.supplierCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 42,
          category: 'llm-key',
        }),
      }),
    );
  });

  test('no SupplierCredential row + no ENV + tenantId passed → false', async () => {
    delete process.env.GEMINI_API_KEY;
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce(null);
    const c = loadClient();
    expect(await c.realModeEnabled(42)).toBe(false);
  });

  test('CJS self-mocking seam still works through module.exports.realModeEnabled', async () => {
    // The standing rule: inter-function calls must go through the
    // module.exports surface so vitest spies intercept. Pin it explicitly.
    const c = loadClient();
    const spy = vi.spyOn(c, 'realModeEnabled').mockResolvedValue(true);
    const callSpy = vi.spyOn(c, 'callGemini').mockResolvedValue({
      daySplit: [], poiSuggestions: [], thematicNotes: 'n', summary: 's',
    });
    const out = await c.suggestItinerary({ tenantId: 1, destination: 'X', durationDays: 1 });
    expect(spy).toHaveBeenCalled();
    expect(out.source).toBe('gemini');
    spy.mockRestore();
    callSpy.mockRestore();
  });
});

// ── 8. computeMonthlySpendCents stub ────────────────────────────────

describe('computeMonthlySpendCents (stub)', () => {
  test('returns 0 for any tenantId in stub mode (no LlmCallLog summing yet)', async () => {
    const c = loadClient();
    expect(await c.computeMonthlySpendCents(1)).toBe(0);
    expect(await c.computeMonthlySpendCents(999)).toBe(0);
    expect(await c.computeMonthlySpendCents(undefined)).toBe(0);
  });
});

// ── 9. llmRouter registration ───────────────────────────────────────

describe('llmRouter registration', () => {
  test('TASK_ROUTING contains "itinerary-suggest" routed to gemini-flash', () => {
    // S14 requirement: the task class is wired into the router scaffold
    // so future routes that prefer the unified routeRequest envelope can
    // call llmRouter.routeRequest({ task: 'itinerary-suggest', ... }) and
    // get the stub-text path. Structured-JSON callers use the service
    // module directly.
    const router = requireCjs('../../lib/llmRouter.js');
    expect(router.TASK_ROUTING['itinerary-suggest']).toBeDefined();
    expect(router.TASK_ROUTING['itinerary-suggest'].primary).toBe('gemini-flash');
    expect(router.VALID_TASKS).toContain('itinerary-suggest');
  });

  test('routeRequest(task: itinerary-suggest) returns stub envelope routed to gemini-flash', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const router = requireCjs('../../lib/llmRouter.js');
    const out = await router.routeRequest({ task: 'itinerary-suggest', payload: { destination: 'X' } });
    expect(out.stub).toBe(true);
    expect(out.model).toBe('gemini-flash');
    expect(out.text).toMatch(/\[STUB-ITINERARY-SUGGEST\]/);
    logSpy.mockRestore();
  });
});

// ── 10. buildStubSuggestion shape pin ───────────────────────────────

describe('buildStubSuggestion', () => {
  test('handles themeJson as object (uses first key as themeTag)', () => {
    const c = loadClient();
    const out = c.buildStubSuggestion({
      destination: 'X',
      durationDays: 2,
      themeJson: { adventure: true, family: true },
      budgetTier: 'standard',
    });
    expect(out.poiSuggestions[0].themeTag).toBe('adventure');
  });

  test('handles themeJson as string', () => {
    const c = loadClient();
    const out = c.buildStubSuggestion({
      destination: 'X',
      durationDays: 2,
      themeJson: 'wellness-retreat',
      budgetTier: 'premium',
    });
    expect(out.poiSuggestions[0].themeTag).toBe('wellness-retreat');
  });

  test('falls back to "general" theme when themeJson is null/empty', () => {
    const c = loadClient();
    const out = c.buildStubSuggestion({
      destination: 'X',
      durationDays: 1,
    });
    expect(out.poiSuggestions[0].themeTag).toBe('general');
  });

  test('coerces non-positive durationDays to at least 1', () => {
    const c = loadClient();
    expect(c.buildStubSuggestion({ destination: 'X', durationDays: 0 }).daySplit).toHaveLength(1);
    expect(c.buildStubSuggestion({ destination: 'X', durationDays: -5 }).daySplit).toHaveLength(1);
  });
});
