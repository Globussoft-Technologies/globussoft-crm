// Unit tests for backend/services/marketingFlyerImageLLM.js
//
// What this module does:
//   Stub-mode wrapper for the `marketing-flyer-image` LLM task class
//   (PRD_TRAVEL_MARKETING_FLYER FR-3.6.3). Real DALL-E 3 (OpenAI) /
//   Stability AI XL call lands when Q-MF-2 key drops. Exports:
//     - INTEGRATION                 — short token 'llm' (shares LLM monthly cap)
//     - TASK_NAME                   — 'marketing-flyer-image' (matches llmRouter TASK_ROUTING)
//     - MODEL_PRIMARY               — 'dall-e-3' per FR-3.6.3 + S16 spec
//     - MODEL_FALLBACK              — 'stability-xl'
//     - OPENAI_KEY_ENV              — 'OPENAI_API_KEY' env-var for DALL-E
//     - STABILITY_KEY_ENV           — 'STABILITY_API_KEY' env-var for Stability XL
//     - ALLOWED_ASPECT_RATIOS       — ['1:1', '9:16', '16:9']
//     - DEFAULT_ASPECT_RATIO        — '1:1'
//     - generateFlyerImage({...}, {prisma}) — primary surface
//     - checkBudgetCap(tenantId)    — pre-call cap check
//     - computeMonthlySpendCents(t) — stub returns 0 (real sums LlmCallLog)
//     - resolveProvider(tenantId)   — picks dalle / stability / null
//     - realModeEnabled(tenantId)   — async key probe (ENV today, SupplierCredential later)
//     - callImageProvider({...})    — real-mode swap point (throws today)
//     - buildStubImageUrl({...})    — deterministic stub URL shape
//     - slugify(s)                  — internal URL-safe slug helper
//
// Surface area covered (mirrors S15 marketing-flyer-copy test coverage):
//   1. Module shape pin (exports + constants)
//   2. Stub mode returns canned imageUrl shape per slice spec
//   3. Real-mode flagged + key absent → falls back to stub
//   4. Real-mode flagged + key PRESENT + callImageProvider errors → falls back to stub
//   5. Real-mode flagged + key PRESENT + callImageProvider succeeds → returns 'dalle' source
//   6. Provider priority: DALL-E (OpenAI) wins when both keys present
//   7. Stability fallback when only STABILITY_API_KEY is set
//   8. generateFlyerImage throws when tenantId missing (before budget check)
//   9. generateFlyerImage throws when destination missing/blank
//  10. Budget cap throws MARKETING_FLYER_IMAGE_BUDGET_EXCEEDED when spend ≥ cap
//  11. Budget cap returns alertThreshold:true at 80%+
//  12. Budget cap silently passes under 80% (no warn emitted)
//  13. CJS self-mocking seam — checkBudgetCap calls computeMonthlySpendCents
//      via module.exports indirection
//  14. CJS self-mocking seam — generateFlyerImage calls checkBudgetCap via
//      module.exports indirection
//  15. CJS self-mocking seam — generateFlyerImage calls realModeEnabled via
//      module.exports indirection
//  16. realModeEnabled() async ENV-only path
//  17. llmRouter.TASK_ROUTING registers 'marketing-flyer-image' to dall-e-3
//  18. Deterministic stub: same inputs → identical output
//  19. Aspect-ratio fallback to default for unrecognised values
//  20. Stub URL slugifies destination + theme
//
// Pin the contract that S17 (PDF/PNG render) + S20 (canvas editor) MUST
// be able to consume regardless of source — stub and real-mode return
// the SAME { imageUrl, source, model, stub } envelope.

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Hoisted Prisma mock — the cap helper does
// `prisma.tenantSetting.findUnique(...)` to read per-tenant cap rows.
// Same Module._cache install pattern as the marketingFlyerCopyLLM /
// adsGptClient / llmRouter / itinerarySuggestLLM tests (vitest's
// ESM-level vi.mock can't intercept CJS require()).
const prismaMock = vi.hoisted(() => {
  const mock = {
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue(null), // default → DEFAULTS fallback
    },
    // Reserved for future S45-style per-tenant resolveProvider lookup.
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

// Capture + restore both provider keys so real-mode tests flip
// deterministically without poisoning siblings.
let originalOpenaiKey;
let originalStabilityKey;

beforeEach(() => {
  originalOpenaiKey = process.env.OPENAI_API_KEY;
  originalStabilityKey = process.env.STABILITY_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.STABILITY_API_KEY;
});

afterEach(() => {
  if (originalOpenaiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenaiKey;
  }
  if (originalStabilityKey === undefined) {
    delete process.env.STABILITY_API_KEY;
  } else {
    process.env.STABILITY_API_KEY = originalStabilityKey;
  }
  vi.restoreAllMocks();
  prismaMock.tenantSetting.findUnique.mockReset();
  prismaMock.tenantSetting.findUnique.mockResolvedValue(null);
  prismaMock.supplierCredential.findFirst.mockReset();
  prismaMock.supplierCredential.findFirst.mockResolvedValue(null);
});

function loadClient() {
  // Reload fresh between tests so the spend-stub mock + module state are
  // pristine. Same pattern as marketingFlyerCopyLLM.test.js.
  delete requireCjs.cache[requireCjs.resolve('../../services/marketingFlyerImageLLM.js')];
  delete requireCjs.cache[requireCjs.resolve('../../lib/llmRouter.js')];
  return requireCjs('../../services/marketingFlyerImageLLM.js');
}

// ── 1. Module shape ──────────────────────────────────────────────────

describe('marketingFlyerImageLLM — module shape', () => {
  test('exports the contract surface', () => {
    const c = loadClient();
    expect(typeof c.generateFlyerImage).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(typeof c.realModeEnabled).toBe('function');
    expect(typeof c.resolveProvider).toBe('function');
    expect(typeof c.callImageProvider).toBe('function');
    expect(typeof c.buildStubImageUrl).toBe('function');
    expect(typeof c.slugify).toBe('function');
    expect(c.INTEGRATION).toBe('llm');
    expect(c.TASK_NAME).toBe('marketing-flyer-image');
    expect(c.MODEL_PRIMARY).toBe('dall-e-3');
    expect(c.MODEL_FALLBACK).toBe('stability-xl');
    expect(c.OPENAI_KEY_ENV).toBe('OPENAI_API_KEY');
    expect(c.STABILITY_KEY_ENV).toBe('STABILITY_API_KEY');
    expect(c.ALLOWED_ASPECT_RATIOS).toEqual(['1:1', '9:16', '16:9']);
    expect(c.DEFAULT_ASPECT_RATIO).toBe('1:1');
  });
});

// ── 2. Stub-mode canned shape ────────────────────────────────────────

describe('generateFlyerImage — STUB mode (default; no provider keys)', () => {
  test('returns canned { imageUrl, source, model, stub } shape', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.generateFlyerImage(
      {
        tenantId: 42,
        destination: 'Greece',
        subBrand: 'tmc',
        themeJson: { school: true, ancient: true },
        aspectRatio: '1:1',
      },
      { prisma: prismaMock },
    );

    // Top-level envelope (S17 + S20 contract).
    expect(out.source).toBe('stub');
    expect(out.stub).toBe(true);
    expect(out.model).toBe('dall-e-3');
    expect(typeof out.imageUrl).toBe('string');

    // imageUrl shape per slice spec verbatim:
    //   [STUB-FLYER-IMAGE] /static/placeholders/flyer/<destSlug>/<themeTag>-<aspectRatio>.jpg
    expect(out.imageUrl).toMatch(/^\[STUB-FLYER-IMAGE\] \/static\/placeholders\/flyer\//);
    expect(out.imageUrl).toContain('/greece/'); // destination slugified
    expect(out.imageUrl).toContain('school');    // first themeJson key
    expect(out.imageUrl).toMatch(/\.jpg$/);

    logSpy.mockRestore();
  });

  test('full canned shape verbatim per slice spec', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const out = await c.generateFlyerImage({
      tenantId: 1,
      destination: 'Bali',
      themeJson: { beach: true },
      aspectRatio: '1:1',
    });
    // Verbatim shape pin — guards the slice's documented canned output.
    expect(out.imageUrl).toBe('[STUB-FLYER-IMAGE] /static/placeholders/flyer/bali/beach-1x1.jpg');
    expect(out.source).toBe('stub');
    expect(out.model).toBe('dall-e-3');
    expect(out.stub).toBe(true);
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
      aspectRatio: '9:16',
    };
    const out1 = await c.generateFlyerImage(args);
    const out2 = await c.generateFlyerImage(args);
    expect(out1).toEqual(out2);
    logSpy.mockRestore();
  });

  test('different destinations produce different stub URLs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const greeceOut = await c.generateFlyerImage({ tenantId: 1, destination: 'Greece' });
    const baliOut = await c.generateFlyerImage({ tenantId: 1, destination: 'Bali' });
    expect(greeceOut.imageUrl).not.toBe(baliOut.imageUrl);
    expect(greeceOut.imageUrl).toContain('/greece/');
    expect(baliOut.imageUrl).toContain('/bali/');
    logSpy.mockRestore();
  });

  test('different aspect ratios produce different stub URLs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const square = await c.generateFlyerImage({
      tenantId: 1,
      destination: 'Goa',
      aspectRatio: '1:1',
    });
    const portrait = await c.generateFlyerImage({
      tenantId: 1,
      destination: 'Goa',
      aspectRatio: '9:16',
    });
    expect(square.imageUrl).not.toBe(portrait.imageUrl);
    expect(square.imageUrl).toContain('1x1.jpg');
    expect(portrait.imageUrl).toContain('9x16.jpg');
    logSpy.mockRestore();
  });
});

// ── 3. Real-mode swap path ───────────────────────────────────────────

describe('generateFlyerImage — REAL mode swap', () => {
  test('both provider keys absent → realModeEnabled false → stub path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.OPENAI_API_KEY;
    delete process.env.STABILITY_API_KEY;

    const c = loadClient();
    expect(await c.realModeEnabled(1)).toBe(false);

    // callImageProvider spy MUST NOT fire when realModeEnabled() false.
    const providerSpy = vi.spyOn(c, 'callImageProvider');
    const out = await c.generateFlyerImage({
      tenantId: 1,
      destination: 'Paris',
    });
    expect(out.source).toBe('stub');
    expect(out.stub).toBe(true);
    expect(providerSpy).not.toHaveBeenCalled();

    providerSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('OPENAI_API_KEY present + callImageProvider throws → falls back to stub (fail-soft)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OPENAI_API_KEY = 'sk-test-value';

    const c = loadClient();
    expect(await c.realModeEnabled(1)).toBe(true);

    const providerSpy = vi.spyOn(c, 'callImageProvider').mockRejectedValue(new Error('synthetic dalle 500'));

    const out = await c.generateFlyerImage({
      tenantId: 1,
      destination: 'Rome',
    });
    expect(providerSpy).toHaveBeenCalledTimes(1);
    // Fell through to stub — same shape, just source='stub'.
    expect(out.source).toBe('stub');
    expect(out.stub).toBe(true);
    expect(typeof out.imageUrl).toBe('string');
    expect(out.imageUrl).toMatch(/\[STUB-FLYER-IMAGE\]/);

    // The error MUST have been logged (so ops can find it) but not thrown.
    const errMsgs = errSpy.mock.calls.flat().map(String).join(' ');
    expect(errMsgs).toMatch(/real-mode call failed/);

    providerSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('OPENAI_API_KEY present + callImageProvider succeeds → returns source=dalle', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.OPENAI_API_KEY = 'sk-test-value';

    const c = loadClient();
    const providerSpy = vi.spyOn(c, 'callImageProvider').mockResolvedValue({
      imageUrl: 'https://cdn.openai.com/dalle/real-image.jpg',
      provider: 'dalle',
      model: 'dall-e-3',
    });

    const out = await c.generateFlyerImage({
      tenantId: 1,
      destination: 'Dubai',
      aspectRatio: '1:1',
    });
    expect(out.source).toBe('dalle');
    expect(out.stub).toBe(false);
    expect(out.model).toBe('dall-e-3');
    expect(out.imageUrl).toBe('https://cdn.openai.com/dalle/real-image.jpg');
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy.mock.calls[0][0]).toMatchObject({
      destination: 'Dubai',
      provider: 'dalle',
      model: 'dall-e-3',
    });

    providerSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('STABILITY_API_KEY present (no OPENAI) + callImageProvider succeeds → returns source=stability', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.OPENAI_API_KEY;
    process.env.STABILITY_API_KEY = 'sk-stability-test';

    const c = loadClient();
    const providerSpy = vi.spyOn(c, 'callImageProvider').mockResolvedValue({
      imageUrl: 'https://cdn.stability.ai/stable-diffusion/real-image.png',
      provider: 'stability',
      model: 'stability-xl',
    });

    const out = await c.generateFlyerImage({
      tenantId: 1,
      destination: 'Mecca',
    });
    expect(out.source).toBe('stability');
    expect(out.stub).toBe(false);
    expect(out.model).toBe('stability-xl');
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy.mock.calls[0][0]).toMatchObject({
      provider: 'stability',
      model: 'stability-xl',
    });

    providerSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('callImageProvider in stub-mode-as-shipped throws (real-mode wire-in pending Q-MF-2)', async () => {
    const c = loadClient();
    process.env.OPENAI_API_KEY = 'sk-fake';
    await expect(
      c.callImageProvider({
        destination: 'X',
        provider: 'dalle',
        model: 'dall-e-3',
      }),
    ).rejects.toThrow(/real-mode not yet wired/);
  });
});

// ── 4. Provider priority ─────────────────────────────────────────────

describe('resolveProvider', () => {
  test('returns null when both provider keys are absent', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.STABILITY_API_KEY;
    const c = loadClient();
    expect(await c.resolveProvider(1)).toBeNull();
  });

  test('returns dalle when only OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    delete process.env.STABILITY_API_KEY;
    const c = loadClient();
    const resolved = await c.resolveProvider(1);
    expect(resolved).toEqual({
      provider: 'dalle',
      model: 'dall-e-3',
      keySource: 'env',
    });
  });

  test('returns stability when only STABILITY_API_KEY is set', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.STABILITY_API_KEY = 'sk-stability';
    const c = loadClient();
    const resolved = await c.resolveProvider(1);
    expect(resolved).toEqual({
      provider: 'stability',
      model: 'stability-xl',
      keySource: 'env',
    });
  });

  test('DALL-E wins when both keys present (PRD §9.1 primary preference)', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.STABILITY_API_KEY = 'sk-stability';
    const c = loadClient();
    const resolved = await c.resolveProvider(1);
    expect(resolved.provider).toBe('dalle');
    expect(resolved.model).toBe('dall-e-3');
  });

  test('returns null when OPENAI_API_KEY is empty string', async () => {
    process.env.OPENAI_API_KEY = '';
    delete process.env.STABILITY_API_KEY;
    const c = loadClient();
    expect(await c.resolveProvider(1)).toBeNull();
  });
});

// ── 5. Argument validation ───────────────────────────────────────────

describe('generateFlyerImage — argument validation', () => {
  test('throws when tenantId is missing (before budget check)', async () => {
    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap');

    await expect(c.generateFlyerImage({ destination: 'X' })).rejects.toThrow(/tenantId required/);
    expect(capSpy).not.toHaveBeenCalled();

    capSpy.mockRestore();
  });

  test('throws when destination is missing or blank (before budget check)', async () => {
    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap');

    await expect(c.generateFlyerImage({ tenantId: 1 })).rejects.toThrow(/destination required/);
    await expect(c.generateFlyerImage({ tenantId: 1, destination: '' })).rejects.toThrow(/destination required/);
    await expect(c.generateFlyerImage({ tenantId: 1, destination: '   ' })).rejects.toThrow(/destination required/);
    expect(capSpy).not.toHaveBeenCalled();

    capSpy.mockRestore();
  });
});

// ── 6. Budget cap ────────────────────────────────────────────────────

describe('checkBudgetCap', () => {
  test('throws MARKETING_FLYER_IMAGE_BUDGET_EXCEEDED when stubbed spend exceeds cap', async () => {
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
    expect(caught.code).toBe('MARKETING_FLYER_IMAGE_BUDGET_EXCEEDED');
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

    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).toMatch(/tenant 7/);
    expect(warnMsgs).toMatch(/85%/);
    expect(warnMsgs).toMatch(/marketingFlyerImageLLM/);

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
    expect(warnMsgs).not.toMatch(/marketingFlyerImageLLM/);

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

// ── 7. CJS self-mocking seam regression pins ────────────────────────

describe('CJS self-mocking seam (regression-pin)', () => {
  test('checkBudgetCap calls computeMonthlySpendCents via module.exports indirection', async () => {
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

  test('generateFlyerImage calls checkBudgetCap via module.exports indirection', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const capSpy = vi.spyOn(c, 'checkBudgetCap').mockResolvedValue({ withinCap: true });

    await c.generateFlyerImage({ tenantId: 88, destination: 'X' });

    expect(capSpy).toHaveBeenCalledTimes(1);
    expect(capSpy).toHaveBeenCalledWith(88);

    capSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('generateFlyerImage calls realModeEnabled via module.exports indirection', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    const enabledSpy = vi.spyOn(c, 'realModeEnabled').mockResolvedValue(false);

    await c.generateFlyerImage({ tenantId: 1, destination: 'X' });

    expect(enabledSpy).toHaveBeenCalled();

    enabledSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('generateFlyerImage calls resolveProvider via module.exports indirection when real-mode enabled', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = loadClient();
    // Force real-mode true so resolveProvider gets called.
    const enabledSpy = vi.spyOn(c, 'realModeEnabled').mockResolvedValue(true);
    const providerSpy = vi.spyOn(c, 'resolveProvider').mockResolvedValue({
      provider: 'dalle',
      model: 'dall-e-3',
      keySource: 'env',
    });
    const callSpy = vi.spyOn(c, 'callImageProvider').mockResolvedValue({
      imageUrl: 'https://x/y.jpg',
      provider: 'dalle',
      model: 'dall-e-3',
    });

    await c.generateFlyerImage({ tenantId: 1, destination: 'X' });

    expect(providerSpy).toHaveBeenCalled();
    expect(callSpy).toHaveBeenCalled();

    enabledSpy.mockRestore();
    providerSpy.mockRestore();
    callSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ── 8. realModeEnabled env probe ─────────────────────────────────────

describe('realModeEnabled', () => {
  test('returns false when both keys are unset', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.STABILITY_API_KEY;
    const c = loadClient();
    expect(await c.realModeEnabled()).toBe(false);
  });

  test('returns true when OPENAI_API_KEY is set to a truthy value', async () => {
    process.env.OPENAI_API_KEY = 'sk-...fake';
    delete process.env.STABILITY_API_KEY;
    const c = loadClient();
    expect(await c.realModeEnabled()).toBe(true);
  });

  test('returns true when STABILITY_API_KEY is set (no OPENAI)', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.STABILITY_API_KEY = 'sk-stability';
    const c = loadClient();
    expect(await c.realModeEnabled()).toBe(true);
  });

  test('returns false when OPENAI_API_KEY is set to empty string', async () => {
    process.env.OPENAI_API_KEY = '';
    delete process.env.STABILITY_API_KEY;
    const c = loadClient();
    expect(await c.realModeEnabled()).toBe(false);
  });
});

// ── 9. computeMonthlySpendCents stub ────────────────────────────────

describe('computeMonthlySpendCents (stub)', () => {
  test('returns 0 for any tenantId in stub mode', async () => {
    const c = loadClient();
    expect(await c.computeMonthlySpendCents(1)).toBe(0);
    expect(await c.computeMonthlySpendCents(999)).toBe(0);
    expect(await c.computeMonthlySpendCents(undefined)).toBe(0);
  });
});

// ── 10. llmRouter registration ──────────────────────────────────────

describe('llmRouter registration', () => {
  test('TASK_ROUTING contains "marketing-flyer-image" routed to dall-e-3 / stability-xl', () => {
    // S16 requirement: the task class is wired into the router scaffold
    // so future routes that prefer the unified routeRequest envelope can
    // call llmRouter.routeRequest({ task: 'marketing-flyer-image', ... })
    // and get the stub-text path. Structured-image callers use the
    // service module directly.
    const router = requireCjs('../../lib/llmRouter.js');
    expect(router.TASK_ROUTING['marketing-flyer-image']).toBeDefined();
    expect(router.TASK_ROUTING['marketing-flyer-image'].primary).toBe('dall-e-3');
    expect(router.TASK_ROUTING['marketing-flyer-image'].fallback).toBe('stability-xl');
    expect(router.VALID_TASKS).toContain('marketing-flyer-image');
  });

  test('routeRequest(task: marketing-flyer-image) returns stub envelope routed to dall-e-3', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete requireCjs.cache[requireCjs.resolve('../../lib/llmRouter.js')];
    const router = requireCjs('../../lib/llmRouter.js');
    const out = await router.routeRequest({ task: 'marketing-flyer-image', payload: { destination: 'X' } });
    expect(out.stub).toBe(true);
    expect(out.model).toBe('dall-e-3');
    expect(out.text).toMatch(/\[STUB-MARKETING-FLYER-IMAGE\]/);
    logSpy.mockRestore();
  });

  test('ENV_FOR_MODEL maps dall-e-3 → OPENAI_API_KEY and stability-xl → STABILITY_API_KEY', () => {
    const router = requireCjs('../../lib/llmRouter.js');
    expect(router.ENV_FOR_MODEL['dall-e-3']).toBe('OPENAI_API_KEY');
    expect(router.ENV_FOR_MODEL['stability-xl']).toBe('STABILITY_API_KEY');
  });
});

// ── 11. buildStubImageUrl shape pin ─────────────────────────────────

describe('buildStubImageUrl', () => {
  test('handles themeJson as object (uses first key as themeTag)', () => {
    const c = loadClient();
    const out = c.buildStubImageUrl({
      destination: 'Goa',
      themeJson: { beach: true, adventure: true },
      aspectRatio: '1:1',
    });
    expect(out).toContain('beach');
    expect(out).toContain('/goa/');
  });

  test('handles themeJson as string', () => {
    const c = loadClient();
    const out = c.buildStubImageUrl({
      destination: 'Maldives',
      themeJson: 'honeymoon-retreat',
      aspectRatio: '16:9',
    });
    expect(out).toContain('honeymoon-retreat');
    expect(out).toContain('16x9');
  });

  test('falls back to "general" theme when themeJson is null/empty', () => {
    const c = loadClient();
    const out = c.buildStubImageUrl({
      destination: 'Mumbai',
    });
    expect(out).toContain('general');
  });

  test('falls back to default aspect ratio (1:1) when aspectRatio is unrecognised', () => {
    const c = loadClient();
    const out = c.buildStubImageUrl({
      destination: 'Mumbai',
      aspectRatio: 'banana',
    });
    expect(out).toContain('1x1');
  });

  test('falls back to default aspect ratio when aspectRatio missing', () => {
    const c = loadClient();
    const out = c.buildStubImageUrl({
      destination: 'Mumbai',
    });
    expect(out).toContain('1x1');
  });

  test('slugifies destination with spaces + special chars', () => {
    const c = loadClient();
    const out = c.buildStubImageUrl({
      destination: 'New York City!',
      themeJson: { food: true },
      aspectRatio: '1:1',
    });
    expect(out).toContain('/new-york-city/');
  });

  test('shape matches slice spec verbatim', () => {
    const c = loadClient();
    const out = c.buildStubImageUrl({
      destination: 'Tokyo',
      themeJson: { culture: true },
      aspectRatio: '9:16',
    });
    expect(out).toBe('[STUB-FLYER-IMAGE] /static/placeholders/flyer/tokyo/culture-9x16.jpg');
  });
});

// ── 12. slugify utility ─────────────────────────────────────────────

describe('slugify', () => {
  test('lowercases + replaces non-alphanumeric runs with dashes', () => {
    const c = loadClient();
    expect(c.slugify('Hello World')).toBe('hello-world');
    expect(c.slugify('New York, NY!')).toBe('new-york-ny');
    expect(c.slugify('UPPER CASE')).toBe('upper-case');
  });

  test('trims leading/trailing dashes', () => {
    const c = loadClient();
    expect(c.slugify('   spaces   ')).toBe('spaces');
    expect(c.slugify('!!!exclaim!!!')).toBe('exclaim');
  });

  test('returns "unknown" for null/undefined/non-strings', () => {
    const c = loadClient();
    expect(c.slugify(null)).toBe('unknown');
    expect(c.slugify(undefined)).toBe('unknown');
    expect(c.slugify('')).toBe('unknown');
    expect(c.slugify(123)).toBe('unknown');
  });

  test('caps at 60 chars (URL path safety)', () => {
    const c = loadClient();
    const long = 'a'.repeat(120);
    expect(c.slugify(long).length).toBeLessThanOrEqual(60);
  });
});
