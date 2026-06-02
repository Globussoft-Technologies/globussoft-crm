// Unit tests for backend/lib/posExpense.js
//
// recordSubscriptionExpense logs a SUBSCRIPTION-category WITHDRAWAL against
// the tenant's currently-open shift so a subscription purchase shows in the
// POS Cash Register Expenses tab + is deducted from the drawer. It's shift-
// scoped: no open shift → nothing recorded (caller carries on).
//
// Prisma singleton monkey-patch pattern (vi.mock can't intercept the SUT's
// CJS require).

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const prisma = requireCjs('../../lib/prisma');

prisma.shift = prisma.shift || {};
prisma.shift.findFirst = vi.fn();
prisma.pettyCashLedger = prisma.pettyCashLedger || {};
prisma.pettyCashLedger.create = vi.fn();

const { recordSubscriptionExpense, findOpenShift } = requireCjs('../../lib/posExpense');

beforeEach(() => {
  prisma.shift.findFirst.mockReset();
  prisma.pettyCashLedger.create.mockReset();
  prisma.pettyCashLedger.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
});

describe('recordSubscriptionExpense', () => {
  test('records a SUBSCRIPTION WITHDRAWAL against the open shift', async () => {
    prisma.shift.findFirst.mockResolvedValue({ id: 88, tenantId: 2, status: 'OPEN', userId: 9 });

    const r = await recordSubscriptionExpense({
      tenantId: 2, userId: 9, amount: 499, reason: 'Subscription: Pro',
    });

    expect(r.recorded).toBe(true);
    expect(r.shiftId).toBe(88);
    expect(prisma.pettyCashLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 2,
          shiftId: 88,
          type: 'WITHDRAWAL',
          category: 'SUBSCRIPTION',
          amount: 499,
          reason: 'Subscription: Pro',
          userId: 9,
        }),
      }),
    );
  });

  test('does nothing when no shift is open (NO_OPEN_SHIFT)', async () => {
    prisma.shift.findFirst.mockResolvedValue(null);
    const r = await recordSubscriptionExpense({ tenantId: 2, userId: 9, amount: 499 });
    expect(r.recorded).toBe(false);
    expect(r.reason).toBe('NO_OPEN_SHIFT');
    expect(prisma.pettyCashLedger.create).not.toHaveBeenCalled();
  });

  test('rejects a non-positive amount (INVALID_INPUT, no shift lookup)', async () => {
    const r = await recordSubscriptionExpense({ tenantId: 2, userId: 9, amount: 0 });
    expect(r.recorded).toBe(false);
    expect(r.reason).toBe('INVALID_INPUT');
    expect(prisma.shift.findFirst).not.toHaveBeenCalled();
  });

  test('defaults reason to "Subscription" and falls back to the shift cashier', async () => {
    prisma.shift.findFirst.mockResolvedValue({ id: 5, tenantId: 2, status: 'OPEN', userId: 13 });
    await recordSubscriptionExpense({ tenantId: 2, amount: 100 }); // no userId, no reason
    const data = prisma.pettyCashLedger.create.mock.calls[0][0].data;
    expect(data.reason).toBe('Subscription');
    expect(data.userId).toBe(13); // shift.userId fallback
  });

  test('findOpenShift queries the newest OPEN shift for the tenant', async () => {
    prisma.shift.findFirst.mockResolvedValue({ id: 7 });
    await findOpenShift(2);
    expect(prisma.shift.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 2, status: 'OPEN' },
      orderBy: { id: 'desc' },
    });
  });
});
