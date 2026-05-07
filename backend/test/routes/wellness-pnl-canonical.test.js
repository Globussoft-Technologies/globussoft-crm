// @ts-check
/**
 * Unit test for #565 (HI-16) — canonical revenue source.
 *
 * Pins that GET /api/wellness/reports/pnl-by-service exposes a
 * top-level `totalRevenue` scalar that equals SUM(rows[].revenue).
 *
 * OwnerDashboard's "Revenue this month" KPI now reads from this field
 * so it agrees with the figure surfaced on /wellness/reports. Pre-fix
 * the dashboard pulled today.expectedRevenue from /api/wellness/dashboard
 * (a different scope: scheduled-not-completed) which never reconciled
 * with the P&L tab's realised revenue.
 *
 * Drift-vs-card notes:
 *   - The issue body suggested `totalRevenue` as the field name; the
 *     route already exposed `totals.revenue` (sum of bucketed rows) and
 *     `canonical.revenue` (sum across ALL completed visits including
 *     unbucketed). We add `totalRevenue` as an additive alias for the
 *     bucketed total (matches what the report's Revenue column shows)
 *     so existing callers of `totals.revenue` keep working.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();
prisma.service = prisma.service || {};
prisma.service.findMany = vi.fn();
prisma.serviceConsumption = prisma.serviceConsumption || {};
prisma.serviceConsumption.findMany = vi.fn();
prisma.patient = prisma.patient || { findFirst: vi.fn() };
prisma.loyaltyTransaction = prisma.loyaltyTransaction || { findFirst: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), create: vi.fn() };
prisma.referral = prisma.referral || { findMany: vi.fn(), count: vi.fn() };
prisma.loyaltyConfig = prisma.loyaltyConfig || { findUnique: vi.fn(), upsert: vi.fn() };
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN', wellnessRole = 'admin' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // `vertical: 'wellness'` short-circuits resolveTenantVertical so we
    // don't hit prisma.tenant.findUnique (the test runner has no DB).
    req.user = { userId, tenantId, role, wellnessRole, vertical: 'wellness' };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.visit.findMany.mockReset();
  prisma.service.findMany.mockReset();
  prisma.serviceConsumption.findMany.mockReset();
});

describe('GET /api/wellness/reports/pnl-by-service — #565 (HI-16)', () => {
  test('exposes top-level totalRevenue scalar equal to SUM(rows[].revenue)', async () => {
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, serviceId: 10, amountCharged: 5000, doctorId: 1 },
      { id: 2, serviceId: 10, amountCharged: 7500, doctorId: 1 },
      { id: 3, serviceId: 20, amountCharged: 3000, doctorId: 2 },
    ]);
    prisma.service.findMany.mockResolvedValue([
      { id: 10, name: 'Hair Restoration', category: 'restoration', ticketTier: 'high', basePrice: 5000 },
      { id: 20, name: 'Skincare Consult', category: 'consult', ticketTier: 'low', basePrice: 1500 },
    ]);
    prisma.serviceConsumption.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/wellness/reports/pnl-by-service?from=2026-05-01&to=2026-05-08');
    expect(res.status).toBe(200);
    expect(typeof res.body.totalRevenue).toBe('number');
    const summed = res.body.rows.reduce((s, r) => s + r.revenue, 0);
    expect(res.body.totalRevenue).toBe(summed);
    expect(res.body.totalRevenue).toBe(15500);
    // Back-compat: existing fields stay populated.
    expect(res.body.totals.revenue).toBe(15500);
  });

  test('totalRevenue is 0 when no completed visits in the window', async () => {
    prisma.visit.findMany.mockResolvedValue([]);
    prisma.service.findMany.mockResolvedValue([]);
    prisma.serviceConsumption.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/api/wellness/reports/pnl-by-service?from=2026-05-01&to=2026-05-08');
    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe(0);
    expect(res.body.rows).toEqual([]);
  });
});
