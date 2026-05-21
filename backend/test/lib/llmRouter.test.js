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
// Surface area covered (18 cases):
//   - module shape (3): exports + TASK_ROUTING matches PRD §9.1 + VALID_TASKS
//   - llmEnabled (4):   no-env false, reasoning-with-Anthropic-key true,
//                       call-summary-with-Gemini-key true, unknown-task false
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
//   - estimateTokens (2): empty → 0, Math.ceil(length / 4) heuristic
//
// Pin the contract that the REAL implementation MUST honour when the
// stub gets swapped — downstream consumers (talking-points endpoint,
// personalised recs PDF, form-vs-call mismatch detection) depend on
// the { text, finishReason, usage, model, stub } envelope shape.

import { describe, test, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

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

  test('TASK_ROUTING matches PRD §9.1 exactly (per-task primary + fallback)', () => {
    const r = loadRouter();
    // Pins PRD §9.1 (docs/TRAVEL_CRM_PRD.md lines 700-708).
    expect(r.TASK_ROUTING).toEqual({
      "search":           { primary: "perplexity-sonar",  fallback: null },
      "citation":         { primary: "perplexity-sonar",  fallback: null },
      "reasoning":        { primary: "claude-opus-4-7",   fallback: "gpt-4" },
      "talking-points":   { primary: "claude-opus-4-7",   fallback: "gpt-4" },
      "form-vs-call":     { primary: "claude-opus-4-7",   fallback: "gpt-4" },
      "bulk-text":        { primary: "gemini-flash",      fallback: "claude-haiku" },
      "call-summary":     { primary: "gemini-flash",      fallback: null },
    });
  });

  test('VALID_TASKS contains all routing keys and no extras', () => {
    const r = loadRouter();
    expect(r.VALID_TASKS.sort()).toEqual(
      Object.keys(r.TASK_ROUTING).sort(),
    );
    // Length cross-check — PRD §9.1 has exactly 7 task classes.
    expect(r.VALID_TASKS).toHaveLength(7);
  });
});

describe('llmEnabled', () => {
  test('returns false when no LLM env vars are set', () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const r = loadRouter();
    for (const task of r.VALID_TASKS) {
      expect(r.llmEnabled(task)).toBe(false);
    }
  });

  test('returns true for "reasoning" when ANTHROPIC_API_KEY is set', () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    const r = loadRouter();
    expect(r.llmEnabled('reasoning')).toBe(true);
    // Talking-points + form-vs-call share Claude → also true.
    expect(r.llmEnabled('talking-points')).toBe(true);
    expect(r.llmEnabled('form-vs-call')).toBe(true);
  });

  test('returns true for "call-summary" when GEMINI_API_KEY is set', () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSy-real';
    const r = loadRouter();
    expect(r.llmEnabled('call-summary')).toBe(true);
    // Bulk-text also routed to Gemini → also true.
    expect(r.llmEnabled('bulk-text')).toBe(true);
    // But "reasoning" goes to Claude — Gemini key alone isn't enough.
    expect(r.llmEnabled('reasoning')).toBe(false);
  });

  test('returns false for an unknown task even when every env is set', () => {
    process.env.PERPLEXITY_API_KEY = 'pk-real';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    process.env.OPENAI_API_KEY = 'sk-real';
    process.env.GEMINI_API_KEY = 'AIzaSy-real';
    const r = loadRouter();
    expect(r.llmEnabled('not-a-real-task')).toBe(false);
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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

  test('text always includes the [STUB-<TASK>] tag prefix', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = loadRouter();
    for (const task of r.VALID_TASKS) {
      const out = await r.routeRequest({ task, payload: {}, tenantId: 1 });
      expect(out.text).toMatch(new RegExp(`^\\[STUB-${task.toUpperCase()}\\]`));
    }
    logSpy.mockRestore();
  });

  test('usage.totalTokens === promptTokens + completionTokens', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = loadRouter();
    const payload = { leadId: 42, name: 'demo' };
    const a = await r.routeRequest({ task: 'talking-points', payload, tenantId: 1 });
    const b = await r.routeRequest({ task: 'talking-points', payload, tenantId: 1 });
    expect(a.text).toBe(b.text);
    expect(a.usage).toEqual(b.usage);
    logSpy.mockRestore();
  });

  test('emits the structured cost-attribution log line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
