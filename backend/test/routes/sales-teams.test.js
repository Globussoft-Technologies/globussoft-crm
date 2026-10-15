// @ts-check

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

prisma.salesTeam = prisma.salesTeam || {};
prisma.salesTeamMember = prisma.salesTeamMember || {};
prisma.user = prisma.user || {};
prisma.salesTeam.findMany = vi.fn();
prisma.salesTeam.findFirst = vi.fn();
prisma.salesTeam.create = vi.fn();
prisma.salesTeam.update = vi.fn();
prisma.salesTeam.deleteMany = vi.fn();
prisma.salesTeamMember.deleteMany = vi.fn();
prisma.salesTeamMember.createMany = vi.fn();
prisma.user.findMany = vi.fn();
prisma.user.findFirst = vi.fn();

const salesTeamsRouter = requireCJS('../../routes/sales_teams');
const TENANT_ID = 11;

function makeApp(role = 'ADMIN') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 22, tenantId: TENANT_ID, role };
    next();
  });
  app.use('/api/sales-teams', salesTeamsRouter);
  return app;
}

beforeEach(() => {
  for (const model of [prisma.salesTeam, prisma.salesTeamMember, prisma.user]) {
    for (const value of Object.values(model)) value?.mockReset?.();
  }
  prisma.salesTeam.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.findFirst.mockResolvedValue(null);
});

describe('sales teams authorization and tenant isolation', () => {
  test.each(['GET', 'POST', 'PUT', 'DELETE'])('%s rejects regular users', async (method) => {
    const agent = request(makeApp('USER'));
    const path = method === 'GET' || method === 'POST' ? '/api/sales-teams' : '/api/sales-teams/1';
    const res = method === 'GET' ? await agent.get(path)
      : method === 'POST' ? await agent.post(path).send({ name: 'Team' })
        : method === 'PUT' ? await agent.put(path).send({ name: 'Team' })
          : await agent.delete(path);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('lists only teams from the authenticated tenant', async () => {
    await request(makeApp()).get('/api/sales-teams').expect(200);
    expect(prisma.salesTeam.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: TENANT_ID },
    }));
  });

  test('creates memberships only for users owned by the tenant', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 2 }]);
    prisma.salesTeam.create.mockResolvedValue({ id: 8, name: 'East', members: [] });
    const res = await request(makeApp()).post('/api/sales-teams').send({ name: 'East', memberIds: [2, 999] });
    expect(res.status).toBe(201);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, id: { in: [2, 999] } }, select: { id: true },
    });
    expect(prisma.salesTeam.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: TENANT_ID, members: { create: [{ userId: 2, tenantId: TENANT_ID }] } }),
    }));
  });

  test('saves an active admin or manager from the same tenant as team manager', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 3 });
    prisma.salesTeam.create.mockResolvedValue({ id: 8, name: 'East', managerId: 3, manager: { id: 3, role: 'MANAGER' }, members: [] });
    const res = await request(makeApp()).post('/api/sales-teams').send({ name: 'East', managerId: 3 });
    expect(res.status).toBe(201);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 3, tenantId: TENANT_ID, role: { in: ['ADMIN', 'MANAGER'] }, deactivatedAt: null },
      select: { id: true },
    });
    expect(prisma.salesTeam.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ managerId: 3 }),
    }));
  });

  test('rejects a manager outside the tenant or without an eligible role', async () => {
    const res = await request(makeApp()).post('/api/sales-teams').send({ name: 'East', managerId: 3 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_MANAGER_INVALID');
    expect(prisma.salesTeam.create).not.toHaveBeenCalled();
  });

  test('updates and clears the assigned manager', async () => {
    prisma.salesTeam.findFirst.mockResolvedValue({ id: 8, managerId: 3 });
    prisma.user.findFirst.mockResolvedValue({ id: 4 });
    prisma.salesTeam.update.mockResolvedValue({ id: 8, managerId: 4 });
    const updated = await request(makeApp()).put('/api/sales-teams/8').send({ name: 'East', managerId: 4 });
    expect(updated.status).toBe(200);
    expect(prisma.salesTeam.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ managerId: 4 }) }));

    const cleared = await request(makeApp()).put('/api/sales-teams/8').send({ name: 'East', managerId: null });
    expect(cleared.status).toBe(200);
    expect(prisma.salesTeam.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ managerId: null }) }));
  });

  test('returns 404 instead of updating a team from another tenant', async () => {
    prisma.salesTeam.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).put('/api/sales-teams/8').send({ name: 'East' });
    expect(res.status).toBe(404);
    expect(prisma.salesTeam.findFirst).toHaveBeenCalledWith({ where: { id: 8, tenantId: TENANT_ID } });
    expect(prisma.salesTeam.update).not.toHaveBeenCalled();
  });
});
