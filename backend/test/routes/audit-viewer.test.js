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

/**
 * Extended coverage — query semantics + tenant isolation + CSV contract.
 *
 * 10 new cases pin behaviour that the RBAC-only block above didn't exercise:
 *   - filter where-clause shape (entity, action, userId, from/to)
 *   - validateDateRange #665 error contract (INVALID_DATE + INVERTED_DATE_RANGE)
 *   - pagination math (limit cap at 200, page=1 minimum, total/pages envelope)
 *   - tenant isolation (req.user.tenantId always pinned to where clause)
 *   - sort order (createdAt desc) + include user fields
 *   - CSV /export.csv Content-Type + Content-Disposition headers
 *   - CSV cell escaping for commas / quotes / newlines (csvCell function)
 *   - CSV applies the same validateDateRange guard
 *
 * All cases mock prisma.auditLog at the singleton level and drive supertest
 * against the bare express app — no real DB, no real router state.
 */
describe('audit_viewer query semantics + CSV contract', () => {
  test('GET / passes entity + action + userId into prisma where clause', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?entity=Deal&action=CREATE&userId=42')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where.entity).toBe('Deal');
    expect(call.where.action).toBe('CREATE');
    expect(call.where.userId).toBe(42);
    expect(call.where.tenantId).toBe(1);
  });

  test('GET / with non-numeric userId → drops the filter rather than crashing', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?userId=not-a-number')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    // parseInt('not-a-number') is NaN — the route's Number.isNaN guard skips it.
    expect(call.where.userId).toBeUndefined();
  });

  test('GET /?from=bad → 400 INVALID_DATE (validateDateRange #665 contract)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?from=not-a-date&to=2026-05-20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    // Defence in depth: bad input rejected BEFORE prisma is queried.
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('GET /?from > to → 400 INVERTED_DATE_RANGE (#665)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?from=2026-05-20&to=2026-05-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVERTED_DATE_RANGE');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('GET / returns paginated envelope {logs, total, pages, page, limit}', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([
      { id: 1, action: 'CREATE', entity: 'Deal', entityId: 100, createdAt: new Date(), details: 'x', user: null },
      { id: 2, action: 'UPDATE', entity: 'Deal', entityId: 100, createdAt: new Date(), details: 'y', user: null },
    ]);
    prisma.auditLog.count.mockResolvedValueOnce(47);
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?page=2&limit=10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 47,
      page: 2,
      limit: 10,
      pages: 5, // ceil(47 / 10)
    });
    expect(res.body.logs).toHaveLength(2);
    // Pagination math: skip = (page - 1) * limit = 10.
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.skip).toBe(10);
    expect(call.take).toBe(10);
  });

  test('GET /?limit=99999 → clamped to 200 (route safety cap)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?limit=99999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.take).toBe(200);
    expect(res.body.limit).toBe(200);
  });

  test('GET / sorts createdAt desc and includes user name+email', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
    expect(call.include).toEqual({
      user: { select: { id: true, name: true, email: true } },
    });
  });

  test('GET / always scopes prisma where.tenantId to caller (tenant isolation)', async () => {
    const app = makeApp();
    // Caller has tenantId=1 per tokenFor(). No matter what filters they pass,
    // the where clause must include tenantId: 1 — no body/query field can
    // override it (stripDangerous handles req.body; query is route-controlled).
    const res = await request(app)
      .get('/api/audit-viewer?entity=Deal&action=CREATE&tenantId=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    // Query-string tenantId is NOT promoted into where clause; only req.user.tenantId is.
    expect(call.where.tenantId).not.toBe(999);
  });

  test('GET /export.csv → sets Content-Type text/csv + attachment Content-Disposition', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([
      {
        id: 1,
        createdAt: new Date('2026-05-15T10:30:00Z'),
        action: 'CREATE',
        entity: 'Deal',
        entityId: 100,
        details: 'created',
        user: { name: 'Alice', email: 'alice@test.local' },
      },
    ]);
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer/export.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/filename=audit-log\.csv/);
    // CSV body has header + 1 data row.
    expect(res.text).toMatch(/^ID,Timestamp,TimestampLocal,Action,Entity,EntityId,UserName,UserEmail,Details\r\n/);
    expect(res.text).toMatch(/CREATE,Deal,100,Alice,alice@test\.local,created$/);
  });

  test('GET /export.csv escapes commas, quotes, and newlines in cell values (csvCell contract)', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([
      {
        id: 1,
        createdAt: new Date('2026-05-15T10:30:00Z'),
        action: 'UPDATE',
        entity: 'Deal',
        entityId: 100,
        // All three CSV-dangerous characters in the same field:
        //   comma → needs quoting; quote → needs doubling; newline → needs quoting.
        details: 'a,b "c" d\nnext line',
        user: { name: 'Bob, Jr.', email: 'bob@test.local' },
      },
    ]);
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer/export.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Comma in user name → field wrapped in quotes.
    expect(res.text).toContain('"Bob, Jr."');
    // Internal double quote → doubled ("c" → ""c""), whole field quoted.
    expect(res.text).toContain('"a,b ""c"" d\nnext line"');
  });

  test('GET /export.csv?from > to → 400 INVERTED_DATE_RANGE (#665 applies to CSV too)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer/export.csv?from=2026-05-20&to=2026-05-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVERTED_DATE_RANGE');
    // Defence in depth: bad input rejected BEFORE prisma is queried, so the
    // 10k-row export query never fires.
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});

/**
 * #920 slice 24 — `?fields=summary` slim-shape opt-in.
 *
 * Audit rows carry heavy `details` JSON (often PII diffs of CREATE/UPDATE
 * payloads) plus hash-chain bookkeeping (`prevHash`/`hash`) that's
 * forensically essential for the integrity verifier but irrelevant to a
 * paginated list view. The slim shape drops those + the nested user
 * include — list-view consumers (AuditLog.jsx, future ops dashboards)
 * can opt into the lighter payload without breaking existing callers.
 *
 * What this block pins
 * ────────────────────
 *   1. Default (no ?fields) — preserves full shape: uses `include`, no
 *      `select` (back-compat — existing callers keep working).
 *   2. ?fields=summary — switches to `select` with the 7-field projection
 *      (id, entity, entityId, action, userId, tenantId, createdAt) and
 *      drops the user `include` entirely.
 *   3. Slim `select` excludes `details` (the PII column motivation for #920).
 *   4. Slim `select` excludes `prevHash` + `hash` (hash-chain bookkeeping).
 *   5. Non-exact `?fields` values (typos, casing) fall back to the full
 *      shape — opt-in is strict-equality, not heuristic.
 */
describe('audit_viewer ?fields=summary slim-shape opt-in — #920 slice 24', () => {
  test('GET / (no ?fields) — preserves full-shape contract: uses include, no select', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    // Back-compat: callers that don't pass ?fields keep the user join.
    expect(call.include).toEqual({
      user: { select: { id: true, name: true, email: true } },
    });
    // Crucially: no `select` is passed alongside, which would conflict with
    // include and cause a Prisma validation error.
    expect(call.select).toBeUndefined();
  });

  test('GET /?fields=summary → slim `select` with 7-field projection (no user include)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?fields=summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    // Slim shape switches include → select.
    expect(call.include).toBeUndefined();
    expect(call.select).toEqual({
      id: true,
      entity: true,
      entityId: true,
      action: true,
      userId: true,
      tenantId: true,
      createdAt: true,
    });
  });

  test('GET /?fields=summary → slim shape EXCLUDES `details` (PII column motivation for #920)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?fields=summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    // The core #920 motivation: audit details often carry PII diffs of
    // CREATE/UPDATE payloads. Slim list-view callers shouldn't pull it.
    expect(call.select.details).toBeUndefined();
    // Sanity: select exists and has the expected non-details keys.
    expect(call.select.id).toBe(true);
    expect(call.select.entity).toBe(true);
  });

  test('GET /?fields=summary → slim shape EXCLUDES `prevHash` + `hash` (hash-chain bookkeeping)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?fields=summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    // #558's hash-chain columns are essential for the integrity verifier
    // (GET /api/audit/verify) but the list-view UI never reads them. Slim
    // shape drops both so list queries stop pulling Text columns that can
    // grow large for malformed/multi-row diffs.
    expect(call.select.prevHash).toBeUndefined();
    expect(call.select.hash).toBeUndefined();
  });

  test('GET /?fields=summary still scopes tenantId + still paginates (orthogonal to slim shape)', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([
      // Slim rows: no `user` field, no `details`, no `prevHash`/`hash`.
      { id: 1, entity: 'Deal', entityId: 100, action: 'CREATE', userId: 7, tenantId: 1, createdAt: new Date() },
      { id: 2, entity: 'Contact', entityId: 200, action: 'UPDATE', userId: 7, tenantId: 1, createdAt: new Date() },
    ]);
    prisma.auditLog.count.mockResolvedValueOnce(2);
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?fields=summary&page=1&limit=50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    // Tenant isolation still pinned to req.user.tenantId (1 per tokenFor).
    expect(call.where.tenantId).toBe(1);
    // Pagination math unchanged: skip = (page - 1) * limit.
    expect(call.skip).toBe(0);
    expect(call.take).toBe(50);
    // Envelope still emits paginated meta.
    expect(res.body).toMatchObject({ total: 2, page: 1, limit: 50, pages: 1 });
    expect(res.body.logs).toHaveLength(2);
  });

  test('GET /?fields=Summary (wrong casing) → falls back to full shape (strict-equality opt-in)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/audit-viewer?fields=Summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    // Strict `=== 'summary'` opt-in — typos and casing variants don't
    // accidentally enter slim mode (preserves principle-of-least-surprise:
    // either you ask for summary exactly, or you get the full row).
    expect(call.select).toBeUndefined();
    expect(call.include).toEqual({
      user: { select: { id: true, name: true, email: true } },
    });
  });
});
