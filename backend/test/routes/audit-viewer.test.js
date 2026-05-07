// @ts-check
/**
 * Unit-level RBAC pin for backend/routes/audit_viewer.js — closes #621.
 *
 * Issue context
 * ─────────────
 *   #621 — Manager could open Audit Log in Generic CRM (`['ADMIN','MANAGER']`
 *          on the route) but the wellness sidebar's `adminOnly` flag hid the
 *          link AND the toast wording said "System Admin Required". Three
 *          inconsistent surfaces of the same role contract. Default chosen:
 *          ADMIN-only across both verticals — backend tightens to `['ADMIN']`,
 *          sidebar `adminOnly` flag stays, RoleGuard already redirects
 *          non-ADMIN to /dashboard (#589 fix in `76d94ad`).
 *
 * What this file pins
 * ───────────────────
 *   1. ADMIN bearer token reaches the GET / handler (route mounted, gate
 *      not over-tightened).
 *   2. MANAGER bearer token returns 403 with `code: 'RBAC_DENIED'` and a
 *      neutral `error` string — the canonical envelope from #590/#591.
 *   3. USER bearer token also returns 403 RBAC_DENIED.
 *   4. Missing Authorization header returns 401 (verifyToken fail-closed).
 *
 * Test pattern
 * ────────────
 *   Mirror of communications.test.js — patch the prisma singleton's
 *   `auditLog` model with vi.fn() before requiring the router so the
 *   handler doesn't hit a real DB. Mount on a bare express app and
 *   drive with supertest. Tokens are real HS256 JWTs signed with the
 *   same fallback secret the middleware uses in dev — verifyToken is
 *   the actual middleware in the chain (we don't bypass it).
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router (router resolves prisma at
// import-time via top-level require).
prisma.auditLog = {
  findMany: vi.fn(),
  count: vi.fn(),
  groupBy: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue(null);
prisma.user.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// auth middleware reads JWT_SECRET at module init — keep this in sync
// with backend/middleware/auth.js's fallback so signing works in tests.
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

const auditViewerRouter = requireCJS('../../routes/audit_viewer');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/audit-viewer', auditViewerRouter);
  return app;
}

function tokenFor(role) {
  return jwt.sign(
    { userId: 1, tenantId: 1, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeAll(() => {
  // verifyToken does an optional revoked-token lookup — stub it absent.
  prisma.revokedToken = prisma.revokedToken || {};
  prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
});

beforeEach(() => {
  prisma.auditLog.findMany.mockReset();
  prisma.auditLog.count.mockReset();
  prisma.auditLog.findMany.mockResolvedValue([]);
  prisma.auditLog.count.mockResolvedValue(0);
});

describe('audit_viewer RBAC — #621 ADMIN-only', () => {
  test('GET / without Authorization → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/audit-viewer');
    expect(res.status).toBe(401);
  });

  test('GET / with MANAGER token → 403 with canonical RBAC_DENIED envelope', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
    // Defence in depth: route handler must NOT have been entered.
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('GET /stats with MANAGER token → 403 RBAC_DENIED', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('GET /export.csv with MANAGER token → 403 RBAC_DENIED', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer/export.csv')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('GET / with USER token → 403 RBAC_DENIED', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('GET / with ADMIN token → 200 and reaches the handler', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?page=1&limit=10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
    expect(prisma.auditLog.findMany).toHaveBeenCalled();
  });
});
