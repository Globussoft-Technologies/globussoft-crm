// @ts-check
/**
 * Travel diagnostic share route contract test.
 */

import { describe, test, expect, beforeEach, vi, afterAll } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

const emailSender = requireCJS('../../lib/emailSender');
const waWebClient = requireCJS('../../services/whatsappWebClient');
const audit = requireCJS('../../lib/audit');

audit.writeAudit = vi.fn().mockResolvedValue(undefined);
emailSender.sendEmail = vi.fn().mockResolvedValue({ sent: true, messageId: 'msg-1' });
waWebClient.sendBestEffort = vi.fn().mockResolvedValue({ sent: true, status: 'SENT' });

prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  findFirst: vi.fn(),
};
prisma.contact = {
  ...(prisma.contact || {}),
  findFirst: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.userRole = {
  ...(prisma.userRole || {}),
  findMany: vi.fn().mockResolvedValue([
    {
      role: {
        permissions: [{ module: 'diagnostics', action: 'update' }],
      },
    },
  ]),
  findUnique: vi.fn().mockResolvedValue(null),
  create: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({ id: 1 }),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ id: 1, vertical: 'travel' });

const router = requireCJS('../../routes/travel_diagnostics');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', router);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.travelDiagnostic.findFirst.mockResolvedValue({
    id: 42,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 100,
  });
  prisma.contact.findFirst.mockResolvedValue({
    id: 100,
    name: 'Asha Verma',
    email: 'asha@example.com',
    phone: '+91 99999 00000',
  });
});

afterAll(() => {
  delete audit.writeAudit;
});

const frontendBase = 'https://crm.globusdemos.com';

describe('POST /api/travel/diagnostics/:id/share', () => {
  test('auto share returns the public link and calls both delivery helpers', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/42/share')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        channel: 'auto',
        frontendBase,
      });

    expect(res.status).toBe(200);
    expect(res.body.diagnosticId).toBe(42);
    expect(res.body.reportSlug).toMatch(/^42-/);
    expect(res.body.shareUrl).toBe(`${frontendBase}/p/tmc/report/${res.body.reportSlug}`);
    expect(res.body.channel).toBe('email+whatsapp');
    expect(res.body.email).toBe('SENT');
    expect(res.body.whatsapp).toBe('SENT');
    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1);
    expect(waWebClient.sendBestEffort).toHaveBeenCalledTimes(1);
    expect(audit.writeAudit).toHaveBeenCalledWith(
      'TravelDiagnostic',
      'DIAGNOSTIC_SHARE',
      42,
      7,
      1,
      expect.objectContaining({
        subBrand: 'tmc',
        channel: 'email+whatsapp',
      }),
    );
  });

  test('manual share returns the public link without sending', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/42/share')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        channel: 'manual',
        frontendBase,
      });

    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('none');
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(waWebClient.sendBestEffort).not.toHaveBeenCalled();
  });
});
