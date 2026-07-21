// @ts-check
/**
 * Unit tests for the patient-resolution changes in the appointment booking
 * routes: POST /api/wellness/appointments/book and the related
 * /book-and-pay + /confirm-payment handshake.
 *
 * Pins the behaviour:
 *   1. Staff booking with an explicit `patientId` creates the Visit for that
 *      patient, not for the logged-in user's own patient record.
 *   2. Self-booking (CUSTOMER role) resolves to the user's own Patient row,
 *      creating it on first book.
 *   3. Staff booking with an unknown/tenant-mismatched patientId returns 404.
 *   4. Staff booking without a patientId falls back to the logged-in user's
 *      own patient record (back-compat for staff self-booking).
 *   5. /book-and-pay stashes the resolved patientId in Payment metadata.
 *   6. /confirm-payment reads the patientId from metadata and binds the Visit
 *      to the same patient; falls back to self-booking if absent.
 *
 * Pattern: prisma singleton monkey-patch BEFORE requiring the router, same as
 * wellness-visits-payment-link.test.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

// Prisma surfaces touched by the routes + appointmentService at runtime.
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn();
prisma.contact.findFirst = vi.fn();
prisma.contact.create = vi.fn();
prisma.contact.update = vi.fn();

prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.patient.findUnique = vi.fn();
prisma.patient.create = vi.fn();
prisma.patient.update = vi.fn();

prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();

prisma.visit = prisma.visit || {};
prisma.visit.create = vi.fn();
prisma.visit.findFirst = vi.fn();
prisma.visit.findUnique = vi.fn();

prisma.service = prisma.service || {};
prisma.service.findFirst = vi.fn();

prisma.payment = prisma.payment || {};
prisma.payment.create = vi.fn();
prisma.payment.findFirst = vi.fn();
prisma.payment.update = vi.fn();

prisma.membership = prisma.membership || {};
prisma.membership.findFirst = vi.fn();

prisma.leaveRequest = prisma.leaveRequest || {};
prisma.leaveRequest.findFirst = vi.fn();

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();

prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }), findFirst: vi.fn().mockResolvedValue(null) };
prisma.automationRule = { findMany: vi.fn().mockResolvedValue([]) };
prisma.webhook = { findMany: vi.fn().mockResolvedValue([]) };

// Mock the shared audit writer so route + service audit calls don't error.
const requireCJS = createRequire(import.meta.url);
const auditModulePath = requireCJS.resolve('../../lib/audit');
requireCJS.cache[auditModulePath] = {
  id: auditModulePath,
  filename: auditModulePath,
  loaded: true,
  exports: {
    writeAudit: vi.fn().mockResolvedValue({ id: 1 }),
    diffFields: vi.fn(() => []),
  },
};

// Mock verifyToken so tests don't need a real JWT for every route call.
const authMiddlewarePath = requireCJS.resolve('../../middleware/auth');
requireCJS.cache[authMiddlewarePath] = {
  id: authMiddlewarePath,
  filename: authMiddlewarePath,
  loaded: true,
  exports: {
    verifyToken: (req, _res, next) => next(),
    verifyRole: (_roles) => (req, _res, next) => next(),
    RBAC_DENIED_MESSAGE: "You don't have permission to perform this action. Contact your administrator.",
    RBAC_DENIED_CODE: 'RBAC_DENIED',
  },
};

import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

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

function resetMocks() {
  prisma.patient.findFirst.mockReset();
  prisma.patient.findUnique.mockReset();
  prisma.patient.create.mockReset();
  prisma.patient.update.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.visit.create.mockReset();
  prisma.visit.findFirst.mockReset();
  prisma.visit.findUnique.mockReset();
  prisma.service.findFirst.mockReset();
  prisma.payment.create.mockReset();
  prisma.payment.findFirst.mockReset();
  prisma.payment.update.mockReset();
  prisma.membership.findFirst.mockReset();
  prisma.leaveRequest.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.contact.create.mockReset();
  prisma.contact.update.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.findFirst.mockReset();
  prisma.automationRule.findMany.mockReset();
  prisma.webhook.findMany.mockReset();
}

function makeVisitEnvelope({ id = 1, patientId = 42, doctorId = null, serviceId = null }) {
  return {
    id,
    tenantId: 1,
    patientId,
    doctorId,
    serviceId,
    status: 'booked',
    bookingType: 'CLINIC_VISIT',
    reason: 'Checkup',
    visitDate: new Date('2026-07-25T10:00:00.000Z'),
    createdAt: new Date('2026-07-21T10:00:00.000Z'),
    patient: { id: patientId, name: 'Anita Sharma', email: 'anita@example.com', phone: '+919876543210' },
    doctor: doctorId ? { id: doctorId, name: 'Dr. Meena' } : null,
    service: serviceId ? { id: serviceId, name: 'Consultation' } : null,
  };
}

const orderId = 'order_test_123';
const paymentId = 'pay_test_123';
const keySecret = 'test_secret';

function computeSignature(orderId, paymentId, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

beforeEach(() => {
  resetMocks();

  // Mock tenant Razorpay gateway so book-and-pay + confirm-payment never
  // hit the network or read real credentials.
  const tenantGatewayModulePath = requireCJS.resolve('../../lib/tenantPaymentGateway');
  requireCJS.cache[tenantGatewayModulePath] = {
    id: tenantGatewayModulePath,
    filename: tenantGatewayModulePath,
    loaded: true,
    exports: {
      getTenantRazorpayClient: vi.fn().mockResolvedValue({
        client: {
          orders: {
            create: vi.fn().mockResolvedValue({ id: orderId }),
          },
        },
        keyId: 'rzp_test_key',
      }),
      getTenantRazorpayCreds: vi.fn().mockResolvedValue({ keySecret }),
      NOT_CONFIGURED_MESSAGE: 'Gateway not configured',
    },
  };

  // Default: staff self has no pre-existing patient record.
  prisma.patient.findFirst.mockResolvedValue(null);
  prisma.patient.findUnique.mockResolvedValue(null);
  prisma.patient.create.mockResolvedValue({
    id: 99,
    tenantId: 1,
    userId: 7,
    name: 'Staff User',
    email: 'staff@example.com',
  });
  prisma.patient.update.mockImplementation(async (args) => ({
    id: args.where.id,
    ...args.data,
  }));

  prisma.contact.findUnique.mockResolvedValue(null);
  prisma.contact.findFirst.mockResolvedValue(null);
  prisma.contact.create.mockResolvedValue({
    id: 88,
    tenantId: 1,
    name: 'Staff User',
    email: 'staff@example.com',
  });
  prisma.contact.update.mockImplementation(async (args) => ({
    id: args.where.id,
    ...args.data,
  }));

  prisma.user.findUnique.mockResolvedValue({
    id: 7,
    name: 'Staff User',
    email: 'staff@example.com',
  });

  prisma.visit.create.mockResolvedValue(makeVisitEnvelope({ id: 1, patientId: 42 }));
  prisma.leaveRequest.findFirst.mockResolvedValue(null);
  prisma.membership.findFirst.mockResolvedValue(null);
  prisma.tenant.findUnique.mockResolvedValue({ id: 1, name: 'Enhanced Wellness' });
  prisma.automationRule.findMany.mockResolvedValue([]);
  prisma.webhook.findMany.mockResolvedValue([]);
});

describe('POST /api/wellness/appointments/book — patient resolution', () => {
  test('staff with explicit patientId creates the visit for that patient', async () => {
    const targetPatient = {
      id: 42,
      tenantId: 1,
      name: 'Anita Sharma',
      email: 'anita@example.com',
    };
    prisma.patient.findFirst.mockImplementation(async (args) => {
      if (args.where.id === 42 && args.where.tenantId === 1) return targetPatient;
      return null;
    });

    const res = await request(makeApp())
      .post('/api/wellness/appointments/book')
      .send({
        reason: 'Routine checkup',
        doctorId: 5,
        serviceId: 10,
        appointmentDate: '2026-07-25',
        appointmentTime: '10:00',
        patientId: 42,
      });

    expect(res.status).toBe(201);
    expect(res.body.appointment.patientName).toBe('Anita Sharma');
    expect(prisma.visit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ patientId: 42 }),
      }),
    );
  });

  test('staff with invalid patientId returns 404', async () => {
    prisma.patient.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/wellness/appointments/book')
      .send({
        reason: 'Routine checkup',
        appointmentDate: '2026-07-25',
        appointmentTime: '10:00',
        patientId: 9999,
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
    expect(prisma.visit.create).not.toHaveBeenCalled();
  });

  test('customer self-booking ignores patientId and uses their own patient record', async () => {
    const ownPatient = {
      id: 42,
      tenantId: 1,
      userId: 7,
      name: 'Demo Customer',
      email: 'demo@example.com',
    };
    prisma.patient.findFirst.mockImplementation(async (args) => {
      if (args.where.user?.id === 7) return ownPatient;
      return null;
    });

    const res = await request(makeApp({ role: 'CUSTOMER' }))
      .post('/api/wellness/appointments/book')
      .send({
        reason: 'Self checkup',
        appointmentDate: '2026-07-25',
        appointmentTime: '10:00',
        patientId: 123, // should be ignored for CUSTOMER
      });

    expect(res.status).toBe(201);
    expect(prisma.visit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ patientId: 42 }),
      }),
    );
  });

  test('staff without patientId falls back to their own patient record', async () => {
    const ownPatient = {
      id: 77,
      tenantId: 1,
      userId: 7,
      name: 'Staff User',
      email: 'staff@example.com',
    };
    prisma.patient.findFirst.mockImplementation(async (args) => {
      if (args.where.user?.id === 7) return ownPatient;
      return null;
    });

    const res = await request(makeApp())
      .post('/api/wellness/appointments/book')
      .send({
        reason: 'Staff checkup',
        appointmentDate: '2026-07-25',
        appointmentTime: '10:00',
      });

    expect(res.status).toBe(201);
    expect(prisma.visit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ patientId: 77 }),
      }),
    );
  });
});

describe('POST /api/wellness/appointments/book-and-pay + confirm-payment — patient resolution', () => {
  test('book-and-pay stashes resolved patientId in payment metadata', async () => {
    const targetPatient = {
      id: 42,
      tenantId: 1,
      name: 'Anita Sharma',
      email: 'anita@example.com',
    };
    prisma.patient.findFirst.mockImplementation(async (args) => {
      if (args.where.id === 42 && args.where.tenantId === 1) return targetPatient;
      return null;
    });
    prisma.service.findFirst.mockResolvedValue({
      id: 10,
      tenantId: 1,
      name: 'Consultation',
      basePrice: 1000,
      isActive: true,
    });

    const paymentRowId = 55;
    prisma.payment.create.mockResolvedValue({ id: paymentRowId, gatewayId: orderId });

    const res = await request(makeApp())
      .post('/api/wellness/appointments/book-and-pay')
      .send({
        reason: 'Paid checkup',
        serviceId: 10,
        appointmentDate: '2026-07-25',
        appointmentTime: '10:00',
        patientId: 42,
      });

    expect(res.status).toBe(201);
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.stringContaining('"patientId":42'),
        }),
      }),
    );
  });

  test('confirm-payment reads patientId from metadata and binds visit to that patient', async () => {
    const targetPatient = {
      id: 42,
      tenantId: 1,
      name: 'Anita Sharma',
      email: 'anita@example.com',
    };
    prisma.patient.findFirst.mockImplementation(async (args) => {
      if (args.where.id === 42 && args.where.tenantId === 1) return targetPatient;
      return null;
    });
    prisma.payment.findFirst.mockResolvedValue({
      id: 55,
      tenantId: 1,
      status: 'PENDING',
      amount: 1180,
      metadata: JSON.stringify({
        kind: 'appointment_payment',
        patientId: 42,
        serviceId: 10,
        appointmentDate: '2026-07-25',
        appointmentTime: '10:00',
        reason: 'Paid checkup',
      }),
    });
    prisma.visit.create.mockResolvedValue(makeVisitEnvelope({ id: 101, patientId: 42 }));

    const res = await request(makeApp())
      .post('/api/wellness/appointments/confirm-payment')
      .send({
        paymentId: 55,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: computeSignature(orderId, paymentId, keySecret),
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.visit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ patientId: 42 }),
      }),
    );
  });

  test('confirm-payment falls back to self-booking when metadata has no patientId', async () => {
    const ownPatient = {
      id: 42,
      tenantId: 1,
      userId: 7,
      name: 'Staff User',
      email: 'staff@example.com',
    };
    prisma.patient.findFirst.mockImplementation(async (args) => {
      if (args.where.user?.id === 7) return ownPatient;
      return null;
    });
    prisma.payment.findFirst.mockResolvedValue({
      id: 55,
      tenantId: 1,
      status: 'PENDING',
      amount: 1180,
      metadata: JSON.stringify({
        kind: 'appointment_payment',
        serviceId: 10,
        appointmentDate: '2026-07-25',
        appointmentTime: '10:00',
        reason: 'Paid checkup',
      }),
    });
    prisma.visit.create.mockResolvedValue(makeVisitEnvelope({ id: 101, patientId: 42 }));

    const res = await request(makeApp())
      .post('/api/wellness/appointments/confirm-payment')
      .send({
        paymentId: 55,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: computeSignature(orderId, paymentId, keySecret),
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.visit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ patientId: 42 }),
      }),
    );
  });
});
