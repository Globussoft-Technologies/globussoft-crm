// @ts-check
/**
 * Unit tests for backend/routes/contacts.js — PATCH /api/contacts/:id.
 *
 * Bug: /converted-leads "Revert to Lead" (and the bulk status chips) issue
 * `PATCH /api/contacts/:id` with a partial `{ status }` body, but the router
 * only ever registered `PUT /:id`. Express fell through to the /api catch-all
 * in server.js, so every revert failed with the toast
 * "Failed to update status: Endpoint not found" (404 API_ROUTE_NOT_FOUND).
 *
 * The fix registers the existing update handler under BOTH verbs — the body
 * was already validated as a partial update (isUpdate:true) and spread into
 * `prisma.contact.update`, so PATCH is the semantically correct verb and PUT
 * has to keep working for every existing caller.
 *
 * Why a separate file (not appended to contacts.test.js)
 * -----------------------------------------------------
 * contacts.test.js pins the broad CRUD + auth surface via PUT. This file is a
 * tight pin on the verb registration itself — that PATCH resolves at all, and
 * that it shares one handler with PUT rather than drifting into a second
 * partial implementation.
 *
 * Coverage (6 cases)
 * ------------------
 *   1. PATCH /:id with { status: 'Lead' } -> 200 + status written (the revert)
 *   2. PATCH and PUT produce an identical prisma.update argument (one handler)
 *   3. PATCH /:id with an unknown status -> 400 (validator still runs)
 *   4. PATCH /:id on a missing contact -> 404 "Contact not found", NOT the
 *      server-level "Endpoint not found"
 *   5. PATCH /:id is still tenant-scoped
 *   6. PATCH /:id emits lead.stage_changed when the status actually changes
 *
 * Mocking strategy mirrors backend/test/routes/contacts-billing-state.test.js.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

const writeAuditMock = vi.fn().mockResolvedValue(undefined);
const diffFieldsMock = vi.fn().mockReturnValue({});
const auditPath = requireCJS.resolve('../../lib/audit.js');
Module._cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: { writeAudit: writeAuditMock, diffFields: diffFieldsMock },
};

const emitEventMock = vi.fn(() => Promise.resolve());
const eventBusPath = requireCJS.resolve('../../lib/eventBus.js');
Module._cache[eventBusPath] = {
  id: eventBusPath,
  filename: eventBusPath,
  loaded: true,
  exports: { emitEvent: emitEventMock, onEvent: () => {} },
};

const deliverWebhooksMock = vi.fn().mockResolvedValue(undefined);
const webhookPath = requireCJS.resolve('../../lib/webhookDelivery.js');
Module._cache[webhookPath] = {
  id: webhookPath,
  filename: webhookPath,
  loaded: true,
  exports: { deliverWebhooks: deliverWebhooksMock },
};

const findDuplicateMock = vi.fn().mockResolvedValue(null);
const dedupPath = requireCJS.resolve('../../utils/deduplication.js');
Module._cache[dedupPath] = {
  id: dedupPath,
  filename: dedupPath,
  loaded: true,
  exports: {
    findDuplicateContactFull: findDuplicateMock,
    normalizePhone: (p) => (p ? String(p).replace(/[^0-9]/g, '') : null),
    computeDuplicateGroupKey: (a, rest) => `key:${[a, ...rest].sort().join(',')}`,
  },
};

const leadSlaPath = requireCJS.resolve('../../lib/leadSla.js');
try {
  Module._cache[leadSlaPath] = {
    id: leadSlaPath,
    filename: leadSlaPath,
    loaded: true,
    exports: { markFirstResponseIfNeeded: vi.fn().mockResolvedValue(undefined) },
  };
} catch (_e) { /* ignore */ }

const fieldFilterPath = requireCJS.resolve('../../middleware/fieldFilter.js');
Module._cache[fieldFilterPath] = {
  id: fieldFilterPath,
  filename: fieldFilterPath,
  loaded: true,
  exports: {
    filterReadFields: async (rows) => rows,
    filterWriteFields: async (body) => body,
  },
};

const audienceCtrlPath = requireCJS.resolve('../../controllers/audienceController.js');
try {
  Module._cache[audienceCtrlPath] = {
    id: audienceCtrlPath,
    filename: audienceCtrlPath,
    loaded: true,
    exports: { getContactsByStatus: (_req, res) => res.json([]) },
  };
} catch (_e) { /* ignore */ }

const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = (_roles) => (_req, _res, next) => next();

prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.findUnique = vi.fn();
prisma.contact.update = vi.fn();
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn().mockResolvedValue(null);
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });
prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn().mockResolvedValue(null);
prisma.webhook = prisma.webhook || {};
prisma.webhook.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
const contactsRouter = requireCJS('../../routes/contacts');

const TENANT_ID = 1;
const USER_ID = 7;
const CONTACT_ID = 4242;

function makeApp({ role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: USER_ID, tenantId: TENANT_ID, role };
    next();
  });
  app.use('/api/contacts', contactsRouter);
  // Mirror server.js's /api catch-all so a missing verb registration surfaces
  // here exactly as it does in the browser ("Endpoint not found") instead of
  // as Express's default HTML 404.
  app.use('/api', (_req, res) => res.status(404).json({
    error: 'Endpoint not found',
    code: 'API_ROUTE_NOT_FOUND',
  }));
  return app;
}

const prospect = {
  id: CONTACT_ID,
  name: 'Isabella Rossi',
  email: 'isabella@milandesign.it',
  status: 'Prospect',
  assignedToId: null,
  phone: null,
  tenantId: TENANT_ID,
};

beforeEach(() => {
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.findUnique.mockReset().mockResolvedValue(null);
  prisma.contact.update.mockReset();
  prisma.patient.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'wellness' });
  prisma.wallet.findFirst.mockReset().mockResolvedValue(null);
  prisma.webhook.findMany.mockReset().mockResolvedValue([]);
  writeAuditMock.mockReset().mockResolvedValue(undefined);
  diffFieldsMock.mockReset().mockReturnValue({});
  emitEventMock.mockReset().mockImplementation(() => Promise.resolve());
  deliverWebhooksMock.mockReset().mockResolvedValue(undefined);
  findDuplicateMock.mockReset().mockResolvedValue(null);
});

describe('PATCH /api/contacts/:id — revert a converted lead', () => {
  test('case 1: { status: "Lead" } resolves and writes the status', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(prospect);
    prisma.contact.update.mockResolvedValueOnce({ ...prospect, status: 'Lead' });

    const res = await request(makeApp())
      .patch(`/api/contacts/${CONTACT_ID}`)
      .send({ status: 'Lead' });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(prisma.contact.update).toHaveBeenCalledOnce();
    const call = prisma.contact.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: CONTACT_ID });
    expect(call.data.status).toBe('Lead');
    expect(res.body.status).toBe('Lead');
  });

  test('case 2: PATCH and PUT share one handler — identical update argument', async () => {
    prisma.contact.findFirst.mockResolvedValue(prospect);
    prisma.contact.update.mockResolvedValue({ ...prospect, status: 'Customer' });

    const app = makeApp();
    await request(app).patch(`/api/contacts/${CONTACT_ID}`).send({ status: 'Customer' });
    const patchArg = prisma.contact.update.mock.calls[0][0];

    prisma.contact.update.mockClear();
    await request(app).put(`/api/contacts/${CONTACT_ID}`).send({ status: 'Customer' });
    const putArg = prisma.contact.update.mock.calls[0][0];

    expect(patchArg).toEqual(putArg);
  });

  test('case 3: unknown status returns 400 — the validator still runs on PATCH', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(prospect);

    const res = await request(makeApp())
      .patch(`/api/contacts/${CONTACT_ID}`)
      .send({ status: 'NotAStatus' });

    expect(res.status).toBe(400);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('case 4: missing contact returns "Contact not found", not "Endpoint not found"', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .patch('/api/contacts/999999')
      .send({ status: 'Lead' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Contact not found');
    expect(res.body.code).not.toBe('API_ROUTE_NOT_FOUND');
  });

  test('case 5: the lookup stays tenant-scoped', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .patch(`/api/contacts/${CONTACT_ID}`)
      .send({ status: 'Lead' });

    expect(res.status).toBe(404);
    expect(prisma.contact.findFirst.mock.calls[0][0].where.tenantId).toBe(TENANT_ID);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('case 6: a real status change still delivers lead.stage_changed', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(prospect);
    prisma.contact.update.mockResolvedValueOnce({ ...prospect, status: 'Lead' });

    await request(makeApp())
      .patch(`/api/contacts/${CONTACT_ID}`)
      .send({ status: 'Lead' });

    const events = deliverWebhooksMock.mock.calls.map((c) => c[0]);
    expect(events).toContain('contact.updated');
    expect(events).toContain('lead.stage_changed');
    const stageCall = deliverWebhooksMock.mock.calls.find((c) => c[0] === 'lead.stage_changed');
    expect(stageCall[1].previousStatus).toBe('Prospect');
    expect(stageCall[1].status).toBe('Lead');
  });
});
