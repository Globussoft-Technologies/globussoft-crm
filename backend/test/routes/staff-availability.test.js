// @ts-check
/**
 * Unit tests for the availability endpoints under `backend/routes/users.js`
 * (PRD_TRAVEL_MULTICHANNEL_LEADS G008 — FR-3.3.5).
 *
 * Surface under test
 * ──────────────────
 *   1. PUT /api/users/me/availability — any role
 *      - 200 happy: flips the caller's own isAvailable + returns the slim slice
 *      - 400 when body.isAvailable is missing/not-a-bool
 *
 *   2. PUT /api/users/:userId/availability — ADMIN / MANAGER only
 *      - 401/403 from verifyRole when role=USER
 *      - 200 when role=ADMIN
 *      - 200 when role=MANAGER
 *      - 400 when :userId is not a positive integer
 *      - 400 when body.isAvailable not a bool
 *      - 403 cross-tenant (target's tenantId != caller's tenantId)
 *      - 404 when target user not found
 *
 * Naming the file `staff-availability.test.js` (not `users.test.js`) keeps
 * the surface-of-concern obvious in test logs and lines up with the allowed-
 * files list in the PRD slice prompt — these are the ops endpoints that the
 * Staff Directory + Lead Routing UI consume, not RBAC-permission readouts
 * (which already have their own coverage in `users-permissions.test.js`).
 *
 * Mocking strategy mirrors `lead-routing.test.js`: patch the prisma
 * singleton + a fake-auth middleware in `makeApp({ role, tenantId, userId })`
 * so the same router exercises every role permutation.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching BEFORE the router is required ────────────
const prisma = requireCJS('../../lib/prisma');

prisma.user = prisma.user || {};
prisma.user.update = vi.fn();
prisma.user.findUnique = vi.fn();

// audit lib's writeAudit is best-effort in the route — stub it so the
// test env never blows up trying to touch AuditLog without DATABASE_URL.
const audit = requireCJS('../../lib/audit');
audit.writeAudit = vi.fn().mockResolvedValue(undefined);

// auth middleware: we stub verifyToken to a pass-through (the global
// guard does the work in server.js) and use a real verifyRole.
const authMiddleware = requireCJS('../../middleware/auth');
authMiddleware.verifyToken = (req, _res, next) => next();
// verifyRole is real — uses req.user.role which we populate per request.

import express from 'express';
import request from 'supertest';

const usersRouter = requireCJS('../../routes/users');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/users', usersRouter);
  return app;
}

beforeEach(() => {
  prisma.user.update.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.user.update.mockResolvedValue({ id: 1, name: 'X', email: 'x@y.z', isAvailable: true });
  prisma.user.findUnique.mockResolvedValue(null);
  audit.writeAudit.mockClear();
});

// ─────────────────────────────────────────────────────────────────────
// PUT /api/users/me/availability — self-service, any role
// ─────────────────────────────────────────────────────────────────────

describe('PUT /api/users/me/availability — self-service', () => {
  test('200: flips caller`s own isAvailable + returns the slim slice', async () => {
    prisma.user.update.mockResolvedValue({
      id: 42, name: 'Rishu', email: 'rishu@example.com', isAvailable: false,
    });
    const res = await request(makeApp({ userId: 42, role: 'USER' }))
      .put('/api/users/me/availability')
      .send({ isAvailable: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 42, name: 'Rishu', email: 'rishu@example.com', isAvailable: false,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { isAvailable: false },
      select: { id: true, name: true, email: true, isAvailable: true },
    });
  });

  test('200: any role can flip self (USER allowed; no verifyRole gate)', async () => {
    prisma.user.update.mockResolvedValue({ id: 5, name: 'U', email: 'u@e', isAvailable: true });
    const res = await request(makeApp({ userId: 5, role: 'USER' }))
      .put('/api/users/me/availability')
      .send({ isAvailable: true });
    expect(res.status).toBe(200);
  });

  test('400 when body.isAvailable is missing', async () => {
    const res = await request(makeApp({ userId: 5, role: 'USER' }))
      .put('/api/users/me/availability')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/isAvailable must be a boolean/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('400 when body.isAvailable is not a boolean (e.g. string "maybe")', async () => {
    const res = await request(makeApp({ userId: 5, role: 'USER' }))
      .put('/api/users/me/availability')
      .send({ isAvailable: 'maybe' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/boolean/i);
  });

  test('accepts boolean-coerceable forms: "true" / "false" / 1 / 0', async () => {
    prisma.user.update.mockResolvedValue({ id: 5, name: 'U', email: 'u@e', isAvailable: true });
    for (const v of ['true', 'false', 1, 0]) {
      prisma.user.update.mockClear();
      const res = await request(makeApp({ userId: 5, role: 'USER' }))
        .put('/api/users/me/availability')
        .send({ isAvailable: v });
      expect(res.status, `coerce failed for ${JSON.stringify(v)}`).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// PUT /api/users/:userId/availability — admin / manager only
// ─────────────────────────────────────────────────────────────────────

describe('PUT /api/users/:userId/availability — admin/manager only', () => {
  test('401/403 when caller role=USER (verifyRole gate)', async () => {
    const res = await request(makeApp({ userId: 7, role: 'USER' }))
      .put('/api/users/42/availability')
      .send({ isAvailable: false });
    expect([401, 403]).toContain(res.status);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('200 when caller role=ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 42, tenantId: 1 });
    prisma.user.update.mockResolvedValue({
      id: 42, name: 'T', email: 't@e', isAvailable: false,
    });
    const res = await request(makeApp({ userId: 7, tenantId: 1, role: 'ADMIN' }))
      .put('/api/users/42/availability')
      .send({ isAvailable: false });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
    expect(res.body.isAvailable).toBe(false);
  });

  test('200 when caller role=MANAGER', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 42, tenantId: 1 });
    prisma.user.update.mockResolvedValue({
      id: 42, name: 'T', email: 't@e', isAvailable: true,
    });
    const res = await request(makeApp({ userId: 7, tenantId: 1, role: 'MANAGER' }))
      .put('/api/users/42/availability')
      .send({ isAvailable: true });
    expect(res.status).toBe(200);
  });

  test('400 when :userId is not a positive integer', async () => {
    const res = await request(makeApp({ role: 'ADMIN' }))
      .put('/api/users/-3/availability')
      .send({ isAvailable: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid userid/i);
  });

  test('400 when body.isAvailable not a bool', async () => {
    const res = await request(makeApp({ role: 'ADMIN' }))
      .put('/api/users/42/availability')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/boolean/i);
  });

  test('404 when target user not found', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await request(makeApp({ role: 'ADMIN' }))
      .put('/api/users/99999/availability')
      .send({ isAvailable: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/user not found/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('403 when target lives in a different tenant', async () => {
    // Caller in tenant 1; target in tenant 99.
    prisma.user.findUnique.mockResolvedValue({ id: 42, tenantId: 99 });
    const res = await request(makeApp({ userId: 7, tenantId: 1, role: 'ADMIN' }))
      .put('/api/users/42/availability')
      .send({ isAvailable: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CROSS_TENANT_DENIED');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('writes a best-effort AVAILABILITY_ADMIN audit row', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 42, tenantId: 1 });
    prisma.user.update.mockResolvedValue({
      id: 42, name: 'T', email: 't@e', isAvailable: false,
    });
    const res = await request(makeApp({ userId: 7, tenantId: 1, role: 'ADMIN' }))
      .put('/api/users/42/availability')
      .send({ isAvailable: false });
    expect(res.status).toBe(200);
    expect(audit.writeAudit).toHaveBeenCalled();
    const [entity, action, entityId, actorId, tenantId, details] =
      audit.writeAudit.mock.calls[0];
    expect(entity).toBe('User');
    expect(action).toBe('AVAILABILITY_ADMIN');
    expect(entityId).toBe(42);
    expect(actorId).toBe(7);
    expect(tenantId).toBe(1);
    expect(details).toEqual({ isAvailable: false, targetUserId: 42 });
  });
});
