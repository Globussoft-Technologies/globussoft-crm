// @ts-check
/**
 * Unit tests for backend/routes/status.js (PRD_STATUS_PAGE.md).
 *
 * Pins the public read surfaces (components, history, incidents, RSS/Atom)
 * and the admin write surfaces (create incident, post update, resolve).
 *
 * Pattern mirrors approvals.test.js:
 *   - Prisma singleton monkey-patched BEFORE the router is required.
 *   - Auth middleware patched to pass-through; req.user injected per-test.
 *   - verifyRole spy used to confirm the expected role list.
 */

import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);

// Patch auth middleware before router require.
const authMw = requireCJS('../../middleware/auth');
const originalVerifyToken = authMw.verifyToken;
const originalVerifyRole = authMw.verifyRole;
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

afterAll(() => {
  authMw.verifyToken = originalVerifyToken;
  authMw.verifyRole = originalVerifyRole;
});

// Patch audit helper so admin writes don't hit the DB.
const audit = requireCJS('../../lib/audit');
audit.writeAudit = vi.fn().mockResolvedValue(undefined);

prisma.statusComponent = {
  findMany: vi.fn(),
  upsert: vi.fn(),
};
prisma.statusIncident = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.statusIncidentUpdate = {
  create: vi.fn(),
};
prisma.statusDailySnapshot = {
  findMany: vi.fn(),
  upsert: vi.fn(),
};
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn();

// $transaction is used by the POST /incidents/:id/updates handler.
prisma.$transaction = vi.fn((ops) => Promise.all(ops));

const statusRouter = requireCJS('../../routes/status');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/status', statusRouter);
  return app;
}

beforeEach(() => {
  [
    prisma.statusComponent.findMany,
    prisma.statusComponent.upsert,
    prisma.statusIncident.findMany,
    prisma.statusIncident.findUnique,
    prisma.statusIncident.create,
    prisma.statusIncident.update,
    prisma.statusIncidentUpdate.create,
    prisma.statusDailySnapshot.findMany,
    prisma.statusDailySnapshot.upsert,
    prisma.auditLog.create,
    prisma.$transaction,
  ].forEach((m) => m?.mockReset?.());
  audit.writeAudit.mockClear();

  prisma.statusComponent.findMany.mockResolvedValue([]);
  prisma.statusIncident.findMany.mockResolvedValue([]);
  prisma.statusDailySnapshot.findMany.mockResolvedValue([]);
});

// ─── Public GET / ──────────────────────────────────────────────────────────

describe('GET /api/status — public summary', () => {
  test('returns overall status, components and active incidents', async () => {
    prisma.statusComponent.findMany.mockResolvedValueOnce([
      { id: 1, name: 'CRM API', group: 'Core', description: 'Core API', status: 'operational', updatedAt: new Date('2026-07-10T10:00:00Z') },
      { id: 2, name: 'Travel API', group: 'Travel', description: 'Travel', status: 'degraded', updatedAt: new Date('2026-07-10T10:00:00Z') },
    ]);
    prisma.statusIncident.findMany.mockResolvedValueOnce([
      {
        id: 10,
        title: 'Travel slowness',
        impact: 'minor',
        status: 'investigating',
        createdAt: new Date('2026-07-10T09:00:00Z'),
        components: [{ name: 'Travel API' }],
        updates: [{ id: 1, status: 'investigating', message: 'Looking', createdAt: new Date('2026-07-10T09:00:00Z') }],
      },
    ]);

    const app = makeApp();
    const res = await request(app).get('/api/status');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.overall).toBe('degraded');
    expect(res.body.data.components).toHaveLength(2);
    expect(res.body.data.activeIncidents).toHaveLength(1);
    expect(res.body.data.activeIncidents[0].components).toEqual(['Travel API']);
  });

  test('500 returns a stable error envelope', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.statusComponent.findMany.mockRejectedValueOnce(new Error('db down'));

    const app = makeApp();
    const res = await request(app).get('/api/status');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Unable to load status');

    errSpy.mockRestore();
  });
});

// ─── Public GET /history ───────────────────────────────────────────────────

describe('GET /api/status/history — uptime chart data', () => {
  test('returns daily snapshots grouped by component', async () => {
    prisma.statusComponent.findMany.mockResolvedValueOnce([
      { id: 1, name: 'CRM API', group: 'Core' },
    ]);
    prisma.statusDailySnapshot.findMany.mockResolvedValueOnce([
      { componentId: 1, date: new Date('2026-07-09'), uptimePct: 100, worstStatus: 'operational' },
      { componentId: 1, date: new Date('2026-07-10'), uptimePct: 0, worstStatus: 'major_outage' },
    ]);

    const app = makeApp();
    const res = await request(app).get('/api/status/history?days=7');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.days).toBe(7);
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0].days).toHaveLength(2);
    expect(res.body.data.rows[0].days[1].worstStatus).toBe('major_outage');
  });

  test('caps days between 1 and 90', async () => {
    prisma.statusComponent.findMany.mockResolvedValueOnce([]);
    prisma.statusDailySnapshot.findMany.mockResolvedValueOnce([]);

    const app = makeApp();
    const res = await request(app).get('/api/status/history?days=500');

    expect(res.status).toBe(200);
    expect(res.body.data.days).toBe(90);
  });
});

// ─── Public GET /incidents ─────────────────────────────────────────────────

describe('GET /api/status/incidents — incident feed', () => {
  test('returns paginated incidents with components and updates', async () => {
    prisma.statusIncident.findMany.mockResolvedValueOnce([
      {
        id: 1,
        title: 'Outage',
        impact: 'major',
        status: 'resolved',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        components: [{ id: 1, name: 'CRM API', group: 'Core' }],
        updates: [{ id: 1, status: 'resolved', message: 'Fixed', createdAt: new Date('2026-07-01T01:00:00Z') }],
      },
    ]);

    const app = makeApp();
    const res = await request(app).get('/api/status/incidents?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.incidents).toHaveLength(1);
  });
});

// ─── RSS/Atom feeds ─────────────────────────────────────────────────────────

describe('GET /api/status/feed.rss and /feed.atom', () => {
  test('RSS feed renders XML for active incidents', async () => {
    prisma.statusIncident.findMany.mockResolvedValueOnce([
      {
        id: 1,
        title: 'API outage',
        impact: 'critical',
        status: 'investigating',
        createdAt: new Date('2026-07-10T08:00:00Z'),
        resolvedAt: null,
        components: [{ name: 'CRM API' }],
        updates: [{ id: 1, status: 'investigating', message: 'We are investigating', createdAt: new Date('2026-07-10T08:00:00Z') }],
      },
    ]);

    const app = makeApp();
    const res = await request(app).get('/api/status/feed.rss');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/rss+xml');
    expect(res.text).toContain('<title>API outage</title>');
    expect(res.text).toContain('<description>');
  });

  test('Atom feed renders XML', async () => {
    prisma.statusIncident.findMany.mockResolvedValueOnce([
      {
        id: 1,
        title: 'API outage',
        impact: 'critical',
        status: 'investigating',
        createdAt: new Date('2026-07-10T08:00:00Z'),
        resolvedAt: null,
        components: [{ name: 'CRM API' }],
        updates: [{ id: 1, status: 'investigating', message: 'We are investigating', createdAt: new Date('2026-07-10T08:00:00Z') }],
      },
    ]);

    const app = makeApp();
    const res = await request(app).get('/api/status/feed.atom');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/atom+xml');
    expect(res.text).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(res.text).toContain('<title>API outage</title>');
  });
});

// ─── Admin POST /incidents ─────────────────────────────────────────────────

describe('POST /api/status/incidents — admin only', () => {
  test('creates an incident with an initial update', async () => {
    prisma.statusIncident.create.mockResolvedValueOnce({
      id: 5,
      title: 'DB maintenance',
      impact: 'maintenance',
      status: 'investigating',
      components: [{ id: 1, name: 'Database' }],
      updates: [{ id: 1, status: 'investigating', message: 'Starting' }],
    });

    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app)
      .post('/api/status/incidents')
      .send({
        title: 'DB maintenance',
        impact: 'maintenance',
        status: 'investigating',
        componentIds: [1],
        message: 'Starting',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(5);

    const createArg = prisma.statusIncident.create.mock.calls[0][0];
    expect(createArg.data.title).toBe('DB maintenance');
    expect(createArg.data.components.connect).toEqual([{ id: 1 }]);
    expect(createArg.data.updates.create.status).toBe('investigating');

    expect(audit.writeAudit).toHaveBeenCalled();
  });

  test('rejects invalid payload with 400', async () => {
    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app)
      .post('/api/status/incidents')
      .send({ title: '', impact: 'minor', status: 'investigating', componentIds: [], message: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ─── Admin POST /incidents/:id/updates ─────────────────────────────────────

describe('POST /api/status/incidents/:id/updates — admin only', () => {
  test('posts a resolving update and flips incident status', async () => {
    prisma.statusIncident.findUnique.mockResolvedValueOnce({
      id: 7,
      status: 'monitoring',
      resolvedAt: null,
    });
    prisma.statusIncident.update.mockResolvedValueOnce({
      id: 7,
      status: 'resolved',
      resolvedAt: new Date('2026-07-10T10:00:00Z'),
      components: [],
    });
    prisma.statusIncidentUpdate.create.mockResolvedValueOnce({
      id: 9,
      incidentId: 7,
      status: 'resolved',
      message: 'Fixed',
    });

    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app)
      .post('/api/status/incidents/7/updates')
      .send({ status: 'resolved', message: 'Fixed' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.update.status).toBe('resolved');

    const updateCall = prisma.statusIncident.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('resolved');
    expect(updateCall.data.resolvedAt).toBeInstanceOf(Date);

    expect(audit.writeAudit).toHaveBeenCalled();
  });

  test('404 when incident does not exist', async () => {
    prisma.statusIncident.findUnique.mockResolvedValueOnce(null);

    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app)
      .post('/api/status/incidents/999/updates')
      .send({ status: 'resolved', message: 'Fixed' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
