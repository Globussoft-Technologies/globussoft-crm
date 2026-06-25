// @ts-check
/**
 * POST /api/travel/payment-schedules/:scheduleId/remind — manual customer
 * payment reminder (the Milestone Tracker "Notify" button), plus the contact
 * enrichment on GET /payment-schedules/upcoming.
 *
 * Pins:
 *   - Happy path: loads schedule + invoice + contact, sends email + WhatsApp,
 *     bumps remindersSentCount, returns { ok:true, channels, contactName }.
 *   - 422 NO_CONTACT_CHANNEL when the contact has neither email nor phone.
 *   - 400 NOTHING_TO_REMIND for a paid/waived milestone.
 *   - 404 MILESTONE_NOT_FOUND for an unknown schedule.
 *   - upcoming endpoint hoists contactName/contactPhone/contactEmail onto rows.
 *
 * Pattern mirrors travel-payment-schedule-summary.test.js: patch the prisma
 * singleton + mock the email/WhatsApp transports BEFORE requiring the router.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// The router is loaded via native require() (createRequire), which bypasses
// vitest's vi.mock module interception. So patch the REAL module objects
// before the router requires them: the router destructures `sendEmail` (capture
// at require-time → must patch first) and holds whatsappWebClient as an object
// (`waWebClient.sendBestEffort(...)` → dynamic property lookup at call-time).
const sendEmailMock = vi.fn();
const sendBestEffortMock = vi.fn();
const createPayLinkMock = vi.fn();
requireCJS('../../lib/emailSender').sendEmail = sendEmailMock;
requireCJS('../../services/whatsappWebClient').sendBestEffort = sendBestEffortMock;
requireCJS('../../lib/paymentLink').createInvoicePaymentLink = createPayLinkMock;

// Patch prisma BEFORE requiring the router.
prisma.travelInvoice = { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() };
prisma.travelInvoiceLine = { findMany: vi.fn().mockResolvedValue([]) };
prisma.travelPaymentSchedule = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  update: vi.fn().mockResolvedValue({ id: 1 }),
};
prisma.contact = { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) };
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ id: 1, vertical: 'travel', name: 'Travel Stall', slug: 'travel-stall' });
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelInvoicesRouter = requireCJS('../../routes/travel_invoices');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelInvoicesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeSchedule(overrides = {}) {
  return {
    id: 555,
    tenantId: 1,
    invoiceId: 100,
    milestoneOrder: 2,
    dueDate: new Date(Date.now() - 3 * 86_400_000), // overdue
    expectedAmount: '9416.00',
    expectedCurrency: 'INR',
    status: 'pending',
    remindersSentCount: 0,
    invoice: { id: 100, invoiceNum: 'TINV-2026-0005', subBrand: 'tmc', contactId: 999, currency: 'INR' },
    ...overrides,
  };
}

beforeEach(() => {
  sendEmailMock.mockReset().mockResolvedValue({ sent: true });
  sendBestEffortMock.mockReset().mockResolvedValue({ sent: true });
  createPayLinkMock.mockReset().mockResolvedValue({ url: 'https://rzp.io/i/abc123', gateway: 'razorpay', paymentId: 1 });
  prisma.travelPaymentSchedule.findFirst.mockReset();
  prisma.travelPaymentSchedule.update.mockReset().mockResolvedValue({ id: 555 });
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: 'travel', name: 'Travel Stall', slug: 'travel-stall' });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('POST /api/travel/payment-schedules/:scheduleId/remind', () => {
  test('happy path: sends email + WhatsApp, bumps counter, returns ok + channels', async () => {
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(makeSchedule());
    prisma.contact.findFirst.mockResolvedValue({ id: 999, name: 'Harsha Vardhan', email: 'h@example.com', phone: '+919177007429' });

    const res = await request(makeApp())
      .post('/api/travel/payment-schedules/555/remind')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.channels).toEqual(expect.arrayContaining(['email', 'whatsapp']));
    expect(res.body.contactName).toBe('Harsha Vardhan');
    expect(res.body.payUrl).toBe('https://rzp.io/i/abc123');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendBestEffortMock).toHaveBeenCalledTimes(1);
    // Pay link created for the MILESTONE amount (not the full invoice), tagged
    // with travel context so the webhook reconciles back to this milestone.
    expect(createPayLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 1,
        invoice: expect.objectContaining({ id: 100, amount: 9416 }),
        currency: 'INR',
        travelContext: expect.objectContaining({ scheduleId: 555, travelInvoiceId: 100 }),
      }),
    );
    // The link appears in both the email body and the WhatsApp fallback text.
    expect(sendEmailMock.mock.calls[0][0].text).toContain('https://rzp.io/i/abc123');
    expect(sendBestEffortMock.mock.calls[0][0].fallbackText).toContain('https://rzp.io/i/abc123');
    // Counter bumped + timestamp set.
    expect(prisma.travelPaymentSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 555 },
        data: expect.objectContaining({ remindersSentCount: 1 }),
      }),
    );
  });

  test('fail-soft: no gateway configured → still sends, payUrl null, no link in body', async () => {
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(makeSchedule());
    prisma.contact.findFirst.mockResolvedValue({ id: 999, name: 'Harsha', email: 'h@example.com', phone: '+919177007429' });
    createPayLinkMock.mockResolvedValue({ error: 'No payment gateway configured', code: 'NO_GATEWAY' });

    const res = await request(makeApp())
      .post('/api/travel/payment-schedules/555/remind')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.payUrl).toBeNull();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].text).not.toContain('Pay securely here');
  });

  test('ok=false when recipient exists but no channel delivered', async () => {
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(makeSchedule());
    prisma.contact.findFirst.mockResolvedValue({ id: 999, name: 'No Reach', email: 'x@example.com', phone: '+910000000000' });
    sendEmailMock.mockResolvedValue({ sent: false, reason: 'no_api_key' });
    sendBestEffortMock.mockResolvedValue({ sent: false, status: 'SKIPPED' });

    const res = await request(makeApp())
      .post('/api/travel/payment-schedules/555/remind')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.channels).toEqual([]);
  });

  test('422 NO_CONTACT_CHANNEL when contact has neither email nor phone', async () => {
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(makeSchedule());
    prisma.contact.findFirst.mockResolvedValue({ id: 999, name: 'Ghost', email: null, phone: null });

    const res = await request(makeApp())
      .post('/api/travel/payment-schedules/555/remind')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NO_CONTACT_CHANNEL');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  test('400 NOTHING_TO_REMIND for a paid milestone', async () => {
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(makeSchedule({ status: 'paid' }));

    const res = await request(makeApp())
      .post('/api/travel/payment-schedules/555/remind')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOTHING_TO_REMIND');
  });

  test('404 MILESTONE_NOT_FOUND for an unknown schedule', async () => {
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/payment-schedules/777/remind')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MILESTONE_NOT_FOUND');
  });
});

describe('GET /api/travel/payment-schedules/upcoming — contact enrichment', () => {
  test('hoists contactName / contactPhone / contactEmail onto milestone rows', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([
      {
        id: 1, tenantId: 1, invoiceId: 100, milestoneOrder: 1,
        dueDate: new Date(Date.now() + 2 * 86_400_000),
        expectedAmount: '9416.00', expectedCurrency: 'INR', receivedAmount: null,
        status: 'pending', createdAt: new Date(),
        invoice: { invoiceNum: 'TINV-2026-0005', subBrand: 'tmc', contactId: 999 },
      },
    ]);
    prisma.travelPaymentSchedule.count.mockResolvedValue(1);
    prisma.contact.findMany.mockResolvedValue([
      { id: 999, name: 'Harsha Vardhan', phone: '+919177007429', email: 'h@example.com' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.milestones[0]).toMatchObject({
      contactName: 'Harsha Vardhan',
      contactPhone: '+919177007429',
      contactEmail: 'h@example.com',
    });
  });
});
