// @ts-check
/**
 * Unit tests for the public wellness enquiry endpoint that accepts static
 * site form submissions and stores them as wellness Contact leads.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

const authPath = requireCJS.resolve('../../middleware/auth.js');
Module._cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyToken: (_req, _res, next) => next(),
    verifyRole: () => (_req, _res, next) => next(),
    RBAC_DENIED_MESSAGE: 'denied',
    RBAC_DENIED_CODE: 'RBAC_DENIED',
  },
};

const requirePermissionPath = requireCJS.resolve('../../middleware/requirePermission.js');
Module._cache[requirePermissionPath] = {
  id: requirePermissionPath,
  filename: requirePermissionPath,
  loaded: true,
  exports: {
    requirePermission: () => (_req, _res, next) => next(),
    userHasPermission: () => true,
  },
};

const wellnessRolePath = requireCJS.resolve('../../middleware/wellnessRole.js');
Module._cache[wellnessRolePath] = {
  id: wellnessRolePath,
  filename: wellnessRolePath,
  loaded: true,
  exports: {
    verifyWellnessRole: () => (_req, _res, next) => next(),
  },
};

const auditPath = requireCJS.resolve('../../lib/audit.js');
Module._cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: {
    writeAudit: vi.fn().mockResolvedValue({ id: 1 }),
    diffFields: vi.fn(() => []),
  },
};

const dedupPath = requireCJS.resolve('../../utils/deduplication.js');
const findDuplicateContactFullMock = vi.fn();
Module._cache[dedupPath] = {
  id: dedupPath,
  filename: dedupPath,
  loaded: true,
  exports: {
    findDuplicateContactFull: findDuplicateContactFullMock,
    findDuplicateContact: vi.fn(),
    findDuplicateContactByPassport: vi.fn(),
    findDuplicateMarketplaceLead: vi.fn(),
    normalizePhone: vi.fn(),
    toE164: vi.fn(),
    computeDuplicateGroupKey: vi.fn(),
  },
};

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn();
prisma.contact.findMany = vi.fn();
prisma.contact.create = vi.fn();
prisma.contact.update = vi.fn();

const prismaPath = requireCJS.resolve('../../lib/prisma.js');
Module._cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: prisma,
};

const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset();
    prisma.contact.findUnique.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.create.mockReset();
  prisma.contact.update.mockReset();
  findDuplicateContactFullMock.mockReset();
});

describe('POST /api/wellness/public/enquiry', () => {
  test('rejects missing tenantSlug', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/public/enquiry')
      .send({ firstName: 'Asha', lastName: 'Iyer', email: 'asha@example.com', phone: '+919876543210' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_TENANT' });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('creates a Lead contact for the wellness tenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1,
      slug: 'enhanced-wellness',
      vertical: 'wellness',
      name: 'Enhanced Wellness',
    });
    findDuplicateContactFullMock.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 42 });

    const res = await request(makeApp())
      .post('/api/wellness/public/enquiry')
      .send({
        tenantSlug: 'enhanced-wellness',
        firstName: 'Asha',
        lastName: 'Iyer',
        email: 'asha@example.com',
        phone: '+919876543210',
        service: 'Hair Restoration',
        message: '<b>Need</b> a consult',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, contactId: 42 });
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 1,
        name: 'Asha Iyer',
        email: 'asha@example.com',
        phone: '+919876543210',
        status: 'Lead',
        source: 'website',
      }),
    }));
  });

  test('does not merge by phone alone for website enquiries', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1,
      slug: 'enhanced-wellness',
      vertical: 'wellness',
      name: 'Enhanced Wellness',
    });
    findDuplicateContactFullMock.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 84 });

    const res = await request(makeApp())
      .post('/api/wellness/public/enquiry')
      .send({
        tenantSlug: 'enhanced-wellness',
        firstName: 'Mira',
        lastName: 'Sharma',
        email: 'mira.new@example.com',
        phone: '+919876543210',
        service: 'Body Wellness',
        message: 'Need details',
      });

    expect(res.status).toBe(201);
    expect(findDuplicateContactFullMock).toHaveBeenCalledWith({
      email: 'mira.new@example.com',
      tenantId: 1,
    });
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 1,
        name: 'Mira Sharma',
        email: 'mira.new@example.com',
        phone: '+919876543210',
        status: 'Lead',
        source: 'website',
      }),
    }));
  });

  test('dedupes by email and updates the existing contact', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1,
      slug: 'enhanced-wellness',
      vertical: 'wellness',
      name: 'Enhanced Wellness',
    });
    findDuplicateContactFullMock.mockResolvedValue({
      contact: {
        id: 77,
        name: 'Asha Iyer',
        email: 'asha@example.com',
        phone: '+919876543210',
        description: 'Existing note',
        firstTouchSource: null,
      },
    });
    prisma.contact.update.mockResolvedValue({ id: 77 });

    const res = await request(makeApp())
      .post('/api/wellness/public/enquiry')
      .send({
        tenantSlug: 'enhanced-wellness',
        firstName: 'Asha',
        lastName: 'Iyer',
        email: 'asha@example.com',
        phone: '+919876543210',
        service: 'Skin & Aesthetics',
        message: 'Please call back',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, duplicate: true, contactId: 77 });
    expect(prisma.contact.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 77 },
      data: expect.objectContaining({
        status: 'Lead',
        name: 'Asha Iyer',
      }),
    }));
  });
});
