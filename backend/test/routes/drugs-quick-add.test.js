// @ts-check
/**
 * Route tests for POST /api/wellness/drugs/quick-add.
 *
 * The point of this endpoint: a doctor mid-consultation types "Paracetamol",
 * finds nothing in the catalogue, and must be able to add it there and then.
 * Blocking on an admin means they type it as free text instead, and the
 * catalogue never learns about it — so its stock can never be tracked.
 *
 * What has to hold:
 *   • a PRESCRIBER can use it, unlike full drug CRUD which is admin/manager;
 *   • it cannot set stock — the row lands at 0/0 and admins are notified,
 *     because a prescriber guessing at counts is how a ledger becomes fiction;
 *   • it is idempotent on name, so a double-click or two doctors adding the
 *     same missing drug don't fork the catalogue;
 *   • it is tenant-scoped on both the lookup and the create.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

const prisma = requireCJS('../../lib/prisma');

prisma.drug = prisma.drug || {};
prisma.drug.findFirst = vi.fn();
prisma.drug.findMany = vi.fn();
prisma.drug.create = vi.fn();
prisma.drug.count = vi.fn();

prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.user.findUnique = vi.fn();

prisma.notification = prisma.notification || {};
prisma.notification.create = vi.fn();
prisma.notification.findFirst = vi.fn();
prisma.notificationPreference = prisma.notificationPreference || {};
prisma.notificationPreference.findUnique = vi.fn();

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn();
prisma.auditLog.findFirst = vi.fn();

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });
prisma.userRole = prisma.userRole || {};
prisma.userRole.findMany = vi.fn();

const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);

import express from 'express';
import request from 'supertest';

const drugsRouter = requireCJS('../../routes/drugs');

function makeApp({ tenantId = 1, userId = 7, role = 'USER', wellnessRole = 'doctor' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical: 'wellness' };
    next();
  });
  app.use('/api/wellness/drugs', drugsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.drug.findFirst.mockResolvedValue(null);
  prisma.drug.findMany.mockResolvedValue([]);
  prisma.drug.create.mockImplementation(async ({ data }) => ({ id: 500, ...data }));
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.findUnique.mockResolvedValue({ name: 'Dr Rao' });
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notificationPreference.findUnique.mockResolvedValue(null);
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.userRole.findMany.mockResolvedValue([]);
});

describe('POST /drugs/quick-add', () => {
  test('a DOCTOR can add a missing drug, unlike full drug CRUD', async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: 'doctor' }))
      .post('/api/wellness/drugs/quick-add')
      .send({ name: 'Paracetamol' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Paracetamol');
    expect(res.body.created).toBe(true);
  });

  test('the same doctor cannot use full drug CRUD', async () => {
    // Quick-add is deliberately narrower than writeGate, not a way around it.
    const res = await request(makeApp({ role: 'USER', wellnessRole: 'doctor' }))
      .post('/api/wellness/drugs')
      .send({ name: 'Paracetamol', quantity: 999 });
    expect(res.status).toBe(403);
  });

  test('lands at zero stock and cannot be told otherwise', async () => {
    await request(makeApp())
      .post('/api/wellness/drugs/quick-add')
      // A client trying to seed a count it has no business knowing.
      .send({ name: 'Paracetamol', quantity: 500, lowStockThreshold: 50 });

    const data = prisma.drug.create.mock.calls[0][0].data;
    expect(data.quantity).toBe(0);
    expect(data.lowStockThreshold).toBe(0);
  });

  test('notifies admins so the new row does not sit at zero forever', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    await request(makeApp())
      .post('/api/wellness/drugs/quick-add')
      .send({ name: 'Paracetamol' });

    // Notification is fire-and-forget; give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 20));

    const calls = prisma.notification.create.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0].data.title).toMatch(/needs stock set/i);
    expect(calls[0][0].data.entityType).toBe('drug-stock-setup');
  });

  test('is idempotent on name — a double-click does not fork the catalogue', async () => {
    prisma.drug.findFirst.mockResolvedValue({ id: 96, name: 'Paracetamol', quantity: 12 });

    const res = await request(makeApp())
      .post('/api/wellness/drugs/quick-add')
      .send({ name: 'Paracetamol' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(96);
    expect(res.body.created).toBe(false);
    expect(prisma.drug.create).not.toHaveBeenCalled();
  });

  test('scopes the duplicate check and the create to the tenant', async () => {
    await request(makeApp({ tenantId: 42 }))
      .post('/api/wellness/drugs/quick-add')
      .send({ name: 'Paracetamol' });

    expect(prisma.drug.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 42 });
    expect(prisma.drug.create.mock.calls[0][0].data.tenantId).toBe(42);
  });

  test('requires a name', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/drugs/quick-add')
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
    expect(prisma.drug.create).not.toHaveBeenCalled();
  });

  test('rejects an unknown dosage form', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/drugs/quick-add')
      .send({ name: 'Paracetamol', dosageForm: 'sorcery' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DOSAGE_FORM');
  });
});

describe('drug stock fields on CRUD', () => {
  function adminApp() {
    return makeApp({ role: 'ADMIN', wellnessRole: undefined });
  }

  test('create accepts quantity and threshold, defaulting both to 0', async () => {
    await request(adminApp())
      .post('/api/wellness/drugs')
      .send({ name: 'Amoxicillin', quantity: 40, lowStockThreshold: 10 });
    expect(prisma.drug.create.mock.calls[0][0].data).toMatchObject({
      quantity: 40,
      lowStockThreshold: 10,
    });

    prisma.drug.create.mockClear();
    await request(adminApp()).post('/api/wellness/drugs').send({ name: 'Bare' });
    expect(prisma.drug.create.mock.calls[0][0].data).toMatchObject({
      quantity: 0,
      lowStockThreshold: 0,
    });
  });

  test('a blank stock box on update leaves the count alone', async () => {
    // The edit form round-trips every field; a blank must never silently wipe
    // a stock count the admin did not intend to touch.
    prisma.drug.findFirst.mockResolvedValue({ id: 1, name: 'X', quantity: 40 });
    prisma.drug.update = vi.fn().mockResolvedValue({ id: 1, name: 'X', quantity: 40 });

    const res = await request(adminApp())
      .put('/api/wellness/drugs/1')
      .send({ name: 'X', quantity: '', lowStockThreshold: '' });

    expect(res.status).toBe(200);
    const data = prisma.drug.update.mock.calls[0][0].data;
    expect('quantity' in data).toBe(false);
    expect('lowStockThreshold' in data).toBe(false);
  });

  test('a negative or fractional stock value is a 400', async () => {
    prisma.drug.findFirst.mockResolvedValue({ id: 1, name: 'X' });
    prisma.drug.update = vi.fn();

    for (const bad of [-1, 1.5, 'plenty']) {
      const res = await request(adminApp())
        .put('/api/wellness/drugs/1')
        .send({ quantity: bad });
      expect(res.status, `quantity=${bad}`).toBe(400);
      expect(res.body.code).toBe('INVALID_STOCK_VALUE');
    }
    expect(prisma.drug.update).not.toHaveBeenCalled();
  });

  test('zero is a legitimate value for both fields', async () => {
    prisma.drug.findFirst.mockResolvedValue({ id: 1, name: 'X', quantity: 40 });
    prisma.drug.update = vi.fn().mockResolvedValue({ id: 1, name: 'X', quantity: 0 });

    await request(adminApp())
      .put('/api/wellness/drugs/1')
      .send({ quantity: 0, lowStockThreshold: 0 });

    expect(prisma.drug.update.mock.calls[0][0].data).toMatchObject({
      quantity: 0,
      lowStockThreshold: 0,
    });
  });
});
