// @ts-check
/**
 * Unit tests for backend/routes/notifications.js — pins the multi-tenant
 * notification CRUD + mark-read + preferences + push-integration surface
 * that backs NotificationBell.jsx, the Notifications page, and the
 * per-user preferences modal.
 *
 * Issue context
 * ─────────────
 *   #169  — type-enum validation (info|success|warning|error|system|deal|
 *           task|ticket) on POST /; non-admin broadcast 403; non-admin
 *           cross-user targeting 403; self-notify always allowed.
 *   #179  — admin DELETE / BROADCAST / cross-user CREATE all writeAudit.
 *   #185  — POST /:id/read + POST /mark-all-read + POST /read-all aliases
 *           introduced because external clients tested them and got 404
 *           when only PUT was wired. PATCH /:id alias for the same.
 *   #550  — DELETE /:id returns 204 No Content (was 200 + {message});
 *           PUT /read-all + POST /mark-all-read + POST /read-all return
 *           the canonical `{status,code,updated}` envelope.
 *   2026-05-13 cron-learning ("NotificationPreference.channels reshape")
 *         — channels are stored as a Json blob; the route surfaces them
 *           verbatim (so the {enabled} shape passes through if the
 *           caller posts it, but the route also accepts the legacy
 *           boolean shape — we pin both).
 *
 * What this file pins
 * ───────────────────
 *   GET /                — pagination, tenant + user scope, filters
 *                          (unread/status/priority/entityType).
 *   GET /unread-count    — count scope = userId + tenantId + isRead:false.
 *   PUT /read-all        — bulk mark-read envelope shape (#550).
 *   PUT /:id/read        — own row 200, cross-tenant 404.
 *   POST /:id/read       — alias delegates to same handler (#185).
 *   PATCH /:id           — alias delegates to same handler (#185).
 *   PATCH /:id/resolve   — sets isRead+readAt via resolve(), 400 on NaN id,
 *                          404 cross-tenant.
 *   POST /mark-all-read  — alias for read-all (#185), {status,code,updated}.
 *   POST /read-all       — alias (#185).
 *   DELETE /:id          — 204 No Content (#550), cross-tenant 404, writeAudit
 *                          fires with action='DELETE' (#179).
 *   POST /               — type-enum validation (#169), missing title/message
 *                          400, non-admin broadcast 403, non-admin cross-user
 *                          403, self-notify 201, admin broadcast 201, admin
 *                          cross-user 201, writeAudit on BROADCAST + cross-user
 *                          CREATE only (#179).
 *   GET /preferences     — DEFAULT_PREFERENCES when no row, persisted row
 *                          surfaced verbatim including the channels Json
 *                          blob (handles both {enabled} and boolean shapes).
 *   PUT /preferences     — upsert with HH:MM validation on quietHoursStart/
 *                          End; returns {status,code,preferences}.
 *   POST /preferences/reset — delete-then-default; surfaces DEFAULT_PREFERENCES.
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/field-permissions.test.js (commit
 *   40de08081): prisma singleton monkey-patch BEFORE router require + real
 *   JWT bearer signed with the config/secrets JWT_SECRET that verifyToken
 *   resolves to + CJS self-mocking seam for lib/notificationService
 *   (notify/notifyTenant/resolve) and lib/audit (writeAudit) so we can
 *   assert the integration without booting Prisma.
 *
 *   vi.mock against the CJS `require('../lib/notificationService')` /
 *   `require('../lib/audit')` does NOT reliably intercept in this repo's
 *   vitest config when the route DESTRUCTURES at top-of-module — node's
 *   require cache hands the route the same module-object identity we
 *   require here, so monkey-patching its exports also doesn't intercept
 *   the destructured local bindings. The route's `require()` happens at
 *   module-load time. So we use the prisma-mock surface as the bedrock
 *   contract: every assertion that exercises a notificationService call
 *   path is pinned via the underlying prisma.notification.create /
 *   prisma.user.findMany / prisma.notification.findFirst mocks that the
 *   real service calls into.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────
// Must happen BEFORE the router is required, since the router's top-level
// `require('../lib/prisma')` resolves at import time. notificationService
// also requires the same prisma module — same cached identity.
prisma.notification = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};
prisma.notificationPreference = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.user.findUnique = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
// verifyToken's revoked-token lookup hits prisma.revokedToken.findUnique;
// stub the surface so any incidental call returns "not revoked".
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { JWT_SECRET } = requireCJS('../../config/secrets');

function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

const notificationsRouter = requireCJS('../../routes/notifications');
// In production server.js, verifyToken is a GLOBAL guard (applied app-wide
// before the route mount). routes/notifications.js itself does not include
// verifyToken — so the test app has to wire it in explicitly, otherwise
// req.user is undefined and every handler throws.
const { verifyToken } = requireCJS('../../middleware/auth');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', verifyToken, notificationsRouter);
  return app;
}

beforeEach(() => {
  prisma.notification.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.findUnique.mockReset();
  prisma.notification.count.mockReset();
  prisma.notification.create.mockReset();
  prisma.notification.update.mockReset();
  prisma.notification.updateMany.mockReset();
  prisma.notification.delete.mockReset();
  prisma.notificationPreference.findUnique.mockReset();
  prisma.notificationPreference.upsert.mockReset();
  prisma.notificationPreference.delete.mockReset();
  prisma.user.findMany.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.auditLog.create.mockClear();
  prisma.auditLog.findFirst.mockClear();
});

// ── GET / — list with pagination + tenant scope + filters ───────────

describe('GET / — list notifications', () => {
  test('returns paginated rows scoped to req.user.userId + tenantId', async () => {
    prisma.notification.findMany.mockResolvedValue([
      { id: 1, title: 'A', userId: 7, tenantId: 1, isRead: false },
      { id: 2, title: 'B', userId: 7, tenantId: 1, isRead: true },
    ]);
    prisma.notification.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/notifications?page=1&limit=10')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
    expect(res.body.pages).toBe(1);

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 7, tenantId: 1 });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.skip).toBe(0);
    expect(args.take).toBe(10);
  });

  test('applies unread=true filter as isRead:false in the where clause', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications?unread=true')
      .set('Authorization', makeBearer());

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ userId: 7, tenantId: 1, isRead: false });
  });

  test('applies status=read filter as isRead:true', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications?status=read')
      .set('Authorization', makeBearer());

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ isRead: true });
  });

  test('applies priority + entityType filters verbatim', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications?priority=high&entityType=ticket')
      .set('Authorization', makeBearer());

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ priority: 'high', entityType: 'ticket' });
  });

  test('caps limit at 100 even when caller asks for more (DOS guardrail)', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications?limit=9999')
      .set('Authorization', makeBearer());

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.take).toBe(100);
  });

  test('returns 401 on missing Authorization header (tenant isolation gate)', async () => {
    const res = await request(makeApp()).get('/api/notifications');
    expect(res.status).toBe(401);
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  test('tenant isolation: a token with tenantId=2 cannot read tenant 1 rows', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications')
      .set('Authorization', makeBearer({ userId: 99, tenantId: 2 }));

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 99, tenantId: 2 });
    // Critically: tenantId is taken from the JWT, not the query string —
    // a hostile caller can't escalate by passing tenantId=1 in the URL.
  });
});

// ── GET /?fields=summary — slim-shape opt-in (#920 slice 7) ──────────
//
// Mirror of slice 1 (contacts), slice 2 (deals), slice 3 (tickets),
// slice 4 (tasks), slice 5 (projects). When the caller passes
// ?fields=summary, the route emits a slim Prisma `select` keyed on the
// columns NotificationBell + NotificationsCenter actually render and
// drops the heavier columns (link, entityType, entityId, readAt,
// type, priority, message) that would otherwise leak via list responses.

describe('GET /?fields=summary — slim-shape opt-in (#920 slice 7)', () => {
  test('?fields=summary triggers prisma.notification.findMany with `select` (slim cols), not the default no-select shape', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications?fields=summary')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.select).toEqual({
      id: true,
      title: true,
      isRead: true,
      userId: true,
      tenantId: true,
      createdAt: true,
    });
    // Slim shape must NOT include heavy/PII-leaking columns in the select map.
    expect(args.select.link).toBeUndefined();
    expect(args.select.entityType).toBeUndefined();
    expect(args.select.entityId).toBeUndefined();
    expect(args.select.message).toBeUndefined();
    expect(args.select.readAt).toBeUndefined();
    expect(args.select.type).toBeUndefined();
    expect(args.select.priority).toBeUndefined();
    // include must NOT be set on slim path.
    expect(args.include).toBeUndefined();
  });

  test('default (no ?fields) preserves the full-row shape — no `select` arg passed to findMany', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
    expect(args.include).toBeUndefined();
  });

  test('?fields=summary response rows reflect the slim Prisma select verbatim', async () => {
    // Prisma `select` honours only the chosen columns. The route forwards
    // whatever Prisma returns, so we pin the contract by mocking the slim
    // rows and confirming heavy keys are absent in the response body too.
    prisma.notification.findMany.mockResolvedValue([
      { id: 1, title: 'Slim A', isRead: false, userId: 7, tenantId: 1, createdAt: new Date('2026-05-26T00:00:00Z') },
      { id: 2, title: 'Slim B', isRead: true, userId: 7, tenantId: 1, createdAt: new Date('2026-05-26T01:00:00Z') },
    ]);
    prisma.notification.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/notifications?fields=summary')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(2);
    for (const row of res.body.notifications) {
      expect(row.id).toBeDefined();
      expect(row.title).toBeDefined();
      expect(row.isRead).toBeDefined();
      expect(row.link).toBeUndefined();
      expect(row.message).toBeUndefined();
      expect(row.entityType).toBeUndefined();
      expect(row.entityId).toBeUndefined();
      expect(row.readAt).toBeUndefined();
    }
  });

  test('?fields=summary preserves auth gate + tenant isolation on where clause', async () => {
    // Missing Authorization → 401 even with ?fields=summary.
    const unauth = await request(makeApp())
      .get('/api/notifications?fields=summary');
    expect(unauth.status).toBe(401);
    expect(prisma.notification.findMany).not.toHaveBeenCalled();

    // Authenticated call: tenantId is sourced from the JWT (not the query),
    // so the where clause is tenant-isolated regardless of the slim opt-in.
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/notifications?fields=summary')
      .set('Authorization', makeBearer({ userId: 99, tenantId: 2 }));
    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 99, tenantId: 2 });
  });

  test('?fields=summary honors pagination params (?page + ?limit) alongside the slim select', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications?fields=summary&page=3&limit=25')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.take).toBe(25);
    expect(args.skip).toBe(50); // (page - 1) * limit
    expect(args.select).toBeDefined();
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary combines with existing filters (unread/status/priority/entityType) on the where clause', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications?fields=summary&unread=true&priority=high&entityType=ticket')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      userId: 7,
      tenantId: 1,
      isRead: false,
      priority: 'high',
      entityType: 'ticket',
    });
    // Slim select still applied.
    expect(args.select).toBeDefined();
    expect(args.select.id).toBe(true);
  });

  test('?fields=other (any non-exact value) falls through to the default full-row shape', async () => {
    // Only the literal string "summary" opts into slim — every other value
    // (including "Summary", "full", arbitrary tokens) must preserve the
    // existing wire shape so we don't accidentally trim production callers.
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/notifications?fields=Summary')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
  });
});

// ── GET /unread-count ───────────────────────────────────────────────

describe('GET /unread-count', () => {
  test('returns the count scoped to userId + tenantId + isRead:false', async () => {
    prisma.notification.count.mockResolvedValue(3);
    const res = await request(makeApp())
      .get('/api/notifications/unread-count')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { userId: 7, tenantId: 1, isRead: false },
    });
  });
});

// ── PUT /read-all + POST aliases ────────────────────────────────────

describe('PUT /read-all + POST aliases (#185)', () => {
  test('PUT /read-all returns the canonical envelope shape (#550)', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 5 });
    const res = await request(makeApp())
      .put('/api/notifications/read-all')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      code: 'NOTIFICATIONS_MARKED_READ',
      updated: 5,
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 7, tenantId: 1, isRead: false },
      data: { isRead: true },
    });
  });

  test('POST /mark-all-read alias returns the same envelope (#185)', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 2 });
    const res = await request(makeApp())
      .post('/api/notifications/mark-all-read')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      code: 'NOTIFICATIONS_MARKED_READ',
      updated: 2,
    });
  });

  test('POST /read-all alias returns the same envelope (#185)', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(makeApp())
      .post('/api/notifications/read-all')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('NOTIFICATIONS_MARKED_READ');
    expect(res.body.updated).toBe(0);
  });
});

// ── PUT /:id/read + POST /:id/read + PATCH /:id ─────────────────────

describe('PUT /:id/read and aliases (#185)', () => {
  test('PUT /:id/read marks an own row read', async () => {
    prisma.notification.findFirst.mockResolvedValue({ id: 42, tenantId: 1, isRead: false });
    prisma.notification.update.mockResolvedValue({ id: 42, tenantId: 1, isRead: true });

    const res = await request(makeApp())
      .put('/api/notifications/42/read')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    expect(res.status).toBe(200);
    expect(res.body.isRead).toBe(true);
    // Tenant scoped lookup (own-tenant)
    expect(prisma.notification.findFirst).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 1 },
    });
  });

  test('PUT /:id/read returns 404 for cross-tenant id (tenant isolation)', async () => {
    prisma.notification.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/notifications/999/read')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));
    expect(res.status).toBe(404);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  test('POST /:id/read alias hits the same handler (#185)', async () => {
    prisma.notification.findFirst.mockResolvedValue({ id: 42, tenantId: 1 });
    prisma.notification.update.mockResolvedValue({ id: 42, isRead: true });
    const res = await request(makeApp())
      .post('/api/notifications/42/read')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    expect(res.body.isRead).toBe(true);
  });

  test('PATCH /:id alias hits the same handler (#185)', async () => {
    prisma.notification.findFirst.mockResolvedValue({ id: 42, tenantId: 1 });
    prisma.notification.update.mockResolvedValue({ id: 42, isRead: true });
    const res = await request(makeApp())
      .patch('/api/notifications/42')
      .set('Authorization', makeBearer())
      .send({ isRead: true });
    expect(res.status).toBe(200);
    expect(res.body.isRead).toBe(true);
  });
});

// ── PATCH /:id/resolve ──────────────────────────────────────────────

describe('PATCH /:id/resolve', () => {
  test('rejects non-numeric id with 400', async () => {
    const res = await request(makeApp())
      .patch('/api/notifications/abc/resolve')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid notification ID/);
  });

  test('returns 404 when the row is missing or cross-tenant', async () => {
    prisma.notification.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/notifications/999/resolve')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));
    expect(res.status).toBe(404);
  });

  test('resolves an own-tenant row (isRead+readAt)', async () => {
    prisma.notification.findFirst.mockResolvedValue({ id: 42, tenantId: 1, isRead: false });
    // The route delegates to lib/notificationService.resolve which itself
    // calls prisma.notification.update. Pin the underlying contract.
    prisma.notification.update.mockResolvedValue({
      id: 42, tenantId: 1, isRead: true, readAt: new Date('2026-01-01T00:00:00Z'),
    });

    const res = await request(makeApp())
      .patch('/api/notifications/42/resolve')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    expect(res.status).toBe(200);
    expect(res.body.isRead).toBe(true);
    expect(res.body.readAt).toBeTruthy();
  });
});

// ── DELETE /:id ─────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  test('returns 204 No Content with empty body (#550) and audits (#179)', async () => {
    prisma.notification.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, userId: 7, title: 'Important', type: 'info',
    });
    prisma.notification.delete.mockResolvedValue({ id: 42 });

    const res = await request(makeApp())
      .delete('/api/notifications/42')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.notification.delete).toHaveBeenCalledWith({ where: { id: 42 } });
    // #179 — audit row written
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.entity).toBe('Notification');
    expect(auditArgs.data.action).toBe('DELETE');
    expect(auditArgs.data.entityId).toBe(42);
    expect(auditArgs.data.tenantId).toBe(1);
  });

  test('cross-tenant id returns 404, does not audit, does not delete', async () => {
    prisma.notification.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/notifications/999')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));
    expect(res.status).toBe(404);
    expect(prisma.notification.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── POST / — create + deliver ────────────────────────────────────────

describe('POST / — create + deliver', () => {
  test('rejects missing title with 400', async () => {
    const res = await request(makeApp())
      .post('/api/notifications')
      .set('Authorization', makeBearer())
      .send({ message: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title and message are required/);
  });

  test('rejects missing message with 400', async () => {
    const res = await request(makeApp())
      .post('/api/notifications')
      .set('Authorization', makeBearer())
      .send({ title: 'hi' });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown type with 400 INVALID_NOTIFICATION_TYPE (#169)', async () => {
    const res = await request(makeApp())
      .post('/api/notifications')
      .set('Authorization', makeBearer())
      .send({ title: 'x', message: 'y', type: 'INVALID_TYPE_ZZZ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NOTIFICATION_TYPE');
  });

  test('accepts every allowed type from the enum (#169)', async () => {
    // self-notify (targetUserId === callerId) — preference lookup + create both fire
    prisma.notificationPreference.findUnique.mockResolvedValue(null);
    prisma.notification.findFirst.mockResolvedValue(null);
    prisma.notification.create.mockResolvedValue({ id: 1, title: 'x' });

    for (const t of ['info', 'success', 'warning', 'error', 'system', 'deal', 'task', 'ticket']) {
      prisma.notification.create.mockClear();
      const res = await request(makeApp())
        .post('/api/notifications')
        .set('Authorization', makeBearer({ userId: 7, tenantId: 1, role: 'USER' }))
        .send({ title: 'x', message: 'y', type: t, targetUserId: 7 });
      expect(res.status).toBe(201);
    }
  });

  test('non-admin broadcast (no targetUserId) → 403 BROADCAST_FORBIDDEN (#169)', async () => {
    const res = await request(makeApp())
      .post('/api/notifications')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1, role: 'USER' }))
      .send({ title: 'x', message: 'y' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BROADCAST_FORBIDDEN');
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('non-admin targeting another user → 403 CROSS_USER_FORBIDDEN (#169)', async () => {
    const res = await request(makeApp())
      .post('/api/notifications')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1, role: 'USER' }))
      .send({ title: 'x', message: 'y', targetUserId: 99 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CROSS_USER_FORBIDDEN');
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('non-admin self-notify (targetUserId === callerId) → 201', async () => {
    prisma.notificationPreference.findUnique.mockResolvedValue(null);
    prisma.notification.findFirst.mockResolvedValue(null);
    prisma.notification.create.mockResolvedValue({ id: 11, title: 'self' });

    const res = await request(makeApp())
      .post('/api/notifications')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1, role: 'USER' }))
      .send({ title: 'self', message: 'note', targetUserId: 7 });
    expect(res.status).toBe(201);
    expect(res.body.delivered).toBe(1);
    expect(res.body.notification.id).toBe(11);
    // Self-notify must NOT audit (#179: only cross-user is security-relevant)
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('admin broadcast → notifyTenant fans out, 201 + writeAudit BROADCAST (#179)', async () => {
    // notifyTenant → user.findMany → notify(per user) → preference + create
    prisma.user.findMany.mockResolvedValue([{ id: 7 }, { id: 8 }, { id: 9 }]);
    prisma.notificationPreference.findUnique.mockResolvedValue(null);
    prisma.notification.findFirst.mockResolvedValue(null);
    prisma.notification.create.mockResolvedValue({ id: 100, title: 'broadcast' });

    const res = await request(makeApp())
      .post('/api/notifications')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1, role: 'ADMIN' }))
      .send({ title: 'broadcast', message: 'all hands', type: 'system' });

    expect(res.status).toBe(201);
    expect(res.body.delivered).toBe(3);
    expect(Array.isArray(res.body.notifications)).toBe(true);
    expect(prisma.notification.create).toHaveBeenCalledTimes(3);

    // #179: BROADCAST audit row
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.entity).toBe('Notification');
    expect(auditArgs.data.action).toBe('BROADCAST');
    expect(auditArgs.data.entityId).toBeNull();
  });

  test('admin cross-user → 201 + writeAudit CREATE (#179)', async () => {
    prisma.notificationPreference.findUnique.mockResolvedValue(null);
    prisma.notification.findFirst.mockResolvedValue(null);
    prisma.notification.create.mockResolvedValue({ id: 55, title: 'hi' });

    const res = await request(makeApp())
      .post('/api/notifications')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1, role: 'ADMIN' }))
      .send({ title: 'hi', message: 'msg', targetUserId: 99 });

    expect(res.status).toBe(201);
    expect(res.body.delivered).toBe(1);
    expect(res.body.notification.id).toBe(55);

    // #179 — cross-user CREATE is audited
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe('CREATE');
    expect(auditArgs.data.entity).toBe('Notification');
  });
});

// ── GET /preferences ────────────────────────────────────────────────

describe('GET /preferences', () => {
  test('returns DEFAULT_PREFERENCES when no row exists', async () => {
    prisma.notificationPreference.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/notifications/preferences')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));
    expect(res.status).toBe(200);
    expect(res.body.categoryToggles.deal).toBe(true);
    expect(res.body.channels.db).toBe(true);
    expect(res.body.channels.push).toBe(false);
    expect(res.body.quietHoursStart).toBeNull();
    expect(res.body.quietHoursEnd).toBeNull();
    expect(res.body.timezone).toBeNull();
  });

  test('surfaces the persisted row verbatim (channels JSON blob preserved)', async () => {
    // 2026-05-13 cron-learning: NotificationPreference.channels can hold
    // either a legacy boolean blob or the newer {enabled} shape; route
    // must pass through whatever was persisted without coercing.
    prisma.notificationPreference.findUnique.mockResolvedValue({
      categoryToggles: { deal: false, task: true },
      channels: { db: { enabled: true }, socket: { enabled: false }, push: true, email: false },
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      timezone: 'Asia/Kolkata',
    });
    const res = await request(makeApp())
      .get('/api/notifications/preferences')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));
    expect(res.status).toBe(200);
    expect(res.body.categoryToggles).toEqual({ deal: false, task: true });
    // Both shapes pass through — the route doesn't mutate the blob
    expect(res.body.channels.db).toEqual({ enabled: true });
    expect(res.body.channels.push).toBe(true);
    expect(res.body.quietHoursStart).toBe('22:00');
    expect(res.body.quietHoursEnd).toBe('07:00');
    expect(res.body.timezone).toBe('Asia/Kolkata');
  });
});

// ── PUT /preferences ────────────────────────────────────────────────

describe('PUT /preferences', () => {
  test('upserts and returns {status,code,preferences}', async () => {
    prisma.notificationPreference.upsert.mockResolvedValue({
      categoryToggles: { deal: true },
      channels: { db: true, socket: true, push: false, email: false },
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      timezone: 'Asia/Kolkata',
    });
    const res = await request(makeApp())
      .put('/api/notifications/preferences')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }))
      .send({
        categoryToggles: { deal: true },
        channels: { db: true, socket: true, push: false, email: false },
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        timezone: 'Asia/Kolkata',
      });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('PREFERENCES_SAVED');
    expect(res.body.preferences.quietHoursStart).toBe('22:00');

    const args = prisma.notificationPreference.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 7 });
    expect(args.create.tenantId).toBe(1);
    expect(args.create.userId).toBe(7);
  });

  test('rejects malformed quietHoursStart with 400', async () => {
    const res = await request(makeApp())
      .put('/api/notifications/preferences')
      .set('Authorization', makeBearer())
      .send({ quietHoursStart: 'not-a-time' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/quietHoursStart must be in HH:MM format/);
    expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
  });

  test('rejects malformed quietHoursEnd with 400', async () => {
    // The validator is regex-only (`^\d{2}:\d{2}$`) — it pins the FORMAT,
    // not the semantic clock range. So '25:99' passes (it's a two-digit
    // colon two-digit string) even though it's not a real clock time.
    // The route relies on the frontend time picker to keep values sane.
    // Test the format gate with a non-matching shape.
    const res = await request(makeApp())
      .put('/api/notifications/preferences')
      .set('Authorization', makeBearer())
      .send({ quietHoursEnd: '7am' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/quietHoursEnd must be in HH:MM format/);
  });

  test('accepts the {enabled} channels object shape per 2026-05-13 cron-learning', async () => {
    prisma.notificationPreference.upsert.mockResolvedValue({
      categoryToggles: { deal: true },
      // Route doesn't validate channel shape — passes the JSON blob through
      // to Prisma.Json, so {enabled:true|false} object form survives.
      channels: {
        db: { enabled: true },
        socket: { enabled: true },
        push: { enabled: false },
        email: { enabled: false },
      },
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: null,
    });
    const res = await request(makeApp())
      .put('/api/notifications/preferences')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }))
      .send({
        channels: {
          db: { enabled: true },
          socket: { enabled: true },
          push: { enabled: false },
          email: { enabled: false },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.preferences.channels.db).toEqual({ enabled: true });
  });
});

// ── POST /preferences/reset ─────────────────────────────────────────

describe('POST /preferences/reset', () => {
  test('deletes the row and surfaces DEFAULT_PREFERENCES', async () => {
    prisma.notificationPreference.delete.mockResolvedValue({});
    const res = await request(makeApp())
      .post('/api/notifications/preferences/reset')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('PREFERENCES_RESET');
    expect(res.body.preferences.categoryToggles.deal).toBe(true);
    expect(res.body.preferences.channels.db).toBe(true);
    expect(prisma.notificationPreference.delete).toHaveBeenCalledWith({
      where: { userId: 7 },
    });
  });

  test('is idempotent when the row does not exist (catches the delete throw)', async () => {
    prisma.notificationPreference.delete.mockRejectedValue(new Error('not found'));
    const res = await request(makeApp())
      .post('/api/notifications/preferences/reset')
      .set('Authorization', makeBearer({ userId: 7, tenantId: 1 }));
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('PREFERENCES_RESET');
  });
});
