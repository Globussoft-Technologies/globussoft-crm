// @ts-check
/**
 * Unit tests for backend/routes/expenses.js — pin the Expense CRUD +
 * submit/approve/reject status-transition flow against accidental regression.
 *
 * Why this file exists
 * ────────────────────
 * expenses.js is a 258-LOC route surface backing the Expenses page and the
 * employee-reimbursement workflow. The contract has these moving parts:
 *   - GET /              — list scoped to req.user.tenantId; ?status + ?category filters
 *   - GET /:id           — single fetch; parseInt-NaN guard → 400 INVALID; cross-tenant → 404
 *   - POST /             — title + amount required; emits expense.created
 *   - PUT /:id           — partial update (whitelist of fields)
 *   - DELETE /:id        — 204 No Content per the #550 sweep
 *   - PATCH /:id/submit  — verifyToken-gated; status → "Pending"; emits expense.submitted
 *   - PATCH /:id/approve — verifyRole(["ADMIN"]) gated; status → "Approved"; sets approvedById; emits expense.approved
 *   - PATCH /:id/reject  — verifyRole(["ADMIN"]) gated; status → "Rejected"; appends reason to notes; emits expense.rejected
 *
 * What this file pins
 * ───────────────────
 *   1. GET /          — happy + ?status + ?category filter wiring
 *   2. GET /:id       — happy + NaN-id → 400 + cross-tenant → 404
 *   3. POST /         — happy (201 + event emit) + title-missing → 400 + amount-missing → 400
 *   4. PUT /:id       — happy partial update + missing → 404
 *   5. DELETE /:id    — 204 No Content (#550 contract)
 *   6. PATCH submit   — Pending transition + event emit
 *   7. PATCH approve  — Approved + approvedById stamped + event emit
 *   8. PATCH reject   — Rejected + reason appended to notes + event emit
 *
 * Pattern reference: billing.test.js — auth-middleware bypass via singleton
 * patch on `../../middleware/auth` before requiring the route, prisma
 * singleton-patch with vi.fn() delegates, supertest with an express test app
 * that injects req.user via middleware.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch auth middleware BEFORE the router is required — destructured
// require'd references capture whatever the export points at at load time.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// Stub eventBus.emitEvent so emits don't hit the real workflow path. We still
// spy on it to assert which events fire.
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn();

// Prisma singleton patching — bare vi.fn() surfaces for the models the route
// touches (expense + user).
prisma.expense = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();

import express from 'express';
import request from 'supertest';
const expensesRouter = requireCJS('../../routes/expenses');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN', name = 'Admin User' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, name };
    next();
  });
  app.use('/api/expenses', expensesRouter);
  return app;
}

beforeEach(() => {
  prisma.expense.findMany.mockReset();
  prisma.expense.findFirst.mockReset();
  prisma.expense.create.mockReset();
  prisma.expense.update.mockReset();
  prisma.expense.delete.mockReset();
  prisma.user.findUnique.mockReset();
  eventBus.emitEvent.mockClear();
  // Sensible defaults
  prisma.user.findUnique.mockResolvedValue({ name: 'Test Employee' });
});

// ─── GET / — list with filters ─────────────────────────────────────

describe('GET /api/expenses — list', () => {
  test('happy path: returns expenses scoped to tenantId, no filters', async () => {
    prisma.expense.findMany.mockResolvedValue([
      { id: 1, title: 'Hotel — Mumbai trip', amount: 4500, status: 'Pending', tenantId: 1 },
      { id: 2, title: 'Client lunch', amount: 850, status: 'Approved', tenantId: 1 },
    ]);
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).get('/api/expenses');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const findArgs = prisma.expense.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1 });
    expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?status=Pending forwards to Prisma where clause', async () => {
    prisma.expense.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 1 });
    await request(app).get('/api/expenses?status=Pending');
    const findArgs = prisma.expense.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1, status: 'Pending' });
  });

  test('?category=Travel forwards to Prisma where clause', async () => {
    prisma.expense.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 1 });
    await request(app).get('/api/expenses?category=Travel');
    const findArgs = prisma.expense.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1, category: 'Travel' });
  });
});

// ─── GET /:id — fetch one ──────────────────────────────────────────

describe('GET /api/expenses/:id — fetch one', () => {
  test('happy path: returns expense scoped to tenant', async () => {
    prisma.expense.findFirst.mockResolvedValue({
      id: 7, title: 'Stationery', amount: 240, status: 'Pending', tenantId: 1,
    });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).get('/api/expenses/7');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    const findArgs = prisma.expense.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 7, tenantId: 1 });
  });

  test('non-numeric id → 400 INVALID (parseInt-NaN guard)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/expenses/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    // Crucially, the guard must short-circuit BEFORE Prisma.
    expect(prisma.expense.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant fetch → 404 (findFirst returns null when tenant filter excludes row)', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app).get('/api/expenses/7');
    expect(res.status).toBe(404);
    const findArgs = prisma.expense.findFirst.mock.calls[0][0];
    // Tenant-isolation: the where clause MUST include caller's tenantId.
    expect(findArgs.where.tenantId).toBe(99);
  });
});

// ─── POST / — create ───────────────────────────────────────────────

describe('POST /api/expenses — create', () => {
  test('happy path: title + amount → 201 + expense.created event emitted', async () => {
    prisma.expense.create.mockResolvedValue({
      id: 101,
      title: 'Client dinner — Acme negotiations',
      amount: 1850,
      category: 'Meals',
      status: 'Draft',
      tenantId: 1,
      userId: 7,
      user: { id: 7, name: 'Priya Sharma' },
    });
    const app = makeApp({ tenantId: 1, userId: 7 });
    const res = await request(app)
      .post('/api/expenses')
      .send({ title: 'Client dinner — Acme negotiations', amount: 1850, category: 'Meals' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(101);
    const createArgs = prisma.expense.create.mock.calls[0][0];
    expect(createArgs.data.title).toBe('Client dinner — Acme negotiations');
    expect(createArgs.data.amount).toBe(1850);
    expect(createArgs.data.category).toBe('Meals');
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.userId).toBe(7);
    // Event emit fires with correct payload + tenant scope.
    expect(eventBus.emitEvent).toHaveBeenCalledTimes(1);
    const [eventName, payload, tenantId] = eventBus.emitEvent.mock.calls[0];
    expect(eventName).toBe('expense.created');
    expect(payload.expenseId).toBe(101);
    expect(payload.amount).toBe(1850);
    expect(payload.title).toBe('Client dinner — Acme negotiations');
    expect(tenantId).toBe(1);
  });

  test('missing title → 400 (validation)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/expenses').send({ amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title is required/i);
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });

  test('missing amount → 400 (validation; null and undefined both rejected)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/expenses').send({ title: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount is required/i);
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });

  test('category defaults to "General" when omitted', async () => {
    prisma.expense.create.mockResolvedValue({
      id: 102, title: 'Misc', amount: 50, category: 'General', tenantId: 1, user: null,
    });
    const app = makeApp({ tenantId: 1 });
    await request(app).post('/api/expenses').send({ title: 'Misc', amount: 50 });
    const createArgs = prisma.expense.create.mock.calls[0][0];
    expect(createArgs.data.category).toBe('General');
  });
});

// ─── PUT /:id — update ─────────────────────────────────────────────

describe('PUT /api/expenses/:id — update', () => {
  test('happy path: partial update — only provided fields land in data', async () => {
    prisma.expense.findFirst.mockResolvedValue({
      id: 7, title: 'old', amount: 100, status: 'Draft', tenantId: 1,
    });
    prisma.expense.update.mockResolvedValue({
      id: 7, title: 'updated title', amount: 100, status: 'Draft', tenantId: 1,
    });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .put('/api/expenses/7')
      .send({ title: 'updated title' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('updated title');
    const updateArgs = prisma.expense.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 7 });
    expect(updateArgs.data.title).toBe('updated title');
    // amount/status/etc. NOT in update.data because they were not in request body.
    expect(updateArgs.data.amount).toBeUndefined();
    expect(updateArgs.data.status).toBeUndefined();
  });

  test('missing expense → 404 (cross-tenant or non-existent)', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app)
      .put('/api/expenses/7')
      .send({ title: 'irrelevant' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.expense.update).not.toHaveBeenCalled();
    // Tenant-isolation: the lookup MUST scope by tenantId.
    const findArgs = prisma.expense.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(99);
  });

  test('non-numeric id → 400 (parseInt-NaN guard)', async () => {
    const app = makeApp();
    const res = await request(app).put('/api/expenses/abc').send({ title: 'x' });
    expect(res.status).toBe(400);
    expect(prisma.expense.findFirst).not.toHaveBeenCalled();
  });
});

// ─── DELETE /:id — 204 No Content (#550 contract) ──────────────────

describe('DELETE /api/expenses/:id — delete (#550: 204 No Content)', () => {
  test('happy path: existing row → 204 with no body', async () => {
    prisma.expense.findFirst.mockResolvedValue({ id: 7, tenantId: 1 });
    prisma.expense.delete.mockResolvedValue({ id: 7 });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).delete('/api/expenses/7');
    expect(res.status).toBe(204);
    // 204 means no response body.
    expect(res.body).toEqual({});
    expect(prisma.expense.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  test('missing expense → 404 (cross-tenant or non-existent)', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app).delete('/api/expenses/7');
    expect(res.status).toBe(404);
    expect(prisma.expense.delete).not.toHaveBeenCalled();
  });
});

// ─── PATCH /:id/submit — submit for approval ───────────────────────

describe('PATCH /api/expenses/:id/submit — submit for approval', () => {
  test('happy path: status → "Pending" + expense.submitted event', async () => {
    prisma.expense.findFirst.mockResolvedValue({
      id: 7, title: 'Travel — Bangalore client visit', amount: 6500,
      status: 'Draft', tenantId: 1, userId: 7,
    });
    prisma.expense.update.mockResolvedValue({
      id: 7, title: 'Travel — Bangalore client visit', amount: 6500,
      status: 'Pending', tenantId: 1, userId: 7,
    });
    prisma.user.findUnique.mockResolvedValue({ name: 'Rahul Mehta' });
    const app = makeApp({ tenantId: 1, userId: 7 });
    const res = await request(app).patch('/api/expenses/7/submit').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Pending');
    const updateArgs = prisma.expense.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Pending');
    // Event payload + tenant scope.
    const eventNames = eventBus.emitEvent.mock.calls.map(([n]) => n);
    expect(eventNames).toContain('expense.submitted');
    const submitted = eventBus.emitEvent.mock.calls.find(c => c[0] === 'expense.submitted');
    expect(submitted[1].expenseId).toBe(7);
    expect(submitted[1].submitterName).toBe('Rahul Mehta');
    expect(submitted[2]).toBe(1);
  });

  test('missing expense → 404', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).patch('/api/expenses/999/submit').send({});
    expect(res.status).toBe(404);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });
});

// ─── PATCH /:id/approve — admin approves ───────────────────────────

describe('PATCH /api/expenses/:id/approve — admin approves', () => {
  test('happy path: status → "Approved" + approvedById stamped + event', async () => {
    prisma.expense.findFirst.mockResolvedValue({
      id: 7, title: 'Hotel', amount: 4500, status: 'Pending', tenantId: 1, userId: 22,
    });
    prisma.expense.update.mockResolvedValue({
      id: 7, title: 'Hotel', amount: 4500, status: 'Approved',
      tenantId: 1, userId: 22, approvedById: 7,
    });
    const app = makeApp({ tenantId: 1, userId: 7, name: 'Anjali Verma' });
    const res = await request(app).patch('/api/expenses/7/approve').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Approved');
    expect(res.body.approvedById).toBe(7);
    const updateArgs = prisma.expense.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Approved');
    expect(updateArgs.data.approvedById).toBe(7);
    // expense.approved event includes approverName from req.user.
    const eventNames = eventBus.emitEvent.mock.calls.map(([n]) => n);
    expect(eventNames).toContain('expense.approved');
    const approved = eventBus.emitEvent.mock.calls.find(c => c[0] === 'expense.approved');
    expect(approved[1].approverName).toBe('Anjali Verma');
    expect(approved[2]).toBe(1);
  });

  test('missing expense → 404 (cross-tenant or non-existent)', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app).patch('/api/expenses/7/approve').send({});
    expect(res.status).toBe(404);
    expect(prisma.expense.update).not.toHaveBeenCalled();
    // Tenant-isolation: the lookup MUST scope by tenantId.
    const findArgs = prisma.expense.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(99);
  });
});

// ─── PATCH /:id/reject — admin rejects with reason ─────────────────

describe('PATCH /api/expenses/:id/reject — admin rejects', () => {
  test('happy path: status → "Rejected" + reason appended to notes + event', async () => {
    prisma.expense.findFirst.mockResolvedValue({
      id: 7, title: 'Late-night cab', amount: 380,
      status: 'Pending', tenantId: 1, userId: 22,
      notes: 'Original note line',
    });
    prisma.expense.update.mockResolvedValue({
      id: 7, title: 'Late-night cab', amount: 380, status: 'Rejected',
      tenantId: 1, userId: 22, approvedById: 7,
      notes: 'Original note line\nRejection reason: Not a billable activity',
    });
    const app = makeApp({ tenantId: 1, userId: 7 });
    const res = await request(app)
      .patch('/api/expenses/7/reject')
      .send({ reason: 'Not a billable activity' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');
    const updateArgs = prisma.expense.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Rejected');
    expect(updateArgs.data.approvedById).toBe(7);
    // Reason is APPENDED to existing notes, not overwriting.
    expect(updateArgs.data.notes).toBe('Original note line\nRejection reason: Not a billable activity');
    // Event payload.
    const eventNames = eventBus.emitEvent.mock.calls.map(([n]) => n);
    expect(eventNames).toContain('expense.rejected');
    const rejected = eventBus.emitEvent.mock.calls.find(c => c[0] === 'expense.rejected');
    expect(rejected[1].rejectionReason).toBe('Not a billable activity');
    expect(rejected[2]).toBe(1);
  });

  test('no reason in body → notes left unchanged + event has "No reason provided"', async () => {
    prisma.expense.findFirst.mockResolvedValue({
      id: 7, title: 'X', amount: 100, status: 'Pending', tenantId: 1, userId: 22,
      notes: 'Existing notes',
    });
    prisma.expense.update.mockResolvedValue({
      id: 7, title: 'X', amount: 100, status: 'Rejected', tenantId: 1, userId: 22,
      approvedById: 7, notes: 'Existing notes',
    });
    const app = makeApp({ tenantId: 1, userId: 7 });
    const res = await request(app).patch('/api/expenses/7/reject').send({});
    expect(res.status).toBe(200);
    const updateArgs = prisma.expense.update.mock.calls[0][0];
    // No reason → notes pass through unchanged.
    expect(updateArgs.data.notes).toBe('Existing notes');
    const rejected = eventBus.emitEvent.mock.calls.find(c => c[0] === 'expense.rejected');
    expect(rejected[1].rejectionReason).toBe('No reason provided');
  });

  test('missing expense → 404', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .patch('/api/expenses/999/reject')
      .send({ reason: 'whatever' });
    expect(res.status).toBe(404);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });
});

// ─── GET /?fields=summary — slim-shape PII reduction (#920 slice 6) ─

/**
 * #920 slice 6 — opt-in slim Prisma `select` to drop heavy nested includes
 * (user + contact) and sensitive flat columns (description, notes, receiptUrl)
 * from list responses. Mirrors the contacts/deals/tickets/tasks/projects shape
 * shipped in slices 1-5. ADDITIVE only; any non-`summary` value (or absent
 * param) leaves the existing full-shape include path untouched. Pins:
 *   1. response rows carry only the slim keys (no nested objects on the wire).
 *   2. prisma.expense.findMany called with `select` (not `include`) on slim path.
 *   3. ?fields= absent → existing full-shape include path preserved.
 *   4. ?fields=anything-else → full-shape include path (exact-string match).
 *   5. tenant scoping + status/category filters preserved on slim path.
 */
describe('GET /api/expenses?fields=summary — slim-shape opt-in (#920 slice 6)', () => {
  const FULL_INCLUDE = { user: true, contact: true };

  test('?fields=summary: response rows carry only slim keys (no nested objects)', async () => {
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 1, title: 'Hotel — Mumbai trip', amount: 4500, category: 'Travel',
        status: 'Pending', currency: 'INR',
        expenseDate: new Date('2026-05-01'),
        userId: 7, contactId: null, tenantId: 1,
        createdAt: new Date('2026-05-01'),
      },
      {
        id: 2, title: 'Client lunch', amount: 850, category: 'Meals',
        status: 'Approved', currency: 'INR',
        expenseDate: new Date('2026-05-02'),
        userId: 7, contactId: 42, tenantId: 1,
        createdAt: new Date('2026-05-02'),
      },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/expenses?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // No nested includes leaked into the response.
    expect(res.body[0].user).toBeUndefined();
    expect(res.body[0].contact).toBeUndefined();
    // Slim keys present.
    expect(res.body[0]).toHaveProperty('id');
    expect(res.body[0]).toHaveProperty('title');
    expect(res.body[0]).toHaveProperty('amount');
    expect(res.body[0]).toHaveProperty('category');
    expect(res.body[0]).toHaveProperty('status');
    expect(res.body[0]).toHaveProperty('currency');
    expect(res.body[0]).toHaveProperty('userId');
    expect(res.body[0]).toHaveProperty('contactId');
    expect(res.body[0]).toHaveProperty('tenantId');
    expect(res.body[0]).toHaveProperty('createdAt');
  });

  test('?fields=summary: prisma.expense.findMany called with select (not include)', async () => {
    prisma.expense.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get('/api/expenses?fields=summary');

    const findArgs = prisma.expense.findMany.mock.calls[0][0];
    // Slim path: select is set, include is absent.
    expect(findArgs.select).toBeDefined();
    expect(findArgs.include).toBeUndefined();
    // The slim select contains exactly the documented field set.
    expect(findArgs.select).toEqual({
      id: true,
      title: true,
      amount: true,
      category: true,
      status: true,
      currency: true,
      expenseDate: true,
      userId: true,
      contactId: true,
      tenantId: true,
      createdAt: true,
    });
  });

  test('?fields= (absent): existing full-shape include path is preserved', async () => {
    prisma.expense.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get('/api/expenses');

    const findArgs = prisma.expense.findMany.mock.calls[0][0];
    // Full-shape path: include is set, select is absent.
    expect(findArgs.include).toEqual(FULL_INCLUDE);
    expect(findArgs.select).toBeUndefined();
  });

  test('?fields=anything-else: opt-in is exact-string only, NOT a prefix match', async () => {
    prisma.expense.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get('/api/expenses?fields=summaryfoo');

    const findArgs = prisma.expense.findMany.mock.calls[0][0];
    // Any non-exact 'summary' value falls through to the full-shape include.
    expect(findArgs.include).toEqual(FULL_INCLUDE);
    expect(findArgs.select).toBeUndefined();
  });

  test('?fields=summary: tenant scoping + status/category filters preserved on slim path', async () => {
    prisma.expense.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 42 }))
      .get('/api/expenses?fields=summary&status=Pending&category=Travel');

    const findArgs = prisma.expense.findMany.mock.calls[0][0];
    // Tenant isolation must survive the shape swap.
    expect(findArgs.where.tenantId).toBe(42);
    // Status + category filters must still apply on the slim path.
    expect(findArgs.where.status).toBe('Pending');
    expect(findArgs.where.category).toBe('Travel');
    // Slim path was taken.
    expect(findArgs.select).toBeDefined();
    expect(findArgs.include).toBeUndefined();
  });
});
