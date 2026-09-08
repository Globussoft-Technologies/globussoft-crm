import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

prisma.service = prisma.service || {};
prisma.service.findMany = vi.fn();
prisma.service.count = vi.fn();
prisma.$transaction = vi.fn((operations) => Promise.all(operations));

const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { userId: 7, tenantId: 42, role: 'ADMIN', wellnessRole: 'admin', vertical: 'wellness' };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.service.findMany.mockReset();
  prisma.service.count.mockReset();
  prisma.$transaction.mockClear();
});

describe('GET /api/wellness/services pagination', () => {
  test('returns a tenant-scoped envelope with deterministic ordering', async () => {
    const rows = [{ id: 25, name: 'Consultation', ticketTier: 'medium' }];
    prisma.service.findMany.mockResolvedValue(rows);
    prisma.service.count.mockResolvedValue(49);

    const res = await request(makeApp()).get('/api/wellness/services?page=2&pageSize=24');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: rows, total: 49, page: 2, pageSize: 24 });
    const where = { tenantId: 42, NOT: { isActive: false } };
    expect(prisma.service.findMany).toHaveBeenCalledWith({
      where,
      orderBy: [{ ticketTier: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      skip: 24,
      take: 24,
    });
    expect(prisma.service.count).toHaveBeenCalledWith({ where });
  });
});
