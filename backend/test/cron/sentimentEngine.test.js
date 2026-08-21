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

// The engine now routes its optional AI call through lib/aiGateway.runAiRequest
// — the mandatory resolve/gate/log/deduct entry point every AI feature in the
// CRM shares (BYOK first, then a funded CRM-managed subscription). This
// suite mocks aiGateway.runAiRequest directly rather than the Gemini SDK
// (the engine no longer touches the SDK or captures a module-load-time
// singleton — access is resolved per-call, per-tenantId).
const { mockRunAiRequest } = vi.hoisted(() => ({ mockRunAiRequest: vi.fn() }));
vi.mock('../../lib/aiGateway', () => ({
  default: { runAiRequest: mockRunAiRequest },
  runAiRequest: mockRunAiRequest,
}));

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
// The engine requires aiGateway via CJS; make the CJS cache resolve to the
// same mock object vi.mock's ESM-level factory installed (Module._cache
// injection pattern used across this suite for CJS modules vitest's
// ESM-level vi.mock can't otherwise intercept).
const aiGatewayPath = requireCJS.resolve('../../lib/aiGateway');
require('node:module')._cache[aiGatewayPath] = {
  id: aiGatewayPath,
  filename: aiGatewayPath,
  loaded: true,
  exports: { runAiRequest: mockRunAiRequest },
  children: [],
  paths: [],
};

const {
  analyzeMessage,
  tickSentimentEngine,
  ruleBasedAnalyze,
  parseGeminiResponse,
} = requireCJS('../../cron/sentimentEngine.js');

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

  // DEFAULT: AI "fails" so analyzeMessage falls through to the rule-based
  // scorer. Tests that want to exercise the AI happy path queue a
  // mockResolvedValueOnce, which takes precedence over this default reject.
  mockRunAiRequest.mockReset();
  mockRunAiRequest.mockRejectedValue(new Error('test-default-no-ai'));
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

// ─── AI-on path ─────────────────────────────────────────────────────────────
//
// analyzeMessage/analyzeMessageDetailed now require a tenantId to attempt
// the AI path at all (aiGateway.runAiRequest resolves BYOK/CRM-managed
// access per-tenant — no tenantId means no bare-env fallback, straight to
// rule-based). Every test in this block passes a tenantId so the AI attempt
// actually fires; mockRunAiRequest's resolved/rejected value controls the
// provider response.

describe('cron/sentimentEngine — analyzeMessage (AI-on path)', () => {
  beforeEach(() => {
    mockRunAiRequest.mockReset();
  });

  afterEach(() => {
    mockRunAiRequest.mockReset();
  });

  test('AI happy path → label/score is returned', async () => {
    mockRunAiRequest.mockResolvedValueOnce({
      text: 'positive\n0.92',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const out = await analyzeMessage('the new feature is amazing', 1);
    expect(out).toEqual({ sentiment: 'positive', sentimentScore: 0.92 });
    expect(mockRunAiRequest).toHaveBeenCalledTimes(1);
    expect(mockRunAiRequest.mock.calls[0][0].tenantId).toBe(1);
  });

  test('AI sees the prompt with body slice + the two-line answer template', async () => {
    mockRunAiRequest.mockResolvedValueOnce({
      text: 'neutral\n0.0',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });
    await analyzeMessage('hello world', 1);
    const prompt = mockRunAiRequest.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('positive, neutral, or negative');
    expect(prompt).toContain('hello world');
  });

  test('AI happy path: negative label parsed', async () => {
    mockRunAiRequest.mockResolvedValueOnce({
      text: 'negative\n-0.7',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });
    const out = await analyzeMessage('please cancel my subscription', 1);
    expect(out).toEqual({ sentiment: 'negative', sentimentScore: -0.7 });
  });

  test('AI throws → graceful fallback to rule-based scorer', async () => {
    mockRunAiRequest.mockRejectedValueOnce(new Error('quota exceeded'));

    const out = await analyzeMessage('great service, thanks!', 1);
    // Rule-based picks up "great"+"thanks" → positive even though AI failed.
    expect(out.sentiment).toBe('positive');
    expect(out.sentimentScore).toBeGreaterThan(0);
    expect(mockRunAiRequest).toHaveBeenCalledTimes(1);
  });

  test('blocked access (no BYOK, no funded subscription) → silent fallback, no warning noise', async () => {
    const err = new Error('Your organization has not configured an AI provider yet.');
    err.friendly = true;
    mockRunAiRequest.mockRejectedValueOnce(err);

    const out = await analyzeMessage('great service, thanks!', 1);
    expect(out.sentiment).toBe('positive');
    expect(mockRunAiRequest).toHaveBeenCalledTimes(1);
  });

  test('no tenantId → AI is never attempted, straight to rule-based', async () => {
    const out = await analyzeMessage('great service, thanks!');
    expect(out.sentiment).toBe('positive');
    expect(mockRunAiRequest).not.toHaveBeenCalled();
  });

  test('AI returns unparseable text → graceful fallback', async () => {
    mockRunAiRequest.mockResolvedValueOnce({
      text: 'I am not sure about this one',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });

    // parseGeminiResponse returns null for unknown labels → fall through.
    const out = await analyzeMessage('terrible problem, please cancel', 1);
    expect(out.sentiment).toBe('negative');
    expect(out.sentimentScore).toBeLessThan(0);
  });

  test('empty body short-circuits BEFORE AI is called', async () => {
    const out = await analyzeMessage('', 1);
    expect(out).toEqual({ sentiment: 'neutral', sentimentScore: 0 });
    expect(mockRunAiRequest).not.toHaveBeenCalled();
  });

  test('long body is truncated to 4000 chars in the prompt', async () => {
    mockRunAiRequest.mockResolvedValueOnce({
      text: 'neutral\n0',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });
    const huge = 'x'.repeat(10_000);
    await analyzeMessage(huge, 1);
    const prompt = mockRunAiRequest.mock.calls[0][0].messages[0].content;
    // The body slice is wrapped in `Text: "<...>"`; the embedded copy must
    // not exceed 4000 chars (engine's slice cap).
    const m = prompt.match(/Text: "([\s\S]*)"$/);
    expect(m).toBeTruthy();
    expect(m[1].length).toBeLessThanOrEqual(4000);
  });

  test('AI failure inside tickSentimentEngine → row still persists via rule-based fallback', async () => {
    mockRunAiRequest.mockRejectedValueOnce(new Error('rate limit'));

    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-fail', tenantId: 1, body: 'great work but had a problem' },
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

  test('tickSentimentEngine threads each row\'s own tenantId into the AI call', async () => {
    mockRunAiRequest.mockResolvedValue({
      text: 'neutral\n0',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-t3', tenantId: 3, body: 'hello' },
      { id: 'msg-t9', tenantId: 9, body: 'world' },
    ]);

    await tickSentimentEngine();

    expect(mockRunAiRequest).toHaveBeenCalledTimes(2);
    const tenantIds = mockRunAiRequest.mock.calls.map((c) => c[0].tenantId);
    expect(tenantIds).toEqual([3, 9]);
  });
});
