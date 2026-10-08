// @ts-check
/**
 * Unit tests for backend/lib/apiPricing.js — static per-provider pricing
 * table used to estimate external API cost WITHOUT calling the provider's
 * own billing API. Powers the Super Admin "API Analytics" dashboard.
 *
 * Pinned:
 *   - inferProvider() maps model-name substrings to provider families
 *     (gemini/openai/anthropic/perplexity/groq), defaults to "unknown".
 *   - estimateLlmCost() computes $ from promptTokens/completionTokens using
 *     PRICING_PER_1K; unknown models return 0 (never throws, never guesses).
 *   - estimateFlatCost() returns a number for known flat-rate providers
 *     (serpapi) and null (NOT 0) for unknown ones, so callers can tell
 *     "priced at $0" apart from "we don't know the price".
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import { inferProvider, estimateLlmCost, estimateFlatCost, PRICING_PER_1K, FLAT_RATE_PER_REQUEST } from '../../lib/apiPricing.js';

describe('inferProvider', () => {
  test.each([
    ['gemini-2.5-flash', 'gemini'],
    ['gemini-pro', 'gemini'],
    ['gpt-4o', 'openai'],
    ['gpt-4o-mini', 'openai'],
    ['claude-opus-4-7', 'anthropic'],
    ['claude-haiku', 'anthropic'],
    ['perplexity-sonar', 'perplexity'],
    ['groq-llama', 'groq'],
    ['some-made-up-model', 'unknown'],
    [undefined, 'unknown'],
    [null, 'unknown'],
    ['', 'unknown'],
  ])('%s -> %s', (model, expected) => {
    expect(inferProvider(model)).toBe(expected);
  });

  test('is case-insensitive', () => {
    expect(inferProvider('GEMINI-2.5-FLASH')).toBe('gemini');
    expect(inferProvider('GPT-4O')).toBe('openai');
  });
});

describe('estimateLlmCost', () => {
  afterEach(() => vi.useRealTimers());

  test('prices Gemini Flash-Lite input and output instead of reporting zero spend', () => {
    expect(estimateLlmCost('gemini-3.5-flash-lite', 1_000_000, 0)).toBe(0.3);
    expect(estimateLlmCost('gemini-3.5-flash-lite', 0, 1_000_000)).toBe(2.5);
    expect(estimateLlmCost('gemini-3.5-flash-lite', 1_000_000, 1_000_000)).toBe(2.8);
  });

  test.each([
    ['2026-10-08T00:00:00Z', 0.75, 3.75],
    ['2026-12-31T23:59:59.999Z', 0.75, 3.75],
    ['2027-01-01T00:00:00Z', 1.5, 7.5],
  ])('prices Gemini Flash fallback at the applicable rates on %s', (date, input, output) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(date));
    expect(estimateLlmCost('gemini-3.8-flash', 1_000_000, 0)).toBe(input);
    expect(estimateLlmCost('gemini-3.8-flash', 0, 1_000_000)).toBe(output);
    expect(estimateLlmCost('GEMINI-3.8-FLASH', 1_000_000, 1_000_000)).toBe(input + output);
  });

  test('computes cost from promptTokens + completionTokens at the model rate', () => {
    const rate = PRICING_PER_1K['gemini-2.5-flash'];
    const cost = estimateLlmCost('gemini-2.5-flash', 1000, 1000);
    expect(cost).toBeCloseTo(rate.in + rate.out, 6);
  });

  test('zero tokens -> zero cost', () => {
    expect(estimateLlmCost('gpt-4o', 0, 0)).toBe(0);
  });

  test('unknown model -> 0, never throws', () => {
    expect(estimateLlmCost('totally-unknown-model-xyz', 5000, 5000)).toBe(0);
  });

  test('missing/undefined token counts default to 0 rather than NaN', () => {
    expect(estimateLlmCost('gpt-4o-mini', undefined, undefined)).toBe(0);
  });

  test('input and output tokens are priced at their own (different) rates', () => {
    const rate = PRICING_PER_1K['gpt-4'];
    expect(rate.in).not.toBe(rate.out); // sanity: this model's rates actually differ
    const inputOnly = estimateLlmCost('gpt-4', 1000, 0);
    const outputOnly = estimateLlmCost('gpt-4', 0, 1000);
    expect(inputOnly).toBeCloseTo(rate.in, 6);
    expect(outputOnly).toBeCloseTo(rate.out, 6);
    expect(inputOnly).not.toBeCloseTo(outputOnly, 6);
  });

  test('rounds to 6 decimal places (matches Prisma Decimal(12,6) column)', () => {
    const cost = estimateLlmCost('gemini-2.5-flash-lite', 333, 777);
    const decimalPlaces = (String(cost).split('.')[1] || '').length;
    expect(decimalPlaces).toBeLessThanOrEqual(6);
  });
});

describe('estimateFlatCost', () => {
  test('serpapi returns the known flat rate', () => {
    expect(estimateFlatCost('serpapi')).toBe(FLAT_RATE_PER_REQUEST.serpapi);
    expect(typeof estimateFlatCost('serpapi')).toBe('number');
  });

  test('unknown provider returns null, NOT 0 (unpriced vs free are different)', () => {
    expect(estimateFlatCost('some-new-provider')).toBeNull();
  });

  test('is case-insensitive', () => {
    expect(estimateFlatCost('SerpApi')).toBe(FLAT_RATE_PER_REQUEST.serpapi);
  });
});
