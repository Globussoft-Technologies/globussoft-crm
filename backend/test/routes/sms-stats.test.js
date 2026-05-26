// @ts-check
/**
 * Communications polish — pin GET /api/sms/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header -> 401.
 *   - 400 INVALID_DATE on bad ?from (independent validation, no findMany leak).
 *   - 400 INVALID_DATE on bad ?to.
 *   - Empty-tenant: zeroed envelope with byDirection={INBOUND:0,OUTBOUND:0},
 *     byStatus={}, deliveredCount/failedCount/inboundCount=0,
 *     lastMessageAt=null.
 *   - Happy path: mixed direction + status -> correct buckets + counters.
 *   - byStatus omits empty buckets entirely (no QUEUED:0 noise).
 *   - byDirection ALWAYS includes both INBOUND + OUTBOUND keys (pre-seeded).
 *   - Null/undefined direction falls back to OUTBOUND (mirrors schema default).
 *   - Null/undefined status falls back to QUEUED (mirrors schema default).
 *   - deliveredCount tracks status='DELIVERED'; failedCount tracks 'FAILED';
 *     inboundCount tracks direction='INBOUND'.
 *   - lastMessageAt: max(createdAt) ISO across selected rows.
 *   - Tenant isolation: prisma where.tenantId = req.user.tenantId.
 *   - ?from / ?to narrows the window via createdAt gte/lte on the same
 *     findMany call.
 *   - findMany select limits columns to {direction, status, createdAt} —
 *     SmsMessage.body LongText MUST NOT be selected.
 *   - NO audit row written (read-only meta surface).
 *   - 500 envelope on prisma error does not leak stack.
 *
 * Schema notes (verified against prisma/schema.prisma:1454-1479)
 * ------------------------------------------------------------
 *   - SmsMessage.direction default "OUTBOUND" — INBOUND | OUTBOUND.
 *   - SmsMessage.status default "QUEUED" — QUEUED, SENT, DELIVERED, FAILED,
 *     RECEIVED.
 *   - SmsMessage.body is String @db.Text — DO NOT select it for an aggregate.
 *   - SmsMessage.createdAt is DateTime @default(now()).
 *
 * Pattern reference: document-templates-stats.test.js (canonical CRM polish
 * /stats pattern). sms.js exports `module.exports = router` directly
 * (single-export). /stats endpoint mounts explicit verifyToken so the
 * 401-gate case can be exercised in isolation.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.smsMessage = prisma.smsMessage || {};
prisma.smsMessage.findMany = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const smsRouter = requireCJS('../../routes/sms');
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sms', smsRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.smsMessage.findMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/sms/stats', () => {
  test('auth gate: missing Authorization header -> 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/sms/stats');
    expect(res.status).toBe(401);
    expect(prisma.smsMessage.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from (no findMany leak)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.smsMessage.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to (no findMany leak)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats?to=also-not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.smsMessage.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope with pre-seeded direction keys', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byDirection: { INBOUND: 0, OUTBOUND: 0 },
      byStatus: {},
      deliveredCount: 0,
      failedCount: 0,
      inboundCount: 0,
      lastMessageAt: null,
    });
  });

  test('happy path: 6 messages (3 OUTBOUND-DELIVERED, 1 OUTBOUND-FAILED, 2 INBOUND-RECEIVED) -> all aggregates correct', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([
      { direction: 'OUTBOUND', status: 'DELIVERED', createdAt: new Date('2026-05-01T10:00:00Z') },
      { direction: 'OUTBOUND', status: 'DELIVERED', createdAt: new Date('2026-05-02T10:00:00Z') },
      { direction: 'OUTBOUND', status: 'DELIVERED', createdAt: new Date('2026-05-03T10:00:00Z') },
      { direction: 'OUTBOUND', status: 'FAILED',    createdAt: new Date('2026-05-04T10:00:00Z') },
      { direction: 'INBOUND',  status: 'RECEIVED',  createdAt: new Date('2026-05-05T10:00:00Z') },
      { direction: 'INBOUND',  status: 'RECEIVED',  createdAt: new Date('2026-05-06T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(6);
    expect(res.body.byDirection).toEqual({ INBOUND: 2, OUTBOUND: 4 });
    expect(res.body.byStatus).toEqual({ DELIVERED: 3, FAILED: 1, RECEIVED: 2 });
    expect(res.body.deliveredCount).toBe(3);
    expect(res.body.failedCount).toBe(1);
    expect(res.body.inboundCount).toBe(2);
    expect(res.body.lastMessageAt).toBe(new Date('2026-05-06T10:00:00Z').toISOString());
  });

  test('byStatus omits empty buckets entirely (no QUEUED:0 noise)', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([
      { direction: 'OUTBOUND', status: 'SENT', createdAt: new Date('2026-05-01T10:00:00Z') },
      { direction: 'OUTBOUND', status: 'SENT', createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byStatus).toEqual({ SENT: 2 });
    expect(res.body.byStatus.QUEUED).toBeUndefined();
    expect(res.body.byStatus.DELIVERED).toBeUndefined();
    expect(res.body.byStatus.FAILED).toBeUndefined();
    expect(res.body.byStatus.RECEIVED).toBeUndefined();
  });

  test('byDirection ALWAYS includes both INBOUND + OUTBOUND keys (pre-seeded), even when one is zero', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([
      { direction: 'OUTBOUND', status: 'SENT', createdAt: new Date('2026-05-01T10:00:00Z') },
      { direction: 'OUTBOUND', status: 'SENT', createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byDirection).toEqual({ INBOUND: 0, OUTBOUND: 2 });
    expect(Object.keys(res.body.byDirection).sort()).toEqual(['INBOUND', 'OUTBOUND']);
  });

  test('null/undefined direction falls back to OUTBOUND (mirrors schema default)', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([
      { direction: null,      status: 'SENT', createdAt: new Date('2026-05-01T10:00:00Z') },
      { direction: undefined, status: 'SENT', createdAt: new Date('2026-05-02T10:00:00Z') },
      { direction: 'INBOUND', status: 'RECEIVED', createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.byDirection).toEqual({ INBOUND: 1, OUTBOUND: 2 });
    expect(res.body.inboundCount).toBe(1);
  });

  test('null/undefined status falls back to QUEUED (mirrors schema default)', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([
      { direction: 'OUTBOUND', status: null,      createdAt: new Date('2026-05-01T10:00:00Z') },
      { direction: 'OUTBOUND', status: undefined, createdAt: new Date('2026-05-02T10:00:00Z') },
      { direction: 'OUTBOUND', status: 'SENT',    createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.byStatus).toEqual({ QUEUED: 2, SENT: 1 });
  });

  test('lastMessageAt: max(createdAt) ISO across selected rows', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.smsMessage.findMany.mockResolvedValue([
      { direction: 'OUTBOUND', status: 'DELIVERED', createdAt: new Date('2026-05-01T10:00:00Z') },
      { direction: 'OUTBOUND', status: 'DELIVERED', createdAt: newest },
      { direction: 'OUTBOUND', status: 'SENT',      createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastMessageAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const findWhere = prisma.smsMessage.findMany.mock.calls[0][0].where;
    expect(findWhere.tenantId).toBe(42);
  });

  test('?from/?to: narrows the window via createdAt gte/lte clauses', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/sms/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const findWhere = prisma.smsMessage.findMany.mock.calls[0][0].where;
    expect(findWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(findWhere.createdAt.lte).toEqual(new Date(toIso));
  });

  test('findMany select limits columns to {direction, status, createdAt} — NEVER body', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.smsMessage.findMany.mock.calls[0][0];
    expect(callArg.select).toEqual({ direction: true, status: true, createdAt: true });
    // body is @db.Text LongText — MUST NOT be selected for an aggregate
    // (would pull every message body into memory).
    expect(callArg.select.body).toBeUndefined();
    expect(callArg.select.to).toBeUndefined();
    expect(callArg.select.from).toBeUndefined();
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([
      { direction: 'OUTBOUND', status: 'DELIVERED', createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('500 envelope on prisma error (does not leak stack)', async () => {
    prisma.smsMessage.findMany.mockRejectedValue(new Error('boom'));

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to compute SMS stats');
    // Sanity: no `stack` field surfaced.
    expect(res.body.stack).toBeUndefined();
  });

  test('USER role can access /stats (mirrors GET /messages auth posture)', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    // verifyToken-only gate — USER role accepted.
    expect(res.status).toBe(200);
  });

  test('MANAGER role can access /stats', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sms/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
  });
});
