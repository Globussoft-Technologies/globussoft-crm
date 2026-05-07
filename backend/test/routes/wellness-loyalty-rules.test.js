// @ts-check
/**
 * Unit tests for the #614 Loyalty rules surface in backend/routes/wellness.js.
 * Pins the GET / PUT /api/wellness/loyalty/rules contract so the manager
 * UI can self-serve earn/burn config (previously hardcoded as `amt * 0.1`
 * inside maybeAutoCreditLoyalty).
 *
 * What this file pins
 * ───────────────────
 *   1. GET /loyalty/rules returns DEFAULTS when no LoyaltyConfig row exists
 *      for the tenant — preserves byte-identical behaviour vs the historic
 *      hardcoded 10%-of-spend rule.
 *   2. GET /loyalty/rules returns the persisted config when one exists.
 *   3. PUT /loyalty/rules upserts (create-or-update) the per-tenant row.
 *   4. PUT /loyalty/rules requires manager-or-admin role (returns 403 for
 *      USER role).
 *   5. PUT /loyalty/rules rejects negative numbers + earnPercentOfSpend > 100.
 *   6. Tenant scope: PUT writes against req.user.tenantId only.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.loyaltyConfig = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
};
// Existing prisma surfaces required by routes/wellness.js at import time.
// We're not exercising them here, but the require at the bottom triggers
// top-level imports, so stub permissively. Force-replace audit since the
// real client may already expose a (non-mocked) auditLog delegate.
prisma.patient = prisma.patient || { findFirst: vi.fn() };
prisma.loyaltyTransaction = prisma.loyaltyTransaction || { findFirst: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), create: vi.fn() };
prisma.referral = prisma.referral || { findMany: vi.fn(), count: vi.fn() };
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.loyaltyConfig.findUnique.mockReset();
  prisma.loyaltyConfig.upsert.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
});

describe('GET /api/wellness/loyalty/rules — #614', () => {
  test('returns DEFAULTS when no row exists (preserves historic 10% rule)', async () => {
    prisma.loyaltyConfig.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/wellness/loyalty/rules');
    expect(res.status).toBe(200);
    // Historic behaviour was 10% of spend; defaults must mirror that or
    // existing tenants see different point grants on day 1.
    expect(res.body.earnPercentOfSpend).toBe(10);
    expect(res.body.redeemPointsPerUnit).toBe(10);
    expect(res.body.autoEarnEnabled).toBe(true);
    expect(res.body.tenantId).toBe(1);
  });

  test('returns persisted config when row exists', async () => {
    prisma.loyaltyConfig.findUnique.mockResolvedValue({
      id: 99,
      tenantId: 2,
      earnPerVisit: 50,
      earnPercentOfSpend: 5,
      earnPerCurrencyUnit: 0,
      redeemPointsPerUnit: 20,
      welcomeBonus: 100,
      referralBonus: 250,
      autoEarnEnabled: true,
    });
    const res = await request(makeApp({ tenantId: 2 })).get('/api/wellness/loyalty/rules');
    expect(res.status).toBe(200);
    expect(res.body.earnPerVisit).toBe(50);
    expect(res.body.earnPercentOfSpend).toBe(5);
    expect(res.body.welcomeBonus).toBe(100);
    expect(prisma.loyaltyConfig.findUnique).toHaveBeenCalledWith({ where: { tenantId: 2 } });
  });
});

describe('PUT /api/wellness/loyalty/rules — #614', () => {
  test('upserts per-tenant config row + writes audit', async () => {
    prisma.loyaltyConfig.upsert.mockImplementation(({ where, update, create }) =>
      Promise.resolve({ id: 1, tenantId: where.tenantId, ...create, ...update })
    );
    const res = await request(makeApp({ tenantId: 7, role: 'MANAGER' }))
      .put('/api/wellness/loyalty/rules')
      .send({ earnPerVisit: 25, earnPercentOfSpend: 7.5, redeemPointsPerUnit: 100 });
    expect(res.status).toBe(200);
    expect(prisma.loyaltyConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 7 },
        update: expect.objectContaining({ earnPerVisit: 25, earnPercentOfSpend: 7.5, redeemPointsPerUnit: 100 }),
        create: expect.objectContaining({ tenantId: 7 }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('rejects USER role with 403', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .put('/api/wellness/loyalty/rules')
      .send({ earnPerVisit: 10 });
    expect(res.status).toBe(403);
  });

  test('rejects negative numbers (400)', async () => {
    const res = await request(makeApp({ role: 'ADMIN' }))
      .put('/api/wellness/loyalty/rules')
      .send({ earnPerVisit: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/earnPerVisit/);
  });

  test('rejects earnPercentOfSpend > 100 (400)', async () => {
    const res = await request(makeApp({ role: 'ADMIN' }))
      .put('/api/wellness/loyalty/rules')
      .send({ earnPercentOfSpend: 150 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);
  });
});
