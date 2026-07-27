// @ts-check
/**
 * Regression test for the wellness owner dashboard patient count.
 *
 * The dashboard quick-link must count the same patient dataset as the
 * Patients page, which excludes soft-deleted rows. This pins the route's
 * patient-count query so the dashboard cannot drift back to counting all
 * tenant rows.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();
prisma.patient = prisma.patient || {};
prisma.patient.count = vi.fn();
prisma.patient.findMany = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.count = vi.fn();
prisma.agentRecommendation = prisma.agentRecommendation || {};
prisma.agentRecommendation.findMany = vi.fn();
prisma.treatmentPlan = prisma.treatmentPlan || {};
prisma.treatmentPlan.count = vi.fn();
prisma.service = prisma.service || {};
prisma.service.count = vi.fn();
prisma.location = prisma.location || {};
prisma.location.count = vi.fn();
prisma.smsMessage = prisma.smsMessage || {};
prisma.smsMessage.findMany = vi.fn();
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {};
prisma.loyaltyTransaction.findMany = vi.fn();
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
    req.user = { userId, tenantId, role, wellnessRole, vertical: 'wellness' };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.visit.findMany.mockReset().mockResolvedValue([]);
  prisma.patient.count.mockReset().mockResolvedValue(66);
  prisma.patient.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.count.mockReset().mockResolvedValue(0);
  prisma.agentRecommendation.findMany.mockReset().mockResolvedValue([]);
  prisma.treatmentPlan.count.mockReset().mockResolvedValue(0);
  prisma.service.count.mockReset().mockResolvedValue(0);
  prisma.location.count.mockReset().mockResolvedValue(0);
  prisma.smsMessage.findMany.mockReset().mockResolvedValue([]);
  prisma.loyaltyTransaction.findMany.mockReset().mockResolvedValue([]);
});

describe('GET /api/wellness/dashboard — patient count mirrors Patients page scope', () => {
  test('counts only non-deleted patients in the tenant', async () => {
    const res = await request(makeApp()).get('/api/wellness/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.totals.patients).toBe(66);
    expect(prisma.patient.count).toHaveBeenCalledTimes(1);
    expect(prisma.patient.count).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        deletedAt: null,
      },
    });
  });
});
