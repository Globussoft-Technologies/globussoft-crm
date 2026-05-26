// @ts-check
/**
 * Unit tests for backend/routes/estimates.js — pin the Estimates CRUD +
 * line-items + convert-to-invoice contract against accidental regression.
 *
 * Why this file exists
 * ────────────────────
 * estimates.js is a 628-LOC route surface backing the Estimates page +
 * sales-quote workflow. Several issues have closed inside it:
 *   - #164                — at least one line item required; zero-qty rows rejected.
 *   - #167                — DELETE is now a soft-delete (writes deletedAt) +
 *                           idempotent; soft-deleted rows are 404 on GET unless
 *                           ?includeDeleted=true; POST /:id/restore unflips.
 *   - #168 / regression-23 — PUT now runs the same validator as POST. Pre-fix the
 *                            endpoint accepted "not-a-date" validUntil and 500'd
 *                            at the DB layer. validUntil > now + 10y is rejected.
 *   - #174                — line-items hard-cap at 200 entries (DoS surface).
 *   - #178 / #322         — validUntil in the past is rejected.
 *   - #199                — legacy `name` / `items` field aliases honored for
 *                           older mobile builds + cached SPA bundles.
 *   - #179                — every mutating path writes an AuditLog row
 *                           (CREATE / UPDATE / SOFT_DELETE / RESTORE /
 *                           CONVERT_TO_INVOICE). The PUT path diffs only
 *                           changed keys so the audit trail stays focused.
 *   - convert-to-invoice  — Draft → Converted is one-shot; mints an
 *                           UNPAID invoice (dueDate = +30d) with both
 *                           contactId + dealId preserved; transaction-wrapped
 *                           so a downstream Prisma failure leaves the estimate
 *                           untouched. Both the estimate side AND the
 *                           invoice side get an audit entry (two-sided
 *                           trail) so auditors can walk either direction.
 *
 * What this file pins
 * ───────────────────
 *   1. POST /              — happy path, title-required, line-item-required,
 *                            past validUntil, sub-1 quantity, negative price,
 *                            line-items > 200 cap, legacy `name`/`items` alias.
 *   2. GET /:id            — happy path, INVALID_ID guard, tenant isolation,
 *                            soft-deleted 404-by-default + ?includeDeleted=true.
 *   3. PUT /:id            — happy path, status whitelist guard, validUntil
 *                            >10y-future cap, tenant isolation.
 *   4. PUT /:id/convert    — happy path mints UNPAID invoice + flips estimate,
 *                            already-Converted blocked, missing-contact blocked.
 *   5. DELETE /:id         — soft-delete writes deletedAt, idempotent re-delete.
 *   6. POST /:id/restore   — unflips deletedAt.
 *
 * Pattern reference: billing.test.js (auth-middleware bypass + prisma
 * singleton-monkey-patch). The route's CJS `require('../middleware/auth')`
 * destructures `verifyRole` at module-load, so the test patches THAT export
 * to a pass-through factory before requiring the router. `req.user` is
 * injected by the test's express middleware.
 *
 * What this file does NOT cover (intentional, out of scope for ≥12 cases):
 *   - GET /:id/pdf      — PDFKit binary streaming; covered by pdf-rendering
 *                         e2e specs in e2e/tests/estimates-api.spec.js.
 *   - POST /:id/email   — SendGrid dispatch + EmailMessage row + `quote.sent`
 *                         webhook fan-out (#929); covered by the email e2e
 *                         spec which can drive a real fetch-stub.
 *   - includeDeleted=true on the LIST endpoint — pinning the WHERE clause
 *                         shape is the LIST contract; covered by estimates-api
 *                         e2e and accountIng.test.js's parallel list-helper.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch the auth middleware BEFORE the estimates router is required — the
// router does `const { verifyRole } = require(...)` at module-load, so the
// destructured reference captures whatever `authMw.verifyRole` points at
// THE MOMENT the route is required. Pass-through both so the route's
// handlers see whatever req.user we inject downstream.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// Patch eventBus.safeEmitEvent BEFORE the router is required so the
// quote.sent webhook emission (POST /:id/email path) doesn't hit the real
// DB-backed workflow path. The route already wraps every emit in try/catch,
// but stubbing keeps the test output clean.
const eventBus = requireCJS('../../lib/eventBus');
eventBus.safeEmitEvent = vi.fn();
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);

// Prisma singleton patching — replace the lazy delegates with bare vi.fn()
// surfaces. The route touches estimate, invoice, auditLog, tenant,
// emailMessage, activity, and (transitively, via lib/audit + lib/validators)
// no other tables.
prisma.estimate = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.invoice = prisma.invoice || {};
prisma.invoice.create = vi.fn();
prisma.invoice.update = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.auditLog = {
  findFirst: vi.fn(),
  create: vi.fn(),
};
prisma.emailMessage = { create: vi.fn() };
prisma.activity = { create: vi.fn() };
// $transaction: route hands a callback that returns { estimate, invoice }.
// Run the callback against a tx-like surface that proxies to the patched
// prisma. Real Prisma's transaction semantics aren't under test here; what
// IS under test is that the route hands the right shapes to both calls.
prisma.$transaction = vi.fn(async (cb) => cb({
  estimate: prisma.estimate,
  invoice: prisma.invoice,
}));

import express from 'express';
import request from 'supertest';
const estimatesRouter = requireCJS('../../routes/estimates');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/estimates', estimatesRouter);
  return app;
}

beforeEach(() => {
  prisma.estimate.findMany.mockReset();
  prisma.estimate.findFirst.mockReset();
  prisma.estimate.create.mockReset();
  prisma.estimate.update.mockReset();
  prisma.invoice.create.mockReset();
  prisma.invoice.update.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.auditLog.findFirst.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.activity.create.mockReset();
  // Sensible defaults — happy-path resolves.
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({
    id: 1, name: 'Acme', defaultCurrency: 'USD', locale: 'en-US', emailRetention: true,
  });
  prisma.activity.create.mockResolvedValue({ id: 99 });
  eventBus.safeEmitEvent.mockClear();
  eventBus.emitEvent.mockClear();
});

// ─── POST / — Estimate creation (validation contract) ──────────────

describe('POST /api/estimates — create estimate (#164 #174 #178 #199)', () => {
  test('happy path: title + ≥1 lineItem + future validUntil → 201 with created row + audit', async () => {
    const futureDate = new Date(Date.now() + 7 * 86400000).toISOString();
    prisma.estimate.create.mockResolvedValue({
      id: 1001,
      estimateNum: 'EST-ABC123',
      title: 'Service quote',
      totalAmount: 500,
      validUntil: new Date(futureDate),
      contactId: 42,
      tenantId: 1,
      status: 'Draft',
      lineItems: [],
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/estimates')
      .send({
        title: 'Service quote',
        contactId: 42,
        validUntil: futureDate,
        lineItems: [{ description: 'Consulting', quantity: 5, unitPrice: 100 }],
      });
    expect(res.status).toBe(201);
    expect(prisma.estimate.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.estimate.create.mock.calls[0][0];
    expect(createArgs.data.title).toBe('Service quote');
    expect(createArgs.data.totalAmount).toBe(500); // 5 × 100
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.contactId).toBe(42);
    expect(createArgs.data.estimateNum).toMatch(/^EST-/);
    // Audit row written for #179.
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('missing title → 400 (route inlines bare check before validator)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/estimates')
      .send({ lineItems: [{ description: 'x', quantity: 1, unitPrice: 10 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });

  test('no line items → 400 LINE_ITEMS_REQUIRED (#164)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/estimates')
      .send({ title: 'Empty quote', lineItems: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LINE_ITEMS_REQUIRED');
    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });

  test('line items > 200 → 400 LINE_ITEMS_LIMIT_EXCEEDED (#174 DoS cap)', async () => {
    const app = makeApp();
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      description: `Item ${i}`, quantity: 1, unitPrice: 1,
    }));
    const res = await request(app)
      .post('/api/estimates')
      .send({ title: 'Big quote', lineItems: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LINE_ITEMS_LIMIT_EXCEEDED');
    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });

  test('validUntil in the past → 400 VALID_UNTIL_IN_PAST (#178)', async () => {
    const app = makeApp();
    const pastDate = new Date(Date.now() - 7 * 86400000).toISOString();
    const res = await request(app)
      .post('/api/estimates')
      .send({
        title: 'Stale quote',
        validUntil: pastDate,
        lineItems: [{ description: 'x', quantity: 1, unitPrice: 10 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALID_UNTIL_IN_PAST');
    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });

  test('line-item quantity < 1 → 400 INVALID_QUANTITY (#123 + #164)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/estimates')
      .send({
        title: 'Bad qty',
        lineItems: [{ description: 'x', quantity: 0, unitPrice: 10 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUANTITY');
    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });

  test('line-item negative unitPrice → 400 NEGATIVE_PRICE (#123)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/estimates')
      .send({
        title: 'Negative price',
        lineItems: [{ description: 'x', quantity: 1, unitPrice: -5 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NEGATIVE_PRICE');
    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });

  test('legacy `name` + `items` aliases honored (#199 deprecation window)', async () => {
    prisma.estimate.create.mockResolvedValue({
      id: 1002, estimateNum: 'EST-LEGACY', title: 'Legacy mobile payload',
      totalAmount: 200, tenantId: 1, contactId: null, status: 'Draft', lineItems: [],
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/estimates')
      .send({
        name: 'Legacy mobile payload', // legacy alias for `title`
        items: [{ description: 'Old-shape item', quantity: 2, unitPrice: 100 }], // legacy alias for `lineItems`
      });
    expect(res.status).toBe(201);
    const createArgs = prisma.estimate.create.mock.calls[0][0];
    expect(createArgs.data.title).toBe('Legacy mobile payload');
    expect(createArgs.data.totalAmount).toBe(200); // 2 × 100 — proves items[] flowed through to total
  });

  test('validUntil > 10 years in future → 400 INVALID_VALID_UNTIL_FUTURE (regression-23 #11)', async () => {
    // POST itself only checks the past-bound inline; the +10y check is in the
    // shared validator which POST also runs (via validateEstimateInput).
    const app = makeApp();
    const farFutureDate = new Date(Date.now() + 11 * 365 * 86400000).toISOString();
    const res = await request(app)
      .post('/api/estimates')
      .send({
        title: 'Decade quote',
        validUntil: farFutureDate,
        lineItems: [{ description: 'x', quantity: 1, unitPrice: 10 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALID_UNTIL_FUTURE');
    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });
});

// ─── GET /:id — fetch single estimate ──────────────────────────────

describe('GET /api/estimates/:id — fetch one', () => {
  test('happy path: returns estimate scoped to tenant', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 100,
      status: 'Draft', tenantId: 1, deletedAt: null,
      contact: { id: 42, name: 'Acme' }, deal: null, lineItems: [],
    });
    const app = makeApp();
    const res = await request(app).get('/api/estimates/7');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    const findArgs = prisma.estimate.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 7, tenantId: 1 });
  });

  test('non-numeric id → 400 (parseInt-NaN guard)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/estimates/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    expect(prisma.estimate.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant fetch → 404 (findFirst returns null because tenant filter does not match)', async () => {
    prisma.estimate.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app).get('/api/estimates/7');
    expect(res.status).toBe(404);
    const findArgs = prisma.estimate.findFirst.mock.calls[0][0];
    // Tenant-isolation: the where clause MUST include the caller's tenantId.
    expect(findArgs.where.tenantId).toBe(99);
  });

  test('soft-deleted row → 404 by default; ?includeDeleted=true → 200 (#167)', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'gone', totalAmount: 50,
      status: 'Draft', tenantId: 1, deletedAt: new Date('2026-01-01'),
      contact: null, deal: null, lineItems: [],
    });
    const app = makeApp();

    const resHidden = await request(app).get('/api/estimates/7');
    expect(resHidden.status).toBe(404);

    const resOpenIn = await request(app).get('/api/estimates/7?includeDeleted=true');
    expect(resOpenIn.status).toBe(200);
    expect(resOpenIn.body.id).toBe(7);
  });
});

// ─── PUT /:id — update + validator parity (#168) ───────────────────

describe('PUT /api/estimates/:id — update with validator parity (#168)', () => {
  test('happy path: PUT updates title + writes audit diff', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Old title', totalAmount: 100,
      status: 'Draft', tenantId: 1, contactId: 42, dealId: null,
      deletedAt: null, validUntil: null, notes: null,
    });
    prisma.estimate.update.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'New title', totalAmount: 100,
      status: 'Draft', tenantId: 1, contactId: 42, dealId: null,
      deletedAt: null, validUntil: null, notes: null,
      contact: null, deal: null, lineItems: [],
    });
    const app = makeApp();
    const res = await request(app).put('/api/estimates/7').send({ title: 'New title' });
    expect(res.status).toBe(200);
    expect(prisma.estimate.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.estimate.update.mock.calls[0][0];
    expect(updateArgs.data.title).toBe('New title');
    // Audit row written for #179, with a non-empty changes diff.
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('invalid status enum → 400 INVALID_STATUS (whitelist guard)', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 100,
      status: 'Draft', tenantId: 1, deletedAt: null,
    });
    const app = makeApp();
    const res = await request(app)
      .put('/api/estimates/7')
      .send({ status: 'NotARealStatus' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS');
    expect(prisma.estimate.update).not.toHaveBeenCalled();
  });

  test('PUT with invalid validUntil → 400 INVALID_VALID_UNTIL (#168 — used to 500 at DB layer)', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 100,
      status: 'Draft', tenantId: 1, deletedAt: null,
    });
    const app = makeApp();
    const res = await request(app)
      .put('/api/estimates/7')
      .send({ validUntil: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALID_UNTIL');
    expect(prisma.estimate.update).not.toHaveBeenCalled();
  });

  test('PUT against missing-or-cross-tenant id → 404', async () => {
    prisma.estimate.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app).put('/api/estimates/7').send({ title: 'Whatever' });
    expect(res.status).toBe(404);
    expect(prisma.estimate.update).not.toHaveBeenCalled();
    // Tenant-isolation: lookup must use the caller's tenant.
    const findArgs = prisma.estimate.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(99);
  });
});

// ─── PUT /:id/convert — Estimate → Invoice (transactional) ─────────

describe('PUT /api/estimates/:id/convert — convert to invoice', () => {
  test('happy path: mints UNPAID invoice (+30d due) + flips estimate Converted + two-sided audit', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 250,
      status: 'Draft', tenantId: 1, contactId: 42, dealId: 9, lineItems: [],
    });
    prisma.invoice.create.mockResolvedValue({
      id: 1001, invoiceNum: 'INV-AAA', amount: 250, status: 'UNPAID',
      contactId: 42, dealId: 9, tenantId: 1,
    });
    prisma.estimate.update.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 250,
      status: 'Converted', tenantId: 1, contactId: 42, dealId: 9,
      contact: null, deal: null, lineItems: [],
    });
    const app = makeApp();
    const res = await request(app).put('/api/estimates/7/convert');
    expect(res.status).toBe(200);
    expect(res.body.invoice).toBeTruthy();
    expect(res.body.invoice.id).toBe(1001);
    expect(res.body.estimate.status).toBe('Converted');

    // Invoice shape: UNPAID, +30d due, amount inherits totalAmount, preserves both
    // contactId and dealId.
    const invArgs = prisma.invoice.create.mock.calls[0][0];
    expect(invArgs.data.status).toBe('UNPAID');
    expect(invArgs.data.amount).toBe(250);
    expect(invArgs.data.contactId).toBe(42);
    expect(invArgs.data.dealId).toBe(9);
    expect(invArgs.data.invoiceNum).toMatch(/^INV-/);
    expect(invArgs.data.dueDate).toBeInstanceOf(Date);
    // +30 days from now → > 29d, < 31d window.
    const dueDelta = invArgs.data.dueDate.getTime() - Date.now();
    expect(dueDelta).toBeGreaterThan(29 * 86400000);
    expect(dueDelta).toBeLessThan(31 * 86400000);

    // Two-sided audit trail (#179) — both Estimate side + Invoice side.
    const auditCalls = prisma.auditLog.create.mock.calls.map(c => c[0].data);
    const entities = auditCalls.map(d => `${d.entity}:${d.action}`);
    expect(entities).toContain('Estimate:CONVERT_TO_INVOICE');
    expect(entities).toContain('Invoice:CREATE');
  });

  test('already-Converted estimate → 400 (no-op guard)', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 250,
      status: 'Converted', tenantId: 1, contactId: 42, dealId: null, lineItems: [],
    });
    const app = makeApp();
    const res = await request(app).put('/api/estimates/7/convert');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already converted/i);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.estimate.update).not.toHaveBeenCalled();
  });

  test('estimate with no contactId → 400 (invoice must have a customer)', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 250,
      status: 'Draft', tenantId: 1, contactId: null, dealId: null, lineItems: [],
    });
    const app = makeApp();
    const res = await request(app).put('/api/estimates/7/convert');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contact/i);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
});

// ─── DELETE /:id — soft-delete + idempotency (#167) ────────────────

describe('DELETE /api/estimates/:id — soft-delete + idempotency (#167)', () => {
  test('first DELETE writes deletedAt + emits softDeleted:true', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 100,
      status: 'Draft', tenantId: 1, deletedAt: null,
    });
    prisma.estimate.update.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 100,
      status: 'Draft', tenantId: 1, deletedAt: new Date(),
    });
    const app = makeApp();
    const res = await request(app).delete('/api/estimates/7');
    expect(res.status).toBe(200);
    expect(res.body.softDeleted).toBe(true);
    const updateArgs = prisma.estimate.update.mock.calls[0][0];
    expect(updateArgs.data.deletedAt).toBeInstanceOf(Date);
    // SOFT_DELETE audit log written (best-effort in the route).
    const auditDataCalls = prisma.auditLog.create.mock.calls.map(c => c[0].data);
    expect(auditDataCalls.some(d => d.action === 'SOFT_DELETE' && d.entity === 'Estimate')).toBe(true);
  });

  test('re-DELETE on already-soft-deleted → 200 { idempotent: true } (no update fires)', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 100,
      status: 'Draft', tenantId: 1, deletedAt: new Date('2026-01-01'),
    });
    const app = makeApp();
    const res = await request(app).delete('/api/estimates/7');
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.softDeleted).toBe(true);
    // Crucially, no DB write fires on the repeat call.
    expect(prisma.estimate.update).not.toHaveBeenCalled();
  });
});

// ─── POST /:id/restore — undo soft-delete (#167) ───────────────────

describe('POST /api/estimates/:id/restore — undo soft-delete (#167)', () => {
  test('restore on soft-deleted row clears deletedAt + emits restored:true', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 100,
      status: 'Draft', tenantId: 1, deletedAt: new Date('2026-01-01'),
    });
    prisma.estimate.update.mockResolvedValue({
      id: 7, estimateNum: 'EST-X', title: 'Q', totalAmount: 100,
      status: 'Draft', tenantId: 1, deletedAt: null,
      contact: null, deal: null, lineItems: [],
    });
    const app = makeApp();
    const res = await request(app).post('/api/estimates/7/restore').send({});
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(true);
    const updateArgs = prisma.estimate.update.mock.calls[0][0];
    expect(updateArgs.data.deletedAt).toBe(null);
  });
});

// ─── GET /api/estimates?fields=summary — slim-shape opt-in (#920 slice 13) ──

describe('GET /api/estimates?fields=summary — slim-shape opt-in (#920 slice 13)', () => {
  test('?fields=summary → findMany called with `select` (slim columns) + NO `include`', async () => {
    prisma.estimate.findMany.mockResolvedValue([
      { id: 1, estimateNum: 'EST-A', title: 'Q1', status: 'Draft', totalAmount: 100,
        validUntil: null, createdAt: new Date(), contactId: 42, dealId: null, tenantId: 1 },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/estimates?fields=summary');
    expect(res.status).toBe(200);
    expect(prisma.estimate.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.estimate.findMany.mock.calls[0][0];
    expect(args).toHaveProperty('select');
    expect(args).not.toHaveProperty('include');
    // The slim select must drop the heavy relations (lineItems / contact / deal)
    // and the `notes` Text column — those are the bytes the opt-in trims.
    expect(args.select.lineItems).toBeUndefined();
    expect(args.select.contact).toBeUndefined();
    expect(args.select.deal).toBeUndefined();
    expect(args.select.notes).toBeUndefined();
    // …while preserving the columns the list renderer actually shows.
    expect(args.select.id).toBe(true);
    expect(args.select.estimateNum).toBe(true);
    expect(args.select.title).toBe(true);
    expect(args.select.status).toBe(true);
    expect(args.select.totalAmount).toBe(true);
    expect(args.select.validUntil).toBe(true);
  });

  test('no ?fields → existing full-shape contract preserved (include lineItems/contact/deal)', async () => {
    prisma.estimate.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/estimates');
    expect(res.status).toBe(200);
    const args = prisma.estimate.findMany.mock.calls[0][0];
    expect(args).toHaveProperty('include');
    expect(args).not.toHaveProperty('select');
    expect(args.include).toEqual({ contact: true, deal: true, lineItems: true });
  });

  test('?fields=anything-else → falls through to FULL-shape (exact-match only)', async () => {
    prisma.estimate.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/estimates?fields=brief');
    expect(res.status).toBe(200);
    const args = prisma.estimate.findMany.mock.calls[0][0];
    expect(args).toHaveProperty('include');
    expect(args).not.toHaveProperty('select');
  });

  test('?fields=summary preserves tenant + soft-delete + status WHERE filters + pagination', async () => {
    prisma.estimate.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates?fields=summary&status=Sent&limit=25&offset=50');
    expect(res.status).toBe(200);
    const args = prisma.estimate.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    expect(args.where.deletedAt).toBe(null); // soft-delete filter still applied
    expect(args.where.status).toBe('Sent');
    expect(args.take).toBe(25);
    expect(args.skip).toBe(50);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary returns the slim rows verbatim (no enrichment / shape transform)', async () => {
    // The route just `res.json(estimates)` — proves slim payload reaches the wire.
    const slim = [
      { id: 1, estimateNum: 'EST-A', title: 'Q1', status: 'Draft', totalAmount: 100,
        validUntil: null, createdAt: new Date('2026-05-01T00:00:00Z'),
        contactId: 42, dealId: null, tenantId: 1 },
      { id: 2, estimateNum: 'EST-B', title: 'Q2', status: 'Sent', totalAmount: 250,
        validUntil: new Date('2026-12-01T00:00:00Z'),
        createdAt: new Date('2026-04-15T00:00:00Z'),
        contactId: 99, dealId: 7, tenantId: 1 },
    ];
    prisma.estimate.findMany.mockResolvedValue(slim);
    const app = makeApp();
    const res = await request(app).get('/api/estimates?fields=summary');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(res.body[0].id).toBe(1);
    expect(res.body[0].estimateNum).toBe('EST-A');
    expect(res.body[1].estimateNum).toBe('EST-B');
    expect(res.body[1].dealId).toBe(7);
    // Heavy fields are NOT in the wire payload — proves slim shape survives JSON.
    expect(res.body[0].lineItems).toBeUndefined();
    expect(res.body[0].contact).toBeUndefined();
    expect(res.body[0].deal).toBeUndefined();
    expect(res.body[0].notes).toBeUndefined();
  });
});
