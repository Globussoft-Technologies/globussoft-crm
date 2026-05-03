/**
 * Unit tests for backend/cron/sentimentEngine.js — scans EmailMessage rows
 * with sentiment=NULL and classifies them as positive/neutral/negative with
 * a numeric score in [-1, 1].
 *
 * Strategy under test:
 *   1. If GEMINI_API_KEY is set at module load → use Gemini (gemini-2.5-flash)
 *      to analyze the body.
 *   2. Otherwise (or on any Gemini error) → fall back to a rule-based
 *      keyword counter so the engine still produces useful labels offline.
 *
 * Why this file exists (regression class — gap card R-5 batch 2):
 *   - The engine has zero unit-level coverage. Branches awkward to exercise
 *     through API specs:
 *       - parseGeminiResponse — multi-line text parsing, score clamping,
 *         NaN guards, sentinel keyword extraction. Pure-fn, fastest tested
 *         at unit level.
 *       - ruleBasedAnalyze — score formula `(pos - neg) / (pos + neg + 1)`,
 *         sentiment label thresholds, word-boundary matching. Pure-fn.
 *       - tickSentimentEngine — happy path persists sentiment+sentimentScore,
 *         dedup is enforced by where:{ sentiment: null } (already-analyzed
 *         rows never enter the loop), per-row error containment so one bad
 *         message doesn't abort the batch, and a top-level try/catch around
 *         the findMany so a DB outage doesn't crash the cron.
 *       - analyzeMessage AI-failure branch — when Gemini throws, the engine
 *         must silently fall through to the rule-based scorer so the cron
 *         keeps producing labels (graceful degrade — the contract here is
 *         "always return a sentiment, never throw upstream").
 *
 * Functions / branches covered:
 *   - ruleBasedAnalyze
 *       positive-only text → sentiment='positive', score>0
 *       negative-only text → sentiment='negative', score<0
 *       balanced/no-keywords → sentiment='neutral', score=0
 *       null/undefined/empty input → neutral, 0 (safe coercion)
 *       multiple matches → counted (pos:3 neg:1 → positive)
 *       case-insensitive matching
 *       word-boundary respected ("good" matches, "goodbye"-style substrings
 *         do not — pinned via the \b regex contract)
 *       score clamped via formula `(pos - neg) / (pos + neg + 1)`, capped
 *         absolute value <1 even at extreme counts
 *       output rounded to 3 decimals
 *
 *   - parseGeminiResponse
 *       happy path: "positive\n0.85" → { sentiment: 'positive', sentimentScore: 0.85 }
 *       sentiment classification by keyword (positive / neutral / negative)
 *       case-insensitive parsing
 *       handles non-alpha noise ("Positive!" → 'positive')
 *       missing score line → score defaults to 0
 *       NaN score → 0
 *       score >1 → clamped to 1
 *       score <-1 → clamped to -1
 *       empty/null input → null (signals upstream to fall back)
 *       unknown sentiment label → null
 *       output rounded to 3 decimals
 *
 *   - analyzeMessage
 *       no Gemini configured (default unit-test env) → uses rule-based scorer
 *       empty/null text → returns neutral/0 without invoking AI
 *       Gemini configured + happy path → uses Gemini reply (covered via
 *         re-import with stubbed env + vi.mock)
 *       Gemini throws → graceful fallback to rule-based (covered via re-import)
 *
 *   - tickSentimentEngine
 *       no pending rows → returns { processed: 0 }, no updates issued
 *       happy path: pending row gets { sentiment, sentimentScore } persisted
 *         exactly once per row
 *       dedup contract: where-clause filters on sentiment:null AND orders
 *         by createdAt desc AND caps at take:50 (ensures already-analyzed
 *         rows never enter the loop, batch is bounded)
 *       per-row error containment: when prisma.emailMessage.update throws
 *         on row 1, row 2 still gets processed; engine returns the partial
 *         processed count (CRITICAL — one bad UPDATE must not stall the
 *         entire 50-row batch).
 *       top-level findMany failure → returns { processed: 0, error } and
 *         does NOT throw (cron resilience — one DB blip shouldn't crash
 *         the engine for the next 15-min window).
 *
 * NOT covered (intentional — out of scope for unit tests):
 *   - initSentimentCron — wires the module to real `node-cron` + a 15s
 *     setTimeout. Not exported for invocation in a way that's safe to call
 *     under vitest (would schedule a real timer + fire a tick that hits
 *     prisma at unpredictable times). The body is a thin shell over
 *     tickSentimentEngine which we cover directly.
 *   - The top-level Gemini SDK init `try { require('@google/generative-ai') }
 *     catch {}` — invoked once at module load. We exercise both the
 *     "no API key" path (default test env) and the "API key set + mocked
 *     SDK" path via vi.resetModules() + dynamic re-import.
 *
 * Mocking strategy:
 *   - prisma: mirror backend/test/cron/wellnessOpsEngine.test.js — import
 *     the singleton, monkey-patch the emailMessage accessor. The cron
 *     module is inlined via vitest.config.js → server.deps.inline so its
 *     require('../lib/prisma') resolves to the same singleton.
 *   - @google/generative-ai: vi.mock'd at the top of the Gemini-path
 *     describe block, then we vi.resetModules() and dynamic-import the
 *     engine fresh so its top-level `require('@google/generative-ai')`
 *     returns the mock and `geminiModel` becomes our controlled stub.
 *
 * Pattern reference: backend/test/cron/wellnessOpsEngine.test.js (commit
 * 8303272) for the prisma singleton monkey-patch + tenant-iteration shape;
 * backend/test/lib/sentry.test.js for the resetModules + re-import dance.
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import prisma from '../../lib/prisma.js';

// CRITICAL: backend/cron/sentimentEngine.js calls dotenv.config({override:true})
// at module top against the repo root .env, which carries a real GEMINI_API_KEY
// in dev/CI. Without intercepting the @google/generative-ai SDK BEFORE the
// engine's require() chain executes, every "Gemini path" test would issue a
// live, billed API call (and the response returned to the test isn't
// deterministic, so assertions on score values would flake or fail).
//
// vi.mock('@google/generative-ai') with an ESM factory does NOT intercept
// CJS require() chains under this vitest setup (same quirk documented in
// MOCK_PATTERNS.md §4 for @sentry/node). Workaround: load the real CJS
// module via createRequire INSIDE a vi.hoisted() block — vi.hoisted runs
// before any ESM import statement is evaluated — and monkey-patch the
// cached `GoogleGenerativeAI` constructor on its exports object. The
// engine's `const { GoogleGenerativeAI } = require("@google/generative-ai")`
// then resolves to our stub class because the require cache is shared and
// the monkey-patch lands BEFORE the engine import executes.
const { mockGenerateContent } = vi.hoisted(() => {
  const { createRequire } = require('node:module');
  const requireCJS = createRequire(__filename || process.cwd() + '/');
  const genAIModule = requireCJS('@google/generative-ai');

  // Single stable vi.fn() captured at hoist time. The engine's
  // `geminiModel.generateContent` reference is fixed at engine-load time,
  // so we need a single function whose mock-impl we can swap per-test via
  // mockResolvedValueOnce / mockRejectedValueOnce / mockReset.
  const fn = vi.fn();

  // CRITICAL: must be a regular `function` (NOT an arrow) because the engine
  // calls `new GoogleGenerativeAI(key)`. Arrow functions are not constructors
  // — `new` on an arrow throws `TypeError: ... is not a constructor`, which
  // the engine catches and falls back to rules, defeating the test.
  // Also avoid `vi.fn().mockImplementation(arrow)` for the same reason —
  // vi.fn wraps but does not coerce the impl into being constructable.
  function MockGoogleGenerativeAI() {
    this.getGenerativeModel = function () {
      return { generateContent: fn };
    };
  }
  genAIModule.GoogleGenerativeAI = MockGoogleGenerativeAI;
  return { mockGenerateContent: fn };
});

import {
  analyzeMessage,
  tickSentimentEngine,
  ruleBasedAnalyze,
  parseGeminiResponse,
} from '../../cron/sentimentEngine.js';

beforeAll(() => {
  prisma.emailMessage = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
});

beforeEach(() => {
  prisma.emailMessage.findMany.mockReset();
  prisma.emailMessage.update.mockReset();

  // Sensible defaults — every test overrides what it cares about.
  prisma.emailMessage.findMany.mockResolvedValue([]);
  prisma.emailMessage.update.mockResolvedValue({});

  // DEFAULT: Gemini "fails" so analyzeMessage falls through to the rule-based
  // scorer. Tests that want to exercise the Gemini happy path queue a
  // mockResolvedValueOnce, which takes precedence over this default reject.
  mockGenerateContent.mockReset();
  mockGenerateContent.mockRejectedValue(new Error('test-default-no-gemini'));
});

// ─── ruleBasedAnalyze (pure fn) ─────────────────────────────────────────────

describe('cron/sentimentEngine — ruleBasedAnalyze', () => {
  test('positive-only text → sentiment="positive", score > 0', () => {
    const out = ruleBasedAnalyze('this is great and excellent, perfect!');
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBeGreaterThan(0);
  });

  test('negative-only text → sentiment="negative", score < 0', () => {
    const out = ruleBasedAnalyze('terrible problem, very angry, cancel!');
    expect(out.sentiment).toBe('negative');
    expect(out.sentimentScore).toBeLessThan(0);
  });

  test('no-keyword text → sentiment="neutral", score=0', () => {
    const out = ruleBasedAnalyze('the meeting is tomorrow at noon');
    expect(out.sentiment).toBe('neutral');
    expect(out.sentimentScore).toBe(0);
  });

  test('balanced positive/negative counts → sentiment="neutral"', () => {
    const out = ruleBasedAnalyze('it was good but had a problem');
    expect(out.sentiment).toBe('neutral');
    expect(out.sentimentScore).toBe(0);
  });

  test('null input → neutral/0 (safe coercion)', () => {
    const out = ruleBasedAnalyze(null);
    expect(out.sentiment).toBe('neutral');
    expect(out.sentimentScore).toBe(0);
  });

  test('undefined input → neutral/0', () => {
    const out = ruleBasedAnalyze(undefined);
    expect(out.sentiment).toBe('neutral');
    expect(out.sentimentScore).toBe(0);
  });

  test('empty string → neutral/0', () => {
    const out = ruleBasedAnalyze('');
    expect(out.sentiment).toBe('neutral');
    expect(out.sentimentScore).toBe(0);
  });

  test('case-insensitive matching ("GREAT" hits as "great")', () => {
    const out = ruleBasedAnalyze('GREAT job, EXCELLENT work, THANKS!');
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBeGreaterThan(0);
  });

  test('multiple positive matches counted (pos:3 neg:0 → positive)', () => {
    const out = ruleBasedAnalyze('good great great great');
    expect(out.sentiment).toBe('positive');
    // pos=4 (good + 3x great), neg=0 → 4/(4+0+1) = 0.8
    expect(out.sentimentScore).toBeCloseTo(0.8, 2);
  });

  test('multiple negative matches counted', () => {
    const out = ruleBasedAnalyze('bad terrible angry frustrated');
    expect(out.sentiment).toBe('negative');
    // neg=4, pos=0 → -4/5 = -0.8
    expect(out.sentimentScore).toBeCloseTo(-0.8, 2);
  });

  test('output rounded to 3 decimals (formula deterministic)', () => {
    const out = ruleBasedAnalyze('great problem');
    // pos=1, neg=1 → (1-1)/(1+1+1) = 0
    expect(out.sentiment).toBe('neutral');
    // The formula yields a finite-precision number; toFixed(3) is applied.
    const str = out.sentimentScore.toString();
    // Sanity: digits-after-decimal ≤ 3
    const dec = str.split('.')[1] || '';
    expect(dec.length).toBeLessThanOrEqual(3);
  });

  test('score formula stays bounded — denominator (pos+neg+1) prevents inf', () => {
    // 100 "great" hits, no negatives: 100 / 101 ≈ 0.990, never exceeds 1.
    const text = Array(100).fill('great').join(' ');
    const out = ruleBasedAnalyze(text);
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBeGreaterThan(0.98);
    expect(out.sentimentScore).toBeLessThan(1.0);
  });

  test('word-boundary respected — substring "goodbye" should not double-count "good"', () => {
    // The engine uses \b{word}\b regex. "goodbye" contains "good" as a
    // prefix but \b prevents the match. We pin this so a refactor away
    // from word-boundary matching gets caught.
    const out = ruleBasedAnalyze('goodbye');
    // 'goodbye' should NOT match 'good' under \b\bgood\b — sentiment
    // remains neutral.
    expect(out.sentiment).toBe('neutral');
    expect(out.sentimentScore).toBe(0);
  });
});

// ─── parseGeminiResponse (pure fn) ──────────────────────────────────────────

describe('cron/sentimentEngine — parseGeminiResponse', () => {
  test('happy path: "positive\\n0.85" → positive/0.85', () => {
    const out = parseGeminiResponse('positive\n0.85');
    expect(out).toEqual({ sentiment: 'positive', sentimentScore: 0.85 });
  });

  test('happy path: "negative\\n-0.6"', () => {
    const out = parseGeminiResponse('negative\n-0.6');
    expect(out).toEqual({ sentiment: 'negative', sentimentScore: -0.6 });
  });

  test('happy path: "neutral\\n0.0"', () => {
    const out = parseGeminiResponse('neutral\n0.0');
    expect(out).toEqual({ sentiment: 'neutral', sentimentScore: 0 });
  });

  test('case-insensitive — "Positive\\n0.5"', () => {
    const out = parseGeminiResponse('Positive\n0.5');
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBe(0.5);
  });

  test('strips non-alpha noise — "Positive!\\n0.7"', () => {
    const out = parseGeminiResponse('Positive!\n0.7');
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBe(0.7);
  });

  test('extra whitespace trimmed — "  positive  \\n  0.4  "', () => {
    const out = parseGeminiResponse('  positive  \n  0.4  ');
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBe(0.4);
  });

  test('missing score line → score defaults to 0', () => {
    const out = parseGeminiResponse('positive');
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBe(0);
  });

  test('NaN score → 0', () => {
    const out = parseGeminiResponse('positive\nnotanumber');
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBe(0);
  });

  test('score > 1 → clamped to 1', () => {
    const out = parseGeminiResponse('positive\n5.5');
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBe(1);
  });

  test('score < -1 → clamped to -1', () => {
    const out = parseGeminiResponse('negative\n-9.2');
    expect(out.sentiment).toBe('negative');
    expect(out.sentimentScore).toBe(-1);
  });

  test('exact boundary 1.0 stays 1', () => {
    const out = parseGeminiResponse('positive\n1.0');
    expect(out.sentimentScore).toBe(1);
  });

  test('exact boundary -1.0 stays -1', () => {
    const out = parseGeminiResponse('negative\n-1.0');
    expect(out.sentimentScore).toBe(-1);
  });

  test('null input → null (signals upstream to fall back)', () => {
    expect(parseGeminiResponse(null)).toBeNull();
  });

  test('empty string input → null', () => {
    expect(parseGeminiResponse('')).toBeNull();
  });

  test('whitespace-only input → null', () => {
    expect(parseGeminiResponse('   \n  \n  ')).toBeNull();
  });

  test('unknown sentiment label → null (forces upstream fallback)', () => {
    const out = parseGeminiResponse('happy\n0.9');
    expect(out).toBeNull();
  });

  test('output rounded to 3 decimals', () => {
    const out = parseGeminiResponse('positive\n0.123456789');
    expect(out.sentimentScore).toBe(0.123);
  });

  test('extracts first numeric match from line 2 — "score: 0.4 confidence"', () => {
    // The regex grabs the first signed-decimal it finds. Pin that contract.
    const out = parseGeminiResponse('positive\nscore: 0.4 high');
    expect(out.sentimentScore).toBe(0.4);
  });
});

// ─── analyzeMessage (default env: no Gemini → rule-based) ────────────────────

describe('cron/sentimentEngine — analyzeMessage (no-Gemini default path)', () => {
  test('positive text → rule-based positive', async () => {
    const out = await analyzeMessage('thanks, this is great work!');
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBeGreaterThan(0);
  });

  test('negative text → rule-based negative', async () => {
    const out = await analyzeMessage('this is a terrible problem, please cancel');
    expect(out.sentiment).toBe('negative');
    expect(out.sentimentScore).toBeLessThan(0);
  });

  test('empty text → neutral/0 short-circuit (no AI invoked)', async () => {
    const out = await analyzeMessage('');
    expect(out).toEqual({ sentiment: 'neutral', sentimentScore: 0 });
  });

  test('null text → neutral/0', async () => {
    const out = await analyzeMessage(null);
    expect(out).toEqual({ sentiment: 'neutral', sentimentScore: 0 });
  });

  test('whitespace-only text → neutral/0', async () => {
    const out = await analyzeMessage('   \t\n  ');
    expect(out).toEqual({ sentiment: 'neutral', sentimentScore: 0 });
  });
});

// ─── tickSentimentEngine ────────────────────────────────────────────────────

describe('cron/sentimentEngine — tickSentimentEngine query shape (dedup)', () => {
  test('queries emailMessage with where:{sentiment:null} + orderBy createdAt desc + take:50', async () => {
    await tickSentimentEngine();
    expect(prisma.emailMessage.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.emailMessage.findMany.mock.calls[0][0];
    // Dedup contract: only un-analyzed rows enter the loop.
    expect(arg.where).toEqual({ sentiment: null });
    // Newest-first.
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    // Bounded batch — never overruns.
    expect(arg.take).toBe(50);
  });

  test('no pending rows → returns { processed: 0 }, no update issued', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([]);
    const out = await tickSentimentEngine();
    expect(out).toEqual({ processed: 0 });
    expect(prisma.emailMessage.update).not.toHaveBeenCalled();
  });
});

describe('cron/sentimentEngine — tickSentimentEngine happy path', () => {
  test('pending row → sentiment + sentimentScore persisted exactly once', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-1', body: 'thanks for the great service!' },
    ]);

    const out = await tickSentimentEngine();
    expect(out.processed).toBe(1);

    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(1);
    const arg = prisma.emailMessage.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'msg-1' });
    expect(arg.data).toHaveProperty('sentiment');
    expect(arg.data).toHaveProperty('sentimentScore');
    expect(arg.data.sentiment).toBe('positive');
    expect(arg.data.sentimentScore).toBeGreaterThan(0);
  });

  test('multiple pending rows → each updated independently', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-A', body: 'great experience, thanks' },
      { id: 'msg-B', body: 'terrible service, cancel my account' },
      { id: 'msg-C', body: 'meeting moved to friday' },
    ]);

    const out = await tickSentimentEngine();
    expect(out.processed).toBe(3);
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(3);

    const labels = prisma.emailMessage.update.mock.calls.map(
      (c) => c[0].data.sentiment,
    );
    expect(labels).toEqual(['positive', 'negative', 'neutral']);
  });

  test('null body → safely scored as neutral/0 (no crash)', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-null', body: null },
    ]);
    const out = await tickSentimentEngine();
    expect(out.processed).toBe(1);
    const arg = prisma.emailMessage.update.mock.calls[0][0];
    expect(arg.data.sentiment).toBe('neutral');
    expect(arg.data.sentimentScore).toBe(0);
  });

  test('sentimentScore returned is in [-1, 1] range', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-1', body: 'great great great great great great great great great great' },
      { id: 'msg-2', body: 'bad bad bad bad bad bad bad bad bad bad' },
    ]);
    await tickSentimentEngine();
    for (const call of prisma.emailMessage.update.mock.calls) {
      const score = call[0].data.sentimentScore;
      expect(score).toBeGreaterThanOrEqual(-1);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('cron/sentimentEngine — tickSentimentEngine per-row error containment', () => {
  test('one failing UPDATE does NOT stop sibling rows', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-1', body: 'great work' },
      { id: 'msg-2', body: 'thanks' },
      { id: 'msg-3', body: 'perfect' },
    ]);
    prisma.emailMessage.update
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const out = await tickSentimentEngine();
    // 2 succeeded, 1 failed — partial-success is still useful.
    expect(out.processed).toBe(2);
    // All 3 update attempts were made — loop did not abort.
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(3);
  });

  test('all rows failing → returns { processed: 0 }, no throw', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-1', body: 'a' },
      { id: 'msg-2', body: 'b' },
    ]);
    prisma.emailMessage.update.mockRejectedValue(new Error('db down'));

    await expect(tickSentimentEngine()).resolves.toEqual({ processed: 0 });
  });
});

describe('cron/sentimentEngine — tickSentimentEngine top-level error containment', () => {
  test('findMany failure → returns { processed: 0, error } and does NOT throw', async () => {
    prisma.emailMessage.findMany.mockRejectedValueOnce(
      new Error('connection lost'),
    );
    const out = await tickSentimentEngine();
    expect(out.processed).toBe(0);
    expect(out.error).toBe('connection lost');
    expect(prisma.emailMessage.update).not.toHaveBeenCalled();
  });
});

// ─── Gemini-on path ─────────────────────────────────────────────────────────
//
// The engine captures `geminiModel` once at module load. The createRequire
// monkey-patch above swapped @google/generative-ai's GoogleGenerativeAI
// constructor BEFORE the engine's require() ran, so geminiModel ends up
// pointing at our stubbed object whose .generateContent === mockGenerateContent.
//
// Per-test we just program mockGenerateContent (mockResolvedValueOnce /
// mockRejectedValueOnce) — no resetModules / re-import needed. Each test's
// beforeEach calls mockGenerateContent.mockReset() to clear the call ledger.

describe('cron/sentimentEngine — analyzeMessage (Gemini-on path)', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
  });

  afterEach(() => {
    // Hand the call ledger back to the next test in a clean state.
    mockGenerateContent.mockReset();
  });

  test('Gemini happy path → AI label/score is returned', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'positive\n0.92' },
    });

    const out = await analyzeMessage('the new feature is amazing');
    expect(out).toEqual({ sentiment: 'positive', sentimentScore: 0.92 });
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  test('Gemini sees the prompt with body slice + the two-line answer template', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'neutral\n0.0' },
    });
    await analyzeMessage('hello world');
    const prompt = mockGenerateContent.mock.calls[0][0];
    expect(prompt).toContain('positive, neutral, or negative');
    expect(prompt).toContain('hello world');
  });

  test('Gemini happy path: negative label parsed', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'negative\n-0.7' },
    });
    const out = await analyzeMessage('please cancel my subscription');
    expect(out).toEqual({ sentiment: 'negative', sentimentScore: -0.7 });
  });

  test('Gemini throws → graceful fallback to rule-based scorer', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('quota exceeded'));

    const out = await analyzeMessage('great service, thanks!');
    // Rule-based picks up "great"+"thanks" → positive even though Gemini failed.
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBeGreaterThan(0);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  test('Gemini returns unparseable text → graceful fallback', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'I am not sure about this one' },
    });

    // parseGeminiResponse returns null for unknown labels → fall through.
    const out = await analyzeMessage('terrible problem, please cancel');
    expect(out.sentiment).toBe('negative');
    expect(out.sentimentScore).toBeLessThan(0);
  });

  test('empty body short-circuits BEFORE Gemini is called', async () => {
    const out = await analyzeMessage('');
    expect(out).toEqual({ sentiment: 'neutral', sentimentScore: 0 });
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  test('long body is truncated to 4000 chars in the prompt', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'neutral\n0' },
    });
    const huge = 'x'.repeat(10_000);
    await analyzeMessage(huge);
    const prompt = mockGenerateContent.mock.calls[0][0];
    // The body slice is wrapped in `Text: "<...>"`; the embedded copy must
    // not exceed 4000 chars (engine's slice cap).
    const m = prompt.match(/Text: "([\s\S]*)"$/);
    expect(m).toBeTruthy();
    expect(m[1].length).toBeLessThanOrEqual(4000);
  });

  test('Gemini failure inside tickSentimentEngine → row still persists via rule-based fallback', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('rate limit'));

    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-fail', body: 'great work but had a problem' },
    ]);

    const out = await tickSentimentEngine();
    expect(out.processed).toBe(1);
    // The row was updated via rule-based fallback — engine never propagates
    // the AI failure upstream, the cron keeps going.
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(1);
    const arg = prisma.emailMessage.update.mock.calls[0][0];
    expect(arg.data).toHaveProperty('sentiment');
    expect(['positive', 'negative', 'neutral']).toContain(arg.data.sentiment);
  });
});
