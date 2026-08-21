// Unit tests for backend/services/marketingFlyerImageLLM.js
//
// What this module does:
//   DALL-E 3 / gpt-image-1 flyer-image generator for the `marketing-flyer-image`
//   task class (PRD_TRAVEL_MARKETING_FLYER FR-3.6.3). Provider access now
//   resolves through lib/aiGateway (BYOK or a funded CRM-managed subscription)
//   rather than a bare OPENAI_API_KEY/STABILITY_API_KEY env-var check — same
//   mandatory resolve/gate/log/deduct entry point every AI feature in the CRM
//   shares. Stability AI was never implemented as a real provider (the
//   original code threw "not implemented" for it too) and remains
//   unreachable; only the resolved provider's family (openai-compatible)
//   determines whether real-mode fires. Exports:
//     - INTEGRATION                 — short token 'image-llm' (S73 split —
//                                      separate envelope from the text-LLM
//                                      'llm' cap so a DALL-E 3 HD burst
//                                      doesn't silently exhaust text-LLM budget)
//     - TASK_NAME                   — 'marketing-flyer-image' (matches llmRouter TASK_ROUTING)
//     - MODEL_PRIMARY               — 'dall-e-3' per FR-3.6.3 + S16 spec
//     - MODEL_FALLBACK              — 'stability-xl' (name-only; never wired)
//     - OPENAI_KEY_ENV / STABILITY_KEY_ENV — legacy env-var name constants,
//                                      still exported for llmRouter's ENV_FOR_MODEL map
//     - ALLOWED_ASPECT_RATIOS       — ['1:1', '9:16', '16:9']
//     - DEFAULT_ASPECT_RATIO        — '1:1'
//     - generateFlyerImage({...}, {prisma}) — primary surface
//     - checkBudgetCap(tenantId)    — pre-call cap check
//     - computeMonthlySpendCents(t) — stub returns 0 (real sums LlmCallLog)
//     - resolveProvider(tenantId)   — aiGateway-backed: dalle | null
//     - realModeEnabled(tenantId)   — async access probe (via resolveProvider)
//     - callImageProvider({...})    — routes through aiGateway.runNonTokenAiRequest
//     - callOpenAIImageGeneration({...}) — the raw OpenAI HTTP call (mockable)
//     - buildStubImageUrl({...})    — deterministic stub URL shape
//     - slugify(s)                  — internal URL-safe slug helper
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
// adsGptClient / llmRouter tests (vitest's ESM-level vi.mock can't
// intercept CJS require()).
const prismaMock = vi.hoisted(() => {
  const mock = {
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue(null), // default → DEFAULTS fallback
    },
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

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.STABILITY_API_KEY;
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.STABILITY_API_KEY;
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
    expect(typeof c.callOpenAIImageGeneration).toBe('function');
    expect(typeof c.buildStubImageUrl).toBe('function');
    expect(typeof c.slugify).toBe('function');
    // S73: distinct INTEGRATION token ('image-llm') so the cap envelope
    // is separate from the text-LLM ('llm') cap shared by marketingFlyerCopyLLM.
    expect(c.INTEGRATION).toBe('image-llm');
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

describe('generateFlyerImage — STUB mode (default; no tenant AI access)', () => {
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
  test('no tenant AI access → realModeEnabled false → stub path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const resolveSpy = vi.spyOn(c, 'resolveProvider').mockResolvedValue(null);
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
    resolveSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('tenant has resolvable AI access + callImageProvider throws → falls back to stub (fail-soft)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const c = loadClient();
    const resolveSpy = vi.spyOn(c, 'resolveProvider').mockResolvedValue({ provider: 'dalle', model: 'dall-e-3' });
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
    resolveSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('tenant has resolvable AI access + callImageProvider succeeds → returns source=dalle', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const resolveSpy = vi.spyOn(c, 'resolveProvider').mockResolvedValue({ provider: 'dalle', model: 'dall-e-3' });
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
    resolveSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('callImageProvider throws for non-dalle provider (Stability was never wired)', async () => {
    const c = loadClient();
    await expect(
      c.callImageProvider({
        destination: 'X',
        provider: 'stability',
        model: 'stability-xl',
        tenantId: 1,
      }),
    ).rejects.toThrow(/provider 'stability' not implemented/);
  });
});

// ── 3b. callImageProvider — aiGateway routing ────────────────────────

describe('callImageProvider — routes through aiGateway.runNonTokenAiRequest', () => {
  test('resolved family is openai-compatible → calls callOpenAIImageGeneration with the resolved apiKey, deducts via costUsd', async () => {
    const c = loadClient();

    const aiGateway = requireCjs('../../lib/aiGateway.js');
    const runSpy = vi.spyOn(aiGateway, 'runNonTokenAiRequest').mockImplementation(async ({ runFn }) => {
      const result = await runFn({ family: 'openai-compatible', providerId: 'openai', apiKey: 'sk-resolved-test' });
      return { result: result.result, costUsd: result.costUsd, provider: result.provider, model: result.model };
    });
    const genSpy = vi.spyOn(c, 'callOpenAIImageGeneration').mockResolvedValue({
      imageUrl: 'https://cdn.openai.com/dalle/x.jpg',
      model: 'dall-e-3',
    });

    const out = await c.callImageProvider({
      destination: 'Dubai', subBrand: 'tmc', themeJson: { luxury: true }, aspectRatio: '1:1',
      provider: 'dalle', model: 'dall-e-3', tenantId: 7,
    });

    expect(out.imageUrl).toBe('https://cdn.openai.com/dalle/x.jpg');
    expect(out.provider).toBe('dalle');
    expect(genSpy).toHaveBeenCalledTimes(1);
    expect(genSpy.mock.calls[0][0].apiKey).toBe('sk-resolved-test');
    expect(runSpy.mock.calls[0][0].tenantId).toBe(7);
    expect(runSpy.mock.calls[0][0].task).toBe('marketing-flyer-image');

    runSpy.mockRestore();
    genSpy.mockRestore();
  });

  test('resolved family is NOT openai-compatible (e.g. BYOK is Claude) → friendly error, image gen never attempted', async () => {
    const c = loadClient();
    const aiGateway = requireCjs('../../lib/aiGateway.js');
    const runSpy = vi.spyOn(aiGateway, 'runNonTokenAiRequest').mockImplementation(async ({ runFn }) => {
      return runFn({ family: 'anthropic', providerId: 'claude', apiKey: 'sk-ant-test' });
    });
    const genSpy = vi.spyOn(c, 'callOpenAIImageGeneration');

    await expect(
      c.callImageProvider({ destination: 'X', provider: 'dalle', model: 'dall-e-3', tenantId: 1 }),
    ).rejects.toMatchObject({ friendly: true, code: 'AI_PROVIDER_NO_IMAGE_SUPPORT' });
    expect(genSpy).not.toHaveBeenCalled();

    runSpy.mockRestore();
    genSpy.mockRestore();
  });

  test('friendly access-blocked error from aiGateway (no BYOK, no funded subscription) propagates through callImageProvider', async () => {
    const c = loadClient();
    const aiGateway = requireCjs('../../lib/aiGateway.js');
    const blocked = new Error('Your organization has not configured an AI provider yet.');
    blocked.friendly = true;
    blocked.code = 'AI_NOT_CONFIGURED';
    const runSpy = vi.spyOn(aiGateway, 'runNonTokenAiRequest').mockRejectedValue(blocked);

    await expect(
      c.callImageProvider({ destination: 'X', provider: 'dalle', model: 'dall-e-3', tenantId: 1 }),
    ).rejects.toMatchObject({ friendly: true, code: 'AI_NOT_CONFIGURED' });

    runSpy.mockRestore();
  });
});

// ── 4. resolveProvider — aiGateway-backed ────────────────────────────

describe('resolveProvider', () => {
  test('returns null when tenantId is missing', async () => {
    const c = loadClient();
    expect(await c.resolveProvider(undefined)).toBeNull();
    expect(await c.resolveProvider(null)).toBeNull();
  });

  test('returns null when aiGateway.assertAccessOrThrow throws (no BYOK, no funded subscription)', async () => {
    const c = loadClient();
    const aiGateway = requireCjs('../../lib/aiGateway.js');
    const err = new Error('Your organization has not configured an AI provider yet.');
    err.friendly = true;
    const assertSpy = vi.spyOn(aiGateway, 'assertAccessOrThrow').mockRejectedValue(err);

    expect(await c.resolveProvider(1)).toBeNull();

    assertSpy.mockRestore();
  });

  test('returns { provider: dalle, model: dall-e-3 } when resolved access family is openai-compatible', async () => {
    const c = loadClient();
    const aiGateway = requireCjs('../../lib/aiGateway.js');
    const assertSpy = vi.spyOn(aiGateway, 'assertAccessOrThrow').mockResolvedValue({
      providerId: 'openai', family: 'openai-compatible', apiKey: 'sk-test', model: 'gpt-4o', accessType: 'byok',
    });

    const resolved = await c.resolveProvider(1);
    expect(resolved).toEqual({ provider: 'dalle', model: 'dall-e-3' });

    assertSpy.mockRestore();
  });

  test('returns null when resolved access family is NOT openai-compatible (e.g. Gemini or Claude BYOK)', async () => {
    const c = loadClient();
    const aiGateway = requireCjs('../../lib/aiGateway.js');
    const assertSpy = vi.spyOn(aiGateway, 'assertAccessOrThrow').mockResolvedValue({
      providerId: 'gemini', family: 'gemini', apiKey: 'g-test', model: 'gemini-2.5-flash', accessType: 'byok',
    });

    expect(await c.resolveProvider(1)).toBeNull();

    assertSpy.mockRestore();
  });

  test('passes requestedModelLabel=MODEL_PRIMARY through to assertAccessOrThrow', async () => {
    const c = loadClient();
    const aiGateway = requireCjs('../../lib/aiGateway.js');
    const assertSpy = vi.spyOn(aiGateway, 'assertAccessOrThrow').mockResolvedValue({
      providerId: 'openai', family: 'openai-compatible', apiKey: 'sk-test', accessType: 'crm-managed',
    });

    await c.resolveProvider(9);

    expect(assertSpy).toHaveBeenCalledWith(9, 'dall-e-3');

    assertSpy.mockRestore();
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
    expect(caught.message).toMatch(/Monthly image-LLM spend cap reached/);
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
    // S73 split — warn message names the image-LLM cap explicitly so ops
    // can tell which envelope is approaching exhaustion.
    expect(warnMsgs).toMatch(/image-LLM/);

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

  test('falls back to IMAGE_LLM_MONTHLY_CAP default ($100 = 10000c) when no TenantSetting row exists', async () => {
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

  // ── S73 split: cap-envelope separation regression pins ────────────
  //
  // The whole point of S73 is to keep image-gen budget separate from
  // text-LLM budget. These tests pin that the lookup key sent to the
  // TenantSetting table is the image-LLM one, not the text-LLM one —
  // so an admin override on either cap takes effect only on its own
  // side and an exhausted budget on one side does not block the other.

  test('S73 — checkBudgetCap queries the IMAGE_LLM TenantSetting key, NOT the text-LLM key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce(null);

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(0);

    await c.checkBudgetCap(42);

    expect(prismaMock.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_key: {
          tenantId: 42,
          key: 'budgetCap_image_llm_monthly_usd_cents',
        },
      },
      select: { value: true },
    });
    // Defensive: it must NOT have queried the text-LLM key.
    const allKeys = prismaMock.tenantSetting.findUnique.mock.calls
      .map((args) => args[0]?.where?.tenantId_key?.key);
    expect(allKeys).not.toContain('budgetCap_llm_monthly_usd_cents');

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('S73 — per-tenant IMAGE_LLM cap override takes precedence over the env default', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Tenant 11 has a custom cap of 25000c ($250) for image-LLM —
    // higher than the $100 default to give one ops-power-user tenant
    // more breathing room for image-heavy flyer batches.
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '25000' });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(20000);

    const evaluation = await c.checkBudgetCap(11);
    expect(evaluation.capCents).toBe(25000); // per-tenant override
    expect(evaluation.spentCents).toBe(20000);
    expect(evaluation.withinCap).toBe(true); // 20000c < 25000c

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('S73 — exhausted IMAGE_LLM budget does NOT affect text-LLM budget queries (envelopes are independent)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Image-LLM cap is fully consumed for tenant 99.
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '5000' });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(5000);

    await expect(c.checkBudgetCap(99)).rejects.toMatchObject({
      code: 'MARKETING_FLYER_IMAGE_BUDGET_EXCEEDED',
    });

    // Crucial: the prisma lookup was on the image-LLM key. The text-LLM
    // cap envelope for tenant 99 is independent — a separate lookup on
    // the 'budgetCap_llm_monthly_usd_cents' key would still resolve to
    // its own (untouched) cap. Pin: only the image key was queried.
    expect(prismaMock.tenantSetting.findUnique).toHaveBeenCalledTimes(1);
    const queriedKey = prismaMock.tenantSetting.findUnique.mock.calls[0][0]
      .where.tenantId_key.key;
    expect(queriedKey).toBe('budgetCap_image_llm_monthly_usd_cents');

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('S73 — tenantSettings.getBudgetCap("image-llm") accepts the new integration name', async () => {
    // Pin the lib-level integration registration — getBudgetCap throws on
    // unknown integration names, so this test fails loudly if the KEYS
    // entry is dropped or mis-spelled in a future refactor.
    const { getBudgetCap, KEYS, DEFAULTS } = requireCjs('../../lib/tenantSettings');
    expect(KEYS.IMAGE_LLM_MONTHLY_CAP_USD_CENTS).toBe('budgetCap_image_llm_monthly_usd_cents');
    expect(typeof DEFAULTS[KEYS.IMAGE_LLM_MONTHLY_CAP_USD_CENTS]).toBe('number');
    expect(DEFAULTS[KEYS.IMAGE_LLM_MONTHLY_CAP_USD_CENTS]).toBeGreaterThan(0);

    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce(null);
    const out = await getBudgetCap(1, 'image-llm');
    expect(out).toBe(DEFAULTS[KEYS.IMAGE_LLM_MONTHLY_CAP_USD_CENTS]);
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

// ── 8. realModeEnabled probe ─────────────────────────────────────────

describe('realModeEnabled', () => {
  test('returns false when resolveProvider resolves null (no tenant AI access)', async () => {
    const c = loadClient();
    const resolveSpy = vi.spyOn(c, 'resolveProvider').mockResolvedValue(null);
    expect(await c.realModeEnabled(1)).toBe(false);
    resolveSpy.mockRestore();
  });

  test('returns true when resolveProvider resolves a provider', async () => {
    const c = loadClient();
    const resolveSpy = vi.spyOn(c, 'resolveProvider').mockResolvedValue({ provider: 'dalle', model: 'dall-e-3' });
    expect(await c.realModeEnabled(1)).toBe(true);
    resolveSpy.mockRestore();
  });

  test('returns false with no tenantId (resolveProvider short-circuits to null)', async () => {
    const c = loadClient();
    expect(await c.realModeEnabled(undefined)).toBe(false);
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
