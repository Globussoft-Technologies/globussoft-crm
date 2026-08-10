// @ts-check
/**
 * Qualified-lead auto-assignment tests for backend/routes/callified.js.
 *
 * Pins the contract that a lead classified (or manually overridden) as "qualified"
 * is automatically assigned to the next active staff member in round-robin,
 * and that already-assigned qualified leads are left alone.
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
    getCallDetails: vi.fn().mockResolvedValue({ transcripts: [], reviews: [] }),
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
prisma.callLog.findFirst = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.tenant.update = vi.fn();
prisma.tenantSetting = prisma.tenantSetting || {};
prisma.tenantSetting.findUnique = vi.fn();
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
    id: 11, assignedToId: null, callifiedLeadStatus: 'qualified', assignedTo: null,
  });
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.callLog.findMany.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.update.mockReset();
  prisma.tenantSetting.findUnique.mockReset();
  prisma.$transaction.mockReset().mockImplementation(async (cb) => cb(prisma));

  const callifiedClient = requireCJS('../../services/callifiedClient');
  callifiedClient.getCallDetails.mockReset().mockResolvedValue({ transcripts: [], reviews: [] });
});

describe('PUT /api/callified/leads/:leadId/lead-status', () => {
  test('manual override to qualified assigns an unassigned lead to next staffer', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 101, name: 'Rajesh Sharma', role: 'ADMIN', deactivatedAt: null },
      { id: 102, name: 'Priya Patel', role: 'USER', deactivatedAt: null },
    ]);
    prisma.tenant.findUnique.mockResolvedValue({ callifiedLastHotAssignedUserId: null });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: 101, callifiedLeadStatus: 'qualified',
      assignedTo: { id: 101, name: 'Rajesh Sharma', email: 'rajesh@test.local' },
    });
    prisma.tenant.update.mockResolvedValue({ id: 1, callifiedLastHotAssignedUserId: 101 });

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'qualified' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 11,
      callifiedLeadStatus: 'qualified',
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
        data: { callifiedLastHotAssignedUserId: 101, callifiedLastHotAssignedCount: 1 },
      }),
    );
  });

  test('manual override to qualified does NOT reassign a lead already owned by active staff', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: 105, callifiedLeadStatus: 'junk',
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: 105, callifiedLeadStatus: 'qualified',
      assignedTo: { id: 105, name: 'Existing Owner', email: 'owner@test.local' },
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 101, role: 'ADMIN', deactivatedAt: null },
      { id: 105, role: 'USER', deactivatedAt: null },
    ]);

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'qualified' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.assignedToId).toBe(105);
    // Contact update should NOT touch assignedToId.
    const updateCall = prisma.contact.update.mock.calls.find((c) => c[0]?.where?.id === 11);
    expect(updateCall[0].data).not.toHaveProperty('assignedToId');
  });

  test('manual override to junk does not assign anyone', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'junk' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.assignedToId).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  test('no active staff → qualified override succeeds but remains unassigned', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'qualified', assignedTo: null,
    });
    prisma.user.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'qualified' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.assignedToId).toBeNull();
  });

  test('auto-assignment disabled → qualified override succeeds but remains unassigned', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'false' });
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'qualified', assignedTo: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 101, role: 'ADMIN', deactivatedAt: null },
    ]);

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'qualified' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.assignedToId).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  test('round-robin respects leads-per-user before advancing', async () => {
    // leads_per_user = 2, so first two qualified leads go to user 101, then advance to 102.
    prisma.tenantSetting.findUnique.mockImplementation(async ({ where }) => {
      const key = where?.tenantId_key?.key;
      if (key === 'feature.callified.assign_staff.logic') return { value: 'round_robin' };
      if (key === 'feature.callified.assign_staff.leads_per_user') return { value: '2' };
      return undefined;
    });

    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 101, role: 'ADMIN', deactivatedAt: null },
      { id: 102, role: 'USER', deactivatedAt: null },
    ]);

    // First lead: no previous pointer.
    prisma.tenant.findUnique.mockResolvedValue({
      callifiedLastHotAssignedUserId: null,
      callifiedLastHotAssignedCount: 0,
    });
    prisma.contact.update.mockResolvedValue({ id: 11, assignedToId: 101, callifiedLeadStatus: 'qualified', assignedTo: null });
    prisma.tenant.update.mockResolvedValue({ id: 1, callifiedLastHotAssignedUserId: 101, callifiedLastHotAssignedCount: 1 });

    let res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'qualified' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.body.assignedToId).toBe(101);

    // Second lead: still user 101 (count 1 < 2).
    prisma.tenant.findUnique.mockResolvedValue({
      callifiedLastHotAssignedUserId: 101,
      callifiedLastHotAssignedCount: 1,
    });
    prisma.contact.update.mockResolvedValue({ id: 11, assignedToId: 101, callifiedLeadStatus: 'qualified', assignedTo: null });
    prisma.tenant.update.mockResolvedValue({ id: 1, callifiedLastHotAssignedUserId: 101, callifiedLastHotAssignedCount: 2 });

    res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'qualified' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.body.assignedToId).toBe(101);

    // Third lead: count has reached cap, advance to user 102.
    prisma.tenant.findUnique.mockResolvedValue({
      callifiedLastHotAssignedUserId: 101,
      callifiedLastHotAssignedCount: 2,
    });
    prisma.contact.update.mockResolvedValue({ id: 11, assignedToId: 102, callifiedLeadStatus: 'qualified', assignedTo: null });
    prisma.tenant.update.mockResolvedValue({ id: 1, callifiedLastHotAssignedUserId: 102, callifiedLastHotAssignedCount: 1 });

    res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'qualified' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.body.assignedToId).toBe(102);
  });

  test('random assignment logic assigns one of the active staff', async () => {
    prisma.tenantSetting.findUnique.mockImplementation(async ({ where }) => {
      const key = where?.tenantId_key?.key;
      if (key === 'feature.callified.assign_staff.logic') return { value: 'random' };
      return undefined;
    });

    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 101, role: 'ADMIN', deactivatedAt: null },
      { id: 102, role: 'USER', deactivatedAt: null },
      { id: 103, role: 'USER', deactivatedAt: null },
    ]);
    prisma.tenant.findUnique.mockResolvedValue({ callifiedLastHotAssignedUserId: null, callifiedLastHotAssignedCount: 0 });
    prisma.contact.update.mockImplementation(({ data }) => ({ id: 11, assignedToId: data.assignedToId, callifiedLeadStatus: 'qualified', assignedTo: null }));
    prisma.tenant.update.mockResolvedValue({ id: 1, callifiedLastHotAssignedUserId: null, callifiedLastHotAssignedCount: 0 });

    const res = await request(makeApp())
      .put('/api/callified/leads/11/lead-status')
      .send({ status: 'qualified' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect([101, 102, 103]).toContain(res.body.assignedToId);
  });
});

describe('POST /api/callified/leads/:leadId/classify', () => {
  test('classify returns qualified and auto-assigns unassigned lead', async () => {
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
      id: 11, assignedToId: 101, callifiedLeadStatus: 'qualified',
      assignedTo: { id: 101, name: 'Rajesh Sharma', email: 'rajesh@test.local' },
    });
    prisma.tenant.update.mockResolvedValue({ id: 1, callifiedLastHotAssignedUserId: 101 });

    const res = await request(makeApp())
      .post('/api/callified/leads/11/classify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 11,
      callifiedLeadStatus: 'qualified',
      assignedToId: 101,
      assignedTo: { id: 101, name: 'Rajesh Sharma' },
    });
  });

  test('classify returns junk and leaves lead unassigned', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'junk', assignedTo: null,
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
    expect(res.body.callifiedLeadStatus).toBe('junk');
    expect(res.body.assignedToId).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  test('classify returns dnp when the latest call was not answered', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'dnp', assignedTo: null,
    });
    prisma.callLog.findMany.mockResolvedValue([
      {
        id: 1,
        contactId: 11,
        provider: 'callified',
        status: 'MISSED',
        notes: JSON.stringify({ callifiedLeadId: 3001, reviews: [] }),
      },
    ]);

    const res = await request(makeApp())
      .post('/api/callified/leads/11/classify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.callifiedLeadStatus).toBe('dnp');
    expect(res.body.assignedToId).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  test('classify returns dnp when a non-terminal call is stale and has no conversation', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'dnp', assignedTo: null,
    });
    prisma.callLog.findMany.mockResolvedValue([
      {
        id: 1,
        contactId: 11,
        provider: 'callified',
        status: 'INITIATED',
        createdAt: new Date(Date.now() - 4 * 60 * 1000), // 4 minutes ago
        notes: JSON.stringify({ callifiedLeadId: 3001, reviews: [] }),
      },
    ]);

    const res = await request(makeApp())
      .post('/api/callified/leads/11/classify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.callifiedLeadStatus).toBe('dnp');
    expect(res.body.assignedToId).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  test('classify returns dnp when a completed call has no transcript or review', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'dnp', assignedTo: null,
    });
    prisma.callLog.findMany.mockResolvedValue([
      {
        id: 1,
        contactId: 11,
        provider: 'callified',
        status: 'COMPLETED',
        createdAt: new Date(Date.now() - 30 * 1000), // 30 seconds ago
        notes: JSON.stringify({ callifiedLeadId: 3001, reviews: [] }),
      },
    ]);

    const res = await request(makeApp())
      .post('/api/callified/leads/11/classify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.callifiedLeadStatus).toBe('dnp');
    expect(res.body.assignedToId).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  test('AI transcript classification disabled → skips Gemini and uses score fallback', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'false' });
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'junk', assignedTo: null,
    });

    const callifiedClient = requireCJS('../../services/callifiedClient');
    callifiedClient.getCallDetails.mockResolvedValue({
      transcripts: [{ id: 1, created_at: new Date().toISOString(), transcript_text: 'Hello.' }],
      reviews: [{ quality_score: 1.5, appointment_booked: false, sentiment: 'negative' }],
    });

    prisma.callLog.findMany.mockResolvedValue([
      {
        id: 1,
        contactId: 11,
        provider: 'callified',
        notes: JSON.stringify({ callifiedLeadId: 3001, reviews: [] }),
      },
    ]);

    const res = await request(makeApp())
      .post('/api/callified/leads/11/classify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.callifiedLeadStatus).toBe('junk');
    expect(routeRequestMock).not.toHaveBeenCalled();
  });

  test('AI transcript classification enabled → routeRequest receives __surface and __userId', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'true' });
    llmEnabledMock.mockResolvedValue(true);
    routeRequestMock.mockResolvedValue({ text: JSON.stringify({ status: 'qualified', reason: 'Gemini says qualified' }) });
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, assignedToId: null, callifiedLeadStatus: null,
    });
    prisma.contact.update.mockResolvedValue({
      id: 11, assignedToId: null, callifiedLeadStatus: 'qualified', assignedTo: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 101, role: 'ADMIN', deactivatedAt: null },
      { id: 102, role: 'USER', deactivatedAt: null },
    ]);
    prisma.tenant.findUnique.mockResolvedValue({ callifiedLastHotAssignedUserId: null });
    prisma.tenant.update.mockResolvedValue({ id: 1, callifiedLastHotAssignedUserId: 101 });

    const callifiedClient = requireCJS('../../services/callifiedClient');
    callifiedClient.getCallDetails.mockResolvedValue({
      transcripts: [{ id: 1, created_at: new Date().toISOString(), transcript_text: 'Hello this is a test conversation.' }],
      reviews: [{ quality_score: 3, appointment_booked: false, sentiment: 'neutral' }],
    });

    prisma.callLog.findMany.mockResolvedValue([
      {
        id: 1,
        contactId: 11,
        provider: 'callified',
        notes: JSON.stringify({ callifiedLeadId: 3001, reviews: [] }),
      },
    ]);

    const res = await request(makeApp())
      .post('/api/callified/leads/11/classify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.callifiedLeadStatus).toBe('qualified');
    expect(routeRequestMock).toHaveBeenCalledTimes(1);
    expect(routeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'callified-lead-status',
        tenantId: 1,
        payload: expect.objectContaining({
          __surface: 'leads-callified-transcript',
          __userId: 7,
        }),
      }),
    );
  });
});

describe('POST /api/callified/leads/ensure-assigned', () => {
  test('assigns all qualified unassigned leads in tenant when no body provided', async () => {
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
      .mockResolvedValueOnce({ callifiedLastHotAssignedUserId: null, callifiedLastHotAssignedCount: 0 })
      .mockResolvedValueOnce({ callifiedLastHotAssignedUserId: 101, callifiedLastHotAssignedCount: 1 });
    prisma.contact.update
      .mockResolvedValueOnce({ id: 11, assignedToId: 101 })
      .mockResolvedValueOnce({ id: 12, assignedToId: 102 });
    prisma.tenant.update
      .mockResolvedValueOnce({ id: 1, callifiedLastHotAssignedUserId: 101, callifiedLastHotAssignedCount: 1 })
      .mockResolvedValueOnce({ id: 1, callifiedLastHotAssignedUserId: 102, callifiedLastHotAssignedCount: 1 });

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

  test('no qualified unassigned leads → { assigned: 0, skipped: 0, details: [] }', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([]);

    const res = await request(makeApp())
      .post('/api/callified/leads/ensure-assigned')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assigned: 0, skipped: 0, details: [] });
  });
});
