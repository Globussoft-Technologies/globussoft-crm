// @ts-check
/**
 * GET /api/travel/invoices/:id/transactions — settlement history for one travel
 * invoice (milestones + payments + summary). Powers the InvoicesAdmin "History"
 * modal so an operator can see when/how much was paid on a Partial invoice.
 *
 * Pins:
 *   - Returns milestones (ordered) + payments + summary { total, totalReceived,
 *     outstanding }.
 *   - totalReceived sums only SUCCESS payments; outstanding = total − received.
 *   - Payment filtering: only travel-tagged rows for THIS invoice are kept
 *     (a same-numbered generic Invoice's payments are excluded).
 *
 * Pattern mirrors travel-payment-schedule-summary.test.js: patch the prisma
 * singleton BEFORE requiring the router; drive supertest with a real JWT.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelInvoice = { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() };
prisma.travelInvoiceLine = { findMany: vi.fn().mockResolvedValue([]) };
prisma.travelPaymentSchedule = { findMany: vi.fn() };
prisma.payment = { findMany: vi.fn() };
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ id: 1, vertical: 'travel', name: 'Travel Stall', slug: 'travel-stall' });
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = { ...(prisma.auditLog || {}), create: vi.fn().mockResolvedValue({ id: 1 }), findFirst: vi.fn().mockResolvedValue(null) };
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelInvoicesRouter = requireCJS('../../routes/travel_invoices');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelInvoicesRouter);
  return app;
}
function token(role = 'ADMIN') {
  return jwt.sign({ userId: 7, tenantId: 1, role, email: 'a@test.local' }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset().mockResolvedValue({
    id: 100, tenantId: 1, invoiceNum: 'TINV-2026-0005', subBrand: 'tmc',
    contactId: 999, currency: 'INR', totalAmount: '18832.00', status: 'Partial',
  });
  prisma.travelPaymentSchedule.findMany.mockReset().mockResolvedValue([]);
  prisma.payment.findMany.mockReset().mockResolvedValue([]);
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('GET /api/travel/invoices/:id/transactions', () => {
  test('returns milestones + payments + summary; outstanding = total − received', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([
      { id: 1, milestoneOrder: 1, dueDate: new Date('2026-06-22'), expectedAmount: '9416.00', receivedAmount: '9416.00', status: 'paid', paidAt: new Date('2026-06-22') },
      { id: 2, milestoneOrder: 2, dueDate: new Date('2026-06-25'), expectedAmount: '9416.00', receivedAmount: null, status: 'pending', paidAt: null },
    ]);
    prisma.payment.findMany.mockResolvedValue([
      // mark-paid row for THIS invoice (kept)
      { id: 11, amount: 9416, currency: 'INR', gateway: 'upi', gatewayId: 'UTR123', status: 'SUCCESS', paidAt: new Date('2026-06-22'), createdAt: new Date('2026-06-22'), invoiceId: 100, metadata: JSON.stringify({ type: 'travel-payment-schedule', scheduleId: 1, milestoneOrder: 1 }) },
      // a GENERIC payment that happens to share invoiceId 100 (must be EXCLUDED)
      { id: 12, amount: 5000, currency: 'INR', gateway: 'razorpay', gatewayId: 'pay_x', status: 'SUCCESS', paidAt: new Date('2026-06-20'), createdAt: new Date('2026-06-20'), invoiceId: 100, metadata: JSON.stringify({ mode: 'payment_link', plinkId: 'plink_generic' }) },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/transactions')
      .set('Authorization', `Bearer ${token('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice).toMatchObject({ id: 100, invoiceNum: 'TINV-2026-0005', status: 'Partial' });
    expect(res.body.milestones).toHaveLength(2);
    // Only the travel-tagged payment survives the filter (generic #12 excluded).
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]).toMatchObject({ id: 11, method: 'upi', reference: 'UTR123', status: 'SUCCESS' });
    // Summary: received = 9416 of 18832 → outstanding 9416.
    expect(res.body.summary).toMatchObject({ total: '18832.00', totalReceived: '9416.00', outstanding: '9416.00' });
  });

  test('empty history: no milestones / no payments → zero received, full outstanding', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/transactions')
      .set('Authorization', `Bearer ${token('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.milestones).toEqual([]);
    expect(res.body.payments).toEqual([]);
    expect(res.body.summary).toMatchObject({ totalReceived: '0.00', outstanding: '18832.00' });
  });

  test('404 when the invoice does not exist', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/invoices/404/transactions')
      .set('Authorization', `Bearer ${token('ADMIN')}`);
    expect(res.status).toBe(404);
  });
});
