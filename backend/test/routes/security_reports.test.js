// @ts-check
/**
 * Unit tests for backend/routes/security_reports.js — PRD_TRAVEL_SECURITY_
 * ARCHITECTURE FR-3.7 (S5) — pins the SecurityIncident-backed CSP report
 * sink, the ADMIN listing surface, and the ADMIN triage marker.
 *
 * What this file pins
 * ───────────────────
 *   1. POST /csp-report happy path → 204 + incident persisted with the
 *      right severity inferred from the violated directive.
 *   2. POST /csp-report malformed body (broken JSON) → still returns 204.
 *   3. POST /csp-report script-src directive → severity 'high'.
 *   4. POST /csp-report payload > 8KiB → 413 PAYLOAD_TOO_LARGE.
 *   5. POST /csp-report style-src → severity 'medium'.
 *   6. POST /csp-report img-src → severity 'low'.
 *   7. POST /csp-report Reporting-API array-of-reports shape supported.
 *   8. GET  /incidents ADMIN happy path returns paginated incidents.
 *   9. GET  /incidents ?type=csp-violation filter forwarded to Prisma WHERE.
 *  10. GET  /incidents ?since=ISO filter forwarded to createdAt.gte.
 *  11. GET  /incidents cross-tenant isolation — tenantId in WHERE.
 *  12. GET  /incidents USER role → 403 RBAC_DENIED.
 *  13. POST /incidents/:id/review happy path → 200 + update called.
 *  14. POST /incidents/:id/review missing reviewNote → 400 MISSING_REVIEW_NOTE.
 *  15. POST /incidents/:id/review USER role → 403 RBAC_DENIED.
 *  16. POST /incidents/:id/review cross-tenant id → 404 NOT_FOUND (no
 *      existence confirmation cross-tenant).
 *  17. POST /incidents/:id/review invalid severity → 400 INVALID_SEVERITY.
 *  18. POST /incidents/:id/review invalid :id (non-numeric) → 400 INVALID_ID.
 *  19. POST /incidents/:id/review valid severity override persisted.
 *
 * Pattern: mirrors backend/test/routes/admin.test.js — monkey-patch the
 * prisma singleton's `securityIncident` + `tenant` delegates with vi.fn()
 * surfaces, bypass auth via authMw.verifyToken stub, keep verifyRole REAL
 * so RBAC-denial assertions are end-to-end.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// CJS require shim so we can monkey-patch the auth + prisma surfaces
// BEFORE the router is required (the route does
// `require("../middleware/auth")` at module load, capturing the function
// references at that moment).
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Replace the Prisma delegate with vi.fn() surfaces. The route touches:
//   prisma.securityIncident.create / findMany / count / findUnique / update
//   prisma.tenant.findUnique (best-effort tenant resolution from Host header)
prisma.securityIncident = {
  create: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
};
// tenant delegate is touched by the CSP report path's best-effort host →
// slug lookup. Default to null-tenant (no slug match) unless overridden.
const realTenant = prisma.tenant;
prisma.tenant = {
  ...(realTenant || {}),
  findUnique: vi.fn(),
};

import express from 'express';
import request from 'supertest';

const securityRouter = requireCJS('../../routes/security_reports');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  withAuth = true,
} = {}) {
  const app = express();
  // No global express.json() — the csp-report route mounts its own parser
  // for application/csp-report / application/reports+json / application/json.
  // But the review route needs JSON body parsing, so add it for the
  // /incidents path explicitly.
  app.use((req, res, next) => {
    if (req.path.includes('/incidents')) {
      return express.json()(req, res, next);
    }
    return next();
  });
  if (withAuth) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/security', securityRouter);
  return app;
}

beforeEach(() => {
  prisma.securityIncident.create.mockReset();
  prisma.securityIncident.findMany.mockReset();
  prisma.securityIncident.count.mockReset();
  prisma.securityIncident.findUnique.mockReset();
  prisma.securityIncident.update.mockReset();
  prisma.tenant.findUnique.mockReset();

  // Default fallbacks
  prisma.securityIncident.create.mockResolvedValue({ id: 1 });
  prisma.securityIncident.findMany.mockResolvedValue([]);
  prisma.securityIncident.count.mockResolvedValue(0);
  prisma.securityIncident.findUnique.mockResolvedValue(null);
  prisma.securityIncident.update.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────
// POST /csp-report — public CSP ingest
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/security/csp-report', () => {
  test('happy path: W3C csp-report shape → 204 + incident persisted', async () => {
    const reportBody = {
      'csp-report': {
        'document-uri': 'https://example.com/page',
        'effective-directive': 'script-src',
        'blocked-uri': 'https://evil.example/x.js',
      },
    };
    const res = await request(makeApp({ withAuth: false }))
      .post('/api/security/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify(reportBody));

    expect(res.status).toBe(204);
    // Persist is fire-and-forget — give the microtask queue a tick.
    await new Promise((r) => setImmediate(r));
    expect(prisma.securityIncident.create).toHaveBeenCalledTimes(1);
    const data = prisma.securityIncident.create.mock.calls[0][0].data;
    expect(data.incidentType).toBe('csp-violation');
    expect(data.severity).toBe('high'); // script-src → high
    expect(data.blockedUri).toBe('https://evil.example/x.js');
    expect(data.effectiveDirective).toBe('script-src');
    expect(data.url).toBe('https://example.com/page');
  });

  test('malformed body (parser error) → still 204, no persist', async () => {
    const res = await request(makeApp({ withAuth: false }))
      .post('/api/security/csp-report')
      .set('Content-Type', 'application/json')
      .send('{ this is not json ');
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(prisma.securityIncident.create).not.toHaveBeenCalled();
  });

  test('severity inference: script-src → high', async () => {
    await request(makeApp({ withAuth: false }))
      .post('/api/security/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': { 'effective-directive': 'script-src self' },
      });
    await new Promise((r) => setImmediate(r));
    const data = prisma.securityIncident.create.mock.calls[0][0].data;
    expect(data.severity).toBe('high');
  });

  test('severity inference: style-src → medium', async () => {
    await request(makeApp({ withAuth: false }))
      .post('/api/security/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': { 'effective-directive': 'style-src' },
      });
    await new Promise((r) => setImmediate(r));
    const data = prisma.securityIncident.create.mock.calls[0][0].data;
    expect(data.severity).toBe('medium');
  });

  test('severity inference: img-src → low', async () => {
    await request(makeApp({ withAuth: false }))
      .post('/api/security/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': { 'effective-directive': 'img-src' },
      });
    await new Promise((r) => setImmediate(r));
    const data = prisma.securityIncident.create.mock.calls[0][0].data;
    expect(data.severity).toBe('low');
  });

  test('payload > 8KiB → 413 PAYLOAD_TOO_LARGE', async () => {
    const big = { 'csp-report': { 'document-uri': 'a'.repeat(9 * 1024) } };
    const res = await request(makeApp({ withAuth: false }))
      .post('/api/security/csp-report')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(big));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('Reporting-API array-of-reports shape → 204 + persisted', async () => {
    const reportingApiBody = [
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/p',
          effectiveDirective: 'script-src',
          blockedURL: 'https://e.example/x.js',
        },
      },
    ];
    const res = await request(makeApp({ withAuth: false }))
      .post('/api/security/csp-report')
      .set('Content-Type', 'application/reports+json')
      .send(JSON.stringify(reportingApiBody));
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    const data = prisma.securityIncident.create.mock.calls[0][0].data;
    expect(data.incidentType).toBe('csp-violation');
    expect(data.severity).toBe('high');
    expect(data.blockedUri).toBe('https://e.example/x.js');
  });
});

// ─────────────────────────────────────────────────────────────────────
// GET /incidents — ADMIN listing
// ─────────────────────────────────────────────────────────────────────

describe('GET /api/security/incidents', () => {
  test('ADMIN happy path: returns paginated envelope', async () => {
    prisma.securityIncident.findMany.mockResolvedValue([
      { id: 1, incidentType: 'csp-violation', severity: 'high' },
      { id: 2, incidentType: 'cross-tenant-attempt', severity: 'high' },
    ]);
    prisma.securityIncident.count.mockResolvedValue(2);

    const res = await request(makeApp({ tenantId: 42 })).get(
      '/api/security/incidents',
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.incidents).toHaveLength(2);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    // Tenant scoping — every prisma call carries tenantId=42 in WHERE.
    const fmCall = prisma.securityIncident.findMany.mock.calls[0][0];
    expect(fmCall.where.tenantId).toBe(42);
    const ctCall = prisma.securityIncident.count.mock.calls[0][0];
    expect(ctCall.where.tenantId).toBe(42);
  });

  test('?type=csp-violation forwarded to WHERE.incidentType', async () => {
    await request(makeApp()).get('/api/security/incidents?type=csp-violation');
    const fmCall = prisma.securityIncident.findMany.mock.calls[0][0];
    expect(fmCall.where.incidentType).toBe('csp-violation');
  });

  test('?since=ISO forwarded to WHERE.createdAt.gte', async () => {
    await request(makeApp()).get(
      '/api/security/incidents?since=2026-06-01T00:00:00Z',
    );
    const fmCall = prisma.securityIncident.findMany.mock.calls[0][0];
    expect(fmCall.where.createdAt).toBeDefined();
    expect(fmCall.where.createdAt.gte).toBeInstanceOf(Date);
  });

  test('cross-tenant isolation: tenant B query gets tenantId=B WHERE', async () => {
    await request(makeApp({ tenantId: 999 })).get('/api/security/incidents');
    const fmCall = prisma.securityIncident.findMany.mock.calls[0][0];
    expect(fmCall.where.tenantId).toBe(999);
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' })).get(
      '/api/security/incidents',
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.securityIncident.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /incidents/:id/review
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/security/incidents/:id/review', () => {
  test('happy path: 200 + update called with reviewedAt/reviewedById/reviewNote', async () => {
    prisma.securityIncident.findUnique.mockResolvedValue({
      id: 5,
      tenantId: 1,
    });
    prisma.securityIncident.update.mockResolvedValue({
      id: 5,
      reviewNote: 'known false positive',
    });

    const res = await request(makeApp({ tenantId: 1, userId: 9 }))
      .post('/api/security/incidents/5/review')
      .send({ reviewNote: 'known false positive' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.securityIncident.update).toHaveBeenCalledTimes(1);
    const data = prisma.securityIncident.update.mock.calls[0][0].data;
    expect(data.reviewedById).toBe(9);
    expect(data.reviewNote).toBe('known false positive');
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  test('missing reviewNote → 400 MISSING_REVIEW_NOTE', async () => {
    const res = await request(makeApp())
      .post('/api/security/incidents/5/review')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_REVIEW_NOTE');
    expect(prisma.securityIncident.update).not.toHaveBeenCalled();
  });

  test('blank reviewNote (whitespace only) → 400 MISSING_REVIEW_NOTE', async () => {
    const res = await request(makeApp())
      .post('/api/security/incidents/5/review')
      .send({ reviewNote: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_REVIEW_NOTE');
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/security/incidents/5/review')
      .send({ reviewNote: 'looks fine' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.securityIncident.update).not.toHaveBeenCalled();
  });

  test('cross-tenant id → 404 NOT_FOUND (row exists in tenant B; we are in A)', async () => {
    prisma.securityIncident.findUnique.mockResolvedValue({
      id: 5,
      tenantId: 99,
    });
    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/security/incidents/5/review')
      .send({ reviewNote: 'attempt' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(prisma.securityIncident.update).not.toHaveBeenCalled();
  });

  test('invalid severity → 400 INVALID_SEVERITY', async () => {
    const res = await request(makeApp())
      .post('/api/security/incidents/5/review')
      .send({ reviewNote: 'ok', severity: 'extreme' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SEVERITY');
    expect(prisma.securityIncident.update).not.toHaveBeenCalled();
  });

  test('invalid :id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/security/incidents/abc/review')
      .send({ reviewNote: 'ok' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('valid severity override persisted', async () => {
    prisma.securityIncident.findUnique.mockResolvedValue({
      id: 5,
      tenantId: 1,
    });
    prisma.securityIncident.update.mockResolvedValue({ id: 5 });
    await request(makeApp({ tenantId: 1 }))
      .post('/api/security/incidents/5/review')
      .send({ reviewNote: 'urgent', severity: 'critical' });
    const data = prisma.securityIncident.update.mock.calls[0][0].data;
    expect(data.severity).toBe('critical');
  });
});
