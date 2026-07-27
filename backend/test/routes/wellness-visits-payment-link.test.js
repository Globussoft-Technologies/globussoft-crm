// @ts-check
/**
 * Unit tests for wellness payment-link generation and delivery.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

const mockCreateInvoicePaymentLink = vi.fn();
const mockSendEmail = vi.fn();
const mockSendBestEffort = vi.fn();
const mockCreatePatientNotification = vi.fn();

const requireCJS = createRequire(import.meta.url);
const paymentLinkModulePath = requireCJS.resolve('../../lib/paymentLink');
requireCJS.cache[paymentLinkModulePath] = {
  id: paymentLinkModulePath,
  filename: paymentLinkModulePath,
  loaded: true,
  exports: {
    createInvoicePaymentLink: (...args) => mockCreateInvoicePaymentLink(...args),
    resolveGateway: vi.fn(() => 'razorpay'),
    gatewayAvailability: vi.fn(() => ({ razorpay: true, stripe: false })),
  },
};

const emailSenderModulePath = requireCJS.resolve('../../lib/emailSender');
requireCJS.cache[emailSenderModulePath] = {
  id: emailSenderModulePath,
  filename: emailSenderModulePath,
  loaded: true,
  exports: {
    sendEmail: (...args) => mockSendEmail(...args),
  },
};

const whatsappWebClientModulePath = requireCJS.resolve('../../services/whatsappWebClient');
requireCJS.cache[whatsappWebClientModulePath] = {
  id: whatsappWebClientModulePath,
  filename: whatsappWebClientModulePath,
  loaded: true,
  exports: {
    sendBestEffort: (...args) => mockSendBestEffort(...args),
  },
};


const patientNotificationServiceModulePath = requireCJS.resolve('../../lib/patientNotificationService');
requireCJS.cache[patientNotificationServiceModulePath] = {
  id: patientNotificationServiceModulePath,
  filename: patientNotificationServiceModulePath,
  loaded: true,
  exports: {
    createPatientNotification: (...args) => mockCreatePatientNotification(...args),
    listPatientNotifications: vi.fn().mockResolvedValue({ items: [], unreadCount: 0 }),
    markPatientNotificationRead: vi.fn().mockResolvedValue(null),
    markAllPatientNotificationsRead: vi.fn().mockResolvedValue(0),
    toPublic: (n) => n,
  },
};

prisma.visit = prisma.visit || {};
prisma.visit.findFirst = vi.fn();
prisma.visit.findUnique = vi.fn();
prisma.visit.update = vi.fn();

prisma.patient = prisma.patient || {};
prisma.patient.findUnique = vi.fn();
prisma.patient.update = vi.fn();

prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn();
prisma.contact.findFirst = vi.fn();
prisma.contact.create = vi.fn();

prisma.invoice = prisma.invoice || {};
prisma.invoice.findFirst = vi.fn();
prisma.invoice.create = vi.fn();

prisma.payment = prisma.payment || {};
prisma.payment.findMany = vi.fn().mockResolvedValue([]);
prisma.payment.findFirst = vi.fn().mockResolvedValue(null);
prisma.payment.update = vi.fn().mockResolvedValue({ id: 1 });

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();

prisma.loyaltyConfig = prisma.loyaltyConfig || {};
prisma.loyaltyConfig.findUnique = vi.fn().mockResolvedValue(null);
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {};
prisma.loyaltyTransaction.findFirst = vi.fn().mockResolvedValue(null);
prisma.loyaltyTransaction.aggregate = vi.fn().mockResolvedValue({ _sum: { points: 0 } });
prisma.loyaltyTransaction.create = vi.fn().mockResolvedValue({ id: 1 });

prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }), findFirst: vi.fn().mockResolvedValue(null) };
prisma.automationRule = { findMany: vi.fn().mockResolvedValue([]) };
prisma.webhook = { findMany: vi.fn().mockResolvedValue([]) };

const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = 'doctor',
  vertical = 'wellness',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  process.env.FRONTEND_URL = 'https://app.example.com';

  mockCreateInvoicePaymentLink.mockReset();
  mockSendEmail.mockReset();
  mockSendBestEffort.mockReset();
  mockCreatePatientNotification.mockReset();
  mockCreateInvoicePaymentLink.mockResolvedValue({
    url: 'https://rzp.io/l/test-visit-link',
    gateway: 'razorpay',
    paymentId: 99,
  });

  prisma.visit.findFirst.mockReset();
  prisma.visit.update.mockReset();
  prisma.patient.findUnique.mockReset();
  prisma.patient.update.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.contact.create.mockReset();
  prisma.invoice.findFirst.mockReset();
  prisma.invoice.create.mockReset();
  prisma.payment.findMany.mockReset();
  prisma.payment.findFirst.mockReset();
  prisma.payment.update.mockReset();
  prisma.tenant.findUnique.mockReset();

  prisma.visit.update.mockResolvedValue({
    id: 1,
    tenantId: 1,
    patientId: 42,
    serviceId: 10,
    doctorId: 5,
    status: 'completed',
    amountCharged: 1500,
    paymentLinkUrl: 'https://rzp.io/l/test-visit-link',
    paymentLinkGeneratedAt: new Date('2026-07-21T07:00:00.000Z'),
  });

  prisma.visit.findFirst.mockResolvedValue({
    id: 1,
    tenantId: 1,
    patientId: 42,
    serviceId: 10,
    doctorId: 5,
    status: 'booked',
    amountCharged: 1500,
  });

  prisma.patient.findUnique.mockResolvedValue({
    id: 42,
    tenantId: 1,
    name: 'Anita Sharma',
    email: 'anita@example.com',
    phone: '+919876543210',
    contactId: 100,
  });

  prisma.contact.findUnique.mockResolvedValue({
    id: 100,
    tenantId: 1,
    name: 'Anita Sharma',
    email: 'anita@example.com',
    phone: '+919876543210',
  });

  prisma.invoice.findFirst.mockResolvedValue(null);
  prisma.invoice.create.mockResolvedValue({
    id: 200,
    tenantId: 1,
    invoiceNum: 'WLV-1-1234567890123',
    amount: 1500,
    contactId: 100,
    visitId: 1,
  });
  prisma.payment.findMany.mockResolvedValue([]);
  prisma.payment.findFirst.mockResolvedValue(null);
  prisma.payment.update.mockResolvedValue({ id: 1 });

  prisma.tenant.findUnique.mockResolvedValue({ id: 1, name: 'Enhanced Wellness' });
});

describe('PUT /api/wellness/visits/:id payment link hook', () => {
  test('completing a charged visit creates an invoice and payment link', async () => {
    const res = await request(makeApp())
      .put('/api/wellness/visits/1')
      .send({ status: 'completed', notes: '', amountCharged: 1500 });

    expect(res.status).toBe(200);
    expect(res.body.paymentLinkUrl).toBe('https://rzp.io/l/test-visit-link');
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    expect(mockCreateInvoicePaymentLink).toHaveBeenCalledTimes(1);
    expect(prisma.visit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ paymentLinkUrl: 'https://rzp.io/l/test-visit-link' }),
      }),
    );
  });

  test('completing a visit with no charge does not create an invoice or payment link', async () => {
    prisma.visit.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'booked',
      amountCharged: 0,
    });
    prisma.visit.update.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'completed',
      amountCharged: 0,
    });

    const res = await request(makeApp())
      .put('/api/wellness/visits/1')
      .send({ status: 'completed', notes: '', amountCharged: 0 });

    expect(res.status).toBe(200);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(mockCreateInvoicePaymentLink).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty('paymentLinkUrl');
  });

  test('non-completion status transitions do not create an invoice or payment link', async () => {
    prisma.visit.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'booked',
      amountCharged: 1500,
    });
    prisma.visit.update.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'in-treatment',
      amountCharged: 1500,
    });

    const res = await request(makeApp())
      .put('/api/wellness/visits/1')
      .send({ status: 'in-treatment' });

    expect(res.status).toBe(200);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(mockCreateInvoicePaymentLink).not.toHaveBeenCalled();
  });

  test('gateway failure does not fail the visit update', async () => {
    mockCreateInvoicePaymentLink.mockResolvedValue({
      error: 'Razorpay is not configured for this account.',
      code: 'NO_GATEWAY',
    });

    const res = await request(makeApp())
      .put('/api/wellness/visits/1')
      .send({ status: 'completed', notes: '', amountCharged: 1500 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    const urlUpdates = (prisma.visit.update.mock.calls || []).filter(([args]) => args?.data?.paymentLinkUrl);
    expect(urlUpdates).toHaveLength(0);
  });

  test('patient without a contact gets a lazily created contact linked to the invoice', async () => {
    prisma.patient.findUnique.mockResolvedValue({
      id: 42,
      tenantId: 1,
      name: 'New Patient',
      email: 'new@example.com',
      phone: '+919999999999',
      contactId: null,
    });
    prisma.contact.findUnique.mockResolvedValue(null);
    prisma.contact.findFirst.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({
      id: 101,
      tenantId: 1,
      name: 'New Patient',
      email: 'new@example.com',
      phone: '+919999999999',
    });

    await request(makeApp())
      .put('/api/wellness/visits/1')
      .send({ status: 'completed', notes: '', amountCharged: 1500 });

    expect(prisma.contact.create).toHaveBeenCalledTimes(1);
    expect(prisma.patient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 42 },
        data: { contactId: 101 },
      }),
    );
    expect(prisma.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contactId: 101 }) }),
    );
  });
});

describe('POST /api/wellness/visits/:id/payment-link regeneration', () => {
  test('returns a payment link for a completed charged visit and persists it', async () => {
    prisma.visit.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'completed',
      amountCharged: 1500,
    });

    const res = await request(makeApp())
      .post('/api/wellness/visits/1/payment-link')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://rzp.io/l/test-visit-link');
    expect(res.body.gateway).toBe('razorpay');
    expect(prisma.visit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ paymentLinkUrl: 'https://rzp.io/l/test-visit-link' }),
      }),
    );
  });

  test('returns 400 when the visit is not completed', async () => {
    prisma.visit.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'booked',
      amountCharged: 1500,
    });

    const res = await request(makeApp())
      .post('/api/wellness/visits/1/payment-link')
      .send();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VISIT_NOT_COMPLETED');
  });

  test('returns 400 when the visit has no charge', async () => {
    prisma.visit.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'completed',
      amountCharged: 0,
    });

    const res = await request(makeApp())
      .post('/api/wellness/visits/1/payment-link')
      .send();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VISIT_NO_CHARGE');
  });

  test('returns 502 when the payment gateway returns an error', async () => {
    prisma.visit.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'completed',
      amountCharged: 1500,
    });
    mockCreateInvoicePaymentLink.mockResolvedValue({ error: 'Gateway error', code: 'GATEWAY_ERROR' });

    const res = await request(makeApp())
      .post('/api/wellness/visits/1/payment-link')
      .send();

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('GATEWAY_ERROR');
  });

  test('returns 502 when the gateway succeeds without a hosted URL', async () => {
    prisma.visit.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'completed',
      amountCharged: 1500,
    });
    mockCreateInvoicePaymentLink.mockResolvedValue({ gateway: 'razorpay', paymentId: 99 });

    const res = await request(makeApp())
      .post('/api/wellness/visits/1/payment-link')
      .send();

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('GATEWAY_LINK_URL_MISSING');
  });

  test('returns 400 when the visit is already paid', async () => {
    prisma.visit.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'completed',
      amountCharged: 1500,
      paymentStatus: 'paid',
    });

    const res = await request(makeApp())
      .post('/api/wellness/visits/1/payment-link')
      .send();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VISIT_ALREADY_PAID');
    expect(mockCreateInvoicePaymentLink).not.toHaveBeenCalled();
  });
});

describe('POST /api/wellness/visits/:id/payment-link/send delivery', () => {
  test('returns the payment link and best-effort delivery statuses', async () => {
    prisma.visit.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      patientId: 42,
      status: 'completed',
      amountCharged: 1500,
      paymentLinkUrl: 'https://rzp.io/l/test-visit-link',
    });
    mockSendEmail.mockResolvedValue({ sent: true });
    mockSendBestEffort.mockResolvedValue({ sent: true, status: 'SENT' });
    mockCreatePatientNotification.mockResolvedValue({ id: 900 });

    const res = await request(makeApp())
      .post('/api/wellness/visits/1/payment-link/send')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://rzp.io/l/test-visit-link');
    expect(res.body.email).toBe('SENT');
    expect(res.body.whatsapp).toBe('SENT');
    expect(res.body.channel).toBe('email+whatsapp');
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'anita@example.com',
        subject: 'Your wellness payment link for INR 1,500',
      }),
    );
    expect(mockSendBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 1,
        toPhone: '+919876543210',
      }),
    );
    expect(mockCreatePatientNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        patientId: 42,
        tenantId: 1,
        title: 'Payment link sent',
        type: 'payment',
        link: 'https://rzp.io/l/test-visit-link',
      }),
    );
  });
});
