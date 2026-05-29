// @ts-check
/**
 * Visa Sure Phase 3 / PC-3 + PC-7 — EmbassyRule CRUD scaffold tests.
 *
 * Pins the contract for backend/routes/embassy_rules.js (tick #175, agent A).
 * The EmbassyRule model itself shipped tick #173 (commit 6f82e9a7) with a
 * @@unique([tenantId, destinationCountry, applicationType, ruleType])
 * constraint. This spec covers list/filter/tenant-scope/RBAC/duplicate/
 * soft-delete contracts on the route.
 *
 * Test pattern mirrors backend/test/routes/travel_quotes.test.js — patch
 * the prisma singleton BEFORE requiring the router so the require()'d
 * router binds to the spy'd functions. JWT minted with the same dev
 * fallback secret the middleware uses; verifyToken runs in the chain
 * (no bypass) so auth-gates are exercised end-to-end.
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test
 * gate fast + isolated. The e2e-full / api_tests gates exercise the
 * round-trip against real MySQL via the e2e/tests/*-api.spec.js layer
 * (added in a follow-up tick if needed).
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.embassyRule = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const embassyRulesRouter = requireCJS('../../routes/embassy_rules');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/embassy-rules', embassyRulesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.embassyRule.findMany.mockReset();
  prisma.embassyRule.findFirst.mockReset();
  prisma.embassyRule.count.mockReset();
  prisma.embassyRule.create.mockReset();
  prisma.embassyRule.update.mockReset();
});

describe('GET /api/embassy-rules', () => {
  test('returns empty array initially (tenant-scoped where)', async () => {
    prisma.embassyRule.findMany.mockResolvedValue([]);
    prisma.embassyRule.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .get('/api/embassy-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rules: [], total: 0 });
    expect(prisma.embassyRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
      }),
    );
  });

  test('list filtered by ?destinationCountry returns scoped rows', async () => {
    prisma.embassyRule.findMany.mockResolvedValue([
      {
        id: 1, tenantId: 1, ruleType: 'document_required',
        destinationCountry: 'US', applicationType: 'tourist',
        actionLabel: 'Bank statement required', severity: 'warning',
        isActive: true, createdById: 7,
      },
    ]);
    prisma.embassyRule.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/embassy-rules?destinationCountry=us')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(1);
    // Country uppercased on the way in.
    expect(prisma.embassyRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, destinationCountry: 'US' }),
      }),
    );
  });
});

describe('POST /api/embassy-rules', () => {
  test('happy path returns 201 with stamped tenantId + createdById', async () => {
    prisma.embassyRule.create.mockImplementation(async ({ data }) => ({
      id: 42, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));
    const res = await request(makeApp())
      .post('/api/embassy-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 7, tenantId: 1 })}`)
      .send({
        ruleType: 'document_required',
        destinationCountry: 'AE',
        applicationType: 'tourist',
        actionLabel: 'NOC from sponsor required',
        severity: 'warning',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42,
      destinationCountry: 'AE',
      ruleType: 'document_required',
      severity: 'warning',
      isActive: true,
    });
    // tenantId stamped from req.user.tenantId, not body.
    expect(prisma.embassyRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          createdById: 7,
          destinationCountry: 'AE',
        }),
      }),
    );
  });

  test('rejects invalid destinationCountry with 400 INVALID_DESTINATION_COUNTRY', async () => {
    const res = await request(makeApp())
      .post('/api/embassy-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        ruleType: 'document_required',
        destinationCountry: 'USA', // 3 chars — invalid alpha-2
        actionLabel: 'x',
        severity: 'warning',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DESTINATION_COUNTRY' });
    expect(prisma.embassyRule.create).not.toHaveBeenCalled();
  });

  test('rejects invalid severity with 400 INVALID_SEVERITY', async () => {
    const res = await request(makeApp())
      .post('/api/embassy-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        ruleType: 'document_required',
        destinationCountry: 'US',
        actionLabel: 'x',
        severity: 'critical', // invalid — must be info/warning/blocker
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SEVERITY' });
    expect(res.body.error).toMatch(/info/);
    expect(res.body.error).toMatch(/warning/);
    expect(res.body.error).toMatch(/blocker/);
    expect(prisma.embassyRule.create).not.toHaveBeenCalled();
  });

  test('rejects @@unique violation with 409 EMBASSY_RULE_DUPLICATE', async () => {
    const p2002 = new Error(
      'Unique constraint failed on the fields: (`tenantId`,`destinationCountry`,`applicationType`,`ruleType`)',
    );
    // @ts-expect-error — synthesising a Prisma error shape
    p2002.code = 'P2002';
    prisma.embassyRule.create.mockRejectedValue(p2002);
    const res = await request(makeApp())
      .post('/api/embassy-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        ruleType: 'document_required',
        destinationCountry: 'US',
        applicationType: 'tourist',
        actionLabel: 'x',
        severity: 'warning',
      });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'EMBASSY_RULE_DUPLICATE' });
  });
});

describe('PUT /api/embassy-rules/:id', () => {
  test('updates allowed fields; tenantId reassignment is ignored', async () => {
    prisma.embassyRule.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, ruleType: 'document_required',
      destinationCountry: 'US', applicationType: null,
      actionLabel: 'old', severity: 'info', isActive: true, createdById: 7,
    });
    prisma.embassyRule.update.mockImplementation(async ({ data }) => ({
      id: 5, tenantId: 1, ruleType: 'document_required',
      destinationCountry: 'US', applicationType: null,
      actionLabel: 'updated text', severity: 'blocker',
      isActive: true, createdById: 7, ...data,
    }));
    const res = await request(makeApp())
      .put('/api/embassy-rules/5')
      // Try to slip a tenantId / createdById into the body — the handler
      // never reads them so they should be silently dropped.
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send({
        actionLabel: 'updated text',
        severity: 'blocker',
        tenantId: 999,
        createdById: 999,
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, tenantId: 1, createdById: 7 });

    // The data object handed to prisma.update must NOT carry tenantId or createdById.
    const updateCall = prisma.embassyRule.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('tenantId');
    expect(updateCall.data).not.toHaveProperty('createdById');
    expect(updateCall.data).toMatchObject({
      actionLabel: 'updated text',
      severity: 'blocker',
    });
  });
});

describe('DELETE /api/embassy-rules/:id (soft-delete)', () => {
  test('flips isActive=false and subsequent active-only list excludes it', async () => {
    prisma.embassyRule.findFirst.mockResolvedValue({
      id: 9, tenantId: 1, ruleType: 'cooldown_period',
      destinationCountry: 'AE', applicationType: null,
      actionLabel: '6-month gap required', severity: 'warning',
      isActive: true, createdById: 7,
    });
    prisma.embassyRule.update.mockResolvedValue({
      id: 9, tenantId: 1, ruleType: 'cooldown_period',
      destinationCountry: 'AE', applicationType: null,
      actionLabel: '6-month gap required', severity: 'warning',
      isActive: false, createdById: 7,
    });

    const delRes = await request(makeApp())
      .delete('/api/embassy-rules/9')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body).toMatchObject({ id: 9, isActive: false });

    // Soft-delete shape — prisma.update called with isActive: false.
    expect(prisma.embassyRule.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { isActive: false },
    });

    // Follow-up list with ?isActive=true MUST exclude the row.
    prisma.embassyRule.findMany.mockResolvedValue([]);
    prisma.embassyRule.count.mockResolvedValue(0);
    const listRes = await request(makeApp())
      .get('/api/embassy-rules?isActive=true')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.rules).toEqual([]);
    expect(prisma.embassyRule.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, isActive: true }),
      }),
    );
  });
});

describe('Cross-tenant isolation', () => {
  test('rule under tenant 1 is invisible to tenant 2', async () => {
    // Caller is tenant 2 → findFirst returns null because the where
    // clause filters on tenantId=2 even though id=42 exists for tenant 1.
    prisma.embassyRule.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/embassy-rules/42')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'EMBASSY_RULE_NOT_FOUND' });
    expect(prisma.embassyRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 42, tenantId: 2 }),
      }),
    );
  });
});

describe('GET /api/embassy-rules?fields=summary (slim opt-in, #920 slice 42)', () => {
  test('omits select arg by default — full rows returned', async () => {
    prisma.embassyRule.findMany.mockResolvedValue([]);
    prisma.embassyRule.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .get('/api/embassy-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.embassyRule.findMany.mock.calls[0][0];
    expect(call).not.toHaveProperty('select');
  });

  test('?fields=summary attaches slim select dropping actionLabel + conditionJson', async () => {
    prisma.embassyRule.findMany.mockResolvedValue([]);
    prisma.embassyRule.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .get('/api/embassy-rules?fields=summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.embassyRule.findMany.mock.calls[0][0];
    expect(call.select).toBeDefined();
    // Slim shape MUST NOT include the heavy fields.
    expect(call.select.actionLabel).toBeUndefined();
    expect(call.select.conditionJson).toBeUndefined();
    // Slim shape MUST include identifying + filterable + chrome fields.
    expect(call.select).toMatchObject({
      id: true,
      tenantId: true,
      ruleType: true,
      destinationCountry: true,
      applicationType: true,
      severity: true,
      isActive: true,
    });
  });

  test('?fields=summary is case-insensitive (SUMMARY also opts in)', async () => {
    prisma.embassyRule.findMany.mockResolvedValue([]);
    prisma.embassyRule.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .get('/api/embassy-rules?fields=SUMMARY')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.embassyRule.findMany.mock.calls[0][0];
    expect(call.select).toBeDefined();
    expect(call.select.actionLabel).toBeUndefined();
  });

  test('?fields=full (or any other value) does NOT trigger slim — full rows returned', async () => {
    prisma.embassyRule.findMany.mockResolvedValue([]);
    prisma.embassyRule.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .get('/api/embassy-rules?fields=full')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const call = prisma.embassyRule.findMany.mock.calls[0][0];
    expect(call).not.toHaveProperty('select');
  });

  test('?fields=summary preserves tenant scoping + filter + pagination', async () => {
    prisma.embassyRule.findMany.mockResolvedValue([
      {
        id: 11, tenantId: 1, ruleType: 'cooldown_period',
        destinationCountry: 'AE', applicationType: 'tourist',
        severity: 'warning', isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    prisma.embassyRule.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/embassy-rules?fields=summary&destinationCountry=ae&severity=warning&limit=25&offset=10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 25, offset: 10 });
    const call = prisma.embassyRule.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      tenantId: 1,
      destinationCountry: 'AE',
      severity: 'warning',
    });
    expect(call.take).toBe(25);
    expect(call.skip).toBe(10);
    expect(call.select).toBeDefined();
    // Response row reflects whatever the (mocked) Prisma returned — slim shape.
    expect(res.body.rules[0]).not.toHaveProperty('actionLabel');
    expect(res.body.rules[0]).not.toHaveProperty('conditionJson');
  });
});

describe('RBAC — USER role on write paths returns 403', () => {
  test('POST as USER → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .post('/api/embassy-rules')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({
        ruleType: 'document_required',
        destinationCountry: 'US',
        actionLabel: 'x',
        severity: 'warning',
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.embassyRule.create).not.toHaveBeenCalled();
  });

  test('PUT as USER → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .put('/api/embassy-rules/1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ severity: 'blocker' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.embassyRule.update).not.toHaveBeenCalled();
  });

  test('DELETE as USER → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .delete('/api/embassy-rules/1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.embassyRule.update).not.toHaveBeenCalled();
  });
});
