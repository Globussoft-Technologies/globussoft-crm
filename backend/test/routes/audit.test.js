// @ts-check
/**
 * Route-level tests for backend/routes/audit.js — the GET / listing handler.
 *
 * What this file pins
 * ───────────────────
 *   GET /api/audit — ADMIN-only audit-log LIST endpoint at
 *   backend/routes/audit.js:10-31. Filters by optional ?entity= and ?action=,
 *   tenant-scoped via req.user.tenantId, returns a bare JSON array (NOT
 *   envelope), capped at 100 rows ordered createdAt:desc, and joins
 *   user{id,name,email} for the operator-facing UI.
 *
 * Why this file is distinct from sibling audit test files
 * ───────────────────────────────────────────────────────
 *   audit-viewer.test.js pins /api/audit-viewer (the separate viewer router
 *   for #621 ADMIN-only contract). This file covers the simple GET /api/audit
 *   list handler.
 *
 * Contracts asserted
 * ──────────────────
 *   Happy path:
 *     1. ADMIN + no filters → 200 + array; findMany is scoped by tenant and vertical.
 *     2. ADMIN + ?entity=Contact → where includes entity:'Contact'.
 *     3. ADMIN + ?action=DELETE → where includes action:'DELETE'.
 *     4. ADMIN + ?entity=X&action=Y → both filters AND'd.
 *     5. Empty query string → no spurious entity:'' / action:'' keys.
 *     6. Response is a JSON array (not envelope).
 *     7. take: 100 enforced.
 *     8. orderBy: { createdAt: 'desc' } enforced.
 *     9. Actor names are hydrated in a separate tenant/vertical-scoped query.
 *   Auth/RBAC:
 *    10. MANAGER → 403 RBAC_DENIED.
 *    11. USER    → 403 RBAC_DENIED.
 *    12. Missing Authorization → 401.
 *    13. Bogus JWT signature → 401.
 *   Tenant isolation:
 *    14. Token's tenantId=99 → findMany where.tenantId === 99 (req.user, NOT req.body).
 *   Error surface:
 *    15. findMany rejects → 500 {error:'Failed to fetch audit logs'}.
 *
 * Mocking strategy
 * ────────────────
 *   Exercise the audit list endpoint using a patched prisma singleton's auditLog model
 *   with vi.fn() BEFORE requiring the router (CJS top-level require resolves
 *   the singleton at import time). Mount on a bare express app with
 *   supertest. Real verifyToken + verifyRole middleware run unmodified —
 *   tokens are HS256 JWTs signed with the dev-fallback secret. revokedToken
 *   lookup is stubbed null.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch BEFORE requiring the router.
prisma.auditLog = {
  findMany: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

const auditRouter = requireCJS('../../routes/audit');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/audit', auditRouter);
  return app;
}

function tokenFor(role, tenantId) {
  return jwt.sign(
    { userId: 1, tenantId: tenantId ?? 1, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function sampleLog(overrides = {}) {
  return {
    id: 1,
    action: 'CREATE',
    entity: 'Contact',
    entityId: 100,
    userId: 5,
    tenantId: 1,
    details: JSON.stringify({ name: 'Test Row' }),
    createdAt: new Date('2026-05-26T10:00:00Z'),
    user: { id: 5, name: 'Test User', email: 'test@x.local' },
    ...overrides,
  };
}

beforeAll(() => {
  prisma.revokedToken = prisma.revokedToken || {};
  prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
});

beforeEach(() => {
  prisma.auditLog.findMany.mockReset();
  prisma.auditLog.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'generic' });
});

describe('GET /api/audit — ADMIN-only listing, no filters', () => {
  test('ADMIN + no filters → 200 + JSON array; findMany is tenant and vertical scoped', async () => {
    const rows = [sampleLog({ id: 1 }), sampleLog({ id: 2 })];
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);

    const res = await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    const callArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArg.where).toEqual({ tenantId: 1, tenant: { is: { vertical: 'generic' } } });
    expect(callArg.where.entity).toBeUndefined();
    expect(callArg.where.action).toBeUndefined();
  });

  test('fails closed when the tenant has no valid vertical', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUDIT_SCOPE_INVALID');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('empty query string (just ?) → no spurious entity/action keys in where', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    const res = await request(makeApp())
      .get('/api/audit?')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);

    expect(res.status).toBe(200);
    const callArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArg.where).toEqual({ tenantId: 1, tenant: { is: { vertical: 'generic' } } });
    expect('entity' in callArg.where).toBe(false);
    expect('action' in callArg.where).toBe(false);
  });
});

describe('GET /api/audit — ?entity / ?action filters', () => {
  test('?entity=Contact → where includes entity:"Contact"', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    await request(makeApp())
      .get('/api/audit?entity=Contact')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    const callArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArg.where).toEqual({
      tenantId: 1,
      tenant: { is: { vertical: 'generic' } },
      entity: 'Contact',
    });
  });

  test('?action=DELETE → where includes action:"DELETE"', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    await request(makeApp())
      .get('/api/audit?action=DELETE')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    const callArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArg.where).toEqual({
      tenantId: 1,
      tenant: { is: { vertical: 'generic' } },
      action: 'DELETE',
    });
  });

  test('?entity=Deal&action=UPDATE → both filters AND-composed into where', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    await request(makeApp())
      .get('/api/audit?entity=Deal&action=UPDATE')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    const callArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArg.where).toEqual({
      tenantId: 1,
      tenant: { is: { vertical: 'generic' } },
      entity: 'Deal',
      action: 'UPDATE',
    });
  });
});

describe('GET /api/audit — pagination, ordering, and actor scope', () => {
  test('take: 100 enforced on findMany call', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    const callArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArg.take).toBe(100);
  });

  test('orderBy: { createdAt: "desc" } enforced on findMany call', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    const callArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArg.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('actor lookup is tenant and vertical scoped instead of using an unfiltered relation include', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([sampleLog()]);
    await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    const callArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArg.include).toBeUndefined();
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [5] },
        tenantId: 1,
        tenant: { is: { vertical: 'generic' } },
      },
      select: {
        id: true,
        name: true,
        email: true,
        tenantId: true,
        tenant: { select: { vertical: true } },
      },
    });
  });

  test('response is a bare JSON array — not wrapped in {logs:[]} envelope', async () => {
    const rows = [sampleLog()];
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const res = await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Guard against accidental refactor to {logs:[]} envelope.
    expect(res.body).not.toHaveProperty('logs');
    expect(res.body).not.toHaveProperty('data');
  });
});

describe('GET /api/audit — RBAC + auth gate', () => {
  test('MANAGER token → 403 RBAC_DENIED, findMany never called', async () => {
    const res = await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('MANAGER', 1)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('USER token → 403 RBAC_DENIED, findMany never called', async () => {
    const res = await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('USER', 1)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('missing Authorization header → 401, findMany never called', async () => {
    const res = await request(makeApp()).get('/api/audit');
    expect(res.status).toBe(401);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('bogus JWT (wrong signature) → 401, findMany never called', async () => {
    const forged = jwt.sign(
      { userId: 1, tenantId: 1, role: 'ADMIN' },
      'NOT-THE-REAL-SECRET',
      { expiresIn: '1h' },
    );
    const res = await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/audit — multi-tenant isolation', () => {
  test("token's tenantId=99 → findMany scoped to tenant 99 and its vertical", async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    const res = await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 99)}`)
      // Attempt to spoof tenantId via body — must be ignored (req.user wins,
      // and the global stripDangerous middleware would strip body.tenantId
      // anyway in the real stack).
      .send({ tenantId: 1 });
    expect(res.status).toBe(200);
    const callArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArg.where.tenantId).toBe(99);
    expect(callArg.where.tenant).toEqual({ is: { vertical: 'generic' } });
  });
});

describe('GET /api/audit — error surface', () => {
  test('findMany rejects → 500 {error: "Failed to fetch audit logs"}', async () => {
    prisma.auditLog.findMany.mockRejectedValueOnce(new Error('db unreachable'));
    const res = await request(makeApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch audit logs' });
  });
});
