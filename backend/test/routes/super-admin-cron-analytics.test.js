// @ts-check
/**
 * Unit tests for backend/routes/super_admin_cron_analytics.js — Cron
 * Analytics module (Super Admin Portal). Read-only aggregation over
 * CronExecutionLog powering the charts on /super-admin/cron-analytics.
 *
 * Mocking strategy: prisma singleton monkey-patch (cronExecutionLog) + a
 * fake req.superAdmin injected ahead of the router — same pattern as
 * test/routes/super-admin-cron.test.js.
 *
 * Pinned:
 *   GET /overview — days query clamps to [1, 90], defaults to 14; totals
 *     (runs/success/failed/running) computed correctly; byDay buckets by
 *     calendar day; perCron summarizes runs/failures/avgDurationMs per
 *     cron name, sorted by run count descending.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import prisma from '../../lib/prisma.js';
prisma.cronExecutionLog = { findMany: vi.fn() };

const router = (await import('../../routes/super_admin_cron_analytics.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.superAdmin = { username: 'superadmin' };
    next();
  });
  app.use('/api/super-admin/cron-analytics', router);
  return app;
}

function log(overrides = {}) {
  return {
    cronName: 'testEngine',
    startedAt: new Date('2026-07-10T10:00:00Z'),
    durationMs: 100,
    status: 'success',
    ...overrides,
  };
}

describe('GET /overview', () => {
  let app;

  beforeEach(() => {
    prisma.cronExecutionLog.findMany.mockReset().mockResolvedValue([]);
    app = buildApp();
  });

  test('defaults to 14 days when ?days is omitted', async () => {
    const res = await request(app).get('/api/super-admin/cron-analytics/overview');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(14);
  });

  test('clamps ?days above 90 down to 90', async () => {
    const res = await request(app).get('/api/super-admin/cron-analytics/overview?days=500');
    expect(res.body.days).toBe(90);
  });

  test('non-numeric ?days falls back to the 14-day default', async () => {
    const res = await request(app).get('/api/super-admin/cron-analytics/overview?days=garbage');
    expect(res.body.days).toBe(14);
  });

  test('totals count success/failed/running correctly', async () => {
    prisma.cronExecutionLog.findMany.mockResolvedValue([
      log({ status: 'success' }),
      log({ status: 'success' }),
      log({ status: 'failed' }),
      log({ status: 'running' }),
    ]);
    const res = await request(app).get('/api/super-admin/cron-analytics/overview');
    expect(res.body.totals).toEqual({ runs: 4, success: 2, failed: 1, running: 1 });
  });

  test('byDay buckets logs by calendar day (UTC)', async () => {
    prisma.cronExecutionLog.findMany.mockResolvedValue([
      log({ startedAt: new Date('2026-07-10T01:00:00Z'), status: 'success' }),
      log({ startedAt: new Date('2026-07-10T23:00:00Z'), status: 'failed' }),
      log({ startedAt: new Date('2026-07-11T05:00:00Z'), status: 'success' }),
    ]);
    const res = await request(app).get('/api/super-admin/cron-analytics/overview');
    expect(res.body.byDay).toEqual([
      { date: '2026-07-10', success: 1, failed: 1, running: 0, total: 2 },
      { date: '2026-07-11', success: 1, failed: 0, running: 0, total: 1 },
    ]);
  });

  test('perCron summarizes runs/failures/avgDurationMs per cron, sorted by run count desc', async () => {
    prisma.cronExecutionLog.findMany.mockResolvedValue([
      log({ cronName: 'busyEngine', durationMs: 100, status: 'success' }),
      log({ cronName: 'busyEngine', durationMs: 200, status: 'failed' }),
      log({ cronName: 'quietEngine', durationMs: 50, status: 'success' }),
    ]);
    const res = await request(app).get('/api/super-admin/cron-analytics/overview');
    expect(res.body.perCron).toEqual([
      { cronName: 'busyEngine', runs: 2, failures: 1, avgDurationMs: 150 },
      { cronName: 'quietEngine', runs: 1, failures: 0, avgDurationMs: 50 },
    ]);
  });

  test('perCron avgDurationMs is null when no log for that cron has a durationMs', async () => {
    prisma.cronExecutionLog.findMany.mockResolvedValue([log({ durationMs: null, status: 'running' })]);
    const res = await request(app).get('/api/super-admin/cron-analytics/overview');
    expect(res.body.perCron[0].avgDurationMs).toBeNull();
  });

  test('empty log set returns zeroed totals and empty arrays, not an error', async () => {
    const res = await request(app).get('/api/super-admin/cron-analytics/overview');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ runs: 0, success: 0, failed: 0, running: 0 });
    expect(res.body.byDay).toEqual([]);
    expect(res.body.perCron).toEqual([]);
  });

  test('DB error surfaces as 500, does not leak internals', async () => {
    prisma.cronExecutionLog.findMany.mockRejectedValue(new Error('connection reset'));
    const res = await request(app).get('/api/super-admin/cron-analytics/overview');
    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/connection reset/);
  });
});
