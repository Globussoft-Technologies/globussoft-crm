import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

prisma.user = { findFirst: vi.fn(), findUnique: vi.fn() };
prisma.userRole = { findMany: vi.fn(), findFirst: vi.fn() };
prisma.tenant = { findUnique: vi.fn() };

const requireCJS = createRequire(import.meta.url);
const authMiddleware = requireCJS('../../middleware/auth');
authMiddleware.verifyToken = (_req, _res, next) => next();

const permissionMiddleware = requireCJS('../../middleware/requirePermission');
permissionMiddleware.requirePermission = () => (_req, _res, next) => next();
permissionMiddleware.getUserPermissions = vi.fn();

const usersRouter = requireCJS('../../routes/users');

function makeApp(user = { userId: 7, tenantId: 1, role: 'ADMIN', isOwner: false }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/users', usersRouter);
  return app;
}

function targetUser(tenantId = 1) {
  return {
    id: 22,
    name: 'Staff Member',
    email: 'staff@example.com',
    role: 'USER',
    wellnessRole: null,
    userType: 'STAFF',
    tenantId,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    deactivatedAt: null,
  };
}

function assignedRole() {
  return {
    id: 90,
    userId: 22,
    role: {
      id: 12,
      key: 'USER',
      name: 'User',
      landingPath: '/dashboard',
      dataScope: 'ALL',
      subBrandScopeJson: '["tmc"]',
    },
  };
}

beforeEach(() => {
  prisma.user.findFirst.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.userRole.findMany.mockReset();
  prisma.userRole.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();
  permissionMiddleware.getUserPermissions.mockReset().mockResolvedValue(new Set(['roles.read']));
});

describe('GET /api/users/:userId/permissions tenant and vertical scope', () => {
  test('generic tenant response omits travel scope and tenant database id', async () => {
    prisma.user.findFirst.mockResolvedValue(targetUser());
    prisma.userRole.findMany.mockResolvedValue([{ role: { key: 'USER' } }]);
    prisma.userRole.findFirst.mockResolvedValue(assignedRole());
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'generic' });

    const response = await request(makeApp()).get('/api/users/22/permissions');

    expect(response.status).toBe(200);
    expect(response.body.vertical).toBe('generic');
    expect(response.body.primaryRole).not.toHaveProperty('subBrandScope');
    expect(response.body).not.toHaveProperty('subBrandAccess');
    expect(response.body.user).not.toHaveProperty('tenantId');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 22, tenantId: 1 },
    }));
    expect(prisma.userRole.findMany.mock.calls[0][0].where).toEqual({
      userId: 22,
      role: { OR: [{ tenantId: 1 }, { tenantId: null }] },
    });
  });

  test('travel tenant response includes its own travel role scope', async () => {
    prisma.user.findFirst.mockResolvedValue(targetUser());
    prisma.userRole.findMany.mockResolvedValue([{ role: { key: 'USER' } }]);
    prisma.userRole.findFirst.mockResolvedValue(assignedRole());
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'travel' });

    const response = await request(makeApp()).get('/api/users/22/permissions');

    expect(response.status).toBe(200);
    expect(response.body.vertical).toBe('travel');
    expect(response.body.primaryRole.subBrandScope).toEqual(['tmc']);
  });

  test('wellness tenant response omits travel sub-brand scope', async () => {
    prisma.user.findFirst.mockResolvedValue(targetUser());
    prisma.userRole.findMany.mockResolvedValue([{ role: { key: 'USER' } }]);
    prisma.userRole.findFirst.mockResolvedValue(assignedRole());
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });

    const response = await request(makeApp()).get('/api/users/22/permissions');

    expect(response.status).toBe(200);
    expect(response.body.vertical).toBe('wellness');
    expect(response.body.primaryRole).not.toHaveProperty('subBrandScope');
    expect(response.body).not.toHaveProperty('subBrandAccess');
  });

  test('tenant admin cannot resolve a staff id from another tenant', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    const response = await request(makeApp()).get('/api/users/900/permissions');

    expect(response.status).toBe(404);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 900, tenantId: 1 },
    }));
    expect(prisma.userRole.findMany).not.toHaveBeenCalled();
    expect(prisma.userRole.findFirst).not.toHaveBeenCalled();
  });
});
