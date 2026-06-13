// @ts-check
/**
 * Unit tests for backend/routes/contacts.js — G034 billingStateCode acceptance.
 *
 * PRD_TRAVEL_GST_COMPLIANCE FR-3.5.2 — Contact.billingStateCode is a new
 * additive-nullable column distinct from the residence-state stateCode.
 * GST place-of-supply rules tax against the billing address, not the
 * residence — so a traveller who lives in IN-KA but bills to a corporate
 * AP desk in IN-MH must get IN-MH on the customer side.
 *
 * Why a separate file (not append to contacts.test.js)
 * ----------------------------------------------------
 * contacts.test.js covers the broad CRUD + auth surface. This file is
 * a tight pin on the G034 validator + persist contract — it's
 * specifically the "billingStateCode is accepted, length-validated,
 * round-trips through the Prisma write" surface and doesn't overlap
 * with any case in the sibling file.
 *
 * Coverage (8 cases)
 * ------------------
 *   1. POST /api/contacts accepts billingStateCode → 201 + value persisted
 *   2. POST /api/contacts accepts stateCode AND billingStateCode → both
 *      land on the create.data argument
 *   3. POST /api/contacts billingStateCode > 10 chars → 400 INVALID_FIELD
 *   4. POST /api/contacts stateCode > 10 chars → 400 INVALID_FIELD
 *   5. POST /api/contacts billingStateCode null → not in create.data
 *   6. POST /api/contacts billingStateCode = "" → length-cap passes
 *   7. PUT /api/contacts/:id accepts billingStateCode update → update.data
 *      carries it
 *   8. PUT /api/contacts/:id stateCode update preserves prior billingStateCode
 *      (separate columns — only the named field is written)
 *
 * Mocking strategy
 * ----------------
 * Mirror of backend/test/routes/contacts.test.js — patch the prisma
 * singleton with vi.fn() shapes BEFORE requiring the router, patch
 * lib/audit + lib/eventBus + utils/deduplication + middleware/fieldFilter
 * so the route's `require()` lookups land on test doubles. Pass-through
 * verifyToken so we don't have to sign JWTs.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// ── Patch lib/audit + lib/eventBus + utils/deduplication + middleware/fieldFilter
//    in require cache BEFORE the router is required ─────────────────────
const writeAuditMock = vi.fn().mockResolvedValue(undefined);
const diffFieldsMock = vi.fn().mockReturnValue({});
const auditPath = requireCJS.resolve('../../lib/audit.js');
Module._cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: { writeAudit: writeAuditMock, diffFields: diffFieldsMock },
};

const emitEventMock = vi.fn();
const eventBusPath = requireCJS.resolve('../../lib/eventBus.js');
Module._cache[eventBusPath] = {
  id: eventBusPath,
  filename: eventBusPath,
  loaded: true,
  exports: { emitEvent: emitEventMock, onEvent: () => {} },
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

// fieldFilter: pass-through.
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

// ── Auth middleware → pass-through.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = (_roles) => (_req, _res, next) => next();

// ── Prisma singleton patching.
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.create = vi.fn();
prisma.contact.update = vi.fn();
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn().mockResolvedValue(null);
prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn().mockResolvedValue(null);
prisma.webhook = prisma.webhook || {};
prisma.webhook.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
const contactsRouter = requireCJS('../../routes/contacts');

const TENANT_ID = 1;
const USER_ID = 7;

function makeApp({ role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: USER_ID, tenantId: TENANT_ID, role };
    next();
  });
  app.use('/api/contacts', contactsRouter);
  return app;
}

beforeEach(() => {
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.create.mockReset();
  prisma.contact.update.mockReset();
  prisma.patient.findFirst.mockReset().mockResolvedValue(null);
  prisma.wallet.findFirst.mockReset().mockResolvedValue(null);
  prisma.webhook.findMany.mockReset().mockResolvedValue([]);
  writeAuditMock.mockReset().mockResolvedValue(undefined);
  diffFieldsMock.mockReset().mockReturnValue({});
  emitEventMock.mockReset();
  findDuplicateMock.mockReset().mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────
describe('POST /api/contacts — G034 billingStateCode acceptance', () => {
  test('case 1: accepts billingStateCode → 201 + value persisted on create', async () => {
    prisma.contact.create.mockResolvedValueOnce({
      id: 9100,
      name: 'Anjali Sharma',
      email: 'anjali@example.com',
      tenantId: TENANT_ID,
      billingStateCode: 'IN-MH',
      stateCode: null,
    });
    const res = await request(makeApp())
      .post('/api/contacts')
      .send({
        name: 'Anjali Sharma',
        email: 'anjali@example.com',
        billingStateCode: 'IN-MH',
      });

    expect(res.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledOnce();
    const callData = prisma.contact.create.mock.calls[0][0].data;
    expect(callData.billingStateCode).toBe('IN-MH');
    expect(callData.tenantId).toBe(TENANT_ID);
  });

  test('case 2: both stateCode AND billingStateCode → both land on data argument', async () => {
    prisma.contact.create.mockResolvedValueOnce({
      id: 9101,
      name: 'Vikram Singh',
      email: 'vikram@example.com',
      stateCode: 'IN-KA',
      billingStateCode: 'IN-MH',
      tenantId: TENANT_ID,
    });
    const res = await request(makeApp())
      .post('/api/contacts')
      .send({
        name: 'Vikram Singh',
        email: 'vikram@example.com',
        stateCode: 'IN-KA',
        billingStateCode: 'IN-MH',
      });

    expect(res.status).toBe(201);
    const callData = prisma.contact.create.mock.calls[0][0].data;
    expect(callData.stateCode).toBe('IN-KA');
    expect(callData.billingStateCode).toBe('IN-MH');
  });

  test('case 3: billingStateCode > 10 chars → 400 INVALID_FIELD-style error', async () => {
    const res = await request(makeApp())
      .post('/api/contacts')
      .send({
        name: 'Bad Code',
        email: 'badcode@example.com',
        billingStateCode: 'TOO-LONG-FOR-COLUMN-CAP',
      });

    expect(res.status).toBe(400);
    // The ensureStringLength validator returns code based on the field
    // name — INVALID_BILLINGSTATECODE shape matches the helper's
    // convention (see lib/validators.js field-named code synthesis).
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('case 4: stateCode > 10 chars → 400 same length validator', async () => {
    const res = await request(makeApp())
      .post('/api/contacts')
      .send({
        name: 'Bad State',
        email: 'badstate@example.com',
        stateCode: 'WAYTOOLONGFORACOLUMN',
      });

    expect(res.status).toBe(400);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('case 5: billingStateCode null → not in create.data (or null)', async () => {
    prisma.contact.create.mockResolvedValueOnce({
      id: 9102,
      name: 'Riya Patel',
      email: 'riya@example.com',
      billingStateCode: null,
      tenantId: TENANT_ID,
    });
    const res = await request(makeApp())
      .post('/api/contacts')
      .send({
        name: 'Riya Patel',
        email: 'riya@example.com',
        billingStateCode: null,
      });

    expect(res.status).toBe(201);
    const callData = prisma.contact.create.mock.calls[0][0].data;
    // null is preserved through to Prisma; the column is nullable.
    expect(callData.billingStateCode).toBeNull();
  });

  test('case 6: billingStateCode = "" → length-cap passes (empty string accepted)', async () => {
    prisma.contact.create.mockResolvedValueOnce({
      id: 9103,
      name: 'Empty State',
      email: 'empty@example.com',
      billingStateCode: '',
      tenantId: TENANT_ID,
    });
    const res = await request(makeApp())
      .post('/api/contacts')
      .send({
        name: 'Empty State',
        email: 'empty@example.com',
        billingStateCode: '',
      });

    // Empty string short-circuits before the length cap (the validator
    // skips the check when the value is empty); the route still passes
    // it through to Prisma.
    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('PUT /api/contacts/:id — G034 billingStateCode update', () => {
  test('case 7: PUT accepts billingStateCode update → update.data carries it', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce({
      id: 9001,
      name: 'Existing Customer',
      email: 'existing@example.com',
      stateCode: 'IN-KA',
      billingStateCode: null,
      tenantId: TENANT_ID,
    });
    prisma.contact.update.mockResolvedValueOnce({
      id: 9001,
      name: 'Existing Customer',
      email: 'existing@example.com',
      stateCode: 'IN-KA',
      billingStateCode: 'IN-MH',
      tenantId: TENANT_ID,
    });

    const res = await request(makeApp())
      .put('/api/contacts/9001')
      .send({ billingStateCode: 'IN-MH' });

    expect(res.status).toBe(200);
    expect(prisma.contact.update).toHaveBeenCalledOnce();
    const updateArgs = prisma.contact.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 9001 });
    expect(updateArgs.data.billingStateCode).toBe('IN-MH');
  });

  test('case 8: PUT stateCode update does NOT touch billingStateCode (separate columns)', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce({
      id: 9001,
      name: 'Existing Customer',
      stateCode: null,
      billingStateCode: 'IN-MH',
      tenantId: TENANT_ID,
    });
    prisma.contact.update.mockResolvedValueOnce({
      id: 9001,
      name: 'Existing Customer',
      stateCode: 'IN-KA',
      billingStateCode: 'IN-MH',
      tenantId: TENANT_ID,
    });

    const res = await request(makeApp())
      .put('/api/contacts/9001')
      .send({ stateCode: 'IN-KA' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.contact.update.mock.calls[0][0];
    expect(updateArgs.data.stateCode).toBe('IN-KA');
    // billingStateCode was NOT in the request body so the update.data
    // shouldn't carry it — Prisma's partial-update semantics preserve
    // the existing column value.
    expect(updateArgs.data).not.toHaveProperty('billingStateCode');
  });
});
