/**
 * Unit tests for backend/scripts/backfill-llm-call-log-provider-cost.js —
 * one-time backfill for LlmCallLog rows written before provider/cost
 * estimation existed (they're frozen at provider:"unknown", costEstimate:0).
 *
 * Pinned:
 *   - Only rows with provider:"unknown" are read/touched (idempotent).
 *   - provider is inferred from `model` via lib/apiPricing.js's inferProvider.
 *   - Non-stub rows get a real costEstimate computed from their token counts.
 *   - Stub rows are backfilled with the correct provider but costEstimate
 *     stays 0 (no real API call was made, so there's no real cost).
 *   - --dry-run makes zero writes but still reports what WOULD change.
 *   - No rows to backfill -> returns {updated: 0, total: 0}, no error.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.llmCallLog = { ...(prisma.llmCallLog || {}), findMany: vi.fn(), update: vi.fn() };

const { run } = await import('../../scripts/backfill-llm-call-log-provider-cost.js');

function row(overrides = {}) {
  return {
    id: 1,
    model: 'gemini-flash',
    promptTokens: 1000,
    completionTokens: 500,
    stub: false,
    provider: 'unknown',
    ...overrides,
  };
}

describe('backfill-llm-call-log-provider-cost', () => {
  let originalArgv;

  beforeEach(() => {
    prisma.llmCallLog.findMany.mockReset().mockResolvedValue([]);
    prisma.llmCallLog.update.mockReset().mockResolvedValue({});
    originalArgv = process.argv;
    process.argv = ['node', 'script.js'];
  });

  test('queries only rows with provider:"unknown"', async () => {
    await run();
    expect(prisma.llmCallLog.findMany).toHaveBeenCalledWith({ where: { provider: 'unknown' } });
  });

  test('no rows to backfill -> returns zeroed result, no update calls', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([]);
    const result = await run();
    expect(result).toEqual({ updated: 0, total: 0 });
    expect(prisma.llmCallLog.update).not.toHaveBeenCalled();
  });

  test('infers provider from model and computes real cost for a non-stub row', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([row({ id: 42, model: 'gpt-4', promptTokens: 1000, completionTokens: 500, stub: false })]);
    const result = await run();
    expect(result.updated).toBe(1);
    const call = prisma.llmCallLog.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 42 });
    expect(call.data.provider).toBe('openai');
    expect(call.data.costEstimate).toBeGreaterThan(0);
  });

  test('stub rows get the real provider but costEstimate stays 0', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([row({ id: 7, model: 'gemini-flash', stub: true })]);
    await run();
    const call = prisma.llmCallLog.update.mock.calls[0][0];
    expect(call.data.provider).toBe('gemini');
    expect(call.data.costEstimate).toBe(0);
  });

  test('--dry-run makes zero write calls but reports the row count', async () => {
    process.argv = ['node', 'script.js', '--dry-run'];
    prisma.llmCallLog.findMany.mockResolvedValue([row({ id: 1 }), row({ id: 2 })]);
    const result = await run();
    expect(result).toEqual({ updated: 0, total: 2 });
    expect(prisma.llmCallLog.update).not.toHaveBeenCalled();
  });

  test('unknown model -> provider "unknown" is written back (never throws)', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([row({ id: 9, model: 'some-made-up-model-xyz' })]);
    await run();
    expect(prisma.llmCallLog.update.mock.calls[0][0].data.provider).toBe('unknown');
  });
});
