// @ts-check
/**
 * PRD Gap §13 wave-6a — pin the new analytics event emissions wired into:
 *
 *   - backend/routes/billing.js     (invoice.created, invoice.completed,
 *                                     invoice.voided, invoice.refunded,
 *                                     payment.collected)
 *   - backend/routes/wellness.js    (wallet.topup / wallet.spent,
 *                                     giftcard.issued / giftcard.redeemed,
 *                                     cashback.credited,
 *                                     membership.plan_created / .enrolled /
 *                                     .renewed / .benefit_applied /
 *                                     .expired / .cancelled)
 *   - backend/routes/attendance.js  (attendance.checked_in / .checked_out)
 *   - backend/routes/workflows.js   (TRIGGER_TYPES catalogue includes all
 *                                     of the above so workflow rule authors
 *                                     can build automations on them)
 *
 * Test strategy
 * ─────────────
 *   We monkey-patch `emitEvent` on the eventBus module's exports object via
 *   the SAME `require()` path the routes use. Each route handler invokes
 *   `require("../lib/eventBus").emitEvent(name, payload, tenantId, io)`,
 *   so replacing `eventBusCJS.emitEvent` with a `vi.fn()` shim lets us
 *   capture every call without spinning up the workflow rule fan-out
 *   (prisma.automationRule.findMany / executeAction / deliverWebhooks).
 *
 *   The CJS require here is load-bearing — the ESM `import` of the same
 *   module under vitest's module loader resolves to a transformed instance
 *   that's NOT the same object the route's `require()` returns. The
 *   existing eventBus.test.js works around this for prisma stubs by
 *   patching `prisma.<model>.<method>` (the prisma singleton IS the same
 *   instance because of vi.config inlining); we follow the same pattern
 *   here on the eventBus exports object.
 *
 * What's pinned per route
 * ───────────────────────
 *   1. The event name fires (call shows up in emitSpy.mock.calls).
 *   2. The payload includes the load-bearing fields workflow rule
 *      conditions need (invoiceId / amount / patientId / membershipId /
 *      etc.) — flat, no nested envelope, so evaluateCondition's dot-path
 *      lookup resolves them.
 *   3. tenantId is propagated as the 3rd argument so per-tenant
 *      automation rules don't cross-fire.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma singleton stubs ──────────────────────────────────────────────
// Patch every model + method the routes under test touch BEFORE require-time.

prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.webhook = prisma.webhook || {};
prisma.webhook.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ defaultCurrency: 'INR', locale: 'en-IN' });

prisma.invoice = prisma.invoice || {};
prisma.invoice.create = vi.fn();
prisma.invoice.findFirst = vi.fn();
prisma.invoice.update = vi.fn();
prisma.payment = prisma.payment || {};
prisma.payment.create = vi.fn();
prisma.payment.findFirst = vi.fn();
prisma.payment.update = vi.fn();

prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn();
prisma.wallet.create = vi.fn();
prisma.wallet.update = vi.fn();
prisma.walletTransaction = prisma.walletTransaction || {};
prisma.walletTransaction.create = vi.fn();
prisma.walletTransaction.findFirst = vi.fn();
prisma.walletTransaction.findMany = vi.fn().mockResolvedValue([]);
prisma.giftCard = prisma.giftCard || {};
prisma.giftCard.create = vi.fn();
prisma.giftCard.findFirst = vi.fn();
prisma.giftCard.update = vi.fn();
prisma.giftCard.findMany = vi.fn().mockResolvedValue([]);
prisma.giftCard.count = vi.fn().mockResolvedValue(0);
prisma.cashbackRule = prisma.cashbackRule || {};
prisma.cashbackRule.findMany = vi.fn().mockResolvedValue([]);
prisma.visit = prisma.visit || {};
prisma.visit.findFirst = vi.fn();
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.membership = prisma.membership || {};
prisma.membership.create = vi.fn();
prisma.membership.findFirst = vi.fn();
prisma.membership.update = vi.fn();
prisma.membership.count = vi.fn().mockResolvedValue(0);
prisma.membershipPlan = prisma.membershipPlan || {};
prisma.membershipPlan.create = vi.fn();
prisma.membershipPlan.findFirst = vi.fn();
prisma.membershipRedemption = prisma.membershipRedemption || {};
prisma.membershipRedemption.create = vi.fn();
prisma.$transaction = vi.fn();

prisma.attendance = prisma.attendance || {};
prisma.attendance.findUnique = vi.fn();
prisma.attendance.findMany = vi.fn().mockResolvedValue([]);
prisma.attendance.create = vi.fn();
prisma.attendance.update = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findFirst = vi.fn();
prisma.user.findUnique = vi.fn();

// ─── #929 Part B emissions (ticks #36/#37/#38) ──────────────────────────
// visa.status_changed — routes/travel_visa.js PATCH /applications/:id
// quote.sent           — routes/estimates.js POST /:id/email (Draft → Sent)
// itinerary.accepted   — routes/travel_itineraries.js POST /itineraries/:id/accept

prisma.visaApplication = prisma.visaApplication || {};
prisma.visaApplication.findFirst = vi.fn();
prisma.visaApplication.update = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.findUnique = vi.fn();
prisma.contact.findMany = vi.fn().mockResolvedValue([]);

prisma.estimate = prisma.estimate || {};
prisma.estimate.findFirst = vi.fn();
prisma.estimate.update = vi.fn();
prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.create = vi.fn();
prisma.activity = prisma.activity || {};
prisma.activity.create = vi.fn();

prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findFirst = vi.fn();
prisma.itinerary.findUnique = vi.fn();
prisma.itinerary.update = vi.fn();
prisma.itineraryItem = prisma.itineraryItem || {};
prisma.itineraryItem.findMany = vi.fn().mockResolvedValue([]);
prisma.webCheckin = prisma.webCheckin || {};
prisma.webCheckin.create = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch auth + fieldFilter + audit middleware to no-ops BEFORE requiring routes.
const authPath = requireCJS.resolve('../../middleware/auth');
requireCJS.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    verifyToken: (req, _res, next) => next(),
    verifyRole: () => (_req, _res, next) => next(),
  },
};
const ffPath = requireCJS.resolve('../../middleware/fieldFilter');
requireCJS.cache[ffPath] = {
  id: ffPath, filename: ffPath, loaded: true,
  exports: {
    filterReadFields: async (data) => data,
    filterWriteFields: async (body) => body,
  },
};
const auditPath = requireCJS.resolve('../../lib/audit');
requireCJS.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true,
  exports: {
    writeAudit: vi.fn().mockResolvedValue({}),
    diffFields: () => ({}),
  },
};

// Resolve the eventBus module via the SAME path the routes use. Monkey-patching
// `.emitEvent` on this exports object replaces what the route handler invokes.
const eventBusCJS = requireCJS('../../lib/eventBus');

const wellnessRouter = requireCJS('../../routes/wellness');
const billingRouter = requireCJS('../../routes/billing');
const attendanceRouter = requireCJS('../../routes/attendance');
const travelVisaRouter = requireCJS('../../routes/travel_visa');
const estimatesRouter = requireCJS('../../routes/estimates');
const travelItinerariesRouter = requireCJS('../../routes/travel_itineraries');

function makeApp(routerPath, mountPath, opts = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      userId: opts.userId || 7,
      tenantId: opts.tenantId || 1,
      role: opts.role || 'ADMIN',
      wellnessRole: opts.wellnessRole || 'admin',
      vertical: opts.vertical || 'wellness',
    };
    req.io = null;
    next();
  });
  app.use(mountPath, routerPath);
  return app;
}

// Helper: install a vi.fn() on eventBus.emitEvent for the duration of one
// test, then restore. Callers receive the spy to assert on.
function withEmitSpy(fn) {
  const original = eventBusCJS.emitEvent;
  const emitSpy = vi.fn(); // No-op default — don't call into the original
                           // (which would touch prisma.automationRule).
  eventBusCJS.emitEvent = emitSpy;
  return Promise.resolve(fn(emitSpy)).finally(() => {
    eventBusCJS.emitEvent = original;
  });
}

function findCall(spy, eventName) {
  return spy.mock.calls.find((c) => c[0] === eventName);
}

beforeEach(() => {
  prisma.invoice.create.mockReset();
  prisma.invoice.findFirst.mockReset();
  prisma.invoice.update.mockReset();
  prisma.payment.create.mockReset();
  prisma.payment.findFirst.mockReset();
  prisma.payment.update.mockReset();
  prisma.wallet.findFirst.mockReset();
  prisma.wallet.create.mockReset();
  prisma.wallet.update.mockReset();
  prisma.walletTransaction.create.mockReset();
  prisma.walletTransaction.findFirst.mockReset();
  prisma.giftCard.create.mockReset();
  prisma.giftCard.findFirst.mockReset();
  prisma.giftCard.update.mockReset();
  prisma.visit.findFirst.mockReset();
  prisma.patient.findFirst.mockReset();
  prisma.membership.create.mockReset();
  prisma.membership.findFirst.mockReset();
  prisma.membership.update.mockReset();
  prisma.membership.count.mockReset().mockResolvedValue(0);
  prisma.membershipPlan.create.mockReset();
  prisma.membershipPlan.findFirst.mockReset();
  prisma.membershipRedemption.create.mockReset();
  prisma.$transaction.mockReset();
  prisma.attendance.findUnique.mockReset();
  prisma.attendance.create.mockReset();
  prisma.attendance.update.mockReset();
  prisma.user.findFirst.mockReset();
  prisma.user.findUnique.mockReset();
  // #929 Part B stubs
  prisma.visaApplication.findFirst.mockReset();
  prisma.visaApplication.update.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.estimate.findFirst.mockReset();
  prisma.estimate.update.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.activity.create.mockReset();
  prisma.itinerary.findFirst.mockReset();
  prisma.itinerary.findUnique.mockReset();
  prisma.itinerary.update.mockReset();
  prisma.itineraryItem.findMany.mockReset().mockResolvedValue([]);
  prisma.webCheckin.create.mockReset();
  // Restore default tenant.findUnique behaviour each test (some #929 cases
  // override with mockResolvedValueOnce to swap vertical='travel' in).
  prisma.tenant.findUnique
    .mockReset()
    .mockResolvedValue({ defaultCurrency: 'INR', locale: 'en-IN' });
});

// ─── billing.js — invoice.created ───────────────────────────────────────

describe('billing.js — invoice.created event', () => {
  test('POST /api/billing fires invoice.created with flat payload', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    prisma.invoice.create.mockResolvedValue({
      id: 101, invoiceNum: 'INV-ABCDEF', amount: 500, contactId: 5,
      dealId: null, dueDate: new Date(tomorrow), status: 'UNPAID',
    });
    const app = makeApp(billingRouter, '/api/billing');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app).post('/api/billing').send({ amount: 500, dueDate: tomorrow, contactId: 5 });
      expect(res.status).toBe(201);
      const call = findCall(emitSpy, 'invoice.created');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({ invoiceId: 101, amount: 500, contactId: 5, status: 'UNPAID' });
      expect(call[2]).toBe(1);
    });
  });
});

// ─── billing.js — invoice.completed + payment.collected on mark-paid ────

describe('billing.js — invoice.completed + payment.collected on POST /:id/mark-paid', () => {
  test('mark-paid emits invoice.completed AND payment.collected', async () => {
    const paidAt = new Date();
    prisma.invoice.findFirst.mockResolvedValue({ id: 5, status: 'UNPAID', amount: 500, contact: { name: 'X' } });
    prisma.invoice.update.mockResolvedValue({ id: 5, status: 'PAID', amount: 500, paidAt, invoiceNum: 'INV-x', contactId: 9, dealId: null });
    prisma.payment.create.mockResolvedValue({ id: 50, currency: 'INR' });
    const app = makeApp(billingRouter, '/api/billing');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app).post('/api/billing/5/mark-paid').send({ paymentMethod: 'cash' });
      expect(res.status).toBe(200);
      const completed = findCall(emitSpy, 'invoice.completed');
      const collected = findCall(emitSpy, 'payment.collected');
      expect(completed).toBeTruthy();
      expect(completed[1]).toMatchObject({ invoiceId: 5, status: 'PAID' });
      expect(collected).toBeTruthy();
      expect(collected[1]).toMatchObject({ invoiceId: 5, method: 'cash', amount: 500 });
    });
  });
});

// ─── billing.js — invoice.voided + invoice.refunded ─────────────────────

describe('billing.js — invoice.voided + invoice.refunded events', () => {
  test('POST /:id/void emits invoice.voided', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 7, status: 'UNPAID' });
    prisma.invoice.update.mockResolvedValue({ id: 7, status: 'VOIDED', invoiceNum: 'INV-x', amount: 200, contactId: 9, dealId: null });
    const app = makeApp(billingRouter, '/api/billing');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app).post('/api/billing/7/void').send({ reason: 'duplicate' });
      expect(res.status).toBe(200);
      const call = findCall(emitSpy, 'invoice.voided');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({ invoiceId: 7, status: 'VOIDED', reason: 'duplicate' });
    });
  });

  test('POST /:id/refund emits invoice.refunded', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 9, status: 'PAID' });
    prisma.invoice.update.mockResolvedValue({ id: 9, status: 'REFUNDED', invoiceNum: 'INV-x', amount: 750, contactId: 11, dealId: null });
    const app = makeApp(billingRouter, '/api/billing');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app).post('/api/billing/9/refund').send({ reason: 'wrong-card' });
      expect(res.status).toBe(200);
      const call = findCall(emitSpy, 'invoice.refunded');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({ invoiceId: 9, status: 'REFUNDED', reason: 'wrong-card' });
    });
  });
});

// ─── wellness.js — wallet.topup + wallet.spent ──────────────────────────

describe('wellness.js — wallet.topup + wallet.spent events', () => {
  test('POST /api/wellness/wallet/:id/credit emits wallet.topup', async () => {
    prisma.wallet.findFirst.mockResolvedValue({ id: 22, tenantId: 1, patientId: 33, balance: 0 });
    prisma.$transaction.mockImplementation(async (cb) => {
      const fakeTx = {
        wallet: {
          findFirst: vi.fn().mockResolvedValue({ id: 22, tenantId: 1, balance: 0 }),
          update: vi.fn().mockResolvedValue({}),
        },
        walletTransaction: {
          create: vi.fn().mockResolvedValue({ id: 401, type: 'CREDIT_REFUND', balanceAfter: 100 }),
        },
      };
      return cb(fakeTx);
    });
    const app = makeApp(wellnessRouter, '/api/wellness');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app).post('/api/wellness/wallet/22/credit').send({ amount: 100, reason: 'Refund' });
      expect(res.status).toBe(201);
      const call = findCall(emitSpy, 'wallet.topup');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({ walletId: 22, amount: 100, balanceAfter: 100 });
    });
  });

  test('POST /api/wellness/wallet/:id/debit emits wallet.spent', async () => {
    prisma.wallet.findFirst.mockResolvedValue({ id: 22, tenantId: 1, patientId: 33, balance: 200 });
    prisma.$transaction.mockImplementation(async (cb) => {
      const fakeTx = {
        wallet: {
          findFirst: vi.fn().mockResolvedValue({ id: 22, tenantId: 1, balance: 200 }),
          update: vi.fn().mockResolvedValue({}),
        },
        walletTransaction: {
          create: vi.fn().mockResolvedValue({ id: 402, type: 'DEBIT_REVERSAL', balanceAfter: 150 }),
        },
      };
      return cb(fakeTx);
    });
    const app = makeApp(wellnessRouter, '/api/wellness');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app).post('/api/wellness/wallet/22/debit').send({ amount: 50, reason: 'reversal' });
      expect(res.status).toBe(201);
      const call = findCall(emitSpy, 'wallet.spent');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({ walletId: 22, amount: 50, balanceAfter: 150 });
    });
  });
});

// ─── attendance.js — attendance.checked_in + attendance.checked_out ─────

describe('attendance.js — clock-in / clock-out events', () => {
  test('POST /api/attendance/clock-in emits attendance.checked_in', async () => {
    prisma.attendance.findUnique.mockResolvedValue(null);
    prisma.attendance.create.mockResolvedValue({
      id: 88, userId: 7, tenantId: 1, date: new Date(), clockInAt: new Date(),
      clockInLocationId: null, source: 'MANUAL',
    });
    const app = makeApp(attendanceRouter, '/api/attendance');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app).post('/api/attendance/clock-in').send({});
      expect(res.status).toBe(201);
      const call = findCall(emitSpy, 'attendance.checked_in');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({ attendanceId: 88, userId: 7, source: 'MANUAL' });
      expect(call[2]).toBe(1);
    });
  });

  test('POST /api/attendance/clock-out emits attendance.checked_out', async () => {
    const inAt = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h ago → PRESENT
    prisma.attendance.findUnique.mockResolvedValue({
      id: 88, userId: 7, tenantId: 1, date: new Date(), clockInAt: inAt, clockOutAt: null,
    });
    prisma.attendance.update.mockResolvedValue({
      id: 88, userId: 7, tenantId: 1, date: new Date(), clockInAt: inAt,
      clockOutAt: new Date(), totalMinutes: 360, status: 'PRESENT',
      clockOutLocationId: null,
    });
    const app = makeApp(attendanceRouter, '/api/attendance');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app).post('/api/attendance/clock-out').send({});
      expect(res.status).toBe(200);
      const call = findCall(emitSpy, 'attendance.checked_out');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({ attendanceId: 88, userId: 7, totalMinutes: 360, status: 'PRESENT' });
    });
  });
});

// ─── workflows.js TRIGGER_TYPES — every new event is in the catalogue ───

describe('workflows.js — TRIGGER_TYPES catalogue includes every wave-6a event', () => {
  test('all wave-6a event names are exposed via the trigger catalogue', async () => {
    const wfRouter = requireCJS('../../routes/workflows');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { userId: 1, tenantId: 1, role: 'ADMIN' }; next(); });
    app.use('/api/workflows', wfRouter);
    const res = await request(app).get('/api/workflows/triggers');
    expect(res.status).toBe(200);
    const values = res.body.map((t) => t.value);
    const expected = [
      'invoice.created', 'invoice.completed', 'invoice.voided', 'invoice.refunded',
      'payment.collected',
      'wallet.topup', 'wallet.spent',
      'cashback.credited',
      'giftcard.issued', 'giftcard.redeemed',
      'membership.plan_created', 'membership.enrolled', 'membership.renewed',
      'membership.benefit_applied', 'membership.expired', 'membership.cancelled',
      'attendance.checked_in', 'attendance.checked_out',
    ];
    for (const e of expected) {
      expect(values).toContain(e);
    }
  });
});

// ─── #929 Part B — travel_visa.js — visa.status_changed ─────────────────

describe('travel_visa.js — visa.status_changed event (#929 tick #36)', () => {
  test('PATCH /api/travel/visa/applications/:id with status change emits visa.status_changed', async () => {
    // requireTravelTenant → prisma.tenant.findUnique must return vertical='travel'.
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 1, vertical: 'travel', name: 'TravelCo', slug: 'travelco',
    });
    // Existing visa application, currently in 'intake' state.
    prisma.visaApplication.findFirst.mockResolvedValueOnce({
      id: 501, contactId: 91, status: 'intake',
    });
    // Sub-brand guard: contact loaded + must be subBrand=visasure.
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 91, subBrand: 'visasure' });
    // The actual write.
    prisma.visaApplication.update.mockResolvedValueOnce({
      id: 501, status: 'docs-pending',
    });
    const app = makeApp(travelVisaRouter, '/api/travel/visa');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app)
        .patch('/api/travel/visa/applications/501')
        .send({ status: 'docs-pending' });
      expect(res.status).toBe(200);
      const call = findCall(emitSpy, 'visa.status_changed');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({
        id: 501,
        contactId: 91,
        subBrand: 'visasure',
        oldStatus: 'intake',
        newStatus: 'docs-pending',
        tenantId: 1,
      });
      expect(call[1].changedAt).toBeDefined();
      // 3rd positional arg = tenantId for per-tenant rule fan-out.
      expect(call[2]).toBe(1);
    });
  });

  test('PATCH without status change does NOT emit visa.status_changed', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 1, vertical: 'travel', name: 'TravelCo', slug: 'travelco',
    });
    // Same status — body only updates applicationType.
    prisma.visaApplication.findFirst.mockResolvedValueOnce({
      id: 502, contactId: 92, status: 'intake',
    });
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 92, subBrand: 'visasure' });
    prisma.visaApplication.update.mockResolvedValueOnce({
      id: 502, applicationType: 'business',
    });
    const app = makeApp(travelVisaRouter, '/api/travel/visa');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app)
        .patch('/api/travel/visa/applications/502')
        .send({ applicationType: 'business' });
      expect(res.status).toBe(200);
      const call = findCall(emitSpy, 'visa.status_changed');
      expect(call).toBeUndefined();
    });
  });
});

// ─── #929 Part B — estimates.js — quote.sent ────────────────────────────

describe('estimates.js — quote.sent event (#929 tick #37)', () => {
  test('POST /api/estimates/:id/email on Draft estimate emits quote.sent', async () => {
    // Estimate in Draft → expect Draft → Sent flip + quote.sent emission.
    prisma.estimate.findFirst.mockResolvedValueOnce({
      id: 701,
      tenantId: 1,
      estimateNum: 'EST-DRAFT-01',
      title: 'Quarterly retainer',
      status: 'Draft',
      totalAmount: 5000,
      validUntil: null,
      contactId: 33,
      contact: { id: 33, name: 'Asha Patel', email: 'asha@example.com' },
      lineItems: [],
    });
    prisma.emailMessage.create.mockResolvedValueOnce({ id: 9001 });
    prisma.activity.create.mockResolvedValueOnce({ id: 9002 });
    prisma.estimate.update.mockResolvedValueOnce({ id: 701, status: 'Sent' });
    const app = makeApp(estimatesRouter, '/api/estimates');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app)
        .post('/api/estimates/701/email')
        .send({});
      expect(res.status).toBe(200);
      const call = findCall(emitSpy, 'quote.sent');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({
        id: 701,
        estimateNumber: 'EST-DRAFT-01',
        contactId: 33,
        to: 'asha@example.com',
        totalAmount: 5000,
      });
      expect(call[1].sentAt).toBeDefined();
      expect(call[2]).toBe(1);
    });
  });

  test('POST /api/estimates/:id/email on already-Sent estimate does NOT emit (re-send guard)', async () => {
    // Already Sent → no Draft → Sent flip → no emission.
    prisma.estimate.findFirst.mockResolvedValueOnce({
      id: 702,
      tenantId: 1,
      estimateNum: 'EST-SENT-02',
      title: 'Already sent',
      status: 'Sent',
      totalAmount: 3000,
      validUntil: null,
      contactId: 34,
      contact: { id: 34, name: 'Vikram Rao', email: 'vikram@example.com' },
      lineItems: [],
    });
    prisma.emailMessage.create.mockResolvedValueOnce({ id: 9003 });
    prisma.activity.create.mockResolvedValueOnce({ id: 9004 });
    const app = makeApp(estimatesRouter, '/api/estimates');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app)
        .post('/api/estimates/702/email')
        .send({});
      expect(res.status).toBe(200);
      const call = findCall(emitSpy, 'quote.sent');
      expect(call).toBeUndefined();
    });
  });
});

// ─── #929 Part B — travel_itineraries.js — itinerary.accepted ───────────

describe('travel_itineraries.js — itinerary.accepted event (#929 tick #38)', () => {
  test('POST /api/travel/itineraries/:id/accept emits itinerary.accepted with payload', async () => {
    // Tenant guard.
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 1, vertical: 'travel', name: 'TravelCo', slug: 'travelco',
    });
    // loadItineraryWithGuard: itinerary lookup + sub-brand access set.
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 801, subBrand: 'tmc' });
    // ADMIN role → getSubBrandAccessSet returns null (full access).
    prisma.user.findUnique.mockResolvedValueOnce({ role: 'ADMIN', subBrandAccess: null });
    // Second itinerary lookup for status check inside /accept.
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 801, status: 'sent' });
    // The accept-write.
    prisma.itinerary.update.mockResolvedValueOnce({
      id: 801,
      status: 'accepted',
      contactId: 55,
      tripId: null,
      subBrand: 'tmc',
      totalAmount: 12500,
      currency: 'INR',
    });
    // autoCreateWebCheckinsForItinerary: no flight items → no fan-out.
    // (prisma.itineraryItem.findMany already returns [] from beforeEach.)
    const app = makeApp(travelItinerariesRouter, '/api/travel');
    await withEmitSpy(async (emitSpy) => {
      const res = await request(app)
        .post('/api/travel/itineraries/801/accept')
        .send({});
      expect(res.status).toBe(200);
      const call = findCall(emitSpy, 'itinerary.accepted');
      expect(call).toBeTruthy();
      expect(call[1]).toMatchObject({
        id: 801,
        contactId: 55,
        subBrand: 'tmc',
        totalAmount: 12500,
        currency: 'INR',
        tenantId: 1,
      });
      expect(call[1].acceptedAt).toBeDefined();
      expect(call[2]).toBe(1);
    });
  });
});
