// @ts-check
/**
 * Unit tests for backend/routes/super_admin_api_analytics.js — API
 * Analytics module (Super Admin Portal). Aggregates + browses LlmCallLog
 * (Gemini/OpenAI/Anthropic/Perplexity/Groq) and ApiCallLog (SerpApi et al).
 *
 * Mocking strategy: prisma singleton monkey-patch (llmCallLog, apiCallLog,
 * systemSetting) + a fake req.superAdmin injected ahead of the router —
 * same pattern as test/routes/super-admin-cron.test.js.
 *
 * Pinned:
 *   GET /overview — days clamp [1,90] default 14; totals merge BOTH tables
 *     (calls/success/failures/tokens/cost) EXCLUDING stub-mode LlmCallLog
 *     rows entirely (no real API key configured — llmRouter.js's synthetic
 *     fallback never hit a real provider, so it's not surfaced on this
 *     dashboard at all, not even as an informational count); byDay buckets
 *     by calendar day; byProvider + byModel breakdowns; recentFailures
 *     surfaces errorMessage, newest-first, capped at 25.
 *   GET /calls — pagination, provider/status/date-range filters, merges +
 *     sorts both tables by createdAt desc, tags each row with source.
 *   GET/PUT /settings/log-retention — default 30, validates 1-3650 range,
 *     upserts on PUT with the SAME SystemSetting key the retention cron reads.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import prisma from '../../lib/prisma.js';
prisma.llmCallLog = { findMany: vi.fn() };
prisma.apiCallLog = { findMany: vi.fn() };
prisma.systemSetting = { findUnique: vi.fn(), upsert: vi.fn() };

const router = (await import('../../routes/super_admin_api_analytics.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.superAdmin = { username: 'superadmin' };
    next();
  });
  app.use('/api/super-admin/api-analytics', router);
  return app;
}

function llmRow(overrides = {}) {
  return {
    id: 1,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    task: 'email-draft',
    status: 'success',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costEstimate: 0.001,
    stub: false,
    errorMessage: null,
    createdAt: new Date('2026-07-10T10:00:00Z'),
    ...overrides,
  };
}

function apiRow(overrides = {}) {
  return {
    id: 1,
    provider: 'serpapi',
    endpoint: 'google_flights',
    status: 'success',
    costEstimate: 0.015,
    errorMessage: null,
    createdAt: new Date('2026-07-10T11:00:00Z'),
    ...overrides,
  };
}

describe('GET /overview', () => {
  let app;

  beforeEach(() => {
    prisma.llmCallLog.findMany.mockReset().mockResolvedValue([]);
    prisma.apiCallLog.findMany.mockReset().mockResolvedValue([]);
    app = buildApp();
  });

  test('defaults to 14 days, clamps above 90', async () => {
    let res = await request(app).get('/api/super-admin/api-analytics/overview');
    expect(res.body.days).toBe(14);
    res = await request(app).get('/api/super-admin/api-analytics/overview?days=999');
    expect(res.body.days).toBe(90);
  });

  test('?from + ?to overrides the days preset entirely — filters both queries by the exact range', async () => {
    const res = await request(app).get('/api/super-admin/api-analytics/overview?from=2026-06-01&to=2026-06-03&days=999');
    expect(res.status).toBe(200);
    const llmWhere = prisma.llmCallLog.findMany.mock.calls[0][0].where.createdAt;
    expect(llmWhere.gte.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(llmWhere.lte.toISOString().slice(0, 10)).toBe('2026-06-03');
    expect(res.body.until).not.toBeNull();
  });

  test('?to includes the WHOLE UTC day (end-of-day 23:59:59.999 UTC), not just midnight — asserted in UTC so this passes regardless of the test runner\'s local timezone', async () => {
    await request(app).get('/api/super-admin/api-analytics/overview?from=2026-06-01&to=2026-06-01');
    const llmWhere = prisma.llmCallLog.findMany.mock.calls[0][0].where.createdAt;
    expect(llmWhere.lte.getUTCHours()).toBe(23);
    expect(llmWhere.lte.getUTCMinutes()).toBe(59);
    expect(llmWhere.lte.toISOString()).toBe('2026-06-01T23:59:59.999Z');
  });

  test('a single ?from with no ?to is treated as "just that one day"', async () => {
    await request(app).get('/api/super-admin/api-analytics/overview?from=2026-06-01');
    const llmWhere = prisma.llmCallLog.findMany.mock.calls[0][0].where.createdAt;
    expect(llmWhere.gte.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(llmWhere.lte.toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  test('invalid ?from date -> 400 INVALID_DATE', async () => {
    const res = await request(app).get('/api/super-admin/api-analytics/overview?from=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('invalid ?to date -> 400 INVALID_DATE', async () => {
    const res = await request(app).get('/api/super-admin/api-analytics/overview?to=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('no from/to -> until is null in the response (preset-days mode)', async () => {
    const res = await request(app).get('/api/super-admin/api-analytics/overview?days=7');
    expect(res.body.until).toBeNull();
  });

  test('totals merge LlmCallLog + ApiCallLog counts, tokens, cost', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([llmRow({ status: 'success' }), llmRow({ status: 'failed', errorMessage: 'quota exceeded' })]);
    prisma.apiCallLog.findMany.mockResolvedValue([apiRow({ status: 'success' })]);
    const res = await request(app).get('/api/super-admin/api-analytics/overview');
    expect(res.body.totals.calls).toBe(3);
    expect(res.body.totals.success).toBe(2);
    expect(res.body.totals.failures).toBe(1);
    expect(res.body.totals.tokens).toBe(300); // 150 + 150 from the two llm rows, api rows contribute 0
    expect(res.body.totals.cost).toBeCloseTo(0.001 + 0.001 + 0.015, 6);
  });

  test('stub LLM calls are EXCLUDED entirely from totals.calls/tokens/cost (never hit a real API, no real cost) and stubCalls is not a field on the response', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      llmRow({ stub: true, totalTokens: 999, costEstimate: 5 }),
      llmRow({ stub: false }),
    ]);
    const res = await request(app).get('/api/super-admin/api-analytics/overview');
    expect(res.body.totals.calls).toBe(1); // only the real (non-stub) call
    expect(res.body.totals.tokens).toBe(150); // the stub row's 999 tokens never counted
    expect(res.body.totals.stubCalls).toBeUndefined(); // stub concept isn't surfaced on this dashboard at all
  });

  test('a provider/model that ONLY has stub rows produces zero byProvider/byModel entries (never hit a real API)', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([llmRow({ provider: 'anthropic', model: 'claude-opus-4-7', stub: true })]);
    const res = await request(app).get('/api/super-admin/api-analytics/overview');
    expect(res.body.byProvider.find((p) => p.provider === 'anthropic')).toBeUndefined();
    expect(res.body.byModel.find((m) => m.model === 'claude-opus-4-7')).toBeUndefined();
    expect(res.body.totals.calls).toBe(0);
  });

  test('byProvider breaks down calls/tokens/cost/failures per provider across both tables', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([llmRow({ provider: 'gemini' }), llmRow({ provider: 'openai', model: 'gpt-4o', totalTokens: 200, costEstimate: 0.01 })]);
    prisma.apiCallLog.findMany.mockResolvedValue([apiRow({ provider: 'serpapi' })]);
    const res = await request(app).get('/api/super-admin/api-analytics/overview');
    const byProvider = Object.fromEntries(res.body.byProvider.map((p) => [p.provider, p]));
    expect(byProvider.gemini.calls).toBe(1);
    expect(byProvider.openai.calls).toBe(1);
    expect(byProvider.openai.tokens).toBe(200);
    expect(byProvider.serpapi.calls).toBe(1);
    expect(byProvider.serpapi.tokens).toBe(0);
  });

  test('byModel only reflects LlmCallLog rows (ApiCallLog has no model concept)', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([llmRow({ model: 'gemini-2.5-flash' })]);
    prisma.apiCallLog.findMany.mockResolvedValue([apiRow()]);
    const res = await request(app).get('/api/super-admin/api-analytics/overview');
    expect(res.body.byModel).toHaveLength(1);
    expect(res.body.byModel[0].model).toBe('gemini-2.5-flash');
  });

  test('recentFailures surfaces errorMessage, newest first, capped at 25', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      llmRow({ status: 'failed', errorMessage: `err-${i}`, createdAt: new Date(2026, 6, 1, 0, i) }),
    );
    prisma.llmCallLog.findMany.mockResolvedValue(many);
    const res = await request(app).get('/api/super-admin/api-analytics/overview');
    expect(res.body.recentFailures).toHaveLength(25);
    expect(res.body.recentFailures[0].errorMessage).toBe('err-29'); // newest first
  });

  test('DB error surfaces as 500, does not leak internals', async () => {
    prisma.llmCallLog.findMany.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3307'));
    const res = await request(app).get('/api/super-admin/api-analytics/overview');
    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/ECONNREFUSED/);
  });

  test('?provider filters both underlying queries', async () => {
    await request(app).get('/api/super-admin/api-analytics/overview?provider=gemini');
    expect(prisma.llmCallLog.findMany.mock.calls[0][0].where.provider).toBe('gemini');
    expect(prisma.apiCallLog.findMany.mock.calls[0][0].where.provider).toBe('gemini');
  });

  test('?model filters the LlmCallLog query and excludes ApiCallLog entirely', async () => {
    await request(app).get('/api/super-admin/api-analytics/overview?model=gpt-4o');
    expect(prisma.llmCallLog.findMany.mock.calls[0][0].where.model).toBe('gpt-4o');
    // ApiCallLog has no `model` column — the route scopes it out via an
    // unsatisfiable id filter rather than silently ignoring ?model=.
    expect(prisma.apiCallLog.findMany.mock.calls[0][0].where.id).toBe(-1);
  });

  test('?provider + ?model combine (both applied to the LlmCallLog query)', async () => {
    await request(app).get('/api/super-admin/api-analytics/overview?provider=openai&model=gpt-4o');
    const llmWhere = prisma.llmCallLog.findMany.mock.calls[0][0].where;
    expect(llmWhere.provider).toBe('openai');
    expect(llmWhere.model).toBe('gpt-4o');
  });
});

describe('GET /filters', () => {
  let app;

  beforeEach(() => {
    prisma.llmCallLog.findMany.mockReset().mockResolvedValue([]);
    prisma.apiCallLog.findMany.mockReset().mockResolvedValue([]);
    app = buildApp();
  });

  test('returns distinct providers merged across both tables, sorted', async () => {
    prisma.llmCallLog.findMany.mockImplementation((args) =>
      args && args.select && args.select.provider
        ? Promise.resolve([{ provider: 'openai' }, { provider: 'gemini' }])
        : Promise.resolve([]),
    );
    prisma.apiCallLog.findMany.mockResolvedValue([{ provider: 'serpapi' }]);
    const res = await request(app).get('/api/super-admin/api-analytics/filters');
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(['gemini', 'openai', 'serpapi']);
  });

  test('returns distinct models from LlmCallLog only, sorted', async () => {
    prisma.llmCallLog.findMany.mockImplementation((args) =>
      args && args.select && args.select.model
        ? Promise.resolve([{ model: 'gpt-4o' }, { model: 'gemini-flash' }])
        : Promise.resolve([]),
    );
    const res = await request(app).get('/api/super-admin/api-analytics/filters');
    expect(res.body.models).toEqual(['gemini-flash', 'gpt-4o']);
  });

  test('DB error surfaces as 500, does not leak internals', async () => {
    prisma.llmCallLog.findMany.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3307'));
    const res = await request(app).get('/api/super-admin/api-analytics/filters');
    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/ECONNREFUSED/);
  });

  test('provider/model queries are scoped to stub:false — a stub-only provider never appears as a filter option', async () => {
    await request(app).get('/api/super-admin/api-analytics/filters');
    const providerCall = prisma.llmCallLog.findMany.mock.calls.find((c) => c[0].distinct?.[0] === 'provider');
    const modelCall = prisma.llmCallLog.findMany.mock.calls.find((c) => c[0].distinct?.[0] === 'model');
    expect(providerCall[0].where).toEqual({ stub: false });
    expect(modelCall[0].where).toEqual({ stub: false });
  });

  test('?provider= scopes the model list to that provider only — prevents a mismatched (provider, model) pair', async () => {
    prisma.llmCallLog.findMany.mockImplementation((args) => {
      if (args && args.select && args.select.model) {
        // Confirm the provider filter actually reached this query's where clause.
        expect(args.where).toEqual({ stub: false, provider: 'openai' });
        return Promise.resolve([{ model: 'gpt-4o' }, { model: 'gpt-4' }]);
      }
      return Promise.resolve([]);
    });
    const res = await request(app).get('/api/super-admin/api-analytics/filters?provider=openai');
    expect(res.body.models).toEqual(['gpt-4', 'gpt-4o']);
  });

  test('no ?provider= -> model query has no provider constraint (all models across all providers)', async () => {
    await request(app).get('/api/super-admin/api-analytics/filters');
    const modelCall = prisma.llmCallLog.findMany.mock.calls.find((c) => c[0].distinct?.[0] === 'model');
    expect(modelCall[0].where.provider).toBeUndefined();
  });
});

describe('GET /calls', () => {
  let app;

  beforeEach(() => {
    prisma.llmCallLog.findMany.mockReset().mockResolvedValue([]);
    prisma.apiCallLog.findMany.mockReset().mockResolvedValue([]);
    app = buildApp();
  });

  test('merges both tables, sorted by createdAt desc, tagged with source', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([llmRow({ id: 1, createdAt: new Date('2026-07-10T09:00:00Z') })]);
    prisma.apiCallLog.findMany.mockResolvedValue([apiRow({ id: 1, createdAt: new Date('2026-07-10T10:00:00Z') })]);
    const res = await request(app).get('/api/super-admin/api-analytics/calls');
    expect(res.status).toBe(200);
    expect(res.body.calls).toHaveLength(2);
    expect(res.body.calls[0].source).toBe('api'); // newer row first
    expect(res.body.calls[1].source).toBe('llm');
  });

  test('paginates the merged+sorted result set', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => llmRow({ id: i, createdAt: new Date(2026, 6, 1, 0, i) }));
    prisma.llmCallLog.findMany.mockResolvedValue(rows);
    const res = await request(app).get('/api/super-admin/api-analytics/calls?page=1&pageSize=2');
    expect(res.body.calls).toHaveLength(2);
    expect(res.body.total).toBe(5);
  });

  test('?provider filters both underlying queries', async () => {
    await request(app).get('/api/super-admin/api-analytics/calls?provider=gemini');
    expect(prisma.llmCallLog.findMany.mock.calls[0][0].where.provider).toBe('gemini');
    expect(prisma.apiCallLog.findMany.mock.calls[0][0].where.provider).toBe('gemini');
  });

  test('?model filters the LlmCallLog query and excludes ApiCallLog entirely', async () => {
    await request(app).get('/api/super-admin/api-analytics/calls?model=gemini-flash');
    expect(prisma.llmCallLog.findMany.mock.calls[0][0].where.model).toBe('gemini-flash');
    expect(prisma.apiCallLog.findMany.mock.calls[0][0].where.model).toBeUndefined();
    expect(prisma.apiCallLog.findMany.mock.calls[0][0].where.id).toBe(-1);
  });

  test('?status=failed filters both underlying queries', async () => {
    await request(app).get('/api/super-admin/api-analytics/calls?status=failed');
    expect(prisma.llmCallLog.findMany.mock.calls[0][0].where.status).toBe('failed');
    expect(prisma.apiCallLog.findMany.mock.calls[0][0].where.status).toBe('failed');
  });

  test('invalid ?from date -> 400 INVALID_DATE', async () => {
    const res = await request(app).get('/api/super-admin/api-analytics/calls?from=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('invalid ?to date -> 400 INVALID_DATE', async () => {
    const res = await request(app).get('/api/super-admin/api-analytics/calls?to=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });
});

describe('GET/PUT /settings/log-retention', () => {
  let app;

  beforeEach(() => {
    prisma.systemSetting.findUnique.mockReset().mockResolvedValue(null);
    prisma.systemSetting.upsert.mockReset().mockResolvedValue({});
    app = buildApp();
  });

  test('GET defaults to 30 when unset', async () => {
    const res = await request(app).get('/api/super-admin/api-analytics/settings/log-retention');
    expect(res.body.retainDays).toBe(30);
  });

  test('GET returns the persisted value when set', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '60' });
    const res = await request(app).get('/api/super-admin/api-analytics/settings/log-retention');
    expect(res.body.retainDays).toBe(60);
  });

  test('PUT validates 1-3650 range', async () => {
    let res = await request(app).put('/api/super-admin/api-analytics/settings/log-retention').send({ retainDays: 0 });
    expect(res.status).toBe(400);
    res = await request(app).put('/api/super-admin/api-analytics/settings/log-retention').send({ retainDays: 3651 });
    expect(res.status).toBe(400);
  });

  test('PUT upserts using the SAME SystemSetting key the retention cron reads', async () => {
    const res = await request(app).put('/api/super-admin/api-analytics/settings/log-retention').send({ retainDays: 45 });
    expect(res.status).toBe(200);
    expect(res.body.retainDays).toBe(45);
    expect(prisma.systemSetting.upsert.mock.calls[0][0].where).toEqual({ key: 'api_call_log_retention_days' });
  });
});
