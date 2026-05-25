// @ts-check
/**
 * Unit tests for backend/routes/v1_invoices.js — pin the contract of the
 * `/api/v1/invoices` stable public-API alias surface against accidental
 * regression. 247-LOC route had ZERO vitest coverage prior to this file.
 *
 * Why this file exists
 * ────────────────────
 * v1_invoices.js is the canonical `/api/v1/invoices` namespace per PRD Gap
 * §2 items 7a–d. It wraps the legacy `/api/billing` router via Express's
 * router-as-handler pattern (`router.use("/", billingRouter)`) for the
 * shared paths — GET / GET/:id / POST / PATCH /:id — and adds two new
 * route shapes:
 *   - POST /:id/payments  — new Payment-row create + auto-flip Invoice to
 *                           PAID when sum(SUCCESS payments) reaches the
 *                           grand-total ± PAYMENT_SUM_TOLERANCE (0.01).
 *   - POST /:id/complete  — rewritten alias for billing's /:id/mark-paid.
 *
 * Contract drift on either of these surfaces would either (a) silently
 * mis-flip invoice status under partial-pay reconciliation, or (b) break
 * SCIM/Zapier/external-API consumers that already pin the `/api/v1`
 * namespace per PRD §2. Pin the wire shape now.
 *
 * Endpoints under test
 * ────────────────────
 *   POST /:id/payments     — explicit, defined inline in v1_invoices.js
 *   POST /:id/complete     — alias, rewrites URL → billing.mark-paid
 *   (catch-all delegation through billingRouter is verified by the GET /
 *    + POST / cases below — confirms the `.use("/", billingRouter)` mount
 *    actually wires through and tenant-scoping survives the indirection.)
 *
 * Cases (15 total)
 * ────────────────
 *   POST /:id/payments validation (4):
 *     - 400 INVALID_ID when :id is not a positive integer
 *     - 400 INVALID_AMOUNT when amount is missing / NaN / 0 / negative
 *     - 400 METHOD_REQUIRED when method missing / non-string / whitespace
 *     - 404 when invoice belongs to a different tenant (findFirst null)
 *     - 409 INVOICE_VOIDED when invoice.status === 'VOIDED'
 *   POST /:id/payments happy paths (4):
 *     - 201 partial-pay does NOT flip status; payment.collected emitted
 *     - 201 sum-reaches-grand-total flips invoice.status to PAID + emits
 *       the invoice.paid + invoice.completed + payment.collected trio
 *       AND writes the v1_invoices.payments audit row
 *     - 201 currency defaults to USD; gateway defaults to method.lower()
 *     - 201 reference truncated to 128 chars (gatewayId field guard)
 *   POST /:id/complete alias (1):
 *     - delegates to billing router (mark-paid handler) — rewritten URL
 *   Catch-all delegation through billingRouter (3):
 *     - GET / lists tenant-scoped invoices (billing.GET /)
 *     - GET /:id returns tenant-scoped invoice (billing.GET /:id)
 *     - POST / 400 INVALID_AMOUNT (delegates billing's POST validation)
 *   Tenant-isolation pin (2):
 *     - payments insert uses req.user.tenantId on Payment.create
 *     - invoice lookup uses findFirst with both id AND tenantId
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/billing.test.js + sla.test.js. The route's
 * `const { verifyToken } = require('../middleware/auth')` destructures at
 * module-load, so we monkey-patch `authMw.verifyToken` to a pass-through
 * BEFORE requiring the v1_invoices router. The eventBus's `emitEvent` is
 * patched the same way so the route's three `require('../lib/eventBus')
 * .emitEvent(...)` calls under fullyPaid don't bleed to the real bus.
 *
 * Prisma is singleton-patched on `prisma.{invoice,payment,fieldPermission,
 * auditLog,automationRule}` since (a) the route calls invoice.findFirst +
 * payment.create + payment.aggregate + invoice.update; (b) writeAudit
 * (called on fullyPaid) walks auditLog.create + findFirst; (c) the
 * billingRouter delegation calls filterReadFields which reads
 * fieldPermission.findMany.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── auth middleware patching (BEFORE router require) ───────────────────
// v1_invoices.js does `const { verifyToken } = require("../middleware/auth")`
// and billing.js does the same for verifyToken + verifyRole. Both routes'
// destructured references capture whatever authMw.{verifyToken,verifyRole}
// points at THE MOMENT the modules are required. Pass-through both so
// req.user (injected by our makeApp middleware) flows through.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// ── eventBus patching (BEFORE router require) ──────────────────────────
// The route emits three events under fullyPaid (invoice.paid +
// invoice.completed + payment.collected) and one under partial-pay
// (payment.collected). Each is wrapped in try/catch — the route is
// best-effort — but stubbing keeps the test output clean.
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.invoice = prisma.invoice || {};
prisma.invoice.findFirst = vi.fn();
prisma.invoice.findMany = vi.fn();
prisma.invoice.update = vi.fn();
prisma.invoice.create = vi.fn();

prisma.payment = prisma.payment || {};
prisma.payment.create = vi.fn();
prisma.payment.aggregate = vi.fn();

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);

// filterReadFields (called by billing's GET / + GET /:id) walks
// fieldPermission.findMany. Default empty → no fields stripped.
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

// Import express + supertest + router AFTER all monkey-patching above.
const express = requireCJS('express');
const request = requireCJS('supertest');
const v1InvoicesRouter = requireCJS('../../routes/v1_invoices');

/**
 * Build an express app with a fake-auth middleware that populates req.user.
 * Default role = ADMIN so billing's verifyRole(["ADMIN","MANAGER"]) gates
 * pass on the delegated POST / surface.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/v1/invoices', v1InvoicesRouter);
  return app;
}

beforeEach(() => {
  prisma.invoice.findFirst.mockReset();
  prisma.invoice.findMany.mockReset();
  prisma.invoice.update.mockReset();
  prisma.invoice.create.mockReset();
  prisma.payment.create.mockReset();
  prisma.payment.aggregate.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.fieldPermission.findMany.mockReset().mockResolvedValue([]);
  eventBus.emitEvent.mockReset().mockResolvedValue(undefined);

  // Sensible defaults — individual tests override.
  prisma.invoice.findFirst.mockResolvedValue(null);
  prisma.invoice.findMany.mockResolvedValue([]);
  prisma.invoice.update.mockResolvedValue({ id: 1 });
  prisma.payment.create.mockResolvedValue({ id: 1 });
  prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /:id/payments — explicit endpoint (new per PRD §2 item 7c)
// ═══════════════════════════════════════════════════════════════════════

describe('POST /:id/payments — validation paths', () => {
  test('400 INVALID_ID when :id is not a positive integer', async () => {
    const res = await request(makeApp())
      .post('/api/v1/invoices/not-an-int/payments')
      .send({ method: 'card', amount: 100 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(res.body.error).toMatch(/invalid invoice id/i);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_AMOUNT when amount is 0 or negative', async () => {
    const zeroRes = await request(makeApp())
      .post('/api/v1/invoices/123/payments')
      .send({ method: 'card', amount: 0 });
    expect(zeroRes.status).toBe(400);
    expect(zeroRes.body.code).toBe('INVALID_AMOUNT');

    const negRes = await request(makeApp())
      .post('/api/v1/invoices/123/payments')
      .send({ method: 'card', amount: -50 });
    expect(negRes.status).toBe(400);
    expect(negRes.body.code).toBe('INVALID_AMOUNT');

    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('400 METHOD_REQUIRED when method missing or whitespace-only', async () => {
    const missingRes = await request(makeApp())
      .post('/api/v1/invoices/123/payments')
      .send({ amount: 100 });
    expect(missingRes.status).toBe(400);
    expect(missingRes.body.code).toBe('METHOD_REQUIRED');

    const wsRes = await request(makeApp())
      .post('/api/v1/invoices/123/payments')
      .send({ method: '   ', amount: 100 });
    expect(wsRes.status).toBe(400);
    expect(wsRes.body.code).toBe('METHOD_REQUIRED');

    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('404 when invoice belongs to a different tenant (findFirst null)', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 99 }))
      .post('/api/v1/invoices/777/payments')
      .send({ method: 'card', amount: 100 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    // Tenant-scoping pin: findFirst must include tenantId in the WHERE
    // clause so a cross-tenant id can't pierce the boundary.
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 99 },
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('409 INVOICE_VOIDED when target invoice is in VOIDED status', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, status: 'VOIDED', amount: 100,
    });

    const res = await request(makeApp())
      .post('/api/v1/invoices/50/payments')
      .send({ method: 'card', amount: 100 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_VOIDED');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});

describe('POST /:id/payments — happy paths', () => {
  test('201 partial-pay does NOT flip invoice status; emits payment.collected only', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, status: 'UNPAID', amount: 500, contactId: 7,
    });
    prisma.payment.create.mockResolvedValue({
      id: 1001, invoiceId: 50, amount: 100, gateway: 'card', status: 'SUCCESS',
    });
    // Sum-so-far is 100 of 500 → fullyPaid false.
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 100 } });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/v1/invoices/50/payments')
      .send({ method: 'card', amount: 100 });

    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ id: 1001 });
    expect(res.body.totalPaid).toBe(100);
    expect(res.body.fullyPaid).toBe(false);
    // Invoice MUST NOT be updated on partial pay.
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    // Only payment.collected should fire (no invoice.paid / .completed).
    const emittedEvents = eventBus.emitEvent.mock.calls.map((c) => c[0]);
    expect(emittedEvents).toEqual(['payment.collected']);
    // Audit MUST NOT be written for partial-pay.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('201 sum-reaches-grand-total flips status to PAID + emits trio + writes audit', async () => {
    const inv = {
      id: 50, tenantId: 1, status: 'UNPAID', amount: 500,
      contactId: 7, dealId: 99, invoiceNum: 'INV-1',
    };
    prisma.invoice.findFirst.mockResolvedValue(inv);
    prisma.payment.create.mockResolvedValue({
      id: 1002, invoiceId: 50, amount: 500, gateway: 'card', status: 'SUCCESS',
    });
    // Sum equals total → fullyPaid true.
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 500 } });
    prisma.invoice.update.mockResolvedValue({
      ...inv, status: 'PAID', paidAt: new Date(),
    });

    const res = await request(makeApp({ tenantId: 1, userId: 7 }))
      .post('/api/v1/invoices/50/payments')
      .send({ method: 'card', amount: 500, reference: 'txn-abc' });

    expect(res.status).toBe(201);
    expect(res.body.fullyPaid).toBe(true);
    expect(res.body.totalPaid).toBe(500);
    expect(res.body.invoice.status).toBe('PAID');
    // Status flip: invoice.update called with PAID + paidAt.
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.invoice.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 50 });
    expect(updateArg.data.status).toBe('PAID');
    expect(updateArg.data.paidAt).toBeInstanceOf(Date);
    // Event trio emitted (invoice.paid, invoice.completed, payment.collected).
    const emittedEvents = eventBus.emitEvent.mock.calls.map((c) => c[0]);
    expect(emittedEvents).toEqual([
      'invoice.paid',
      'invoice.completed',
      'payment.collected',
    ]);
    // Audit row written via writeAudit.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArg = prisma.auditLog.create.mock.calls[0][0].data;
    expect(auditArg.entity).toBe('Invoice');
    expect(auditArg.action).toBe('MARK_PAID');
  });

  test('201 currency defaults to USD when omitted; gateway defaults to lower-cased method', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, status: 'UNPAID', amount: 200,
    });
    prisma.payment.create.mockResolvedValue({ id: 1003 });
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 50 } });

    const res = await request(makeApp())
      .post('/api/v1/invoices/50/payments')
      .send({ method: 'CARD', amount: 50 });

    expect(res.status).toBe(201);
    const createArg = prisma.payment.create.mock.calls[0][0].data;
    expect(createArg.currency).toBe('USD');
    expect(createArg.gateway).toBe('card'); // method.toLowerCase()
    expect(createArg.status).toBe('SUCCESS');
    expect(createArg.gatewayId).toBeNull(); // reference omitted
  });

  test('201 reference truncated to 128 chars when over limit', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, status: 'UNPAID', amount: 200,
    });
    prisma.payment.create.mockResolvedValue({ id: 1004 });
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 50 } });

    const longRef = 'X'.repeat(300);
    const res = await request(makeApp())
      .post('/api/v1/invoices/50/payments')
      .send({ method: 'card', amount: 50, reference: longRef });

    expect(res.status).toBe(201);
    const createArg = prisma.payment.create.mock.calls[0][0].data;
    expect(createArg.gatewayId).toHaveLength(128);
    expect(createArg.gatewayId).toBe('X'.repeat(128));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /:id/complete — alias for billing's /:id/mark-paid (PRD §2 item 7d)
// ═══════════════════════════════════════════════════════════════════════

describe('POST /:id/complete — alias for mark-paid', () => {
  test('delegates to billing router; happy-path flips UNPAID → PAID', async () => {
    // billing.js's mark-paid: findFirst → update → emit trio. Same prisma
    // mocks used as above; we only need to ensure the URL-rewrite fires.
    prisma.invoice.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, status: 'UNPAID', amount: 500, invoiceNum: 'INV-1',
    });
    prisma.invoice.update.mockResolvedValue({
      id: 50, tenantId: 1, status: 'PAID', amount: 500, paidAt: new Date(),
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/v1/invoices/50/complete')
      .send({});

    // Billing's mark-paid responds 200 on flip.
    expect(res.status).toBe(200);
    // Confirms the URL was rewritten to /50/mark-paid AND found the
    // billing handler (would 404 otherwise via the catch-all).
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 50, tenantId: 1 }),
      })
    );
    expect(prisma.invoice.update).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Catch-all delegation through billingRouter — confirms `.use("/", billing)`
// actually wires through, tenant-scoping survives, and the explicit routes
// above run FIRST (Express first-match-wins ordering).
// ═══════════════════════════════════════════════════════════════════════

describe('catch-all delegation through billingRouter', () => {
  test('GET / lists tenant-scoped invoices (billing.GET / handler)', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: 1, tenantId: 42, amount: 100, status: 'UNPAID' },
      { id: 2, tenantId: 42, amount: 250, status: 'PAID' },
    ]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/v1/invoices');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Tenant-scoping pin survives the router-as-handler indirection.
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 42 },
      })
    );
  });

  test('GET /:id returns tenant-scoped invoice (billing.GET /:id handler)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, amount: 200, status: 'UNPAID',
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/v1/invoices/50');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 50, amount: 200 });
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 50, tenantId: 1 }),
      })
    );
  });

  test('POST / 400 INVALID_AMOUNT — billing POST validation reachable via v1 mount', async () => {
    const res = await request(makeApp({ tenantId: 1, role: 'ADMIN' }))
      .post('/api/v1/invoices')
      .send({ amount: 0, dueDate: '2027-01-01' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tenant-isolation pins — extracted as standalone cases for grep-ability
// when a future change touches Payment.create or invoice.findFirst.
// ═══════════════════════════════════════════════════════════════════════

describe('tenant-isolation pins', () => {
  test('payment.create writes tenantId from JWT (req.user.tenantId)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 50, tenantId: 88, status: 'UNPAID', amount: 100,
    });
    prisma.payment.create.mockResolvedValue({ id: 1 });
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 25 } });

    await request(makeApp({ tenantId: 88 }))
      .post('/api/v1/invoices/50/payments')
      .send({ method: 'card', amount: 25 });

    const createArg = prisma.payment.create.mock.calls[0][0].data;
    expect(createArg.tenantId).toBe(88);
    expect(createArg.invoiceId).toBe(50);
  });

  test('payment.aggregate scopes by both invoiceId AND tenantId for sum (cross-tenant sum poisoning guard)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 50, tenantId: 88, status: 'UNPAID', amount: 100,
    });
    prisma.payment.create.mockResolvedValue({ id: 1 });
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 50 } });

    await request(makeApp({ tenantId: 88 }))
      .post('/api/v1/invoices/50/payments')
      .send({ method: 'card', amount: 50 });

    // Aggregate scoping pin: if the route ever dropped tenantId from the
    // aggregate WHERE clause, a cross-tenant Payment row could falsely
    // flip an invoice's status to PAID. Pin both filters.
    const aggArg = prisma.payment.aggregate.mock.calls[0][0];
    expect(aggArg.where.invoiceId).toBe(50);
    expect(aggArg.where.tenantId).toBe(88);
    expect(aggArg.where.status).toBe('SUCCESS');
  });
});
