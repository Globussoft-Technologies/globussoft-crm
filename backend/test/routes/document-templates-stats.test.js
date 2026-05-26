// @ts-check
/**
 * CRM polish — pin GET /api/document-templates/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header -> 401.
 *   - 400 INVALID_DATE on bad ?from (independent validation, no findMany leak).
 *   - 400 INVALID_DATE on bad ?to.
 *   - Empty-tenant: zeroed envelope with byType={} + lastCreatedAt=null.
 *   - Happy path: mixed types -> byType buckets + total correct.
 *   - byType buckets keyed by DocumentTemplate.type; empty buckets omitted
 *     (no "PROPOSAL: 0" noise).
 *   - Null/undefined type falls back to "PROPOSAL" (mirrors schema default
 *     `type String @default("PROPOSAL")`).
 *   - lastCreatedAt: max(createdAt) ISO across selected rows.
 *   - Tenant isolation: prisma where.tenantId = req.user.tenantId on
 *     documentTemplate.findMany.
 *   - ?from / ?to narrows the window via createdAt gte/lte on the same
 *     findMany call.
 *   - NO audit row written (read-only meta surface; mirrors landing-pages/stats
 *     posture across the CRM polish wave).
 *
 * Schema notes (verified against prisma/schema.prisma:2247-2257)
 * ------------------------------------------------------------
 *   - DocumentTemplate.type is String @default("PROPOSAL") — no enum, free-form.
 *     Common values: "PROPOSAL", "NDA", "CONTRACT", "EMAIL".
 *   - No isActive column — activeCount intentionally omitted from envelope.
 *   - No usageCount column — usage-signal aggregate intentionally omitted.
 *   - createdAt is DateTime @default(now()); updatedAt is DateTime @updatedAt.
 *
 * Pattern reference: landing-pages-stats.test.js (canonical CRM polish /stats
 * pattern). document_templates.js exports `module.exports = router` directly
 * (single-export), so the requireCJS resolves to the router itself — no
 * `{ router }` destructure (contrast with landing_pages which exports
 * `{ router, publicRouter }`). /stats endpoint mounts explicit verifyToken
 * so the 401-gate case can be exercised in isolation without depending on
 * a global guard.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.documentTemplate = prisma.documentTemplate || {};
prisma.documentTemplate.findMany = vi.fn();
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

// document_templates.js calls `dotenv.config({ override: true })` at the top
// of the module, which clobbers any pre-set process.env.JWT_SECRET with the
// .env file's value (the real production secret on developer boxes). Capture
// JWT_SECRET AFTER requireCJS so the test signs with whatever the route's
// verifyToken middleware actually uses. Falls back to the dev secret when
// .env doesn't set JWT_SECRET (CI's api_tests gate env).
const docTemplatesRouter = requireCJS('../../routes/document_templates');
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/document-templates', docTemplatesRouter);
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
  prisma.documentTemplate.findMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/document-templates/stats', () => {
  test('auth gate: missing Authorization header -> 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/document-templates/stats');
    expect(res.status).toBe(401);
    expect(prisma.documentTemplate.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from (no findMany leak)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.documentTemplate.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to (no findMany leak)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats?to=also-not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.documentTemplate.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope with byType={} + lastCreatedAt=null', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byType: {},
      lastCreatedAt: null,
    });
  });

  test('happy path: 5 templates (3 PROPOSAL, 1 NDA, 1 CONTRACT) -> byType + total correct', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      { type: 'PROPOSAL', createdAt: new Date('2026-05-01T10:00:00Z') },
      { type: 'PROPOSAL', createdAt: new Date('2026-05-02T10:00:00Z') },
      { type: 'PROPOSAL', createdAt: new Date('2026-05-03T10:00:00Z') },
      { type: 'NDA',      createdAt: new Date('2026-05-04T10:00:00Z') },
      { type: 'CONTRACT', createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byType).toEqual({ PROPOSAL: 3, NDA: 1, CONTRACT: 1 });
    expect(res.body.lastCreatedAt).toBe(new Date('2026-05-05T10:00:00Z').toISOString());
  });

  test('byType omits empty buckets entirely (no "PROPOSAL: 0" noise)', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      { type: 'NDA', createdAt: new Date('2026-05-01T10:00:00Z') },
      { type: 'NDA', createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byType).toEqual({ NDA: 2 });
    expect(res.body.byType.PROPOSAL).toBeUndefined();
    expect(res.body.byType.CONTRACT).toBeUndefined();
    expect(res.body.byType.EMAIL).toBeUndefined();
  });

  test('null/undefined type falls back to "PROPOSAL" (mirrors schema default)', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      { type: null,      createdAt: new Date('2026-05-01T10:00:00Z') },
      { type: undefined, createdAt: new Date('2026-05-02T10:00:00Z') },
      { type: 'NDA',     createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.byType).toEqual({ PROPOSAL: 2, NDA: 1 });
  });

  test('custom type buckets are surfaced verbatim (free-form String column)', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      { type: 'EMAIL',          createdAt: new Date('2026-05-01T10:00:00Z') },
      { type: 'EMAIL',          createdAt: new Date('2026-05-02T10:00:00Z') },
      { type: 'CUSTOM_INVOICE', createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byType).toEqual({ EMAIL: 2, CUSTOM_INVOICE: 1 });
  });

  test('lastCreatedAt: max(createdAt) ISO across selected rows', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.documentTemplate.findMany.mockResolvedValue([
      { type: 'PROPOSAL', createdAt: new Date('2026-05-01T10:00:00Z') },
      { type: 'NDA',      createdAt: newest },
      { type: 'CONTRACT', createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const findWhere = prisma.documentTemplate.findMany.mock.calls[0][0].where;
    expect(findWhere.tenantId).toBe(42);
  });

  test('?from/?to: narrows the window via createdAt gte/lte clauses', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/document-templates/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const findWhere = prisma.documentTemplate.findMany.mock.calls[0][0].where;
    expect(findWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(findWhere.createdAt.lte).toEqual(new Date(toIso));
  });

  test('findMany select limits columns to {type, createdAt} (no full-row leak)', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.documentTemplate.findMany.mock.calls[0][0];
    expect(callArg.select).toEqual({ type: true, createdAt: true });
    // No `content` / `variables` (LongText payload columns) selected — the
    // /stats endpoint MUST NOT pull the full row.
    expect(callArg.select.content).toBeUndefined();
    expect(callArg.select.variables).toBeUndefined();
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      { type: 'PROPOSAL', createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('500 envelope on prisma error (does not leak stack)', async () => {
    prisma.documentTemplate.findMany.mockRejectedValue(new Error('boom'));

    const app = makeApp();
    const res = await request(app)
      .get('/api/document-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to compute document-template stats');
    // Sanity: no `stack` field surfaced.
    expect(res.body.stack).toBeUndefined();
  });
});
