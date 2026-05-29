// @ts-check
/**
 * Unit tests for GET /api/tickets/stats — the first /stats endpoint shipped
 * on the support ticket route. CRM polish slice.
 *
 * What's pinned (≥10 cases across 6 describe blocks)
 * ──────────────────────────────────────────────────
 *   1. 401 — no Authorization header (verifyToken refuses).
 *   2. 400 INVALID_DATE — bad ?from query value.
 *   3. 400 INVALID_DATE — bad ?to query value.
 *   4. Empty-tenant happy path — zeroed shape with avgResolutionHours=null
 *      and lastCreatedAt=null.
 *   5. Happy path — 5 tickets across statuses + priorities — byStatus +
 *      byPriority + total + openCount.
 *   6. openCount EXCLUDES terminal states (Resolved + Closed + Cancelled).
 *      Sibling enum: VALID_STATUSES = [Open, Pending, Resolved, Closed];
 *      we exclude "Cancelled" defensively for forward-compat.
 *   7. slaBreachedCount counts only tickets where breachedAt IS NOT NULL.
 *      (Schema: Ticket.breached Boolean + Ticket.breachedAt DateTime.)
 *   8. avgResolutionHours formula — average across resolved-only,
 *      half-up to 2dp.
 *   9. avgResolutionHours=null when zero resolved tickets are present.
 *  10. lastCreatedAt — max(createdAt) ISO across all tickets, regardless
 *      of status.
 *  11. Tenant isolation — the route's where-clause includes tenantId
 *      pulled from the bearer's JWT claim; findMany sees exactly that.
 *  12. ?from / ?to narrows the createdAt window — both clauses land in
 *      where.createdAt with gte/lte respectively.
 *  13. No audit row written — read-only meta surface; mirrors
 *      travel_suppliers/stats + deals/stats posture.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/tickets.test.js — prisma singleton patch +
 * real JWT bearer signed with config/secrets.JWT_SECRET so the real
 * verifyToken middleware passes. routes/tickets.js does NOT mount
 * verifyToken inline (it relies on the global guard in server.js), so the
 * test app wires it manually via `app.use('/api/tickets', verifyToken, ...)`.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────────
// Must happen BEFORE the router is required, since the router's top-level
// `require('../lib/prisma')` resolves at import time.
prisma.ticket = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.slaPolicy = prisma.slaPolicy || {};
prisma.slaPolicy.findFirst = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });

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

const { verifyToken } = requireCJS('../../middleware/auth');
const ticketsRouter = requireCJS('../../routes/tickets');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tickets', verifyToken, ticketsRouter);
  return app;
}

beforeEach(() => {
  prisma.ticket.findMany.mockReset();
  prisma.ticket.findFirst.mockReset();
  prisma.slaPolicy.findFirst.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

// ── auth gate ────────────────────────────────────────────────────────────

describe('GET /stats — auth gate', () => {
  test('401 when no Authorization header is sent', async () => {
    const res = await request(makeApp()).get('/api/tickets/stats');
    expect(res.status).toBe(401);
    expect(prisma.ticket.findMany).not.toHaveBeenCalled();
  });
});

// ── ?from / ?to validation ───────────────────────────────────────────────

describe('GET /stats — date validation', () => {
  test('400 INVALID_DATE on bad ?from', async () => {
    const res = await request(makeApp())
      .get('/api/tickets/stats?from=not-a-date')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.ticket.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const res = await request(makeApp())
      .get('/api/tickets/stats?to=garbage-string')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.ticket.findMany).not.toHaveBeenCalled();
  });

  test('?from / ?to narrow the createdAt window — both gte + lte land in where', async () => {
    prisma.ticket.findMany.mockResolvedValue([]);
    const from = '2026-05-01T00:00:00.000Z';
    const to = '2026-05-31T23:59:59.999Z';

    const res = await request(makeApp())
      .get(`/api/tickets/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(prisma.ticket.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.ticket.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.createdAt.gte).toEqual(new Date(from));
    expect(call.where.createdAt.lte).toEqual(new Date(to));
  });
});

// ── empty-tenant short-circuit ───────────────────────────────────────────

describe('GET /stats — empty tenant', () => {
  test('returns zeroed shape with avgResolutionHours=null + lastCreatedAt=null', async () => {
    prisma.ticket.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: {},
      byPriority: {},
      openCount: 0,
      slaBreachedCount: 0,
      avgResolutionHours: null,
      lastCreatedAt: null,
    });
  });
});

// ── happy path — byStatus + byPriority + counts ──────────────────────────

describe('GET /stats — 5-ticket happy path', () => {
  test('byStatus + byPriority + total + openCount bucketed correctly', async () => {
    const t0 = new Date('2026-05-20T10:00:00.000Z');
    const t1 = new Date('2026-05-21T10:00:00.000Z');
    const t2 = new Date('2026-05-22T10:00:00.000Z');
    const t3 = new Date('2026-05-23T10:00:00.000Z');
    const t4 = new Date('2026-05-24T10:00:00.000Z');
    prisma.ticket.findMany.mockResolvedValue([
      { status: 'Open', priority: 'High', createdAt: t0, resolvedAt: null, breachedAt: null },
      { status: 'Open', priority: 'Low', createdAt: t1, resolvedAt: null, breachedAt: null },
      { status: 'Pending', priority: 'Medium', createdAt: t2, resolvedAt: null, breachedAt: null },
      { status: 'Resolved', priority: 'Urgent', createdAt: t3, resolvedAt: new Date(t3.getTime() + 2 * 3600000), breachedAt: null },
      { status: 'Closed', priority: 'Low', createdAt: t4, resolvedAt: new Date(t4.getTime() + 4 * 3600000), breachedAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byStatus).toEqual({ Open: 2, Pending: 1, Resolved: 1, Closed: 1 });
    expect(res.body.byPriority).toEqual({ High: 1, Low: 2, Medium: 1, Urgent: 1 });
    // openCount = Open + Pending = 3 (Resolved + Closed are terminal).
    expect(res.body.openCount).toBe(3);
  });
});

// ── openCount excludes terminal states ───────────────────────────────────

describe('GET /stats — openCount terminal exclusion', () => {
  test('openCount excludes Resolved + Closed + Cancelled (case-insensitive)', async () => {
    const now = new Date('2026-05-20T00:00:00.000Z');
    prisma.ticket.findMany.mockResolvedValue([
      { status: 'Open', priority: 'Low', createdAt: now, resolvedAt: null, breachedAt: null },
      { status: 'Pending', priority: 'Low', createdAt: now, resolvedAt: null, breachedAt: null },
      { status: 'Resolved', priority: 'Low', createdAt: now, resolvedAt: now, breachedAt: null },
      { status: 'Closed', priority: 'Low', createdAt: now, resolvedAt: now, breachedAt: null },
      // Defensive forward-compat — Ticket schema today is [Open,Pending,Resolved,Closed],
      // but `support.js` siblings already use "Cancelled" — stats endpoint
      // treats it as terminal too.
      { status: 'Cancelled', priority: 'Low', createdAt: now, resolvedAt: null, breachedAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    // Open + Pending = 2 open; Resolved + Closed + Cancelled = 3 terminal.
    expect(res.body.openCount).toBe(2);
  });
});

// ── slaBreachedCount: only non-null breachedAt ───────────────────────────

describe('GET /stats — slaBreachedCount', () => {
  test('counts ONLY tickets where breachedAt IS NOT NULL', async () => {
    const now = new Date('2026-05-20T00:00:00.000Z');
    prisma.ticket.findMany.mockResolvedValue([
      { status: 'Open', priority: 'Low', createdAt: now, resolvedAt: null, breachedAt: null },
      { status: 'Open', priority: 'High', createdAt: now, resolvedAt: null, breachedAt: new Date('2026-05-20T05:00:00.000Z') },
      { status: 'Pending', priority: 'Urgent', createdAt: now, resolvedAt: null, breachedAt: new Date('2026-05-20T07:00:00.000Z') },
      { status: 'Resolved', priority: 'Low', createdAt: now, resolvedAt: now, breachedAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.slaBreachedCount).toBe(2);
  });
});

// ── avgResolutionHours ───────────────────────────────────────────────────

describe('GET /stats — avgResolutionHours', () => {
  test('averages (resolvedAt - createdAt) / 3_600_000 across resolved tickets, half-up to 2dp', async () => {
    const base = new Date('2026-05-20T00:00:00.000Z');
    prisma.ticket.findMany.mockResolvedValue([
      // 2h to resolve
      { status: 'Resolved', priority: 'Low', createdAt: base, resolvedAt: new Date(base.getTime() + 2 * 3600000), breachedAt: null },
      // 4h to resolve
      { status: 'Closed', priority: 'Low', createdAt: base, resolvedAt: new Date(base.getTime() + 4 * 3600000), breachedAt: null },
      // 9h to resolve — average of [2,4,9] = 5
      { status: 'Resolved', priority: 'Low', createdAt: base, resolvedAt: new Date(base.getTime() + 9 * 3600000), breachedAt: null },
      // unresolved — does NOT participate in the average
      { status: 'Open', priority: 'Low', createdAt: base, resolvedAt: null, breachedAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.avgResolutionHours).toBe(5);
  });

  test('avgResolutionHours=null when zero resolved tickets exist', async () => {
    const now = new Date('2026-05-20T00:00:00.000Z');
    prisma.ticket.findMany.mockResolvedValue([
      { status: 'Open', priority: 'Low', createdAt: now, resolvedAt: null, breachedAt: null },
      { status: 'Pending', priority: 'Medium', createdAt: now, resolvedAt: null, breachedAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.avgResolutionHours).toBeNull();
  });

  test('avgResolutionHours half-up rounded to 2dp', async () => {
    const base = new Date('2026-05-20T00:00:00.000Z');
    // 1h + 2h + 2h = 5/3 = 1.6666... → 1.67 (half-up to 2dp)
    prisma.ticket.findMany.mockResolvedValue([
      { status: 'Resolved', priority: 'Low', createdAt: base, resolvedAt: new Date(base.getTime() + 1 * 3600000), breachedAt: null },
      { status: 'Resolved', priority: 'Low', createdAt: base, resolvedAt: new Date(base.getTime() + 2 * 3600000), breachedAt: null },
      { status: 'Resolved', priority: 'Low', createdAt: base, resolvedAt: new Date(base.getTime() + 2 * 3600000), breachedAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.avgResolutionHours).toBe(1.67);
  });
});

// ── lastCreatedAt ────────────────────────────────────────────────────────

describe('GET /stats — lastCreatedAt', () => {
  test('returns max(createdAt) ISO across all tickets regardless of status', async () => {
    const oldest = new Date('2026-05-01T00:00:00.000Z');
    const newest = new Date('2026-05-24T12:34:56.000Z');
    const middle = new Date('2026-05-15T08:00:00.000Z');
    prisma.ticket.findMany.mockResolvedValue([
      { status: 'Open', priority: 'Low', createdAt: oldest, resolvedAt: null, breachedAt: null },
      { status: 'Resolved', priority: 'High', createdAt: newest, resolvedAt: new Date(newest.getTime() + 3600000), breachedAt: null },
      { status: 'Pending', priority: 'Medium', createdAt: middle, resolvedAt: null, breachedAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────

describe('GET /stats — tenant isolation', () => {
  test('findMany is called with the bearer JWT tenantId in the where clause', async () => {
    prisma.ticket.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer({ tenantId: 42 }));

    expect(res.status).toBe(200);
    expect(prisma.ticket.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.ticket.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(42);
  });
});

// ── no audit row written ─────────────────────────────────────────────────

describe('GET /stats — no audit row written', () => {
  test('read-only meta surface — no prisma.auditLog.create call fires', async () => {
    const now = new Date('2026-05-20T00:00:00.000Z');
    prisma.ticket.findMany.mockResolvedValue([
      { status: 'Open', priority: 'Low', createdAt: now, resolvedAt: null, breachedAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets/stats')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
