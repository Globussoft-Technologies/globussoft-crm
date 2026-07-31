// @ts-check
/**
 * Hot-lead auto-assignment tests for backend/routes/callified.js.
 *
 * Pins the contract that a lead classified (or manually overridden) as "hot"
 * is automatically assigned to the next active staff member in round-robin,
 * and that already-assigned hot leads are left alone.
 *
 * Test pattern mirrors backend/test/routes/callified.test.js — cache-inject
 * mocks for services and pure helpers BEFORE requiring the router.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const Module = requireCJS('node:module');

// ── Patch lib/llmRouter BEFORE router require ──────────────────────────
const routeRequestMock = vi.fn();
const llmEnabledMock = vi.fn();
const llmRouterPath = requireCJS.resolve('../../lib/llmRouter.js');
Module._cache[llmRouterPath] = {
  id: llmRouterPath,
  filename: llmRouterPath,
  loaded: true,
  exports: {
    routeRequest: routeRequestMock,
    llmEnabled: llmEnabledMock,
    TASK_ROUTING: {},
    VALID_TASKS: [],
  },
};

// ── Patch lib/notificationService BEFORE router require ────────────────
const notifyMock = vi.fn().mockResolvedValue(undefined);
const notificationServicePath = requireCJS.resolve('../../lib/notificationService.js');
Module._cache[notificationServicePath] = {
  id: notificationServicePath,
  filename: notificationServicePath,
  loaded: true,
  exports: {
    notify: notifyMock,
  },
};

// ── Patch services/callifiedClient BEFORE router require ───────────────
const callifiedClientPath = requireCJS.resolve('../../services/callifiedClient.js');
Module._cache[callifiedClientPath] = {
  id: callifiedClientPath,
  filename: callifiedClientPath,
  loaded: true,
  exports: {
    initiateCall: vi.fn(),
    fetchCallResult: vi.fn(),
    checkBudgetCap: vi.fn(),
    isEnabledForTenant: vi.fn(),
    listCampaigns: vi.fn(),
    initiateCallForContact: vi.fn(),
    normalizeCallifiedPhone: (phone) => String(phone).replace(/\D/g, ''),
    fetchAndStoreCallDetails: vi.fn(),
  },
};

// ── Prisma singleton patching ──────────────────────────────────────────
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  id: 7, role: 'ADMIN', tenantId: 1, isActive: true,
});
prisma.user.findMany = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.update = vi.fn();
prisma.contact.findMany = vi.fn().mockResolvedValue([]);
prisma.callLog = prisma.callLog || {};
prisma.callLog.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.tenant.update = vi.fn();
// $transaction(cb) invokes the callback with the same prisma singleton so
// tx.user / tx.contact / tx.tenant resolve to our mocks.
prisma.$transaction = vi.fn(async (cb) => cb(prisma));

const callifiedRouter = requireCJS('../../routes/callified');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/callified', callifiedRouter);
  return app;
}

beforeEach(() => {
  routeRequestMock.mockReset();
  llmEnabledMock.mockReset().mockResolvedValue(false);
  notifyMock.mockReset().mockResolvedValue(undefined);

  prisma.user.findUnique.mockReset().mockResolvedValue({
    id: 7, role: 'ADMIN', tenantId: 1, isActive: true,
  });
  prisma.user.findMany.mockReset();
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.findFirst.mockReset();
  prisma.contact.update.mockReset().mockResolvedValue({
    id: 11, assignedToId: null, callifiedLeadStatus: 'hot', assignedTo: null,
  });
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.callLog.findMany.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.update.mockReset();
  prisma.$transaction.mockReset().mockImplementation(async (cb) => cb(prisma));
});

describe('PUT /api/callified/leads/:leadId/lead-status', () => {
  test('manual override to hot assigns an unassigned lead to next staffer', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 101, name: 'Rajesh Sharma', role: 'ADMIN', deactivatedAt: null },
      { id: 102, name: 'Priya Patel', role: 'USER', deactivatedAt: null },
    ]);
    prisma.tenant.findUnique.mockResolvedValue({ callifiedLastHotAssignedUserId: null });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: 101, callifiedLeadStatus: 'hot',
      assignedTo: { id: 101, name: 'Rajesh Sharma', email: 'rajesh@test.local' },
    });
    prisma.tenant.update.mockResolvedValue({ id: 1, callifiedLastHotAssignedUserId: 101 });

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'hot' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 11,
      callifiedLeadStatus: 'hot',
      assignedToId: 101,
      assignedTo: { id: 101, name: 'Rajesh Sharma' },
    });
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 11 },
        data: expect.objectContaining({ assignedToId: 101 }),
      }),
    );
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: { callifiedLastHotAssignedUserId: 101 },
      }),
    );
  });

  test('manual override to hot does NOT reassign a lead already owned by active staff', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: 105, callifiedLeadStatus: 'cold',
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: 105, callifiedLeadStatus: 'hot',
      assignedTo: { id: 105, name: 'Existing Owner', email: 'owner@test.local' },
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 101, role: 'ADMIN', deactivatedAt: null },
      { id: 105, role: 'USER', deactivatedAt: null },
    ]);

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'hot' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.assignedToId).toBe(105);
    // Contact update should NOT touch assignedToId.
    const updateCall = prisma.contact.update.mock.calls.find((c) => c[0]?.where?.id === 11);
    expect(updateCall[0].data).not.toHaveProperty('assignedToId');
  });

  test('manual override to cold does not assign anyone', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'cold' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.assignedToId).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  test('no active staff → hot override succeeds but remains unassigned', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'hot', assignedTo: null,
    });
    prisma.user.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'hot' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.assignedToId).toBeNull();
  });
});

describe('POST /api/callified/leads/:leadId/classify', () => {
  test('classify returns hot and auto-assigns unassigned lead', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.callLog.findMany.mockResolvedValue([
      {
        id: 1,
        contactId: 11,
        provider: 'callified',
        notes: JSON.stringify({
          reviews: [{ quality_score: 4.5, appointment_booked: true }],
        }),
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 101, role: 'ADMIN', deactivatedAt: null },
      { id: 102, role: 'USER', deactivatedAt: null },
    ]);
    prisma.tenant.findUnique.mockResolvedValue({ callifiedLastHotAssignedUserId: null });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: 101, callifiedLeadStatus: 'hot',
      assignedTo: { id: 101, name: 'Rajesh Sharma', email: 'rajesh@test.local' },
    });
    prisma.tenant.update.mockResolvedValue({ id: 1, callifiedLastHotAssignedUserId: 101 });

    const res = await request(makeApp())
      .post('/api/callified/leads/11/classify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 11,
      callifiedLeadStatus: 'hot',
      assignedToId: 101,
      assignedTo: { id: 101, name: 'Rajesh Sharma' },
    });
  });

  test('classify returns cold and leaves lead unassigned', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'cold', assignedTo: null,
    });
    prisma.callLog.findMany.mockResolvedValue([
      {
        id: 1,
        contactId: 11,
        provider: 'callified',
        notes: JSON.stringify({
          reviews: [{ quality_score: 1.5, appointment_booked: false }],
        }),
      },
    ]);

    const res = await request(makeApp())
      .post('/api/callified/leads/11/classify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.callifiedLeadStatus).toBe('cold');
    expect(res.body.assignedToId).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/callified/leads/ensure-assigned', () => {
  test('assigns all hot unassigned leads in tenant when no body provided', async () => {
    prisma.contact.findMany
      .mockResolvedValueOnce([
        { id: 11 },
        { id: 12 },
      ]);
    prisma.contact.findFirst
      .mockResolvedValueOnce({ id: 11, tenantId: 1, assignedToId: null })
      .mockResolvedValueOnce({ id: 12, tenantId: 1, assignedToId: null });
    prisma.user.findMany
      .mockResolvedValueOnce([
        { id: 101, role: 'ADMIN', deactivatedAt: null },
        { id: 102, role: 'USER', deactivatedAt: null },
      ])
      .mockResolvedValueOnce([
        { id: 101, role: 'ADMIN', deactivatedAt: null },
        { id: 102, role: 'USER', deactivatedAt: null },
      ]);
    prisma.tenant.findUnique
      .mockResolvedValueOnce({ callifiedLastHotAssignedUserId: null })
      .mockResolvedValueOnce({ callifiedLastHotAssignedUserId: 101 });
    prisma.contact.update
      .mockResolvedValueOnce({ id: 11, assignedToId: 101 })
      .mockResolvedValueOnce({ id: 12, assignedToId: 102 });
    prisma.tenant.update
      .mockResolvedValueOnce({ id: 1, callifiedLastHotAssignedUserId: 101 })
      .mockResolvedValueOnce({ id: 1, callifiedLastHotAssignedUserId: 102 });

    const res = await request(makeApp())
      .post('/api/callified/leads/ensure-assigned')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ assigned: 2, skipped: 0 });
    expect(res.body.details).toHaveLength(2);
    expect(res.body.details[0]).toMatchObject({ contactId: 11, assignedToId: 101, reason: 'assigned' });
    expect(res.body.details[1]).toMatchObject({ contactId: 12, assignedToId: 102, reason: 'assigned' });
  });

  test('limits scope to provided contactIds', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([{ id: 11 }]);
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 11, tenantId: 1, assignedToId: null });
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 101, role: 'ADMIN', deactivatedAt: null },
    ]);
    prisma.tenant.findUnique.mockResolvedValueOnce({ callifiedLastHotAssignedUserId: null });
    prisma.contact.update.mockResolvedValueOnce({ id: 11, assignedToId: 101 });
    prisma.tenant.update.mockResolvedValueOnce({ id: 1, callifiedLastHotAssignedUserId: 101 });

    const res = await request(makeApp())
      .post('/api/callified/leads/ensure-assigned')
      .send({ contactIds: [11, 99] })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ assigned: 1, skipped: 0 });
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [11, 99] } }),
      }),
    );
  });

  test('no hot unassigned leads → { assigned: 0, skipped: 0, details: [] }', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([]);

    const res = await request(makeApp())
      .post('/api/callified/leads/ensure-assigned')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assigned: 0, skipped: 0, details: [] });
  });
});
