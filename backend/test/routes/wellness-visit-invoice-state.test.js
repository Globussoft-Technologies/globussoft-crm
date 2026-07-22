// @ts-check
/**
 * Regression tests for wellness patient visit payloads.
 *
 * The patient detail route and the patient-visits subresource both need to
 * surface invoice payment state for completed visits, but this schema does
 * not expose a Prisma `Visit.invoice` include. These tests pin the safe
 * fallback: fetch visits normally, enrich them in memory, and return the
 * invoice state without mutating the database.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();
prisma.invoice = prisma.invoice || {};
prisma.invoice.findMany = vi.fn();
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });
prisma.referral = prisma.referral || {
  findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), update: vi.fn(),
};
prisma.loyaltyConfig = prisma.loyaltyConfig || { findUnique: vi.fn() };
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {
  findFirst: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), create: vi.fn(),
};
prisma.automationRule = prisma.automationRule || { findMany: vi.fn().mockResolvedValue([]) };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 7, tenantId: 1, role: 'ADMIN', wellnessRole: 'admin' };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.visit.findMany.mockReset();
  prisma.invoice.findMany.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
  prisma.invoice.findMany.mockResolvedValue([]);
});

describe('GET /api/wellness/patients/:id', () => {
  test('enriches nested visits with invoice state', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22,
      name: 'Riya Sharma',
      visits: [
        {
          id: 301,
          visitDate: new Date('2026-07-20T10:00:00Z'),
          status: 'completed',
          amountCharged: 300,
          paymentLinkUrl: 'https://rzp.io/l/visit-301',
          service: { id: 1, name: 'Hair Streak' },
          doctor: { id: 2, name: 'Dr. Anita Das', email: 'anita@example.com' },
        },
      ],
      prescriptions: [],
      consents: [],
      treatmentPlans: [],
    });
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 9001,
        visitId: 301,
        status: 'PAID',
        paidAt: new Date('2026-07-21T10:00:00Z'),
      },
    ]);

    const res = await request(makeApp()).get('/api/wellness/patients/22');

    expect(res.status).toBe(200);
    expect(res.body.visits[0]).toMatchObject({
      id: 301,
      invoice: {
        id: 9001,
        status: 'PAID',
      },
    });
  });
});

describe('GET /api/wellness/patients/:id/visits', () => {
  test('enriches the visit list with invoice state', async () => {
    prisma.patient.findFirst.mockResolvedValue({ id: 22 });
    prisma.visit.findMany.mockResolvedValue([
      {
        id: 401,
        visitDate: new Date('2026-07-20T10:00:00Z'),
        status: 'completed',
        amountCharged: 300,
        paymentLinkUrl: 'https://rzp.io/l/visit-401',
        service: { id: 1, name: 'Hair Streak' },
        doctor: { id: 2, name: 'Dr. Anita Das' },
      },
      {
        id: 402,
        visitDate: new Date('2026-07-19T10:00:00Z'),
        status: 'completed',
        amountCharged: 500,
        paymentLinkUrl: 'https://rzp.io/l/visit-402',
        service: { id: 3, name: 'Advanced Acne Facial' },
        doctor: { id: 4, name: 'Dr. Vikas Singh' },
      },
    ]);
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 9002,
        visitId: 401,
        status: 'PAID',
        paidAt: new Date('2026-07-21T10:00:00Z'),
      },
    ]);

    const res = await request(makeApp()).get('/api/wellness/patients/22/visits');

    expect(res.status).toBe(200);
    expect(prisma.visit.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          visitId: { in: [401, 402] },
        }),
      }),
    );
    expect(res.body[0]).toMatchObject({
      id: 401,
      invoice: {
        id: 9002,
        status: 'PAID',
      },
    });
    expect(res.body[1]).not.toHaveProperty('invoice');
  });
});
