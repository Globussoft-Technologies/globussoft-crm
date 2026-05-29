// @ts-check
/**
 * Unit tests for backend/routes/report_schedules.js — pin the contract of the
 * scheduled-report management surface (list / create / update / delete /
 * toggle) for the Report Schedules admin UI + reportEngine cron consumer.
 *
 * Why this file exists
 * ────────────────────
 * routes/report_schedules.js (230 LOC) had ZERO vitest coverage prior to this
 * file. It owns the ReportSchedule CRUD that feeds reportEngine.js's nightly
 * cron — silent contract drift here would either (a) corrupt the cron's input
 * (wrong cronExpression / wrong recipients shape) and cause silent
 * non-delivery, or (b) red the #171 PII-exfil guard
 * (validateRecipientsAgainstTenant) that gates against attacker@evil.com
 * recipient injection. Pin the wire shape now.
 *
 * Endpoints under test
 * ────────────────────
 *   1. GET    /                — list (admin sees all in tenant, others own)
 *   2. POST   /                — create with #171 enum + tenant-bounded
 *                                 recipients + v3.4.11 sanitization
 *   3. PUT    /:id             — update with same guards + cross-tenant 404
 *   4. DELETE /:id             — 204 No Content (#550 sweep)
 *   5. PUT    /:id/toggle      — flips enabled flag
 *
 * Cases (15 total)
 * ────────────────
 *   list: 200 admin sees all tenant; 200 non-admin scoped to userId (2)
 *   create: 400 INVALID_REPORT_TYPE; 400 INVALID_REPORT_FORMAT; 400
 *     INVALID_FREQUENCY; 400 EXTERNAL_RECIPIENT_FORBIDDEN (#171); 400
 *     INVALID_RECIPIENT (regex); 201 happy with JSON-string col stringify
 *     of metrics + recipients (CLAUDE.md JSON-string columns rule); 201
 *     defaults cronExpression from frequency (7)
 *   update: 404 cross-tenant; 200 partial update with sanitized metrics
 *     (string-in stays string-out per sanitizeJsonForStringColumn); 400
 *     INVALID_REPORT_FORMAT on update (3)
 *   delete: 404 cross-tenant; 204 No Content on success (2)
 *   toggle: 200 flips enabled false → true (1)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js — fake-auth middleware in makeApp
 * populates req.user; prisma singleton patched BEFORE requiring the router.
 * No eventBus calls in this router; no engine import. Recipient validation
 * hits prisma.user.findMany, so that's mocked too.
 *
 * JSON-string columns contract (CLAUDE.md standing rule)
 * ──────────────────────────────────────────────────────
 * ReportSchedule.metrics and ReportSchedule.recipients are both
 * `String? @db.Text` storing JSON. The CALL SITE (this route) must invoke
 * sanitizeJsonForStringColumn to stringify before persisting — the helper
 * itself is shape-preserving for cross-route reuse. These tests pin that
 * the create / update Prisma .data fields receive STRING (JSON-encoded)
 * values, not raw arrays/objects.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.reportSchedule = prisma.reportSchedule || {};
prisma.reportSchedule.findMany = vi.fn();
prisma.reportSchedule.findFirst = vi.fn();
prisma.reportSchedule.create = vi.fn();
prisma.reportSchedule.update = vi.fn();
prisma.reportSchedule.delete = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();

import express from 'express';
import request from 'supertest';

const reportSchedulesRouter = requireCJS('../../routes/report_schedules');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. Default role = ADMIN (admin gets tenant-wide list).
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN', email = 'admin@globussoft.com' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, email };
    next();
  });
  app.use('/api/report-schedules', reportSchedulesRouter);
  return app;
}

beforeEach(() => {
  prisma.reportSchedule.findMany.mockReset();
  prisma.reportSchedule.findFirst.mockReset();
  prisma.reportSchedule.create.mockReset();
  prisma.reportSchedule.update.mockReset();
  prisma.reportSchedule.delete.mockReset();
  prisma.user.findMany.mockReset();

  // Sensible defaults — individual tests override.
  prisma.reportSchedule.findMany.mockResolvedValue([]);
  prisma.reportSchedule.findFirst.mockResolvedValue(null);
  prisma.reportSchedule.create.mockResolvedValue({ id: 1 });
  prisma.reportSchedule.update.mockResolvedValue({ id: 1 });
  prisma.reportSchedule.delete.mockResolvedValue({ id: 1 });
  prisma.user.findMany.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list (admin sees all in tenant, non-admin scoped to userId)
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list report schedules', () => {
  test('200 ADMIN sees all schedules in tenant (no userId filter)', async () => {
    prisma.reportSchedule.findMany.mockResolvedValue([
      { id: 1, name: 'Weekly Deals', userId: 7 },
      { id: 2, name: 'Daily Contacts', userId: 99 },
    ]);

    const res = await request(makeApp({ tenantId: 42, userId: 7, role: 'ADMIN' }))
      .get('/api/report-schedules');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(prisma.reportSchedule.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });

  test('200 non-admin (USER) is scoped to req.user.userId (own schedules only)', async () => {
    prisma.reportSchedule.findMany.mockResolvedValue([
      { id: 3, name: 'My Tasks', userId: 7 },
    ]);

    const res = await request(makeApp({ tenantId: 42, userId: 7, role: 'USER' }))
      .get('/api/report-schedules');

    expect(res.status).toBe(200);
    expect(prisma.reportSchedule.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, userId: 7 },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create with #171 enum + tenant-bounded recipients + sanitize
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — create schedule', () => {
  test('400 INVALID_REPORT_TYPE when reportType not in allow-list', async () => {
    const res = await request(makeApp())
      .post('/api/report-schedules')
      .send({ name: 'X', reportType: 'EXE', frequency: 'weekly' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REPORT_TYPE');
    expect(res.body.error).toMatch(/deals/);
    expect(prisma.reportSchedule.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_REPORT_FORMAT when format not in allow-list', async () => {
    const res = await request(makeApp())
      .post('/api/report-schedules')
      .send({ name: 'X', reportType: 'deals', format: 'DOCX' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REPORT_FORMAT');
    expect(res.body.error).toMatch(/PDF/);
    expect(prisma.reportSchedule.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_FREQUENCY when frequency not in allow-list', async () => {
    const res = await request(makeApp())
      .post('/api/report-schedules')
      .send({ name: 'X', reportType: 'deals', frequency: 'every-5-minutes' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FREQUENCY');
    expect(prisma.reportSchedule.create).not.toHaveBeenCalled();
  });

  test('400 EXTERNAL_RECIPIENT_FORBIDDEN when recipient not a known tenant user (#171 PII-exfil guard)', async () => {
    // tenant has admin@globussoft.com but NOT attacker@evil.com
    prisma.user.findMany.mockResolvedValue([
      { email: 'admin@globussoft.com' },
    ]);

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/report-schedules')
      .send({
        name: 'Exfil',
        reportType: 'deals',
        recipients: ['admin@globussoft.com', 'attacker@evil.com'],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXTERNAL_RECIPIENT_FORBIDDEN');
    expect(res.body.error).toMatch(/attacker@evil\.com/);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, email: { in: ['admin@globussoft.com', 'attacker@evil.com'] } },
      select: { email: true },
    });
    expect(prisma.reportSchedule.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_RECIPIENT when recipient fails regex shape check', async () => {
    const res = await request(makeApp())
      .post('/api/report-schedules')
      .send({
        name: 'BadShape',
        reportType: 'deals',
        recipients: ['@@@not-an-email'],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RECIPIENT');
    expect(prisma.reportSchedule.create).not.toHaveBeenCalled();
  });

  test('201 happy: metrics + recipients are JSON-stringified before storing (JSON-string-column contract)', async () => {
    prisma.user.findMany.mockResolvedValue([
      { email: 'admin@globussoft.com' },
      { email: 'manager@globussoft.com' },
    ]);
    prisma.reportSchedule.create.mockResolvedValue({
      id: 50, name: 'Weekly Deals', tenantId: 42,
    });

    const res = await request(makeApp({ tenantId: 42, userId: 7 }))
      .post('/api/report-schedules')
      .send({
        name: 'Weekly Deals',
        reportType: 'deals',
        metrics: ['count', 'value', 'wonRate'],
        recipients: ['admin@globussoft.com', 'manager@globussoft.com'],
        format: 'PDF',
        frequency: 'weekly',
        enabled: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(50);

    const createArg = prisma.reportSchedule.create.mock.calls[0][0];
    // CLAUDE.md JSON-string-columns standing rule — the route MUST stringify
    // metrics + recipients before persisting (the helper itself is
    // shape-preserving; the call site does the stringification).
    expect(typeof createArg.data.metrics).toBe('string');
    expect(typeof createArg.data.recipients).toBe('string');
    expect(JSON.parse(createArg.data.metrics)).toEqual(['count', 'value', 'wonRate']);
    expect(JSON.parse(createArg.data.recipients)).toEqual([
      'admin@globussoft.com', 'manager@globussoft.com',
    ]);
    expect(createArg.data.name).toBe('Weekly Deals');
    expect(createArg.data.reportType).toBe('deals');
    expect(createArg.data.format).toBe('PDF');
    expect(createArg.data.frequency).toBe('weekly');
    expect(createArg.data.enabled).toBe(true);
    expect(createArg.data.tenantId).toBe(42);
    expect(createArg.data.userId).toBe(7);
  });

  test('201 defaults: cronExpression auto-derived from frequency when omitted (weekly → "0 8 * * 1")', async () => {
    prisma.user.findMany.mockResolvedValue([
      { email: 'admin@globussoft.com' },
    ]);
    prisma.reportSchedule.create.mockResolvedValue({ id: 51 });

    await request(makeApp({ tenantId: 42, userId: 7, email: 'admin@globussoft.com' }))
      .post('/api/report-schedules')
      .send({
        name: 'Defaults',
        // no reportType → default 'deals'
        // no frequency → default 'weekly'
        // no cronExpression → derived from weekly
        // no recipients → falls back to req.user.email
      });

    const createArg = prisma.reportSchedule.create.mock.calls[0][0];
    expect(createArg.data.reportType).toBe('deals');
    expect(createArg.data.frequency).toBe('weekly');
    expect(createArg.data.cronExpression).toBe('0 8 * * 1'); // Monday 8am
    expect(createArg.data.format).toBe('PDF');
    expect(createArg.data.enabled).toBe(true);
    // recipients fell back to req.user.email and got stringified
    expect(JSON.parse(createArg.data.recipients)).toEqual(['admin@globussoft.com']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — update with cross-tenant 404 + sanitization
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id — update schedule', () => {
  test('404 when schedule belongs to a different tenant (findFirst returns null)', async () => {
    prisma.reportSchedule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/report-schedules/777')
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.reportSchedule.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.reportSchedule.update).not.toHaveBeenCalled();
  });

  test('200 partial update: only supplied fields written + metrics stringified (JSON-string-column)', async () => {
    prisma.reportSchedule.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'Old',
    });
    prisma.reportSchedule.update.mockResolvedValue({
      id: 50, name: 'Renamed',
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/report-schedules/50')
      .send({
        name: 'Renamed',
        metrics: ['count', 'value'],
      });

    expect(res.status).toBe(200);
    const updateArg = prisma.reportSchedule.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 50 });
    expect(updateArg.data.name).toBe('Renamed');
    // metrics must be a string post-sanitize (call-site stringification).
    expect(typeof updateArg.data.metrics).toBe('string');
    expect(JSON.parse(updateArg.data.metrics)).toEqual(['count', 'value']);
    // Fields NOT supplied must be absent (partial-update contract).
    expect(updateArg.data).not.toHaveProperty('format');
    expect(updateArg.data).not.toHaveProperty('frequency');
    expect(updateArg.data).not.toHaveProperty('recipients');
  });

  test('400 INVALID_REPORT_FORMAT when format not in allow-list on update', async () => {
    prisma.reportSchedule.findFirst.mockResolvedValue({
      id: 50, tenantId: 1,
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/report-schedules/50')
      .send({ format: 'DOCX' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REPORT_FORMAT');
    expect(prisma.reportSchedule.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — 204 No Content per #550 sweep
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — delete schedule', () => {
  test('404 when schedule belongs to a different tenant', async () => {
    prisma.reportSchedule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/report-schedules/777');

    expect(res.status).toBe(404);
    expect(prisma.reportSchedule.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.reportSchedule.delete).not.toHaveBeenCalled();
  });

  test('204 No Content on successful delete (#550 — DELETE→204 sweep)', async () => {
    prisma.reportSchedule.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.reportSchedule.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/report-schedules/50');

    expect(res.status).toBe(204);
    expect(res.body).toEqual({}); // 204 has no body
    expect(prisma.reportSchedule.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id/toggle — flip enabled
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id/toggle — flip enabled flag', () => {
  test('200 flips enabled from false → true (and back) via !existing.enabled', async () => {
    prisma.reportSchedule.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, enabled: false,
    });
    prisma.reportSchedule.update.mockResolvedValue({
      id: 50, enabled: true,
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/report-schedules/50/toggle')
      .send({});

    expect(res.status).toBe(200);
    expect(prisma.reportSchedule.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { enabled: true },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /?fields=summary — #920 slice 47 slim-shape opt-in
// ─────────────────────────────────────────────────────────────────────────
// Mirrors slices 1-46. When the caller passes ?fields=summary, the route
// MUST switch from `include: { user: ... }` to a slim `select` that drops
// the heavy JSON-stringified columns (ReportSchedule.metrics +
// ReportSchedule.recipients, both `String? @db.Text` storing JSON
// arrays) and the user-include. Any non-exact value (`?fields=foo`,
// `?fields=`, omitted entirely) falls back to the full include shape.
// The tenant/admin scoping branch (admin sees all-in-tenant; non-admin
// scoped to req.user.userId) must be preserved unchanged on both
// branches — slim-shape is orthogonal to authz.

describe('GET /?fields=summary — slim-shape opt-in (#920 slice 47)', () => {
  test('?fields=summary uses slim select that drops metrics + recipients JSON columns', async () => {
    prisma.reportSchedule.findMany.mockResolvedValue([
      { id: 1, name: 'Weekly Deals', reportType: 'deals' },
    ]);

    const res = await request(makeApp({ tenantId: 42, role: 'ADMIN' }))
      .get('/api/report-schedules?fields=summary');

    expect(res.status).toBe(200);
    const callArg = prisma.reportSchedule.findMany.mock.calls[0][0];
    // Must use select, NOT include.
    expect(callArg.select).toBeDefined();
    expect(callArg.include).toBeUndefined();
    // Heavy JSON-stringified columns MUST be absent from select.
    expect(callArg.select).not.toHaveProperty('metrics');
    expect(callArg.select).not.toHaveProperty('recipients');
    // Light columns the list UI needs MUST be present.
    expect(callArg.select.id).toBe(true);
    expect(callArg.select.name).toBe(true);
    expect(callArg.select.reportType).toBe(true);
    expect(callArg.select.frequency).toBe(true);
    expect(callArg.select.format).toBe(true);
    expect(callArg.select.enabled).toBe(true);
    expect(callArg.select.lastRunAt).toBe(true);
    expect(callArg.select.tenantId).toBe(true);
    expect(callArg.select.userId).toBe(true);
  });

  test('no ?fields (default) preserves full include shape with user relation (back-compat)', async () => {
    prisma.reportSchedule.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 42, role: 'ADMIN' }))
      .get('/api/report-schedules');

    expect(res.status).toBe(200);
    const callArg = prisma.reportSchedule.findMany.mock.calls[0][0];
    expect(callArg.select).toBeUndefined();
    expect(callArg.include).toEqual({
      user: { select: { id: true, name: true, email: true } },
    });
  });

  test('?fields=foo (non-exact) falls back to full include shape — only exact "summary" opts in', async () => {
    prisma.reportSchedule.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 42, role: 'ADMIN' }))
      .get('/api/report-schedules?fields=foo');

    expect(res.status).toBe(200);
    const callArg = prisma.reportSchedule.findMany.mock.calls[0][0];
    expect(callArg.select).toBeUndefined();
    expect(callArg.include).toBeDefined();
    expect(callArg.include.user).toBeDefined();
  });

  test('?fields=summary preserves ADMIN tenant-wide scope (no userId filter)', async () => {
    prisma.reportSchedule.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 42, userId: 7, role: 'ADMIN' }))
      .get('/api/report-schedules?fields=summary');

    const callArg = prisma.reportSchedule.findMany.mock.calls[0][0];
    expect(callArg.where).toEqual({ tenantId: 42 });
    expect(callArg.where).not.toHaveProperty('userId');
    expect(callArg.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary preserves non-ADMIN scope (userId filter applied alongside slim select)', async () => {
    prisma.reportSchedule.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 42, userId: 7, role: 'USER' }))
      .get('/api/report-schedules?fields=summary');

    const callArg = prisma.reportSchedule.findMany.mock.calls[0][0];
    // authz scope is preserved orthogonally to slim-shape opt-in.
    expect(callArg.where).toEqual({ tenantId: 42, userId: 7 });
    // slim select still applies.
    expect(callArg.select).toBeDefined();
    expect(callArg.include).toBeUndefined();
  });
});
