import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

prisma.$queryRaw = vi.fn();
prisma.$transaction = vi.fn();
prisma.plotBooking = { findFirst: vi.fn(), update: vi.fn() };
const { reconcilePlotBookingPayment, successfulPaymentTotal } = createRequire(import.meta.url)('../../lib/plotBookingPayments');

beforeEach(() => {
  prisma.$queryRaw.mockReset().mockResolvedValue([]);
  prisma.$transaction.mockReset().mockImplementation(callback => callback(prisma));
  prisma.plotBooking.findFirst.mockReset().mockResolvedValue({ id: 12, tenantId: 7, totalAmount: 1000 });
  prisma.plotBooking.update.mockReset().mockImplementation(async ({ data }) => ({ id: 12, ...data }));
  prisma.contact = { findFirst: vi.fn().mockResolvedValue(null) };
  prisma.plotSite = { findFirst: vi.fn().mockResolvedValue(null) };
});

describe('plot booking payment reconciliation', () => {
  test('synchronizes invoices before releasing the transaction and rolls back on invoice failure', async () => {
    let active = false;
    prisma.$transaction.mockImplementation(async callback => {
      active = true;
      try { return await callback(prisma); } finally { active = false; }
    });
    prisma.plotBooking.findFirst.mockResolvedValue({ id: 12, tenantId: 7, totalAmount: 1000, invoiceId: 50 });
    prisma.invoice = {
      findFirst: vi.fn(async () => { expect(active).toBe(true); return { id: 50 }; }),
      update: vi.fn(async () => { expect(active).toBe(true); throw new Error('invoice failure'); }),
    };
    const payment = { tenantId: 7, metadata: JSON.stringify({ kind: 'plot-booking-payment', plotBookingId: 12 }) };
    await expect(reconcilePlotBookingPayment(payment)).rejects.toThrow('invoice failure');
    expect(prisma.invoice.update).toHaveBeenCalledOnce();
    expect(active).toBe(false);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.invoice.findFirst.mock.invocationCallOrder[0]);
  });

  test('uses exact JSON identity, kind, tenant and successful status in a database aggregate', async () => {
    prisma.$queryRaw.mockResolvedValue([{ amountPaid: 100 }]);
    expect(await successfulPaymentTotal(prisma, 7, 12)).toBe(100);
    const [parts, tenantId, bookingId] = prisma.$queryRaw.mock.calls[0];
    const sql = parts.join('?');
    expect(sql).toContain('SUM(amount)');
    expect(sql).toContain("status = 'SUCCESS'");
    expect(sql).toContain("'$.kind')) = 'plot-booking-payment'");
    expect(sql).toContain("'$.plotBookingId')) = ?");
    expect(sql).toContain('JSON_VALID(metadata)');
    expect(sql).not.toMatch(/LIKE|contains/);
    expect([tenantId, bookingId]).toEqual([7, '12']);
  });

  test('locks the tenant booking before reading or recomputing and is idempotent on retries', async () => {
    prisma.$queryRaw.mockImplementation(async parts => parts.join('').includes('SUM(amount)') ? [{ amountPaid: 100 }] : []);
    const payment = { tenantId: 7, metadata: JSON.stringify({ kind: 'plot-booking-payment', plotBookingId: 12 }) };
    await reconcilePlotBookingPayment(payment);
    await reconcilePlotBookingPayment(payment);
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([12, 7]);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.plotBooking.findFirst.mock.invocationCallOrder[0]);
    for (const [query] of prisma.plotBooking.update.mock.calls) {
      expect(query.data).toEqual({ amountPaid: 100, balance: 900, paymentStatus: 'PARTIAL' });
    }
    expect(prisma.plotBooking.findFirst).toHaveBeenCalledWith({ where: { id: 12, tenantId: 7 } });
  });

  test.each(['not-json', '{}', '{"kind":"travel-milestone","plotBookingId":12}', '{"kind":"plot-booking-payment","plotBookingId":0}'])('ignores unrelated or malformed metadata: %s', async metadata => {
    expect(await reconcilePlotBookingPayment({ tenantId: 7, metadata })).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('does not update a booking belonging to a different tenant', async () => {
    prisma.plotBooking.findFirst.mockResolvedValue(null);
    expect(await reconcilePlotBookingPayment({ tenantId: 7, metadata: '{"kind":"plot-booking-payment","plotBookingId":12}' })).toBeNull();
    expect(prisma.plotBooking.update).not.toHaveBeenCalled();
  });
});
