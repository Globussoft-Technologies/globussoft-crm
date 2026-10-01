import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS('../../lib/prisma');
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();
prisma.leaveRequest = prisma.leaveRequest || {};
prisma.leaveRequest.findMany = vi.fn();
prisma.blockTime = prisma.blockTime || {};
prisma.blockTime.findMany = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn();

const wellnessRouter = requireCJS('../../routes/wellness');
const { JWT_SECRET } = requireCJS('../../config/secrets');

function makeApp() {
  const app = express();
  app.use('/api/wellness', wellnessRouter);
  return app;
}

function bearer() {
  return `Bearer ${jwt.sign({
    userId: 1, tenantId: 7, role: 'USER', userType: 'STAFF', isOwner: false,
  }, JWT_SECRET, { expiresIn: '5m' })}`;
}

beforeEach(() => {
  prisma.user.findMany.mockReset();
  prisma.visit.findMany.mockReset();
  prisma.leaveRequest.findMany.mockReset();
  prisma.blockTime.findMany.mockReset();
  prisma.revokedToken.findUnique.mockReset();
  prisma.user.findMany.mockResolvedValue([
    { id: 11, name: 'Busy doctor', wellnessRole: 'doctor' },
    { id: 12, name: 'Free doctor', wellnessRole: 'doctor' },
  ]);
  prisma.leaveRequest.findMany.mockResolvedValue([]);
  prisma.blockTime.findMany.mockResolvedValue([]);
  prisma.revokedToken.findUnique.mockResolvedValue(null);
});

describe('GET /doctors/availability withSlots', () => {
  test('marks a fully booked doctor unavailable while keeping a free doctor selectable', async () => {
    const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    prisma.visit.findMany.mockResolvedValue([{
      doctorId: 11,
      visitDate: new Date(`${date}T09:00:00+05:30`),
      service: { durationMin: 540 },
    }]);

    const res = await request(makeApp())
      .get(`/api/wellness/doctors/availability?date=${date}&withSlots=true`)
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: 11, available: false, availableSlotCount: 0, unavailableReason: 'No available slots on this date' }),
      expect.objectContaining({ id: 12, available: true, availableSlotCount: 18 }),
    ]);
    expect(prisma.visit.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 7, doctorId: { in: [11, 12] } }),
    }));
  });

  test('keeps day-level availability unchanged for calendar callers', async () => {
    const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const res = await request(makeApp())
      .get(`/api/wellness/doctors/availability?date=${date}`)
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: 11, available: true }),
      expect.objectContaining({ id: 12, available: true }),
    ]);
    expect(res.body[0]).not.toHaveProperty('availableSlotCount');
    expect(prisma.visit.findMany).not.toHaveBeenCalled();
  });
});
