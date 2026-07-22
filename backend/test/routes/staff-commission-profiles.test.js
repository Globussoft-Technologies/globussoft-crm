// @ts-check
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

prisma.commissionProfile = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.auditLog = {
  create: vi.fn().mockResolvedValue({ id: 1 }),
};
prisma.$transaction = vi.fn(async (cb) => cb(prisma));

const requireCJS = createRequire(import.meta.url);
const staffRouter = requireCJS('../../routes/staff');

function formatDateInput(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getCommissionWindowBounds() {
  const today = new Date();
  const currentMonthStart = formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1));
  const maxWindowEnd = formatDateInput(new Date(today.getFullYear(), today.getMonth() + 12, 1));
  return { currentMonthStart, maxWindowEnd };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 7, tenantId: 1, role: 'ADMIN' };
    next();
  });
  app.use('/api/staff', staffRouter);
  return app;
}

beforeEach(() => {
  prisma.commissionProfile.findMany.mockReset();
  prisma.commissionProfile.findFirst.mockReset();
  prisma.commissionProfile.create.mockReset();
  prisma.commissionProfile.update.mockReset();
  prisma.commissionProfile.delete.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/staff/commission-profiles', () => {
  test('returns the profile period window fields', async () => {
    prisma.commissionProfile.findMany.mockResolvedValue([
      {
        id: 11,
        tenantId: 1,
        name: 'Senior Doctor Cut',
        basis: 'REVENUE_PERCENT',
        percentage: '25',
        flatAmount: null,
        period: 'MONTHLY',
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-01T00:00:00.000Z'),
        appliesToCategory: null,
        appliesToProduct: null,
        isActive: true,
      },
    ]);

    const res = await request(makeApp()).get('/api/staff/commission-profiles');
    expect(res.status).toBe(200);
    expect(res.body[0].period).toBe('MONTHLY');
    expect(new Date(res.body[0].periodStart).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(new Date(res.body[0].periodEnd).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('POST /api/staff/commission-profiles', () => {
  test('persists period + periodStart/periodEnd on create', async () => {
    prisma.commissionProfile.create.mockResolvedValue({
      id: 22,
      tenantId: 1,
      name: 'Monthly Bonus',
      basis: 'REVENUE_PERCENT',
      percentage: '12.5',
      flatAmount: null,
      period: 'MONTHLY',
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
      appliesToCategory: null,
      appliesToProduct: null,
      isActive: true,
    });

    const res = await request(makeApp())
      .post('/api/staff/commission-profiles')
      .send({
        name: '  Monthly Bonus  ',
        percentage: 12.5,
        flatAmount: null,
        basis: 'REVENUE_PERCENT',
        period: 'MONTHLY',
        periodStart: '2026-07-01',
        periodEnd: '2026-08-01',
        appliesToProduct: null,
        isActive: true,
      });

    expect(res.status).toBe(201);
    expect(prisma.commissionProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Monthly Bonus',
          period: 'MONTHLY',
          periodStart: new Date('2026-07-01'),
          periodEnd: new Date('2026-08-01'),
        }),
      }),
    );
    expect(res.body.period).toBe('MONTHLY');
  });
});

describe('PUT /api/staff/commission-profiles/:id', () => {
  test('persists period + periodStart/periodEnd on update', async () => {
    prisma.commissionProfile.findFirst.mockResolvedValue({
      id: 22,
      tenantId: 1,
      name: 'Monthly Bonus',
      basis: 'REVENUE_PERCENT',
      percentage: '12.5',
      flatAmount: null,
      period: 'MONTHLY',
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
      appliesToCategory: null,
      appliesToProduct: null,
      isActive: true,
    });
    prisma.commissionProfile.update.mockResolvedValue({
      id: 22,
      tenantId: 1,
      name: 'Monthly Bonus',
      basis: 'REVENUE_PERCENT',
      percentage: '15',
      flatAmount: null,
      period: 'QUARTERLY',
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-01T00:00:00.000Z'),
      appliesToCategory: null,
      appliesToProduct: null,
      isActive: true,
    });

    const res = await request(makeApp())
      .put('/api/staff/commission-profiles/22')
      .send({
        percentage: 15,
        period: 'QUARTERLY',
        periodStart: '2026-07-01',
        periodEnd: '2026-10-01',
      });

    expect(res.status).toBe(200);
    expect(prisma.commissionProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 22 },
        data: expect.objectContaining({
          period: 'QUARTERLY',
          periodStart: new Date('2026-07-01'),
          periodEnd: new Date('2026-10-01'),
        }),
      }),
    );
    expect(res.body.period).toBe('QUARTERLY');
  });
});

describe('POST /api/staff/commission-profiles — date validation', () => {
  test('rejects a periodStart before the current month before Prisma create is called', async () => {
    const { currentMonthStart } = getCommissionWindowBounds();
    const priorMonthStart = formatDateInput(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1));

    const res = await request(makeApp())
      .post('/api/staff/commission-profiles')
      .send({
        name: 'Future Bonus',
        percentage: 10,
        flatAmount: null,
        basis: 'REVENUE_PERCENT',
        period: 'MONTHLY',
        periodStart: priorMonthStart,
        periodEnd: currentMonthStart,
        appliesToProduct: null,
        isActive: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/periodStart cannot be before the current month/i);
    expect(prisma.commissionProfile.create).not.toHaveBeenCalled();
  });

  test('rejects a periodEnd beyond one year from the current month before Prisma create is called', async () => {
    const { currentMonthStart } = getCommissionWindowBounds();
    const overLimitEnd = formatDateInput(new Date(new Date().getFullYear(), new Date().getMonth() + 12, 2));

    const res = await request(makeApp())
      .post('/api/staff/commission-profiles')
      .send({
        name: 'Future Bonus',
        percentage: 10,
        flatAmount: null,
        basis: 'REVENUE_PERCENT',
        period: 'MONTHLY',
        periodStart: currentMonthStart,
        periodEnd: overLimitEnd,
        appliesToProduct: null,
        isActive: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/periodEnd cannot be more than one year from the current month/i);
    expect(prisma.commissionProfile.create).not.toHaveBeenCalled();
  });
});
