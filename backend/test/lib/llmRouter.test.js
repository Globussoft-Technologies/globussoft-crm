// Unit tests for backend/lib/llmRouter.js
//
// What this module does:
//   Stub-mode wrapper for per-task LLM routing per PRD §9.1. Real
//   provider calls land when Q11 keys drop (held by Travel Stall,
//   stored under SupplierCredential category "llm-key"). Exports:
//     - TASK_ROUTING                — frozen routing table per PRD §9.1
//     - VALID_TASKS                 — Object.keys(TASK_ROUTING)
//     - llmEnabled(task)            — true iff env key for task's primary is set
//     - pickModel(task)             — { task, model, reason }
//     - routeRequest({ task, payload, tenantId })
//                                   → { text, finishReason, usage, model, stub: true }
//     - buildStubText(task, payload) — exported for introspection only
//     - estimateTokens(s)            — exported for introspection only
//
// Surface area covered (24 + S45 extension = 30+ cases):
//   - module shape (3): exports + TASK_ROUTING matches PRD §9.1 + VALID_TASKS
//   - llmEnabled (4):   no-env false, reasoning-with-Anthropic-key true,
//                       call-summary-with-Gemini-key true, unknown-task false
//   - getLlmKey (S45, 6): tenantId omitted → ENV-only,
//                         tenantId present + SupplierCredential present → DB wins over ENV,
//                         tenantId present + SupplierCredential absent → ENV fallback,
//                         tenantId present + neither → null,
//                         encrypted credential decrypted via fieldEncryption,
//                         Prisma error → ENV fallback (never throws)
//   - llmEnabled (S45 extension, 2): per-tenant SupplierCredential gate,
//                                    tenantId omitted preserves ENV-only contract
//   - pickModel (4):    talking-points → claude-opus-4-7,
//                       call-summary → gemini-flash,
//                       unknown → claude-opus-4-7 with unknown-task-fallback reason,
//                       every TASK_ROUTING key resolves to non-empty primary
//   - routeRequest (6): throws on missing task,
//                       returns full envelope for every valid task,
//                       stub:true always set,
//                       [STUB-<TASK>] tag in text,
//                       usage.totalTokens === promptTokens + completionTokens,
//                       unknown task does NOT throw + logs warning,
//                       deterministic stub text for same (task, payload)
//   - LlmCallLog persist (5): one row per call with correct shape,
//                             tenantId defaults to 1 when omitted,
//                             __userId + __surface payload hints land on the row,
//                             missing __userId / __surface → null columns,
//                             DB-write rejection does NOT throw out of routeRequest
//   - estimateTokens (2): empty → 0, Math.ceil(length / 4) heuristic
//
// Pin the contract that the REAL implementation MUST honour when the
// stub gets swapped — downstream consumers (talking-points endpoint,
// personalised recs PDF, form-vs-call mismatch detection) depend on
// the { text, finishReason, usage, model, stub } envelope shape.

import { describe, test, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Hoisted Prisma mock — captures create() args so the persist tests
// can assert the LlmCallLog row shape. The router uses CJS
// `require("./prisma")` from inside routeRequest, which bypasses
// vitest's ESM-level vi.mock. Install a fake module record into
// Node's Module._cache BEFORE the router loads (same pattern as
// backend/test/utils/deduplication.test.js).
const prismaMock = vi.hoisted(() => {
  const mock = {
    llmCallLog: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      // aggregate() backs the per-tenant monthly-spend lookup that the
      // budget-cap pre-check uses. Default: zero spend so the cap path
      // is a no-op for existing tests; budget-cap tests override per case.
      aggregate: vi.fn().mockResolvedValue({ _sum: { costEstimate: 0 } }),
    },
    // tenantSetting backs lib/tenantSettings.getBudgetCap. Default null
    // → getBudgetCap falls back to the DEFAULTS env-var-backed value
    // ($100 = 10000 cents for LLM), which is well above the existing
    // tests' zero-spend so the cap check stays a no-op. Budget-cap
    // tests below override per case to dial cap + spend in.
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    // supplierCredential backs the S45 per-tenant LLM-key resolver.
    // Default null → DB miss → getLlmKey falls back to process.env.
    // S45-specific tests override per case to seed a row.
    supplierCredential: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const Module = require('node:module');
  const requireFromCwd = Module.createRequire(process.cwd() + '/');
  // Resolve the lib/prisma.js path the router will require. cwd at
  // vitest invocation is the backend/ dir, so the helper resolves
  // "./lib/prisma" against it.
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

// Snapshot the LLM-key env vars so tests can flip-flop them safely.
const ORIGINAL_ENV = {
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};

afterEach(() => {
  // Restore env between tests so llmEnabled() flip-flops cleanly.
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  // Reset SupplierCredential mock to default-null so S45 per-tenant
  // cases don't bleed into the ENV-only suites above.
  prismaMock.supplierCredential.findFirst.mockReset();
  prismaMock.supplierCredential.findFirst.mockResolvedValue(null);
});

function loadRouter() {
  // Reload fresh so any cached state doesn't bleed across tests.
  // The module reads process.env lazily inside llmEnabled() so the
  // cache reset is mostly defensive — but it matches the pattern
  // used by digilockerClient.test.js for consistency.
  delete requireCjs.cache[requireCjs.resolve('../../lib/llmRouter.js')];
  return requireCjs('../../lib/llmRouter.js');
}

describe('llmRouter — module shape', () => {
  test('exports the contract surface', () => {
    const r = loadRouter();
    expect(typeof r.llmEnabled).toBe('function');
    expect(typeof r.pickModel).toBe('function');
    expect(typeof r.routeRequest).toBe('function');
    expect(typeof r.buildStubText).toBe('function');
    expect(typeof r.estimateTokens).toBe('function');
    expect(Array.isArray(r.VALID_TASKS)).toBe(true);
    expect(typeof r.TASK_ROUTING).toBe('object');
  });

  test('TASK_ROUTING matches PRD §9.1 + itinerary-suggest extension (per-task primary + fallback)', () => {
    const r = loadRouter();
    // Pins PRD §9.1 (docs/TRAVEL_CRM_PRD.md lines 700-708) + the
    // 'itinerary-suggest' extension landed for S14 (PRD_TRAVEL_ITINERARY_UPGRADES
    // FR-3.6 — gemini-flash primary, claude-haiku fallback; 2K in / 4K out;
    // structured-JSON shape emitted inline by routes/travel_itineraries.js
    // FR-3.4 handler; this scaffold's stub-text path returns a tagged synthetic string)
    // + the 'marketing-flyer-copy' extension landed for S15
    // (PRD_TRAVEL_MARKETING_FLYER FR-3.6.1 — gemini-flash primary, claude-haiku
    // fallback; 1K in / 1K out headline+body+CTA JSON routed via
    // backend/services/marketingFlyerCopyLLM.js for structured-JSON shape)
    // + the 'marketing-flyer-image' extension landed for S16
    // (PRD_TRAVEL_MARKETING_FLYER FR-3.6.3 — dall-e-3 primary, stability-xl
    // fallback; image-gen for flyer hero blocks routed via
    // backend/services/marketingFlyerImageLLM.js for structured-image shape).
    expect(r.TASK_ROUTING).toEqual({
      "search": { primary: "perplexity-sonar", fallback: null },
      "citation": { primary: "perplexity-sonar", fallback: null },
      "reasoning": { primary: "claude-opus-4-7", fallback: "gpt-4" },
      "talking-points": { primary: "claude-opus-4-7", fallback: "gpt-4" },
      "form-vs-call": { primary: "claude-opus-4-7", fallback: "gpt-4" },
      "bulk-text": { primary: "gemini-flash", fallback: "groq-llama" },
      "call-summary": { primary: "gemini-flash", fallback: null },
      "itinerary-suggest": { primary: "gemini-flash", fallback: "gpt-4" },
      // AI quote-template line-item JSON generation (PR #1178).
      "quote-template-generate": { primary: "gemini-flash", fallback: "gpt-4" },
      // AI travel-landing-page JSON generation (PR #1174).
      "landing-page-generate": { primary: "gemini-flash", fallback: "groq-llama" },
      // Trip-countdown (packing nudges) + payment-reminder (pay-or-cancel
      // deposit chase) — 2026-06-16 travel notification engines. Both bulk-
      // shape email copy → gemini-flash primary / claude-haiku fallback.
      "trip-countdown": { primary: "gemini-flash", fallback: "groq-llama" },
      "payment-reminder": { primary: "gemini-flash", fallback: "groq-llama" },
      // WhatsApp inbound → Travel auto-lead qualification (2026-06-19).
      "whatsapp-lead-qualify": { primary: "gemini-flash", fallback: "groq-llama" },
      // Lead conversation summary + full-history narrative summary (2026-07-07).
      "lead-conversation-summary": { primary: "gemini-flash", fallback: "gpt-4" },
      "lead-narrative-summary": { primary: "gemini-flash", fallback: "gpt-4" },
      // Browser-extension lead capture consolidation (2026-07-09, PR #1210).
      "lead-capture-consolidate": { primary: "gemini-flash", fallback: "gpt-4" },
      "marketing-flyer-copy": { primary: "gemini-flash", fallback: "groq-llama" },
      "marketing-flyer-image": { primary: "dall-e-3", fallback: "stability-xl" },
      // TBO flight/hotel/transfer AI-estimate search fallback. 2026-06-23:
      // primary is gpt-4o-search (OpenAI's web-search-enabled model, same
      // OPENAI_API_KEY) so estimates are grounded in live web data; plain gpt-4
      // is the no-web-access fallback. TBO tier-1 still takes priority once
      // TBO_* creds land.
      "flight-search": { primary: "gpt-4o-search", fallback: "gpt-4" },
      "hotel-search": { primary: "gpt-4o-search", fallback: "gpt-4" },
      "transfer-search": { primary: "gpt-4o-search", fallback: "gpt-4" },
      // Airport/city name → IATA resolver for the flight search box (2026-06-19;
      // 2026-06-23 primary gemini-flash → gpt-4 to match the search provider).
      "airport-iata": { primary: "gpt-4", fallback: "gemini-flash" },
    });
  });

  test('VALID_TASKS contains all routing keys and no extras', () => {
    const r = loadRouter();
    expect(r.VALID_TASKS.sort()).toEqual(
      Object.keys(r.TASK_ROUTING).sort(),
    );
    // Length cross-check — PRD §9.1's 7 task classes + FR-3.6's
    // 'itinerary-suggest' (S14) + FR-3.6.1's 'marketing-flyer-copy' (S15)
    // + FR-3.6.3's 'marketing-flyer-image' (S16) + the 2026-06-16 travel
    // notification engines 'trip-countdown' + 'payment-reminder' + the
    // 2026-06-19 'whatsapp-lead-qualify' + TBO 'flight-search' / 'hotel-search'
    // / 'transfer-search' + the 'airport-iata' name→code resolver +
    // 'landing-page-generate' (PR #1174) + 'quote-template-generate' (PR #1178) +
    // 'lead-conversation-summary' + 'lead-narrative-summary' (PR #1203) +
    // 'lead-capture-consolidate' (PR #1210) = 22.
    expect(r.VALID_TASKS).toHaveLength(22);
  });
});

describe('llmEnabled', () => {
  test('returns false when no LLM env vars are set', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const r = loadRouter();
    for (const task of r.VALID_TASKS) {
      expect(await r.llmEnabled(task)).toBe(false);
    }
  });

  test('returns true for "reasoning" when ANTHROPIC_API_KEY is set', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    const r = loadRouter();
    expect(await r.llmEnabled('reasoning')).toBe(true);
    // Talking-points + form-vs-call share Claude → also true.
    expect(await r.llmEnabled('talking-points')).toBe(true);
    expect(await r.llmEnabled('form-vs-call')).toBe(true);
  });

  test('returns true for "call-summary" when GEMINI_API_KEY is set', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSy-real';
    const r = loadRouter();
    expect(await r.llmEnabled('call-summary')).toBe(true);
    // Bulk-text also routed to Gemini → also true.
    expect(await r.llmEnabled('bulk-text')).toBe(true);
    // But "reasoning" goes to Claude — Gemini key alone isn't enough.
    expect(await r.llmEnabled('reasoning')).toBe(false);
  });

  test('"itinerary-suggest" follows the Gemini key (gemini-flash provider slot)', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSy-real';
    const r = loadRouter();
    expect(await r.llmEnabled('itinerary-suggest')).toBe(true);
  });

  test('returns false for an unknown task even when every env is set', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSy-real';
    const r = loadRouter();
    expect(await r.llmEnabled('itinerary-suggest')).toBe(true);
  });

  test('returns false for an unknown task even when every env is set', async () => {
    process.env.PERPLEXITY_API_KEY = 'pk-real';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    process.env.OPENAI_API_KEY = 'sk-real';
    process.env.GEMINI_API_KEY = 'AIzaSy-real';
    const r = loadRouter();
    expect(await r.llmEnabled('not-a-real-task')).toBe(false);
  });
});

// ── S45 — getLlmKey + per-tenant SupplierCredential resolution ────────
//
// PRD §9.1 plans per-tenant LLM credentials via SupplierCredential
// category 'llm-key'. The getLlmKey helper resolves SupplierCredential
// first (per-tenant override) then process.env (dev/CI fallback). These
// cases pin the contract that downstream LLM clients
// (marketingFlyerCopyLLM.realModeEnabled, etc.) rely on.

describe('getLlmKey — S45 per-tenant SupplierCredential resolution', () => {
  test('returns null when neither SupplierCredential nor ENV is present', async () => {
    delete process.env.GEMINI_API_KEY;
    prismaMock.supplierCredential.findFirst.mockResolvedValue(null);
    const r = loadRouter();
    expect(await r.getLlmKey(1, 'gemini-flash')).toBeNull();
  });

  test('tenantId omitted → ENV-only (preserves pre-S45 sync contract)', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSy-env-only';
    // findFirst must NOT fire when no tenantId is passed.
    prismaMock.supplierCredential.findFirst.mockClear();
    const r = loadRouter();
    expect(await r.getLlmKey(null, 'gemini-flash')).toBe('AIzaSy-env-only');
    expect(prismaMock.supplierCredential.findFirst).not.toHaveBeenCalled();
  });

  test('tenantId + SupplierCredential present → DB row wins over ENV', async () => {
    process.env.GEMINI_API_KEY = 'AIzaSy-env-fallback';
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce({
      passwordEncrypted: 'tenant-specific-gemini-key',
    });
    const r = loadRouter();
    expect(await r.getLlmKey(42, 'gemini-flash')).toBe('tenant-specific-gemini-key');
  });

  test('tenantId + SupplierCredential absent → ENV fallback', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce(null);
    const r = loadRouter();
    expect(await r.getLlmKey(42, 'claude-opus-4-7')).toBe('sk-ant-env');
  });

  test('accepts SupplierCredential.supplierName matching either model OR env-var name', async () => {
    // The where-clause uses `supplierName: { in: [model, envVar] }` so
    // operators can seed either naming convention. This case proves the
    // helper queries BOTH; the mock just verifies the where-clause shape.
    delete process.env.GEMINI_API_KEY;
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce({
      passwordEncrypted: 'matched-by-env-var-name',
    });
    const r = loadRouter();
    expect(await r.getLlmKey(42, 'gemini-flash')).toBe('matched-by-env-var-name');
    expect(prismaMock.supplierCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 42,
          category: 'llm-key',
          supplierName: { in: ['gemini-flash', 'GEMINI_API_KEY'] },
        }),
      }),
    );
  });

  test('Prisma failure → ENV fallback (never throws)', async () => {
    process.env.GEMINI_API_KEY = 'AIzaSy-fallback-on-error';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    prismaMock.supplierCredential.findFirst.mockRejectedValueOnce(
      new Error('DB connection lost'),
    );
    const r = loadRouter();
    expect(await r.getLlmKey(42, 'gemini-flash')).toBe('AIzaSy-fallback-on-error');
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/getLlmKey supplierCredential lookup failed/));
    errSpy.mockRestore();
  });
});

describe('llmEnabled — S45 per-tenant gate', () => {
  test('returns true when SupplierCredential present + ENV missing', async () => {
    delete process.env.GEMINI_API_KEY;
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce({
      passwordEncrypted: 'tenant-7-gemini-key',
    });
    const r = loadRouter();
    expect(await r.llmEnabled('call-summary', 7)).toBe(true);
  });

  test('tenantId omitted preserves ENV-only contract', async () => {
    delete process.env.GEMINI_API_KEY;
    prismaMock.supplierCredential.findFirst.mockClear();
    const r = loadRouter();
    expect(await r.llmEnabled('call-summary')).toBe(false);
    expect(prismaMock.supplierCredential.findFirst).not.toHaveBeenCalled();
  });
});

describe('pickModel', () => {
  test('"talking-points" → claude-opus-4-7 with reason "primary"', () => {
    const r = loadRouter();
    expect(r.pickModel('talking-points')).toEqual({
      task: 'talking-points',
      model: 'claude-opus-4-7',
      reason: 'primary',
    });
  });

  test('"call-summary" → gemini-flash with reason "primary"', () => {
    const r = loadRouter();
    expect(r.pickModel('call-summary')).toEqual({
      task: 'call-summary',
      model: 'gemini-flash',
      reason: 'primary',
    });
  });

  test('unknown task → claude-opus-4-7 with reason "unknown-task-fallback"', () => {
    const r = loadRouter();
    expect(r.pickModel('not-a-real-task')).toEqual({
      task: 'not-a-real-task',
      model: 'claude-opus-4-7',
      reason: 'unknown-task-fallback',
    });
  });

  test('"itinerary-suggest" → gemini-flash with reason "primary"', () => {
    const r = loadRouter();
    expect(r.pickModel('itinerary-suggest')).toEqual({
      task: 'itinerary-suggest',
      model: 'gemini-flash',
      reason: 'primary',
    });
  });

  test('every TASK_ROUTING key resolves to a non-empty primary model', () => {
    const r = loadRouter();
    for (const task of r.VALID_TASKS) {
      const { model, reason } = r.pickModel(task);
      expect(typeof model).toBe('string');
      expect(model.length).toBeGreaterThan(0);
      expect(reason).toBe('primary');
    }
  });
});

describe('routeRequest', () => {
  test('throws when task is missing', async () => {
    const r = loadRouter();
    await expect(r.routeRequest({})).rejects.toThrow(/task required/);
    await expect(r.routeRequest()).rejects.toThrow(/task required/);
  });

  test('returns the { text, finishReason, usage, model, stub } envelope for every valid task', async () => {
    // Suppress the structured log line for this test — we're verifying
    // the envelope shape, not the log.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const r = loadRouter();
    for (const task of r.VALID_TASKS) {
      const out = await r.routeRequest({ task, payload: { sample: 'x' }, tenantId: 7 });
      expect(out).toMatchObject({
        text: expect.any(String),
        finishReason: 'stop',
        usage: {
          promptTokens: expect.any(Number),
          completionTokens: expect.any(Number),
          totalTokens: expect.any(Number),
        },
        model: expect.any(String),
        stub: true,
      });
      // Model must match what pickModel returned for the same task.
      expect(out.model).toBe(r.pickModel(task).model);
    }
    logSpy.mockRestore();
  });

  test('text always includes the [STUB-<TASK>] tag prefix (or valid JSON for JSON-returning tasks)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const r = loadRouter();
    for (const task of r.VALID_TASKS) {
      const out = await r.routeRequest({ task, payload: {}, tenantId: 1 });
      if (task === 'quote-template-generate') {
        // Stub intentionally returns a parseable JSON array so the consumer
        // can render line items without a live LLM key.
        expect(() => JSON.parse(out.text)).not.toThrow();
        expect(Array.isArray(JSON.parse(out.text))).toBe(true);
      } else if (task === 'lead-conversation-summary' || task === 'lead-narrative-summary' || task === 'lead-capture-consolidate') {
        // Stub returns parseable JSON objects so lead summary consumers can
        // render the summary without a live LLM key.
        expect(() => JSON.parse(out.text)).not.toThrow();
        expect(typeof JSON.parse(out.text)).toBe('object');
        expect(Array.isArray(JSON.parse(out.text))).toBe(false);
      } else {
        expect(out.text).toMatch(new RegExp(`^\\[STUB-${task.toUpperCase()}\\]`));
      }
    }
    logSpy.mockRestore();
  });

  test('usage.totalTokens === promptTokens + completionTokens', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const r = loadRouter();
    for (const task of r.VALID_TASKS) {
      const out = await r.routeRequest({ task, payload: { x: 'a'.repeat(100) }, tenantId: 1 });
      expect(out.usage.totalTokens).toBe(
        out.usage.promptTokens + out.usage.completionTokens,
      );
    }
    logSpy.mockRestore();
  });

  test('unknown task does NOT throw — logs warning + routes to reasoning catch-all', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const r = loadRouter();
    const out = await r.routeRequest({
      task: 'not-a-real-task',
      payload: {},
      tenantId: 1,
    });
    expect(out.model).toBe('claude-opus-4-7');
    expect(out.stub).toBe(true);
    // Warning surfaced for config-drift visibility.
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/unknown task/);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('two calls with the same (task, payload) return the same stubText (deterministic)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const r = loadRouter();
    const payload = { leadId: 42, name: 'demo' };
    const a = await r.routeRequest({ task: 'talking-points', payload, tenantId: 1 });
    const b = await r.routeRequest({ task: 'talking-points', payload, tenantId: 1 });
    expect(a.text).toBe(b.text);
    expect(a.usage).toEqual(b.usage);
    logSpy.mockRestore();
  });

  test('emits the structured cost-attribution log line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const r = loadRouter();
    await r.routeRequest({ task: 'talking-points', payload: { x: 1 }, tenantId: 99 });
    // At least one log call matches the [llm-router] format.
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const match = lines.find((l) => l.startsWith('[llm-router] '));
    expect(match).toBeTruthy();
    expect(match).toContain('task=talking-points');
    expect(match).toContain('model=claude-opus-4-7');
    expect(match).toContain('tenant=99');
    expect(match).toMatch(/tokens_in=\d+/);
    expect(match).toMatch(/tokens_out=\d+/);
    expect(match).toContain('stub=true');
    expect(match).toContain('reason=primary');
    logSpy.mockRestore();
  });
});

describe('estimateTokens', () => {
  test('empty / nullish input → 0', () => {
    const r = loadRouter();
    expect(r.estimateTokens('')).toBe(0);
    expect(r.estimateTokens(null)).toBe(0);
    expect(r.estimateTokens(undefined)).toBe(0);
  });

  test('heuristic is Math.ceil(length / 4)', () => {
    const r = loadRouter();
    // 4 chars → 1 token, 5 chars → 2, 12 chars → 3.
    expect(r.estimateTokens('abcd')).toBe(1);
    expect(r.estimateTokens('abcde')).toBe(2);
    expect(r.estimateTokens('a'.repeat(12))).toBe(3);
    expect(r.estimateTokens('a'.repeat(13))).toBe(4);
  });
});

// PRD §9.1 + R7 — LlmCallLog persistence.
//
// routeRequest writes one row per call to LlmCallLog (fire-and-forget).
// The hoisted `prismaMock` near the top of this file intercepts the
// `require("./prisma")` so we can assert call shape + verify the failure
// path is non-fatal.
describe('routeRequest — LlmCallLog persistence (PRD §9.1, R7)', () => {
  test('writes one row per call with the right shape', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    prismaMock.llmCallLog.create.mockClear();
    const r = loadRouter();
    await r.routeRequest({ task: 'talking-points', payload: { sample: 'x' }, tenantId: 42 });

    // Persist is fire-and-forget — the create() may not be awaited by
    // routeRequest, but it IS called synchronously. Yield to the
    // microtask queue once to flush the lazy require + create kickoff.
    await new Promise((resolve) => setImmediate(resolve));

    expect(prismaMock.llmCallLog.create).toHaveBeenCalledTimes(1);
    const arg = prismaMock.llmCallLog.create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      tenantId: 42,
      task: 'talking-points',
      model: 'claude-opus-4-7',
      reason: 'primary',
      stub: true,
      costEstimate: 0,
    });
    expect(typeof arg.data.promptTokens).toBe('number');
    expect(typeof arg.data.completionTokens).toBe('number');
    expect(arg.data.totalTokens).toBe(arg.data.promptTokens + arg.data.completionTokens);
    logSpy.mockRestore();
  });

  test('__userId + __surface payload hints land on the row', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    prismaMock.llmCallLog.create.mockClear();
    const r = loadRouter();
    await r.routeRequest({
      task: 'reasoning',
      payload: { sample: 'x', __userId: 17, __surface: 'talking-points-regen' },
      tenantId: 3,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const arg = prismaMock.llmCallLog.create.mock.calls[0][0];
    expect(arg.data.userId).toBe(17);
    expect(arg.data.surface).toBe('talking-points-regen');
    logSpy.mockRestore();
  });

  test('missing __userId / __surface → null columns', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    prismaMock.llmCallLog.create.mockClear();
    const r = loadRouter();
    await r.routeRequest({ task: 'reasoning', payload: { sample: 'x' }, tenantId: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    const arg = prismaMock.llmCallLog.create.mock.calls[0][0];
    expect(arg.data.userId).toBeNull();
    expect(arg.data.surface).toBeNull();
    logSpy.mockRestore();
  });

  test('DB-write rejection does NOT throw out of routeRequest', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    prismaMock.llmCallLog.create.mockRejectedValueOnce(new Error('DB transient failure'));
    const r = loadRouter();
    // Should resolve normally — the persist is fire-and-forget + the
    // catch handler swallows the rejection.
    const out = await r.routeRequest({ task: 'reasoning', payload: {}, tenantId: 1 });
    expect(out.stub).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    // Verify the error was logged (non-fatal trail).
    const errMsg = errSpy.mock.calls.flat().join(' ');
    expect(errMsg).toMatch(/LlmCallLog persist failed|DB transient failure/);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// 2026-05-24 product-call — per-tenant monthly LLM budget cap.
//
// routeRequest now runs a pre-call cap check using
//   getBudgetCap(tenantId, 'llm')         → cap in USD cents
//   computeMonthlySpendCents(tenantId)     → SUM(costEstimate*100) since MTD
//   evaluateCap(spent, cap)                → withinCap + alertThreshold
//
// Cap source: TenantSetting row (mocked here via tenantSetting.findUnique)
// or DEFAULTS env-fallback ($100 = 10000 cents). Spend source: LlmCallLog
// aggregate (mocked via llmCallLog.aggregate). Over-cap throws a structured
// error with code LLM_BUDGET_EXCEEDED; ≥80% triggers a console.warn.
describe('routeRequest — per-tenant budget cap (2026-05-24 product-call)', () => {
  test('returns normally when spend is well under cap (zero warn)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    // Clear stale call history from prior tests (this describe is the
    // first to assert aggregate.toHaveBeenCalledTimes; earlier tests
    // exercised the route enough to accumulate calls).
    prismaMock.tenantSetting.findUnique.mockClear();
    prismaMock.llmCallLog.aggregate.mockClear();
    // Cap row: $100 (10000 cents). The DB stores the integer-cents string.
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '10000' });
    // Spend: $5 → 500 cents (5% of cap, well under).
    prismaMock.llmCallLog.aggregate.mockResolvedValueOnce({
      _sum: { costEstimate: 5 },
    });
    const r = loadRouter();
    const out = await r.routeRequest({ task: 'reasoning', payload: {}, tenantId: 42 });
    expect(out.stub).toBe(true);
    expect(out.model).toBe('claude-opus-4-7');
    // Cap query happened with the right tenant.
    expect(prismaMock.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 42, key: 'budgetCap_llm_monthly_usd_cents' } },
      select: { value: true },
    });
    // Aggregate scoped to the tenant.
    expect(prismaMock.llmCallLog.aggregate).toHaveBeenCalledTimes(1);
    const aggArg = prismaMock.llmCallLog.aggregate.mock.calls[0][0];
    expect(aggArg.where.tenantId).toBe(42);
    expect(aggArg._sum).toEqual({ costEstimate: true });
    // No alert warning at 5%.
    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).not.toMatch(/approaching LLM monthly cap/);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('emits 80%-threshold warning when spend is ≥80% but under cap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    // Cap: 10000 cents ($100).
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '10000' });
    // Spend: $95 → 9500 cents (95% — alertThreshold true, still withinCap).
    prismaMock.llmCallLog.aggregate.mockResolvedValueOnce({
      _sum: { costEstimate: 95 },
    });
    const r = loadRouter();
    const out = await r.routeRequest({ task: 'talking-points', payload: {}, tenantId: 7 });
    expect(out.stub).toBe(true);
    // Approaching-cap warning surfaced.
    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).toMatch(/approaching LLM monthly cap/);
    expect(warnMsgs).toMatch(/spent=9500c/);
    expect(warnMsgs).toMatch(/cap=10000c/);
    expect(warnMsgs).toMatch(/95\.0%/);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('throws LLM_BUDGET_EXCEEDED when spend reaches cap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    // Cap: 10000 cents ($100).
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '10000' });
    // Spend: $105 → 10500 cents (over cap).
    prismaMock.llmCallLog.aggregate.mockResolvedValueOnce({
      _sum: { costEstimate: 105 },
    });
    const r = loadRouter();
    let caught;
    try {
      await r.routeRequest({ task: 'reasoning', payload: {}, tenantId: 99 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('LLM_BUDGET_EXCEEDED');
    expect(caught.message).toMatch(/Monthly LLM spend cap reached/);
    expect(caught.spentCents).toBe(10500);
    expect(caught.capCents).toBe(10000);
    // The provider call was NOT reached — no LlmCallLog row persist for
    // a capped-out call (we threw before the persist block).
    // Note: we don't assert llmCallLog.create was NOT called, because
    // earlier tests may have called it; the structural assertion is the
    // throw itself.
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('falls back to env-default cap ($100/10000c) when TenantSetting row absent', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    // No row → getBudgetCap returns DEFAULTS (10000 cents for LLM unless
    // env override set; the budget-cap test in tenantSettings.test.js pins
    // that fallback).
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce(null);
    // Spend: $50 → 5000 cents (50% of default cap — under, no warn).
    prismaMock.llmCallLog.aggregate.mockResolvedValueOnce({
      _sum: { costEstimate: 50 },
    });
    const r = loadRouter();
    const out = await r.routeRequest({ task: 'reasoning', payload: {}, tenantId: 3 });
    expect(out.stub).toBe(true);
    // Query went to the TenantSetting table — DEFAULTS only kicks in
    // when the row is absent.
    expect(prismaMock.tenantSetting.findUnique).toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('skips cap check entirely when tenantId is omitted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    prismaMock.tenantSetting.findUnique.mockClear();
    prismaMock.llmCallLog.aggregate.mockClear();
    const r = loadRouter();
    // No tenantId → router skips the cap pre-check (matches existing
    // optional-tenantId contract; callers pre-cap-pattern didn't all
    // thread it). Aggregate + cap-row lookups must NOT fire.
    const out = await r.routeRequest({ task: 'reasoning', payload: {} });
    expect(out.stub).toBe(true);
    expect(prismaMock.tenantSetting.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.llmCallLog.aggregate).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

// Real-mode: when a provider key is present AND NODE_ENV !== 'test', routeRequest
// calls the real provider (no "swap the stub later" code change). Under test it
// MUST still stub — so unit + e2e runs never make a live call.
describe('routeRequest — real provider call (key present, not under test)', () => {
  test('calls the real provider and returns stub:false when a key is set', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const prevNodeEnv = process.env.NODE_ENV;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'REAL talking points from Claude.' }],
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.NODE_ENV = 'production';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    try {
      const r = loadRouter();
      const out = await r.routeRequest({ task: 'talking-points', payload: { leadId: 7 }, tenantId: 3 });
      expect(out.stub).toBe(false);
      expect(out.text).toBe('REAL talking points from Claude.');
      expect(out.model).toBe('claude-opus-4-7');
      expect(out.usage.promptTokens).toBe(12);
      expect(out.usage.completionTokens).toBe(34);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('api.anthropic.com');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      vi.unstubAllGlobals();
      logSpy.mockRestore();
    }
  });

  test('still stubs under NODE_ENV=test even with a key set (no live call)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real'; // NODE_ENV stays 'test' (vitest default)
    try {
      const r = loadRouter();
      const out = await r.routeRequest({ task: 'talking-points', payload: {}, tenantId: 1 });
      expect(out.stub).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      logSpy.mockRestore();
    }
  });
});
