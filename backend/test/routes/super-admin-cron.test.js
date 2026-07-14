// @ts-check
/**
 * Unit tests for backend/routes/super_admin_cron.js — Cron Maintenance
 * module (Super Admin Portal).
 *
 * Mocking strategy: prisma singleton monkey-patch (cronConfig,
 * cronExecutionLog, systemSetting) + a fake req.superAdmin injected ahead
 * of the router (mirrors how server.js mounts requireSuperAdmin before this
 * router — we bypass the real middleware here and inject the identity
 * directly, since the auth contract itself is pinned in
 * super-admin-auth.test.js). lib/cronRegistry and lib/cronDynamicHandlers
 * are mocked via the require-cache-injection CJS seam (same pattern as
 * test/cron/marketplaceEngine.test.js) since this route calls their real
 * functions directly, not through DI.
 *
 * Pinned:
 *   GET /crons — lists all CronConfig rows, decorated with
 *     isRegisteredInProcess + lastExecutionAt/lastStatus from the newest log.
 *   GET /crons/:name — 404 on unknown name.
 *   POST /crons — validates name/schedule/handlerKey/metadataJson; 409 on
 *     duplicate name; happy path creates isSystem:false + registers live.
 *   PUT /crons/:name — 403 SYSTEM_CRON_READONLY for isSystem:true rows;
 *     404 on unknown; happy path updates + re-registers.
 *   DELETE /crons/:name — 403 SYSTEM_CRON_PROTECTED for isSystem:true;
 *     404 on unknown; happy path unregisters + deletes.
 *   POST /crons/:name/enable + /disable — 404 on unknown; happy path
 *     updates enabled + calls applyConfig for live effect.
 *   PUT /crons/:name/schedule — 400 on invalid cron expression; happy
 *     path updates schedule + calls applyConfig.
 *   POST /crons/:name/run-now — 409 if not currently registered in this
 *     process; happy path calls runTick with triggerType "manual".
 *   GET /logs — pagination + cronName/status/date-range/search filters.
 *   GET /logs/:id — 400 on non-numeric id; 404 on unknown.
 *   DELETE /logs/:id — 404 on unknown; happy path deletes.
 *   POST /logs/clear — scoped-by-cronName vs clear-all.
 *   GET/PUT /settings/log-retention — default 30 when unset; validates
 *     1-3650 range; upserts on PUT.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// ── Mock prisma BEFORE requiring SUT ───────────────────────────────────
import prisma from '../../lib/prisma.js';
prisma.cronConfig = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.cronExecutionLog = {
  findMany: vi.fn(),
  count: vi.fn(),
  findUnique: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
};
prisma.systemSetting = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

// ── Fake cronRegistry + cronDynamicHandlers in the require cache ──────
const registryMock = {
  listRegistered: vi.fn(() => []),
  isValidExpression: vi.fn((expr) => /^(\S+\s+){4}\S+$/.test(String(expr || '').trim())),
  register: vi.fn().mockResolvedValue({}),
  applyConfig: vi.fn().mockResolvedValue({ ok: true }),
  unregister: vi.fn(() => ({ ok: true })),
  isRegistered: vi.fn(() => true),
  runTick: vi.fn().mockResolvedValue({ status: 'success', durationMs: 5, errorMessage: null }),
};
const registryPath = requireCJS.resolve('../../lib/cronRegistry.js');
Module._cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: registryMock };

const handlersMock = {
  isValidHandlerKey: vi.fn((k) => ['http_webhook_ping', 'log_note'].includes(k)),
  VALID_HANDLER_KEYS: ['http_webhook_ping', 'log_note'],
  getHandlerCatalog: vi.fn(() => [
    { key: 'http_webhook_ping', label: 'HTTP Webhook Ping', description: 'Pings a URL', metadataSchema: {} },
    { key: 'log_note', label: 'Log Note', description: 'Logs a message', metadataSchema: {} },
  ]),
  buildDynamicTickFn: vi.fn(() => vi.fn()),
};
const handlersPath = requireCJS.resolve('../../lib/cronDynamicHandlers.js');
Module._cache[handlersPath] = { id: handlersPath, filename: handlersPath, loaded: true, exports: handlersMock };

const router = requireCJS('../../routes/super_admin_cron.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.superAdmin = { username: 'superadmin' };
    next();
  });
  app.use('/api/super-admin/cron', router);
  return app;
}

const app = buildApp();

beforeEach(() => {
  prisma.cronConfig.findMany.mockReset().mockResolvedValue([]);
  prisma.cronConfig.findUnique.mockReset().mockResolvedValue(null);
  prisma.cronConfig.create.mockReset();
  prisma.cronConfig.update.mockReset();
  prisma.cronConfig.delete.mockReset().mockResolvedValue({});
  prisma.cronExecutionLog.findMany.mockReset().mockResolvedValue([]);
  prisma.cronExecutionLog.count.mockReset().mockResolvedValue(0);
  prisma.cronExecutionLog.findUnique.mockReset().mockResolvedValue(null);
  prisma.cronExecutionLog.delete.mockReset().mockResolvedValue({});
  prisma.cronExecutionLog.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.systemSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.systemSetting.upsert.mockReset();

  registryMock.listRegistered.mockReset().mockReturnValue([]);
  registryMock.isValidExpression.mockClear();
  registryMock.register.mockReset().mockResolvedValue({});
  registryMock.applyConfig.mockReset().mockResolvedValue({ ok: true });
  registryMock.unregister.mockReset().mockReturnValue({ ok: true });
  registryMock.isRegistered.mockReset().mockReturnValue(true);
  registryMock.runTick.mockReset().mockResolvedValue({ status: 'success', durationMs: 5, errorMessage: null });
});

describe('GET /crons', () => {
  test('lists crons decorated with isRegisteredInProcess + last execution info', async () => {
    prisma.cronConfig.findMany.mockResolvedValue([
      {
        id: 1, name: 'leadScoringEngine', schedule: '*/10 * * * *', enabled: true, isSystem: true,
        logs: [{ startedAt: new Date('2026-07-13T10:00:00Z'), status: 'success' }],
      },
    ]);
    registryMock.listRegistered.mockReturnValue([{ name: 'leadScoringEngine' }]);

    const res = await request(app).get('/api/super-admin/cron/crons');
    expect(res.status).toBe(200);
    expect(res.body.crons).toHaveLength(1);
    expect(res.body.crons[0]).toMatchObject({
      name: 'leadScoringEngine',
      isRegisteredInProcess: true,
      lastStatus: 'success',
    });
    expect(res.body.crons[0].logs).toBeUndefined(); // raw relation stripped
  });
});

describe('GET /cron-handlers', () => {
  test('returns the handler catalog from lib/cronDynamicHandlers', async () => {
    const res = await request(app).get('/api/super-admin/cron/cron-handlers');
    expect(res.status).toBe(200);
    expect(res.body.handlers).toHaveLength(2);
    expect(res.body.handlers[0]).toMatchObject({ key: 'http_webhook_ping', label: 'HTTP Webhook Ping' });
  });
});

describe('GET /crons/:name', () => {
  test('404 on unknown name', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/super-admin/cron/crons/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CRON_NOT_FOUND');
  });

  test('200 with the cron on happy path', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 1, name: 'foo', schedule: '* * * * *', enabled: true });
    const res = await request(app).get('/api/super-admin/cron/crons/foo');
    expect(res.status).toBe(200);
    expect(res.body.cron.name).toBe('foo');
  });
});

describe('POST /crons (create dynamic cron)', () => {
  test('400 on invalid name', async () => {
    const res = await request(app).post('/api/super-admin/cron/crons').send({
      name: 'has spaces!', schedule: '* * * * *', handlerKey: 'log_note',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME');
  });

  test('400 on invalid schedule', async () => {
    const res = await request(app).post('/api/super-admin/cron/crons').send({
      name: 'myCron', schedule: 'garbage', handlerKey: 'log_note',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCHEDULE');
  });

  test('400 on invalid handlerKey', async () => {
    const res = await request(app).post('/api/super-admin/cron/crons').send({
      name: 'myCron', schedule: '* * * * *', handlerKey: 'delete_everything',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_HANDLER_KEY');
  });

  test('400 on malformed metadataJson', async () => {
    const res = await request(app).post('/api/super-admin/cron/crons').send({
      name: 'myCron', schedule: '* * * * *', handlerKey: 'log_note', metadataJson: '{not json',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_METADATA_JSON');
  });

  test('409 when name already exists', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 5, name: 'myCron' });
    const res = await request(app).post('/api/super-admin/cron/crons').send({
      name: 'myCron', schedule: '* * * * *', handlerKey: 'log_note',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CRON_NAME_TAKEN');
  });

  test('happy path creates isSystem:false + registers live immediately', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue(null);
    prisma.cronConfig.create.mockResolvedValue({
      id: 10, name: 'myCron', schedule: '* * * * *', enabled: true, isSystem: false, handlerKey: 'log_note',
    });

    const res = await request(app).post('/api/super-admin/cron/crons').send({
      name: 'myCron', description: 'test', schedule: '* * * * *', handlerKey: 'log_note',
    });

    expect(res.status).toBe(201);
    expect(prisma.cronConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'myCron', isSystem: false, createdBy: 'superadmin' }),
      }),
    );
    expect(registryMock.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'myCron', defaultSchedule: '* * * * *' }),
    );
  });
});

describe('PUT /crons/:name', () => {
  test('404 on unknown name', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue(null);
    const res = await request(app).put('/api/super-admin/cron/crons/nope').send({ description: 'x' });
    expect(res.status).toBe(404);
  });

  test('403 SYSTEM_CRON_READONLY for isSystem:true rows', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 1, name: 'leadScoringEngine', isSystem: true });
    const res = await request(app).put('/api/super-admin/cron/crons/leadScoringEngine').send({ description: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SYSTEM_CRON_READONLY');
  });

  test('happy path updates a dynamic cron + re-registers', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 10, name: 'myCron', isSystem: false, schedule: '* * * * *' });
    prisma.cronConfig.update.mockResolvedValue({
      id: 10, name: 'myCron', isSystem: false, schedule: '* * * * *', handlerKey: 'log_note', metadataJson: null, description: 'updated',
    });

    const res = await request(app).put('/api/super-admin/cron/crons/myCron').send({ description: 'updated' });
    expect(res.status).toBe(200);
    expect(res.body.cron.description).toBe('updated');
    expect(registryMock.applyConfig).toHaveBeenCalledWith('myCron');
  });
});

describe('DELETE /crons/:name', () => {
  test('404 on unknown name', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue(null);
    const res = await request(app).delete('/api/super-admin/cron/crons/nope');
    expect(res.status).toBe(404);
  });

  test('403 SYSTEM_CRON_PROTECTED for isSystem:true rows', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 1, name: 'leadScoringEngine', isSystem: true });
    const res = await request(app).delete('/api/super-admin/cron/crons/leadScoringEngine');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SYSTEM_CRON_PROTECTED');
    expect(prisma.cronConfig.delete).not.toHaveBeenCalled();
  });

  test('happy path unregisters + deletes a dynamic cron', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 10, name: 'myCron', isSystem: false });
    const res = await request(app).delete('/api/super-admin/cron/crons/myCron');
    expect(res.status).toBe(200);
    expect(registryMock.unregister).toHaveBeenCalledWith('myCron');
    expect(prisma.cronConfig.delete).toHaveBeenCalledWith({ where: { name: 'myCron' } });
  });
});

describe('POST /crons/:name/enable + /disable', () => {
  test('enable: 404 on unknown', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/super-admin/cron/crons/nope/enable');
    expect(res.status).toBe(404);
  });

  test('enable: happy path flips enabled:true + calls applyConfig for live effect', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 1, name: 'foo', enabled: false });
    prisma.cronConfig.update.mockResolvedValue({ id: 1, name: 'foo', enabled: true });
    const res = await request(app).post('/api/super-admin/cron/crons/foo/enable');
    expect(res.status).toBe(200);
    expect(prisma.cronConfig.update).toHaveBeenCalledWith({ where: { name: 'foo' }, data: { enabled: true } });
    expect(registryMock.applyConfig).toHaveBeenCalledWith('foo');
  });

  test('disable: happy path flips enabled:false', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 1, name: 'foo', enabled: true });
    prisma.cronConfig.update.mockResolvedValue({ id: 1, name: 'foo', enabled: false });
    const res = await request(app).post('/api/super-admin/cron/crons/foo/disable');
    expect(res.status).toBe(200);
    expect(prisma.cronConfig.update).toHaveBeenCalledWith({ where: { name: 'foo' }, data: { enabled: false } });
  });
});

describe('PUT /crons/:name/schedule', () => {
  test('400 on invalid cron expression', async () => {
    const res = await request(app).put('/api/super-admin/cron/crons/foo/schedule').send({ schedule: 'garbage' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCHEDULE');
  });

  test('404 on unknown cron', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue(null);
    const res = await request(app).put('/api/super-admin/cron/crons/nope/schedule').send({ schedule: '*/5 * * * *' });
    expect(res.status).toBe(404);
  });

  test('happy path updates schedule + calls applyConfig (live reschedule)', async () => {
    prisma.cronConfig.findUnique.mockResolvedValue({ id: 1, name: 'foo', schedule: '* * * * *' });
    prisma.cronConfig.update.mockResolvedValue({ id: 1, name: 'foo', schedule: '*/5 * * * *' });
    const res = await request(app).put('/api/super-admin/cron/crons/foo/schedule').send({ schedule: '*/5 * * * *' });
    expect(res.status).toBe(200);
    expect(res.body.cron.schedule).toBe('*/5 * * * *');
    expect(registryMock.applyConfig).toHaveBeenCalledWith('foo');
  });
});

describe('POST /crons/:name/run-now', () => {
  test('409 when not currently registered in this process', async () => {
    registryMock.isRegistered.mockReturnValue(false);
    const res = await request(app).post('/api/super-admin/cron/crons/foo/run-now');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CRON_NOT_REGISTERED');
  });

  test('happy path calls runTick with triggerType manual', async () => {
    registryMock.isRegistered.mockReturnValue(true);
    const res = await request(app).post('/api/super-admin/cron/crons/foo/run-now');
    expect(res.status).toBe(200);
    expect(registryMock.runTick).toHaveBeenCalledWith('foo', 'manual');
    expect(res.body.result.status).toBe('success');
  });
});

describe('GET /logs', () => {
  test('applies cronName/status/date-range/search filters + pagination', async () => {
    prisma.cronExecutionLog.findMany.mockResolvedValue([{ id: 1, cronName: 'foo', status: 'success' }]);
    prisma.cronExecutionLog.count.mockResolvedValue(1);

    const res = await request(app).get('/api/super-admin/cron/logs').query({
      cronName: 'foo', status: 'success', from: '2026-01-01', to: '2026-12-31', search: 'boom', page: '2', pageSize: '10',
    });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(10);
    const call = prisma.cronExecutionLog.findMany.mock.calls[0][0];
    expect(call.where.cronName).toBe('foo');
    expect(call.where.status).toBe('success');
    expect(call.where.startedAt.gte).toBeInstanceOf(Date);
    expect(call.where.startedAt.lte).toBeInstanceOf(Date);
    expect(call.where.OR).toEqual([
      { cronName: { contains: 'boom' } },
      { errorMessage: { contains: 'boom' } },
    ]);
    expect(call.skip).toBe(10); // (page 2 - 1) * pageSize 10
  });

  test('400 on invalid `from` date', async () => {
    const res = await request(app).get('/api/super-admin/cron/logs').query({ from: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('pageSize is clamped to a max of 200', async () => {
    prisma.cronExecutionLog.findMany.mockResolvedValue([]);
    prisma.cronExecutionLog.count.mockResolvedValue(0);
    const res = await request(app).get('/api/super-admin/cron/logs').query({ pageSize: '99999' });
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(200);
  });
});

describe('GET /logs/:id', () => {
  test('400 on non-numeric id', async () => {
    const res = await request(app).get('/api/super-admin/cron/logs/abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('404 on unknown id', async () => {
    prisma.cronExecutionLog.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/super-admin/cron/logs/999');
    expect(res.status).toBe(404);
  });

  test('200 happy path', async () => {
    prisma.cronExecutionLog.findUnique.mockResolvedValue({ id: 5, cronName: 'foo' });
    const res = await request(app).get('/api/super-admin/cron/logs/5');
    expect(res.status).toBe(200);
    expect(res.body.log.id).toBe(5);
  });
});

describe('DELETE /logs/:id', () => {
  test('404 on unknown id', async () => {
    prisma.cronExecutionLog.findUnique.mockResolvedValue(null);
    const res = await request(app).delete('/api/super-admin/cron/logs/999');
    expect(res.status).toBe(404);
  });

  test('happy path deletes', async () => {
    prisma.cronExecutionLog.findUnique.mockResolvedValue({ id: 5 });
    const res = await request(app).delete('/api/super-admin/cron/logs/5');
    expect(res.status).toBe(200);
    expect(prisma.cronExecutionLog.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });
});

describe('POST /logs/clear', () => {
  test('scoped to a single cronName', async () => {
    prisma.cronExecutionLog.deleteMany.mockResolvedValue({ count: 3 });
    const res = await request(app).post('/api/super-admin/cron/logs/clear').send({ cronName: 'foo' });
    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(3);
    expect(prisma.cronExecutionLog.deleteMany).toHaveBeenCalledWith({ where: { cronName: 'foo' } });
  });

  test('clears ALL logs when no cronName given', async () => {
    prisma.cronExecutionLog.deleteMany.mockResolvedValue({ count: 100 });
    const res = await request(app).post('/api/super-admin/cron/logs/clear').send({});
    expect(res.status).toBe(200);
    expect(prisma.cronExecutionLog.deleteMany).toHaveBeenCalledWith({ where: {} });
  });
});

describe('GET/PUT /settings/log-retention', () => {
  test('GET returns default 30 when no setting row exists', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/super-admin/cron/settings/log-retention');
    expect(res.status).toBe(200);
    expect(res.body.retainDays).toBe(30);
  });

  test('GET returns the persisted value when a row exists', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '90' });
    const res = await request(app).get('/api/super-admin/cron/settings/log-retention');
    expect(res.body.retainDays).toBe(90);
  });

  test('PUT rejects out-of-range values', async () => {
    const res = await request(app).put('/api/super-admin/cron/settings/log-retention').send({ retainDays: 9999 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RETENTION_DAYS');
  });

  test('PUT rejects non-integer values', async () => {
    const res = await request(app).put('/api/super-admin/cron/settings/log-retention').send({ retainDays: 'abc' });
    expect(res.status).toBe(400);
  });

  test('PUT upserts with the super admin username', async () => {
    prisma.systemSetting.upsert.mockResolvedValue({ value: '60' });
    const res = await request(app).put('/api/super-admin/cron/settings/log-retention').send({ retainDays: 60 });
    expect(res.status).toBe(200);
    expect(res.body.retainDays).toBe(60);
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'cron_log_retention_days' },
        update: expect.objectContaining({ value: '60', updatedBy: 'superadmin' }),
      }),
    );
  });
});
