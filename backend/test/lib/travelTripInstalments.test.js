// @ts-check
import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { materializeTripInstalmentsFromPlan } = requireCJS('../../lib/travelTripInstalments');

prisma.tripPaymentPlan = {
  findUnique: vi.fn(),
};
prisma.tripParticipant = {
  findMany: vi.fn(),
};
prisma.tripInstalmentPayment = {
  findMany: vi.fn(),
  createMany: vi.fn(),
};

beforeEach(() => {
  prisma.tripPaymentPlan.findUnique.mockReset();
  prisma.tripParticipant.findMany.mockReset();
  prisma.tripInstalmentPayment.findMany.mockReset();
  prisma.tripInstalmentPayment.createMany.mockReset();
});

describe('materializeTripInstalmentsFromPlan', () => {
  test('returns a no-op when there is no plan and missing plans are allowed', async () => {
    prisma.tripPaymentPlan.findUnique.mockResolvedValue(null);

    const result = await materializeTripInstalmentsFromPlan({
      db: prisma,
      tripId: 100,
      allowMissingPlan: true,
    });

    expect(result).toMatchObject({
      materialised: 0,
      skipped: 0,
      participants: 0,
      instalmentsPerParticipant: 0,
      planFound: false,
    });
    expect(prisma.tripParticipant.findMany).not.toHaveBeenCalled();
    expect(prisma.tripInstalmentPayment.findMany).not.toHaveBeenCalled();
    expect(prisma.tripInstalmentPayment.createMany).not.toHaveBeenCalled();
  });

  test('materialises only the missing pending rows for the selected participants', async () => {
    prisma.tripPaymentPlan.findUnique.mockResolvedValue({
      tripId: 100,
      instalmentsJson: JSON.stringify([
        { dueDate: '2026-09-01', amount: 5000 },
        { dueDate: '2026-10-01', amount: 4500 },
      ]),
    });
    prisma.tripParticipant.findMany.mockResolvedValue([{ id: 11 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { participantId: 11, instalmentIndex: 0 },
    ]);
    prisma.tripInstalmentPayment.createMany.mockResolvedValue({ count: 1 });

    const result = await materializeTripInstalmentsFromPlan({
      db: prisma,
      tripId: 100,
      participantIds: [11],
    });

    expect(result).toMatchObject({
      materialised: 1,
      skipped: 1,
      participants: 1,
      instalmentsPerParticipant: 2,
      planFound: true,
    });
    expect(prisma.tripParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tripId: 100, id: { in: [11] } },
        select: { id: true },
      }),
    );
    expect(prisma.tripInstalmentPayment.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            tripId: 100,
            participantId: 11,
            instalmentIndex: 1,
            status: 'pending',
            paidAmount: 0,
          }),
        ],
      }),
    );
  });
});
