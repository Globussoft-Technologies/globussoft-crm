// Unit tests for backend/services/marketingFlyerCopyLLM.js
//
// What this module does:
//   Stub-mode wrapper for the `marketing-flyer-copy` LLM task class
//   (PRD_TRAVEL_MARKETING_FLYER FR-3.6.1 + AC-6.8). Real Gemini 2.5
//   Flash call lands when Q-AI-3 (overlapping Q11) key drops. Exports:
//     - INTEGRATION                 — short token 'llm' (shares LLM monthly cap)
//     - TASK_NAME                   — 'marketing-flyer-copy' (matches llmRouter TASK_ROUTING)
//     - MODEL_PRIMARY               — 'gemini-2.5-flash' per FR-3.6.1
//     - GEMINI_KEY_ENV              — 'GEMINI_API_KEY' env-var name
//     - generateFlyerCopy({...}, {prisma}) — primary surface
//     - checkBudgetCap(tenantId)    — pre-call cap check
//     - computeMonthlySpendCents(t) — stub returns 0 (real sums LlmCallLog)
//     - realModeEnabled(tenantId)   — async key probe (SupplierCredential → ENV)
//     - callGemini({...})           — real-mode swap point (throws today)
//     - buildStubCopy({...})        — deterministic stub shape
//
// Surface area covered (mirrors S14 itinerary-suggest test coverage):
//   1. Module shape pin (exports + constants)
//   2. Stub mode returns canned headline + body + CTA shape
//   3. Real-mode flagged + key absent → falls back to stub
//   4. Real-mode flagged + key PRESENT + callGemini errors → falls back to stub
//   5. Real-mode flagged + key PRESENT + callGemini succeeds → returns 'gemini' source
//   6. generateFlyerCopy throws when tenantId missing (before budget check)
//   7. generateFlyerCopy throws when destination missing/blank
//   8. Budget cap throws MARKETING_FLYER_COPY_BUDGET_EXCEEDED when spend ≥ cap
//   9. Budget cap returns alertThreshold:true at 80%+
//  10. Budget cap silently passes under 80% (no warn emitted)
//  11. CJS self-mocking seam — checkBudgetCap calls computeMonthlySpendCents
//      via module.exports indirection
//  12. CJS self-mocking seam — generateFlyerCopy calls checkBudgetCap via
//      module.exports indirection
//  13. Deterministic stub: same inputs → identical output
//  14. realModeEnabled() async ENV-only path
//  15. realModeEnabled() async SupplierCredential per-tenant path
//  16. llmRouter.TASK_ROUTING registers 'marketing-flyer-copy' to gemini-flash
//
// Pin the contract that S17 (PDF/PNG render) + S20 (canvas editor) MUST
// be able to consume regardless of source — stub and real-mode return
// the SAME copyJson shape with { headline, body, cta, _source }.

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
    // S45: realModeEnabled delegates to lib/llmRouter.getLlmKey which
    // checks SupplierCredential first then process.env. Default null →
    // DB miss → ENV fallback.
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
  // Also reload llmRouter so its ENV_FOR_MODEL capture
  // is rebuilt — `realModeEnabled` require()s llmRouter lazily so a stale
  // router would read stale env on the first invocation.
  delete requireCjs.cache[requireCjs.resolve('../../services/marketingFlyerCopyLLM.js')];
  delete requireCjs.cache[requireCjs.resolve('../../lib/llmRouter.js')];
  return requireCjs('../../services/marketingFlyerCopyLLM.js');
}

// ── 1. Module shape ──────────────────────────────────────────────────

describe('marketingFlyerCopyLLM — module shape', () => {
  test('exports the contract surface', () => {
    const c = loadClient();
    expect(typeof c.generateFlyerCopy).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(typeof c.realModeEnabled).toBe('function');
    expect(typeof c.callGemini).toBe('function');
    expect(typeof c.buildStubCopy).toBe('function');
    expect(c.INTEGRATION).toBe('llm');
    expect(c.TASK_NAME).toBe('marketing-flyer-copy');
    expect(c.MODEL_PRIMARY).toBe('gemini-2.5-flash');
    expect(c.GEMINI_KEY_ENV).toBe('GEMINI_API_KEY');
  });
});

// ── 2. Stub-mode canned shape ────────────────────────────────────────

describe('generateFlyerCopy — STUB mode (default; no Gemini key)', () => {
  test('returns canned { headline, body, cta, _source } shape', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.generateFlyerCopy(
      {
        tenantId: 42,
        destination: 'Greece',
        subBrand: 'tmc',
        themeJson: { school: true, ancient: true },
        targetAudience: 'school principals Class IX-X',
      },
      { prisma: prismaMock },
    );

    // Top-level envelope (S17 + S20 contract).
    expect(out.source).toBe('stub');
    expect(out.stub).toBe(true);
    expect(out.model).toBe('gemini-2.5-flash');
    expect(out.copyJson).toBeDefined();

    // copyJson shape — pin the keys S17/S20 will destructure.
    const cj = out.copyJson;
    expect(typeof cj.headline).toBe('string');
    expect(typeof cj.body).toBe('string');
    expect(typeof cj.cta).toBe('string');
    expect(cj._source).toBe('stub');

    // CTA must be non-empty short call-to-action.
    expect(cj.cta.length).toBeGreaterThan(0);
    expect(cj.cta.length).toBeLessThan(40);

    // Destination is interpolated into the headline (matches FR-3.6.1
    // per-destination canned-stub contract from the slice description).
    expect(cj.headline).toContain('Greece');

    // Stub markers visible so operators don't ship synthetic content as real.
    expect(cj.headline).toMatch(/\[STUB\]/);
    expect(cj.body).toMatch(/\[STUB\]/);

    logSpy.mockRestore();
  });

  test('CTA is "Book now" per slice spec', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const out = await c.generateFlyerCopy({
      tenantId: 5,
      destination: 'Bali',
    });
    expect(out.copyJson.cta).toBe('Book now');
    logSpy.mockRestore();
  });

  test('deterministic: same inputs → identical output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const args = {
      tenantId: 1,
      destination: 'Kyoto',
      subBrand: 'travelstall',
      themeJson: { culture: true },
      targetAudience: 'young families',
    };
    const out1 = await c.generateFlyerCopy(args);
    const out2 = await c.generateFlyerCopy(args);
    expect(out1).toEqual(out2);
    logSpy.mockRestore();
  });

  test('different destinations produce different headlines (per-destination canned shape)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const greeceOut = await c.generateFlyerCopy({ tenantId: 1, destination: 'Greece' });
    const baliOut = await c.generateFlyerCopy({ tenantId: 1, destination: 'Bali' });
    expect(greeceOut.copyJson.headline).not.toBe(baliOut.copyJson.headline);
    expect(greeceOut.copyJson.headline).toContain('Greece');
    expect(baliOut.copyJson.headline).toContain('Bali');
    logSpy.mockRestore();
  });
});

// ── 3. Real-mode swap path ───────────────────────────────────────────

describe('generateFlyerCopy — REAL mode swap', () => {
  test('GEMINI_API_KEY absent → realModeEnabled false → stub path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.GEMINI_API_KEY;

    const c = loadClient();
    expect(await c.realModeEnabled(1)).toBe(false);

    // callGemini spy MUST NOT fire when realModeEnabled() resolves false.
    const geminiSpy = vi.spyOn(c, 'callGemini');
    const out = await c.generateFlyerCopy({
      tenantId: 1,
      destination: 'Paris',
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

    const out = await c.generateFlyerCopy({
      tenantId: 1,
      destination: 'Rome',
    });
    expect(geminiSpy).toHaveBeenCalledTimes(1);
    // Fell through to stub — same shape, just source='stub'.
    expect(out.source).toBe('stub');
    expect(out.stub).toBe(true);
    expect(typeof out.copyJson.headline).toBe('string');
    expect(out.copyJson._source).toBe('stub');

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
      headline: 'Real Gemini headline',
      body: 'Real Gemini body',
      cta: 'Real CTA',
    };
    const geminiSpy = vi.spyOn(c, 'callGemini').mockResolvedValue(fakeJson);

    const out = await c.generateFlyerCopy({
      tenantId: 1,
      destination: 'Dubai',
    });
    expect(out.source).toBe('gemini');
    expect(out.stub).toBe(false);
    expect(out.model).toBe('gemini-2.5-flash');
    // copyJson contains the gemini result + the `_source: 'gemini'` marker.
    expect(out.copyJson.headline).toBe('Real Gemini headline');
    expect(out.copyJson.body).toBe('Real Gemini body');
    expect(out.copyJson.cta).toBe('Real CTA');
    expect(out.copyJson._source).toBe('gemini');
    expect(geminiSpy).toHaveBeenCalledTimes(1);
    expect(geminiSpy.mock.calls[0][0]).toMatchObject({
      destination: 'Dubai',
    });

    geminiSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('callGemini throws when GEMINI_API_KEY is absent (real-mode wired but no key)', async () => {
    const c = loadClient();
    // S71 real-mode wire-in landed — callGemini now invokes the SDK when
    // the key is present. Tests that exercise the real-mode SUCCESS path
    // continue to mock callGemini directly (see test #5 above) to avoid
    // hitting the network. Here we only assert the no-key guard.
    delete process.env.GEMINI_API_KEY;
    await expect(c.callGemini({ destination: 'X' })).rejects.toThrow(/GEMINI_API_KEY not set/);
  });
});

// ── 4. Argument validation ───────────────────────────────────────────

describe('generateFlyerCopy — argument validation', () => {
  test('throws when tenantId is missing (before budget check)', async () => {
    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap');

    await expect(c.generateFlyerCopy({ destination: 'X' })).rejects.toThrow(/tenantId required/);
    expect(capSpy).not.toHaveBeenCalled();

    capSpy.mockRestore();
  });

  test('throws when destination is missing or blank (before budget check)', async () => {
    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap');

    await expect(c.generateFlyerCopy({ tenantId: 1 })).rejects.toThrow(/destination required/);
    await expect(c.generateFlyerCopy({ tenantId: 1, destination: '' })).rejects.toThrow(/destination required/);
    await expect(c.generateFlyerCopy({ tenantId: 1, destination: '   ' })).rejects.toThrow(/destination required/);
    expect(capSpy).not.toHaveBeenCalled();

    capSpy.mockRestore();
  });
});

// ── 5. Budget cap ────────────────────────────────────────────────────

describe('checkBudgetCap', () => {
  test('throws MARKETING_FLYER_COPY_BUDGET_EXCEEDED when stubbed spend exceeds cap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Cap row: 10000 cents ($100, the DEFAULTS LLM cap).
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
    expect(caught.code).toBe('MARKETING_FLYER_COPY_BUDGET_EXCEEDED');
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
    expect(warnMsgs).toMatch(/marketingFlyerCopyLLM/);

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
    expect(warnMsgs).not.toMatch(/marketingFlyerCopyLLM/);

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

  test('generateFlyerCopy calls checkBudgetCap via module.exports indirection', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap').mockResolvedValue({ withinCap: true });

    await c.generateFlyerCopy({ tenantId: 88, destination: 'X' });

    expect(capSpy).toHaveBeenCalledTimes(1);
    expect(capSpy).toHaveBeenCalledWith(88);

    capSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('generateFlyerCopy calls realModeEnabled via module.exports indirection', async () => {
    // The real-mode dispatch path resolves realModeEnabled() via the same
    // exports indirection — so callers can stub the env-probe without
    // touching process.env. realModeEnabled is async — use
    // mockResolvedValue (not mockReturnValue) so the awaited call resolves.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const enabledSpy = vi.spyOn(c, 'realModeEnabled').mockResolvedValue(false);

    await c.generateFlyerCopy({ tenantId: 1, destination: 'X' });

    expect(enabledSpy).toHaveBeenCalled();

    enabledSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ── 7. realModeEnabled env probe + per-tenant SupplierCredential ────

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
  test('TASK_ROUTING contains "marketing-flyer-copy" routed to gemini-flash', () => {
    // S15 requirement: the task class is wired into the router scaffold
    // so future routes that prefer the unified routeRequest envelope can
    // call llmRouter.routeRequest({ task: 'marketing-flyer-copy', ... })
    // and get the stub-text path. Structured-JSON callers use the service
    // module directly.
    const router = requireCjs('../../lib/llmRouter.js');
    expect(router.TASK_ROUTING['marketing-flyer-copy']).toBeDefined();
    expect(router.TASK_ROUTING['marketing-flyer-copy'].primary).toBe('gemini-flash');
    expect(router.TASK_ROUTING['marketing-flyer-copy'].fallback).toBe('groq-llama');
    expect(router.VALID_TASKS).toContain('marketing-flyer-copy');
  });

  test('routeRequest(task: marketing-flyer-copy) returns stub envelope routed to gemini-flash', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const router = requireCjs('../../lib/llmRouter.js');
    const out = await router.routeRequest({ task: 'marketing-flyer-copy', payload: { destination: 'X' } });
    expect(out.stub).toBe(true);
    expect(out.model).toBe('gemini-flash');
    expect(out.text).toMatch(/\[STUB-MARKETING-FLYER-COPY\]/);
    logSpy.mockRestore();
  });
});

// ── 10. buildStubCopy shape pin ─────────────────────────────────────

describe('buildStubCopy', () => {
  test('handles themeJson as object (uses first key as themeTag in body)', () => {
    const c = loadClient();
    const out = c.buildStubCopy({
      destination: 'Goa',
      subBrand: 'travelstall',
      themeJson: { beach: true, adventure: true },
      targetAudience: 'families',
    });
    expect(out.body).toContain('beach');
  });

  test('handles themeJson as string', () => {
    const c = loadClient();
    const out = c.buildStubCopy({
      destination: 'Maldives',
      subBrand: 'travelstall',
      themeJson: 'honeymoon-retreat',
      targetAudience: 'couples',
    });
    expect(out.body).toContain('honeymoon-retreat');
  });

  test('falls back to "general" theme when themeJson is null/empty', () => {
    const c = loadClient();
    const out = c.buildStubCopy({
      destination: 'Mumbai',
    });
    expect(out.body).toContain('general');
  });

  test('falls back to "travellers" audience when targetAudience is missing', () => {
    const c = loadClient();
    const out = c.buildStubCopy({
      destination: 'Mumbai',
    });
    expect(out.body).toContain('travellers');
  });

  test('shape includes { headline, body, cta, _source: "stub" }', () => {
    const c = loadClient();
    const out = c.buildStubCopy({
      destination: 'Tokyo',
    });
    expect(out).toEqual({
      headline: expect.any(String),
      body: expect.any(String),
      cta: expect.any(String),
      _source: 'stub',
    });
  });
});
