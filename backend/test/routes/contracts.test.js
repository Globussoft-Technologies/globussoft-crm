// @ts-check
/**
 * Unit tests for backend/routes/contracts.js — pin the Contract CRUD +
 * status-transition contract against accidental regression.
 *
 * Why this file exists
 * ────────────────────
 * contracts.js is a 116-LOC route surface backing the Contracts page +
 * deal-attachment workflow. It is a CRUD route (no event emits, no
 * dedicated PATCH transition endpoints — status moves happen via PUT
 * /:id with the new value). Shape under test:
 *   - GET /         — list scoped to req.user.tenantId; ?status filter
 *                     forwards verbatim to Prisma where clause
 *   - GET /:id      — single fetch with contact + deal includes;
 *                     parseInt-NaN guard → 400 INVALID; cross-tenant → 404
 *   - POST /        — title required; status defaults to "Draft";
 *                     startDate/endDate run through `new Date(...)`;
 *                     value coerced via parseFloat (defaults 0.0);
 *                     contactId/dealId coerced via parseInt (nullable);
 *                     tenantId stamped from req.user.tenantId
 *   - PUT /:id      — partial update (whitelist: title, status, startDate,
 *                     endDate, value, terms, contactId, dealId); cross-
 *                     tenant → 404 (findFirst returns null); NaN-id → 400
 *   - DELETE /:id   — 204 No Content per the #550 cross-route DELETE-shape
 *                     sweep (commit 8853546); cross-tenant → 404; NaN → 400
 *
 * What this file pins (12 cases across 5 describe blocks)
 * ────────────────────────────────────────────────────────
 *   1. GET /          — happy + ?status filter wiring + tenant-scoped where
 *   2. GET /:id       — happy (with contact+deal includes) + NaN→400 +
 *                       cross-tenant→404 (verifies the tenant filter is
 *                       applied, not just the id)
 *   3. POST /         — happy 201 with defaults + title-missing → 400 +
 *                       coercion of value/contactId/dealId + status default
 *                       "Draft" + tenantId stamped from req.user
 *   4. PUT /:id       — happy partial update (only provided fields land in
 *                       data) + missing → 404 + status-transition probe
 *                       (Draft → Active flows through unchanged)
 *   5. DELETE /:id    — 204 No Content (#550) + cross-tenant → 404 +
 *                       NaN-id → 400 short-circuits Prisma
 *
 * Why these cases
 * ───────────────
 * The route's contract is small but load-bearing for the Contracts page
 * + deal-document workflow. The regression classes worth pinning:
 *   - The #550 DELETE → 204 sweep is fragile: any "let's return JSON on
 *     delete" refactor breaks the cross-route shape contract that the
 *     gate spec cross-tenant-stripdangerous-api.spec.js relies on.
 *   - Tenant isolation on PUT/DELETE/:id MUST go through findFirst with
 *     a tenantId-scoped where clause BEFORE the update/delete — direct
 *     update with where:{id} would be a cross-tenant write. The pin
 *     here verifies the findFirst tenant-filter wiring.
 *   - parseInt/parseFloat coercion on POST is silently load-bearing —
 *     incoming form bodies arrive as strings; without coercion the
 *     Prisma int/float columns reject the insert with a cryptic error.
 *   - Status defaults to "Draft" on omit but flows through unchanged on
 *     PUT — this is the status-transition surface (Draft → Active →
 *     Closed). The route has no enum gate; transitions are open.
 *
 * Pattern reference: backend/test/routes/expenses.test.js — singleton
 * patch on `../../lib/prisma` before requiring the router, supertest
 * with an express test app that injects req.user via middleware. No
 * auth middleware patch needed (contracts.js doesn't import verifyToken
 * directly — auth is wired at the server.js mount level).
 *
 * No SUT changes — this file only READS the route and pins its
 * existing contract. Any bug surfaced becomes an `it.skip()` + filed
 * issue per the test-cron protocol.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Prisma singleton patching — replace prisma.contract with bare vi.fn()
// surfaces for every method the route touches. Must happen BEFORE the
// router is require'd (the route binds `prisma` at module-load time).
prisma.contract = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

import express from 'express';
import request from 'supertest';
const contractsRouter = requireCJS('../../routes/contracts');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  // Inject a fake req.user — production wires this via verifyToken
  // upstream of the router mount in server.js.
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/contracts', contractsRouter);
  return app;
}

beforeEach(() => {
  prisma.contract.findMany.mockReset();
  prisma.contract.findFirst.mockReset();
  prisma.contract.create.mockReset();
  prisma.contract.update.mockReset();
  prisma.contract.delete.mockReset();
});

// ─── GET / — list with optional status filter ──────────────────────

describe('GET /api/contracts — list', () => {
  test('happy path: returns contracts scoped to tenantId; orderBy createdAt desc; includes contact + deal', async () => {
    prisma.contract.findMany.mockResolvedValue([
      {
        id: 1, title: 'MSA — Acme Corp', status: 'Active', value: 125000,
        tenantId: 1, contact: { id: 11, name: 'Priya Sharma' }, deal: null,
      },
      {
        id: 2, title: 'SOW — Beta Industries', status: 'Draft', value: 48000,
        tenantId: 1, contact: null, deal: { id: 41, title: 'Beta Q2 onboarding' },
      },
    ]);
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).get('/api/contracts');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].title).toBe('MSA — Acme Corp');
    const findArgs = prisma.contract.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1 });
    expect(findArgs.include).toEqual({ contact: true, deal: true });
    expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?status=Active forwards to Prisma where clause alongside tenantId', async () => {
    prisma.contract.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 1 });
    await request(app).get('/api/contracts?status=Active');
    const findArgs = prisma.contract.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1, status: 'Active' });
  });

  test('tenant-isolation: list never bleeds across tenants (different tenantId → different where)', async () => {
    prisma.contract.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 99 });
    await request(app).get('/api/contracts');
    const findArgs = prisma.contract.findMany.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(99);
  });
});

// ─── GET /:id — fetch one with relations ───────────────────────────

describe('GET /api/contracts/:id — fetch one', () => {
  test('happy path: returns contract with contact + deal includes', async () => {
    prisma.contract.findFirst.mockResolvedValue({
      id: 7, title: 'NDA — Gamma Partners', status: 'Active', value: 0,
      tenantId: 1,
      contact: { id: 11, name: 'Rahul Mehta' },
      deal: { id: 22, title: 'Gamma pilot' },
    });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).get('/api/contracts/7');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(res.body.contact.name).toBe('Rahul Mehta');
    expect(res.body.deal.title).toBe('Gamma pilot');
    const findArgs = prisma.contract.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 7, tenantId: 1 });
    expect(findArgs.include).toEqual({ contact: true, deal: true });
  });

  test('non-numeric id → 400 INVALID (parseInt-NaN guard short-circuits Prisma)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/contracts/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    // Crucially, the guard must fire BEFORE any DB call.
    expect(prisma.contract.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant fetch → 404 (findFirst returns null when tenant filter excludes the row)', async () => {
    prisma.contract.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app).get('/api/contracts/7');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    // Tenant-isolation pin: the where clause MUST include caller's tenantId,
    // not just the row id. A bare findFirst({ where: { id } }) would be a
    // cross-tenant read.
    const findArgs = prisma.contract.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(99);
    expect(findArgs.where.id).toBe(7);
  });
});

// ─── POST / — create ───────────────────────────────────────────────

describe('POST /api/contracts — create', () => {
  test('happy path: title + full payload → 201 + tenant stamped + dates/values coerced', async () => {
    prisma.contract.create.mockResolvedValue({
      id: 101,
      title: 'MSA — Delta Logistics',
      status: 'Active',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
      value: 250000.5,
      terms: 'Net-30 invoicing',
      contactId: 11,
      dealId: 22,
      tenantId: 1,
      contact: { id: 11, name: 'Anjali Verma' },
      deal: { id: 22, title: 'Delta annual contract' },
    });
    const app = makeApp({ tenantId: 1, userId: 7 });
    const res = await request(app).post('/api/contracts').send({
      title: 'MSA — Delta Logistics',
      status: 'Active',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      value: '250000.50', // string from form → parseFloat
      terms: 'Net-30 invoicing',
      contactId: '11',    // string from form → parseInt
      dealId: '22',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(101);
    const createArgs = prisma.contract.create.mock.calls[0][0];
    expect(createArgs.data.title).toBe('MSA — Delta Logistics');
    expect(createArgs.data.status).toBe('Active');
    expect(createArgs.data.value).toBeCloseTo(250000.5);
    expect(createArgs.data.contactId).toBe(11);
    expect(createArgs.data.dealId).toBe(22);
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.startDate).toBeInstanceOf(Date);
    expect(createArgs.data.endDate).toBeInstanceOf(Date);
    expect(createArgs.include).toEqual({ contact: true, deal: true });
  });

  test('status defaults to "Draft" + value defaults to 0.0 + nullable fields → null when omitted', async () => {
    prisma.contract.create.mockResolvedValue({
      id: 102, title: 'Bare-bones contract', status: 'Draft', value: 0.0,
      startDate: null, endDate: null, terms: null, contactId: null, dealId: null,
      tenantId: 1, contact: null, deal: null,
    });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).post('/api/contracts').send({ title: 'Bare-bones contract' });
    expect(res.status).toBe(201);
    const createArgs = prisma.contract.create.mock.calls[0][0];
    expect(createArgs.data.status).toBe('Draft');
    expect(createArgs.data.value).toBe(0.0);
    expect(createArgs.data.startDate).toBeNull();
    expect(createArgs.data.endDate).toBeNull();
    expect(createArgs.data.terms).toBeNull();
    expect(createArgs.data.contactId).toBeNull();
    expect(createArgs.data.dealId).toBeNull();
    expect(createArgs.data.tenantId).toBe(1);
  });

  test('missing title → 400 (validation; Prisma never called)', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/contracts').send({ status: 'Active', value: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title is required/i);
    expect(prisma.contract.create).not.toHaveBeenCalled();
  });
});

// ─── PUT /:id — partial update + status transition ─────────────────

describe('PUT /api/contracts/:id — update', () => {
  test('happy path: partial update — only provided fields land in data; tenant-scoped lookup', async () => {
    prisma.contract.findFirst.mockResolvedValue({
      id: 7, title: 'old title', status: 'Draft', value: 100, tenantId: 1,
    });
    prisma.contract.update.mockResolvedValue({
      id: 7, title: 'renegotiated MSA — Acme', status: 'Draft', value: 100, tenantId: 1,
      contact: null, deal: null,
    });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .put('/api/contracts/7')
      .send({ title: 'renegotiated MSA — Acme' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('renegotiated MSA — Acme');
    // Tenant-scoped lookup BEFORE the update — no cross-tenant write.
    const findArgs = prisma.contract.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 7, tenantId: 1 });
    // Update args: only `title` should land in data; status/value/etc.
    // must NOT be touched because they were not in the request body.
    const updateArgs = prisma.contract.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 7 });
    expect(updateArgs.data.title).toBe('renegotiated MSA — Acme');
    expect(updateArgs.data.status).toBeUndefined();
    expect(updateArgs.data.value).toBeUndefined();
    expect(updateArgs.data.contactId).toBeUndefined();
    expect(updateArgs.include).toEqual({ contact: true, deal: true });
  });

  test('status transition: Draft → Active flows through unchanged (no enum gate)', async () => {
    prisma.contract.findFirst.mockResolvedValue({
      id: 7, title: 'MSA', status: 'Draft', tenantId: 1,
    });
    prisma.contract.update.mockResolvedValue({
      id: 7, title: 'MSA', status: 'Active', tenantId: 1, contact: null, deal: null,
    });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).put('/api/contracts/7').send({ status: 'Active' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Active');
    const updateArgs = prisma.contract.update.mock.calls[0][0];
    // Status transitions are open — any string the caller supplies passes
    // through. If we ever add an enum guard, this test pins what the
    // BEFORE-shape was so the regression is visible.
    expect(updateArgs.data.status).toBe('Active');
    expect(updateArgs.data.title).toBeUndefined();
  });

  test('missing contract → 404 (cross-tenant or non-existent); update never called', async () => {
    prisma.contract.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app)
      .put('/api/contracts/7')
      .send({ title: 'irrelevant' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.contract.update).not.toHaveBeenCalled();
    // Tenant-isolation pin: the lookup scopes by caller's tenantId.
    const findArgs = prisma.contract.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(99);
  });
});

// ─── DELETE /:id — 204 No Content (#550 cross-route shape sweep) ───

describe('DELETE /api/contracts/:id — delete (#550: 204 No Content)', () => {
  test('happy path: existing row → 204 with empty body; tenant-scoped lookup', async () => {
    prisma.contract.findFirst.mockResolvedValue({ id: 7, tenantId: 1 });
    prisma.contract.delete.mockResolvedValue({ id: 7 });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).delete('/api/contracts/7');
    expect(res.status).toBe(204);
    // 204 means no response body — supertest surfaces this as {}.
    expect(res.body).toEqual({});
    expect(prisma.contract.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    // Tenant-scoped lookup MUST run BEFORE the delete.
    const findArgs = prisma.contract.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 7, tenantId: 1 });
  });

  test('cross-tenant delete → 404 (findFirst returns null); delete never called', async () => {
    prisma.contract.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app).delete('/api/contracts/7');
    expect(res.status).toBe(404);
    expect(prisma.contract.delete).not.toHaveBeenCalled();
    const findArgs = prisma.contract.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(99);
  });

  test('non-numeric id → 400 INVALID (parseInt-NaN guard short-circuits Prisma)', async () => {
    const app = makeApp();
    const res = await request(app).delete('/api/contracts/abc');
    expect(res.status).toBe(400);
    expect(prisma.contract.findFirst).not.toHaveBeenCalled();
    expect(prisma.contract.delete).not.toHaveBeenCalled();
  });
});

// ─── GET /?fields=summary — slim-shape opt-in (#920 slice 14) ──────
//
// Mirrors prior 12 slices (contacts f7790241 / deals 6786c2da / tickets
// badc9cca / tasks eec7d856 / projects 257771a0 / expenses e81e6cb5 /
// notifications a3487518 / surveys e71594d9 / email-templates 0d4a63f9 /
// knowledge-base 21ad3290 / sequences). When ?fields=summary, the route
// switches from include:{contact,deal} (relation joins) + default-select-
// all (which pulls the heavy `terms` String? @db.Text column) to an
// explicit Prisma `select` listing only the columns the list renderer
// actually needs. Opt-in additive — non-matching ?fields values fall
// through to the default include-shape.
describe('GET /api/contracts?fields=summary — slim-shape opt-in (#920)', () => {
  test('?fields=summary forwards a Prisma `select` (not include) — drops heavy terms + relations', async () => {
    prisma.contract.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 1 });
    await request(app).get('/api/contracts?fields=summary');
    const findArgs = prisma.contract.findMany.mock.calls[0][0];
    // The opt-in MUST flip to a select — include would still pull the
    // heavy fields by default. Pin the exact shape so accidental drift
    // is loud.
    expect(findArgs.select).toBeDefined();
    expect(findArgs.include).toBeUndefined();
    expect(findArgs.select).toEqual({
      id: true,
      title: true,
      status: true,
      startDate: true,
      endDate: true,
      value: true,
      tenantId: true,
      contactId: true,
      dealId: true,
      createdAt: true,
      updatedAt: true,
    });
    // The heavy fields MUST be absent from the select keyset.
    expect(findArgs.select.terms).toBeUndefined();
    expect(findArgs.select.contact).toBeUndefined();
    expect(findArgs.select.deal).toBeUndefined();
  });

  test('?fields=summary preserves tenant scoping + orderBy createdAt desc', async () => {
    prisma.contract.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 42 });
    await request(app).get('/api/contracts?fields=summary');
    const findArgs = prisma.contract.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 42 });
    expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary&status=Active layers the status filter on top of the slim shape', async () => {
    prisma.contract.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 1 });
    await request(app).get('/api/contracts?fields=summary&status=Active');
    const findArgs = prisma.contract.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1, status: 'Active' });
    expect(findArgs.select).toBeDefined();
    expect(findArgs.include).toBeUndefined();
  });

  test('no ?fields query param → default shape unchanged (include:{contact,deal}, no select)', async () => {
    prisma.contract.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 1 });
    await request(app).get('/api/contracts');
    const findArgs = prisma.contract.findMany.mock.calls[0][0];
    expect(findArgs.include).toEqual({ contact: true, deal: true });
    expect(findArgs.select).toBeUndefined();
  });

  test('?fields=other (non-exact value) → default shape (opt-in is exact-match "summary" only)', async () => {
    prisma.contract.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 1 });
    await request(app).get('/api/contracts?fields=full');
    const findArgs = prisma.contract.findMany.mock.calls[0][0];
    // Anything other than the exact string "summary" must fall through to
    // the default include-shape — no partial-match / case-insensitive /
    // substring opt-in. Existing callers passing arbitrary ?fields values
    // must NOT be silently slim-shaped.
    expect(findArgs.include).toEqual({ contact: true, deal: true });
    expect(findArgs.select).toBeUndefined();
  });

  test('slim-shape response body passes through Prisma rows verbatim (no extra envelope)', async () => {
    prisma.contract.findMany.mockResolvedValue([
      { id: 1, title: 'MSA — Acme', status: 'Active', value: 125000, tenantId: 1, contactId: 11, dealId: null },
      { id: 2, title: 'SOW — Beta', status: 'Draft', value: 48000, tenantId: 1, contactId: null, dealId: 41 },
    ]);
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).get('/api/contracts?fields=summary');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    // Bare array, not { data: [...] } or { contracts: [...] } — same
    // envelope shape as the default list response so the frontend can
    // swap to ?fields=summary without changing its decode path.
    expect(res.body[0].title).toBe('MSA — Acme');
    expect(res.body[1].title).toBe('SOW — Beta');
  });
});
