// @ts-check
/**
 * Unit tests for backend/routes/signatures.js — pin the contract of the
 * e-signature request management surface (CRUD + sign/decline transitions
 * + reminder resend + tenant isolation).
 *
 * Why this file exists
 * ────────────────────
 * routes/signatures.js (312 LOC) had ZERO vitest coverage prior to this
 * file. It owns the SignatureRequest CRUD + the two PUBLIC token-protected
 * signer endpoints (`/sign/:token` GET + POST, `/decline/:token` POST)
 * that bypass the global auth guard. Silent contract drift would either
 * red the e-sign UX (signers click their email link and hit a 500) or —
 * worse — leak signature state across tenants if the `findFirst` scoping
 * gets refactored away. Pin the wire shape now.
 *
 * Endpoints under test
 * ────────────────────
 *   PUBLIC (token-only, no JWT):
 *     1. GET    /sign/:token         — fetch document details for signer
 *     2. POST   /sign/:token         — submit signature (PENDING → SIGNED)
 *     3. POST   /decline/:token      — decline (PENDING → DECLINED)
 *
 *   AUTHENTICATED (tenant-scoped via req.user.tenantId):
 *     4. GET    /                    — list (with status/documentType filters)
 *     5. POST   /                    — create + email signing link
 *     6. GET    /:id                 — single request (tenant scoped)
 *     7. DELETE /:id                 — cancel/delete request
 *     8. POST   /:id/resend          — resend signing email reminder
 *
 * Cases (16 total)
 * ────────────────
 *   GET /sign/:token       — 404 invalid token; 410 EXPIRED (auto-flip);
 *                            200 returns signer-safe envelope (3)
 *   POST /sign/:token      — 400 missing/invalid signature data URL;
 *                            409 already-SIGNED request; happy 200 (3)
 *   POST /decline/:token   — 404 invalid token; happy 200 (2)
 *   GET /                  — tenant-scoped findMany + status filter (1)
 *   POST /                 — 400 missing fields; 400 invalid documentType;
 *                            happy 201 with default 7-day expiry (3)
 *   GET /:id               — 400 invalid id; 404 cross-tenant (2)
 *   DELETE /:id            — 404 cross-tenant; happy 200 (1)
 *   POST /:id/resend       — 409 when request is already SIGNED (1)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js — Prisma singleton patched
 * BEFORE the router is required so the `require('../lib/prisma')` inside
 * the route captures our vi.fn()'d model methods. A fake-auth middleware
 * populates req.user with the desired { userId, tenantId, role } before
 * the router executes; the global auth guard isn't installed in the test
 * harness so the PUBLIC /sign and /decline routes work the same way (they
 * just ignore req.user).
 *
 * `globalThis.fetch` is stubbed at module load with a 503-returning mock —
 * the route's sendSignatureEmail() helper sees a non-ok response and reports
 * `sent: false`. (Even if SENDGRID_API_KEY is set via the repo-root `.env`,
 * the stubbed fetch never hits api.sendgrid.com; if it's unset the helper
 * short-circuits to `sent: false` before fetching. Either way emailDelivered
 * is false in tests.)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.signatureRequest = prisma.signatureRequest || {};
prisma.signatureRequest.findUnique = vi.fn();
prisma.signatureRequest.findFirst = vi.fn();
prisma.signatureRequest.findMany = vi.fn();
prisma.signatureRequest.create = vi.fn();
prisma.signatureRequest.update = vi.fn();
prisma.signatureRequest.delete = vi.fn();

// Document-lookup paths used by the optional Activity-log side-effect in
// POST /sign/:token. Stub so the side-effect doesn't blow up when the
// happy-path test fires — the side-effect itself is best-effort and the
// route swallows its errors, so coverage is bonus, not contract.
prisma.contract = prisma.contract || {};
prisma.contract.findFirst = vi.fn().mockResolvedValue(null);
prisma.estimate = prisma.estimate || {};
prisma.estimate.findFirst = vi.fn().mockResolvedValue(null);
prisma.quote = prisma.quote || {};
prisma.quote.findFirst = vi.fn().mockResolvedValue(null);
prisma.activity = prisma.activity || {};
prisma.activity.create = vi.fn().mockResolvedValue({ id: 1 });

// Tenant lookup — signature emails brand the body with the tenant's name
// (falling back to "Globussoft CRM"). Stub so fetchCompanyName resolves.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ name: 'Enhanced Wellness' });

// Post-sign flow (auto-convert Estimate → Invoice + payment link + notify
// owners). These are best-effort side-effects wrapped in try/catch, but stub
// them so the unit tests stay deterministic + never touch a real DB. Default:
// no recipients (so notify() is a no-op) — the Estimate-sign test overrides.
prisma.estimate.update = vi.fn().mockResolvedValue({ id: 1, status: 'Converted' });
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn().mockResolvedValue([]);
prisma.tenantSetting = prisma.tenantSetting || {};
prisma.tenantSetting.findFirst = vi.fn().mockResolvedValue(null); // gateway pref → 'auto'
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
prisma.invoice = prisma.invoice || {};
prisma.invoice.create = vi.fn();
prisma.invoice.findFirst = vi.fn().mockResolvedValue(null);
prisma.payment = prisma.payment || {};
prisma.payment.create = vi.fn().mockResolvedValue({ id: 1 });
// $transaction proxy: invoke the callback with a tx that resolves invoice
// creation + estimate status flip. Individual tests override the resolved
// invoice via prisma.__txInvoice.
prisma.__txInvoice = { id: 900, invoiceNum: 'INV-TEST01', amount: 4950 };
prisma.$transaction = vi.fn(async (cb) => cb({
  invoice: { create: vi.fn(async () => prisma.__txInvoice) },
  estimate: { update: vi.fn(async () => ({ id: 5, status: 'Converted' })) },
}));
// notificationService.notify internals (shared prisma singleton).
prisma.notification = prisma.notification || {};
prisma.notification.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.notification.findFirst = vi.fn().mockResolvedValue(null);
prisma.notificationPreference = prisma.notificationPreference || {};
prisma.notificationPreference.findUnique = vi.fn().mockResolvedValue(null);

// SAFETY: the route's dotenv.config({override:true}) (run above when the
// router was required) repopulated the LIVE Stripe + Razorpay keys from .env.
// Strip them so lib/paymentLink never makes a real gateway call during tests —
// resolveGateway() then returns null and createInvoicePaymentLink short-circuits
// to { error: NO_GATEWAY } with zero network I/O. The payment-link generation
// itself is covered in test/lib/paymentLink.test.js with mocked SDKs.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

// SendGrid guard — the route does `require('dotenv').config({ override: true })`
// at module load time, reading the repo-root `.env` which may carry a real
// SENDGRID_API_KEY on this dev box (and on demo). The helper reads the key at
// call-time, but we don't want a live POST to api.sendgrid.com regardless.
// Solution: stub `globalThis.fetch` so the route's in-flight POST never hits
// the network; the route's try/catch sees a non-ok-status fetch response and
// reports `sent: false` — exactly the wire shape we want to pin for tests.
// (And when SENDGRID_API_KEY is unset, the helper short-circuits to
// `sent: false` before fetching anyway.)
globalThis.fetch = vi.fn(async () => ({
  ok: false,
  status: 503,
  headers: { get: () => null },
  text: async () => 'test-stub: sendgrid not called from unit tests',
}));

import express from 'express';
import request from 'supertest';

const signaturesRouter = requireCJS('../../routes/signatures');

/**
 * Build an express app with a fake-auth middleware so the authenticated
 * routes see req.user populated. PUBLIC routes (/sign, /decline) ignore
 * req.user — they're keyed on the URL token only.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/signatures', signaturesRouter);
  return app;
}

beforeEach(() => {
  prisma.signatureRequest.findUnique.mockReset();
  prisma.signatureRequest.findFirst.mockReset();
  prisma.signatureRequest.findMany.mockReset();
  prisma.signatureRequest.create.mockReset();
  prisma.signatureRequest.update.mockReset();
  prisma.signatureRequest.delete.mockReset();

  // Defaults — individual tests override.
  prisma.signatureRequest.findUnique.mockResolvedValue(null);
  prisma.signatureRequest.findFirst.mockResolvedValue(null);
  prisma.signatureRequest.findMany.mockResolvedValue([]);
  prisma.signatureRequest.create.mockResolvedValue({ id: 1 });
  prisma.signatureRequest.update.mockResolvedValue({ id: 1 });
  prisma.signatureRequest.delete.mockResolvedValue({ id: 1 });

  // Post-sign side-effect mocks accumulate calls across tests — reset so
  // per-test assertions (e.g. "$transaction NOT called") stay isolated.
  prisma.estimate.findFirst.mockReset().mockResolvedValue(null);
  prisma.estimate.update.mockReset().mockResolvedValue({ id: 1, status: 'Converted' });
  prisma.user.findMany.mockReset().mockResolvedValue([]);
  prisma.notification.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.notification.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenantSetting.findFirst.mockReset().mockResolvedValue(null);
  prisma.invoice.create.mockReset();
  prisma.payment.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.__txInvoice = { id: 900, invoiceNum: 'INV-TEST01', amount: 4950 };
  prisma.$transaction.mockReset().mockImplementation(async (cb) => cb({
    invoice: { create: vi.fn(async () => prisma.__txInvoice) },
    estimate: { update: vi.fn(async () => ({ id: 5, status: 'Converted' })) },
  }));
});

// ─────────────────────────────────────────────────────────────────────────
// GET /sign/:token — PUBLIC signer envelope (no JWT)
// ─────────────────────────────────────────────────────────────────────────

describe('GET /sign/:token — public signer-facing envelope', () => {
  test('404 when the token does not match any signature request', async () => {
    prisma.signatureRequest.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/signatures/sign/bogus-token-aaa');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/invalid|expired/i);
    expect(prisma.signatureRequest.findUnique).toHaveBeenCalledWith({
      where: { signToken: 'bogus-token-aaa' },
    });
  });

  test('410 + auto-flips status PENDING → EXPIRED when expiresAt is in the past', async () => {
    const pastExpiry = new Date(Date.now() - 60 * 1000); // 1 min ago
    prisma.signatureRequest.findUnique.mockResolvedValue({
      id: 42,
      signToken: 'tok-exp-1',
      status: 'PENDING',
      expiresAt: pastExpiry,
      documentType: 'Contract',
      signerName: 'Asha Patel',
    });

    const res = await request(makeApp()).get('/api/signatures/sign/tok-exp-1');

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
    // The route updates the row to EXPIRED status on expiry — pin the call.
    expect(prisma.signatureRequest.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { status: 'EXPIRED' },
    });
  });

  test('200 returns the signer-safe envelope (no signature payload, no tenantId)', async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    prisma.signatureRequest.findUnique.mockResolvedValue({
      id: 42,
      signToken: 'tok-good',
      status: 'PENDING',
      expiresAt: futureExpiry,
      signedAt: null,
      documentType: 'Contract',
      signerName: 'Asha Patel',
      documentId: 1234,
      // Sensitive fields the envelope MUST NOT leak:
      tenantId: 9,
      signature: 'data:image/png;base64,xxx',
      signerEmail: 'asha@example.com',
    });

    const res = await request(makeApp()).get('/api/signatures/sign/tok-good');

    expect(res.status).toBe(200);
    // documentId + companyName are surfaced to the signer (the token-holder)
    // so the signing page can show "Contract #1234" branded with the sender.
    expect(res.body).toEqual({
      documentType: 'Contract',
      documentId: 1234,
      signerName: 'Asha Patel',
      companyName: 'Enhanced Wellness',
      status: 'PENDING',
      expiresAt: futureExpiry.toISOString(),
      signedAt: null,
    });
    // Pin the negative — these MUST NOT appear in the public envelope.
    expect(res.body.tenantId).toBeUndefined();
    expect(res.body.signature).toBeUndefined();
    expect(res.body.signerEmail).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /sign/:token — PUBLIC signer submission
// ─────────────────────────────────────────────────────────────────────────

describe('POST /sign/:token — signer submits signature', () => {
  test('400 when signature body is missing or not a data: URL', async () => {
    const res = await request(makeApp())
      .post('/api/signatures/sign/any-token')
      .send({ signature: 'not-a-data-url' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid signature/i);
    expect(prisma.signatureRequest.findUnique).not.toHaveBeenCalled();
    expect(prisma.signatureRequest.update).not.toHaveBeenCalled();
  });

  test('409 when the request status is already SIGNED (non-replayable)', async () => {
    prisma.signatureRequest.findUnique.mockResolvedValue({
      id: 42,
      signToken: 'tok-signed',
      status: 'SIGNED',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(makeApp())
      .post('/api/signatures/sign/tok-signed')
      .send({ signature: 'data:image/png;base64,iVBOR' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already SIGNED/);
    expect(prisma.signatureRequest.update).not.toHaveBeenCalled();
  });

  test('200 happy path: stamps signature + signedAt + flips status to SIGNED', async () => {
    prisma.signatureRequest.findUnique.mockResolvedValue({
      id: 42,
      signToken: 'tok-pending',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
      documentType: 'Contract',
      documentId: 100,
      tenantId: 1,
      signerName: 'Asha Patel',
      signerEmail: 'asha@example.com',
    });
    prisma.signatureRequest.update.mockResolvedValue({
      id: 42,
      status: 'SIGNED',
      documentType: 'Contract',
      documentId: 100,
      tenantId: 1,
      signerName: 'Asha Patel',
      signerEmail: 'asha@example.com',
    });

    const res = await request(makeApp())
      .post('/api/signatures/sign/tok-pending')
      .send({ signature: 'data:image/png;base64,iVBOR' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    // Pin the update shape — signature + signedAt + status all written.
    const updateArg = prisma.signatureRequest.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 42 });
    expect(updateArg.data.status).toBe('SIGNED');
    expect(updateArg.data.signature).toBe('data:image/png;base64,iVBOR');
    expect(updateArg.data.signedAt).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /sign/:token — post-sign flow: auto-convert Estimate + notify owners
// ─────────────────────────────────────────────────────────────────────────
//
// When an Estimate is signed it is fully fulfilled: auto-converted to an
// invoice (via lib/signatureFulfillment) and ADMIN/MANAGER users get a
// notification. (Gateways are disabled in this suite, so no payment link is
// minted here — that path is covered in test/lib/paymentLink.test.js.) All
// best-effort — a failure must not fail the signing, so 200 { success:true }
// still returns.
describe('POST /sign/:token — auto-converts Estimate + notifies owners', () => {
  function signedEstimate(status = 'Draft', contactId = 77) {
    prisma.signatureRequest.findUnique.mockResolvedValue({
      id: 50, signToken: 'tok-est', status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
      documentType: 'Estimate', documentId: 5, tenantId: 2,
      signerName: 'Mohit Gupta', signerEmail: 'mohit@example.com',
    });
    prisma.signatureRequest.update.mockResolvedValue({
      id: 50, status: 'SIGNED',
      documentType: 'Estimate', documentId: 5, tenantId: 2,
      signerName: 'Mohit Gupta', signerEmail: 'mohit@example.com',
    });
    prisma.estimate.findFirst.mockResolvedValue({
      id: 5, estimateNum: 'EST-777751', status, totalAmount: 4950,
      contactId, dealId: null,
      contact: contactId ? { id: contactId, name: 'Mohit Gupta', email: 'mohit@example.com', phone: '+91999' } : null,
      lineItems: [],
    });
    prisma.user.findMany.mockResolvedValue([{ id: 9 }]); // the ADMIN owner
  }

  test('signing a Draft Estimate converts it to an invoice and notifies the owner', async () => {
    signedEstimate('Draft');

    const res = await request(makeApp())
      .post('/api/signatures/sign/tok-est')
      .send({ signature: 'data:image/png;base64,iVBOR' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // Convert ran inside a transaction (invoice created + estimate flipped).
    expect(prisma.$transaction).toHaveBeenCalled();
    // Owner (ADMIN/MANAGER) scoped lookup + notification persisted.
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 2, role: { in: ['ADMIN', 'MANAGER'] } },
      select: { id: true },
    });
    expect(prisma.notification.create).toHaveBeenCalled();
    const notifData = prisma.notification.create.mock.calls[0][0].data;
    expect(notifData.userId).toBe(9);
    expect(notifData.tenantId).toBe(2);
    expect(notifData.link).toBe('/invoices');
    expect(notifData.message).toMatch(/Mohit Gupta signed INV-TEST01/);
    // Gateways disabled in this suite → owner told to collect manually.
    expect(notifData.message).toMatch(/Invoice INV-TEST01/);
    expect(notifData.message).toMatch(/no payment link|collect payment manually/i);
  });

  test('does NOT re-convert an already-Converted Estimate, still notifies', async () => {
    signedEstimate('Converted');

    const res = await request(makeApp())
      .post('/api/signatures/sign/tok-est')
      .send({ signature: 'data:image/png;base64,iVBOR' });

    expect(res.status).toBe(200);
    // Converted is terminal — no second conversion transaction fires.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalled();
    const notifData = prisma.notification.create.mock.calls[0][0].data;
    expect(notifData.message).toMatch(/already converted/i);
  });

  test('an Estimate with no contact is not converted; owner is told to add one', async () => {
    signedEstimate('Draft', null); // no contactId

    const res = await request(makeApp())
      .post('/api/signatures/sign/tok-est')
      .send({ signature: 'data:image/png;base64,iVBOR' });

    expect(res.status).toBe(200);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const notifData = prisma.notification.create.mock.calls[0][0].data;
    expect(notifData.message).toMatch(/Link a contact/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /decline/:token — PUBLIC signer declines
// ─────────────────────────────────────────────────────────────────────────

describe('POST /decline/:token — signer declines request', () => {
  test('404 when the token does not match any signature request', async () => {
    prisma.signatureRequest.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/signatures/decline/bogus')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/invalid/i);
    expect(prisma.signatureRequest.update).not.toHaveBeenCalled();
  });

  test('200 happy path: flips status PENDING → DECLINED', async () => {
    prisma.signatureRequest.findUnique.mockResolvedValue({
      id: 42,
      signToken: 'tok-declining',
      status: 'PENDING',
    });

    const res = await request(makeApp())
      .post('/api/signatures/decline/tok-declining')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.signatureRequest.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { status: 'DECLINED' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list (tenant-scoped + optional filters)
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list signature requests', () => {
  test('200 applies tenantId + status + documentType filters with createdAt-desc ordering', async () => {
    prisma.signatureRequest.findMany.mockResolvedValue([
      { id: 1, status: 'PENDING', documentType: 'Contract', tenantId: 42 },
    ]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/signatures?status=PENDING&documentType=Contract');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(prisma.signatureRequest.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, status: 'PENDING', documentType: 'Contract' },
      orderBy: { createdAt: 'desc' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create signature request + send signing email
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — create signature request', () => {
  test('400 when any of documentType/documentId/signerName/signerEmail is missing', async () => {
    const res = await request(makeApp())
      .post('/api/signatures')
      .send({ documentType: 'Contract', documentId: 100, signerName: 'Asha' /* signerEmail missing */ });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(prisma.signatureRequest.create).not.toHaveBeenCalled();
  });

  test('400 INVALID when documentType is not in the {Contract, Estimate, Quote, Custom} enum', async () => {
    const res = await request(makeApp())
      .post('/api/signatures')
      .send({
        documentType: 'NotARealType',
        documentId: 100,
        signerName: 'Asha Patel',
        signerEmail: 'asha@example.com',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid documenttype/i);
    expect(prisma.signatureRequest.create).not.toHaveBeenCalled();
  });

  test('201 happy path: defaults expiresInDays=7, generates signToken, returns emailDelivered=false (sendgrid stubbed)', async () => {
    prisma.signatureRequest.create.mockImplementation(async ({ data }) => ({
      id: 99,
      ...data,
    }));

    const before = Date.now();
    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/signatures')
      .send({
        documentType: 'Contract',
        documentId: 100,
        signerName: 'Asha Patel',
        signerEmail: 'asha@example.com',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    expect(res.body.emailDelivered).toBe(false); // SendGrid stubbed/unconfigured in tests.

    const createArg = prisma.signatureRequest.create.mock.calls[0][0].data;
    expect(createArg.documentType).toBe('Contract');
    expect(createArg.documentId).toBe(100);
    expect(createArg.signerName).toBe('Asha Patel');
    expect(createArg.signerEmail).toBe('asha@example.com');
    expect(createArg.status).toBe('PENDING');
    expect(createArg.tenantId).toBe(42);
    // signToken is 32 random bytes hex-encoded = 64 chars.
    expect(createArg.signToken).toMatch(/^[a-f0-9]{64}$/);
    // expiresAt is ~7 days out from now.
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const expectedMin = before + sevenDaysMs - 5_000;
    const expectedMax = Date.now() + sevenDaysMs + 5_000;
    expect(createArg.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(createArg.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — single request (tenant-scoped via findFirst)
// ─────────────────────────────────────────────────────────────────────────

describe('GET /:id — single signature request', () => {
  test('400 when :id is not a number', async () => {
    const res = await request(makeApp()).get('/api/signatures/not-an-int');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.signatureRequest.findFirst).not.toHaveBeenCalled();
  });

  test('404 when the request belongs to a different tenant (findFirst returns null)', async () => {
    prisma.signatureRequest.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/signatures/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.signatureRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — cancel/delete (tenant-scoped guard)
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — cancel signature request', () => {
  test('404 when the request belongs to a different tenant (no cross-tenant delete)', async () => {
    prisma.signatureRequest.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/signatures/777');

    expect(res.status).toBe(404);
    expect(prisma.signatureRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.signatureRequest.delete).not.toHaveBeenCalled();
  });

  test('200 happy path: deletes the row scoped by id', async () => {
    prisma.signatureRequest.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.signatureRequest.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp()).delete('/api/signatures/50');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.signatureRequest.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/resend — re-send signing email (only PENDING requests)
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/resend — resend signing email', () => {
  test('409 when the request is already SIGNED (cannot resend a completed request)', async () => {
    prisma.signatureRequest.findFirst.mockResolvedValue({
      id: 50,
      tenantId: 1,
      status: 'SIGNED',
      signToken: 'tok-signed',
      documentType: 'Contract',
      documentId: 100,
      signerName: 'Asha Patel',
      signerEmail: 'asha@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(makeApp()).post('/api/signatures/50/resend').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot resend.*SIGNED/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /?fields=summary — slim-shape opt-in (#920 slice 39)
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors the slim-shape contract pinned in slices 1-36. The default (no
// ?fields) path continues to return the full row including signature blob +
// signToken + signerEmail. The ?fields=summary path drops the heavy
// `signature @db.LongText` column AND the sensitive `signToken` (URL key
// that bypasses the global auth guard) AND `signerEmail` (PII), passing a
// `select` to Prisma so the wire payload (and the DB read) stay narrow.
// Anything other than the exact string "summary" is treated as default
// (no `select` key forwarded).
describe('GET /?fields=summary — slim-shape opt-in', () => {
  test('omitted ?fields returns full row with signature + signToken + signerEmail (no select forwarded)', async () => {
    prisma.signatureRequest.findMany.mockResolvedValue([
      {
        id: 1,
        documentType: 'Contract',
        documentId: 100,
        signerName: 'Asha Patel',
        signerEmail: 'asha@example.com',
        signature: 'data:image/png;base64,iVBOR-very-long-blob',
        signedAt: new Date('2026-01-10T12:00:00Z'),
        status: 'SIGNED',
        signToken: 'a'.repeat(64),
        tenantId: 42,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        expiresAt: new Date('2026-01-08T00:00:00Z'),
      },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/signatures');

    expect(res.status).toBe(200);
    expect(res.body[0].signature).toBe('data:image/png;base64,iVBOR-very-long-blob');
    expect(res.body[0].signToken).toBe('a'.repeat(64));
    expect(res.body[0].signerEmail).toBe('asha@example.com');
    // No `select` key forwarded — full-row default path.
    const arg = prisma.signatureRequest.findMany.mock.calls[0][0];
    expect(arg.select).toBeUndefined();
    expect(arg).toEqual({
      where: { tenantId: 42 },
      orderBy: { createdAt: 'desc' },
    });
  });

  test('?fields=summary forwards select with chrome columns only (drops signature + signToken + signerEmail + tenantId)', async () => {
    prisma.signatureRequest.findMany.mockResolvedValue([
      {
        id: 1,
        documentType: 'Contract',
        documentId: 100,
        signerName: 'Asha Patel',
        status: 'PENDING',
        expiresAt: new Date('2026-01-08T00:00:00Z'),
        signedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 2,
        documentType: 'Quote',
        documentId: 200,
        signerName: 'Ravi Kumar',
        status: 'SIGNED',
        expiresAt: new Date('2026-01-15T00:00:00Z'),
        signedAt: new Date('2026-01-10T00:00:00Z'),
        createdAt: new Date('2026-01-05T00:00:00Z'),
      },
    ]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/signatures?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const arg = prisma.signatureRequest.findMany.mock.calls[0][0];
    // Pin exact slim shape: ONLY chrome columns the list UI needs.
    expect(arg.select).toEqual({
      id: true,
      documentType: true,
      documentId: true,
      signerName: true,
      status: true,
      expiresAt: true,
      signedAt: true,
      createdAt: true,
    });
    // Heavy LongText + sensitive token + PII MUST NOT be in select.
    expect(arg.select.signature).toBeUndefined();
    expect(arg.select.signToken).toBeUndefined();
    expect(arg.select.signerEmail).toBeUndefined();
    expect(arg.select.tenantId).toBeUndefined();
    // where + orderBy unchanged from default path.
    expect(arg.where).toEqual({ tenantId: 42 });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary composes with ?status + ?documentType filters — both narrow the read', async () => {
    prisma.signatureRequest.findMany.mockResolvedValue([
      {
        id: 1,
        documentType: 'Contract',
        documentId: 100,
        signerName: 'Asha Patel',
        status: 'PENDING',
        expiresAt: new Date('2026-01-08T00:00:00Z'),
        signedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/signatures?fields=summary&status=PENDING&documentType=Contract');

    expect(res.status).toBe(200);
    const arg = prisma.signatureRequest.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 1, status: 'PENDING', documentType: 'Contract' });
    expect(arg.select).toEqual({
      id: true,
      documentType: true,
      documentId: true,
      signerName: true,
      status: true,
      expiresAt: true,
      signedAt: true,
      createdAt: true,
    });
  });

  test('?fields=full (anything not exactly "summary") falls back to default full-row shape', async () => {
    prisma.signatureRequest.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/signatures?fields=full');

    expect(res.status).toBe(200);
    const arg = prisma.signatureRequest.findMany.mock.calls[0][0];
    // Exact-string gate: only "summary" trips the slim branch.
    expect(arg.select).toBeUndefined();
  });

  test('?fields=SUMMARY (uppercase) is treated as default — case-sensitive gate', async () => {
    prisma.signatureRequest.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/signatures?fields=SUMMARY');

    expect(res.status).toBe(200);
    const arg = prisma.signatureRequest.findMany.mock.calls[0][0];
    // The gate is `req.query.fields === "summary"` (case-sensitive). Pin
    // the contract so a future refactor to .toLowerCase() shows up as a
    // deliberate spec edit, not a silent behaviour change.
    expect(arg.select).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /sign/:token/pdf — PUBLIC document preview (token-only, no JWT)
// ─────────────────────────────────────────────────────────────────────────
//
// The signing page embeds this as an <iframe> so the signer can review what
// they're signing. Token-scoped (mirrors GET /sign/:token); renders an Estimate
// with line items + totals, or a generic single-page doc for other types.
describe('GET /sign/:token/pdf — public document preview', () => {
  test('404 when the token does not match any request', async () => {
    prisma.signatureRequest.findUnique.mockResolvedValue(null);

    const res = await request(makeApp()).get('/api/signatures/sign/bogus/pdf');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/invalid|expired/i);
  });

  test('410 when the request has already expired', async () => {
    prisma.signatureRequest.findUnique.mockResolvedValue({
      id: 7,
      signToken: 'tok-exp',
      status: 'PENDING',
      documentType: 'Contract',
      documentId: 1,
      tenantId: 9,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await request(makeApp()).get('/api/signatures/sign/tok-exp/pdf');

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('200 streams an application/pdf for a generic (non-Estimate) document', async () => {
    prisma.signatureRequest.findUnique.mockResolvedValue({
      id: 8,
      signToken: 'tok-pdf-contract',
      status: 'PENDING',
      documentType: 'Contract',
      documentId: 100,
      tenantId: 9,
      signerName: 'Asha Patel',
      signerEmail: 'asha@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Contract lookup (fetchLinkedDocument) — return null so the generic
    // branch renders without a contact.
    prisma.contract.findFirst.mockResolvedValue(null);

    const res = await request(makeApp()).get('/api/signatures/sign/tok-pdf-contract/pdf');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/inline/);
    // PDFKit output begins with the %PDF- magic bytes.
    const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text || '', 'binary');
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('200 streams a PDF for an Estimate with line items + totals', async () => {
    prisma.signatureRequest.findUnique.mockResolvedValue({
      id: 9,
      signToken: 'tok-pdf-est',
      status: 'PENDING',
      documentType: 'Estimate',
      documentId: 5,
      tenantId: 9,
      signerName: 'Mohit Gupta',
      signerEmail: 'mohit@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Estimate branch queries estimate.findFirst with lineItems + contact.
    prisma.estimate.findFirst.mockResolvedValue({
      id: 5,
      title: 'Wellness package',
      estimateNum: 'EST-5',
      status: 'Sent',
      totalAmount: 1500,
      notes: 'Thank you',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      contact: { name: 'Mohit Gupta', email: 'mohit@example.com', company: 'Acme' },
      lineItems: [
        { description: 'Consultation', quantity: 1, unitPrice: 500 },
        { description: 'Treatment', quantity: 2, unitPrice: 500 },
      ],
    });

    const res = await request(makeApp()).get('/api/signatures/sign/tok-pdf-est/pdf');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(prisma.estimate.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 9 },
      include: { contact: true, lineItems: true },
    });
    const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text || '', 'binary');
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Signing link: dynamic origin + frontend route + tenant branding
// ─────────────────────────────────────────────────────────────────────────
//
// The email link must (a) point back at the SAME environment that sent it
// (derived from the request Origin header — demo→demo, staging→staging),
// (b) target the frontend page `/sign/:token` NOT the raw `/api/...` JSON
// endpoint, and (c) be branded with the tenant's name from the DB. We force
// the SendGrid path by setting a key + capturing the outbound payload.
describe('signing link — dynamic base URL + frontend route + branding', () => {
  let savedFetch;
  let savedKey;
  let captured;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedKey = process.env.SENDGRID_API_KEY;
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    captured = null;
    globalThis.fetch = vi.fn(async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, status: 202, headers: { get: () => 'msg-1' }, text: async () => '' };
    });
    prisma.signatureRequest.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = savedKey;
  });

  test('POST / builds a link to {Origin}/sign/:token (frontend route, not /api) branded with tenant name', async () => {
    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/signatures')
      .set('Origin', 'https://staging.example.com')
      .send({
        documentType: 'Estimate',
        documentId: 5,
        signerName: 'Mohit Gupta',
        signerEmail: 'mohit@example.com',
      });

    expect(res.status).toBe(201);
    expect(res.body.emailDelivered).toBe(true);
    expect(captured).toBeTruthy();

    const html = captured.content.find((c) => c.type === 'text/html').value;
    const text = captured.content.find((c) => c.type === 'text/plain').value;
    const token = prisma.signatureRequest.create.mock.calls[0][0].data.signToken;

    // (a) origin-derived host + (b) frontend /sign route, NOT the API path.
    expect(html).toContain(`https://staging.example.com/sign/${token}`);
    expect(text).toContain(`https://staging.example.com/sign/${token}`);
    expect(html).not.toContain('/api/signatures/sign');
    // The link is a real clickable anchor in the HTML part.
    expect(html).toMatch(new RegExp(`<a[^>]+href="https://staging\\.example\\.com/sign/${token}"`));
    // (c) branded with the tenant name from the DB (mocked 'Enhanced Wellness').
    expect(html).toContain('Enhanced Wellness');
    expect(text).toContain('Enhanced Wellness');
  });

  test('falls back to Host header (+ proto) when no Origin is present', async () => {
    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/signatures')
      .set('Host', 'crm.example.org')
      .send({
        documentType: 'Estimate',
        documentId: 5,
        signerName: 'Mohit Gupta',
        signerEmail: 'mohit@example.com',
      });

    expect(res.status).toBe(201);
    const token = prisma.signatureRequest.create.mock.calls[0][0].data.signToken;
    const text = captured.content.find((c) => c.type === 'text/plain').value;
    // supertest speaks http to the in-process app → http:// scheme.
    expect(text).toContain(`http://crm.example.org/sign/${token}`);
  });
});
