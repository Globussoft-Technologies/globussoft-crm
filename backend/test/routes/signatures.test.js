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
 * the route's sendMailgun() helper sees a non-ok response and reports
 * `sent: false`. (We can't unset MAILGUN_API_KEY because the route does
 * `require('dotenv').config({ override: true })` at module load and reads
 * the key into a module-local constant before any test runs.)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
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

// Mailgun guard — the route does `require('dotenv').config({ override: true })`
// at module load time, reading the repo-root `.env` which DOES carry a real
// MAILGUN_API_KEY on this dev box (and on demo). We can't unset it after
// the route loads because dotenv has already cached + injected it into
// `process.env`, AND the route reads `MAILGUN_API_KEY` into a module-local
// constant at require-time anyway — so by the time our test runs, the value
// is already captured. Solution: stub `globalThis.fetch` so the route's
// in-flight POST to api.mailgun.net never actually hits the network; the
// route's try/catch will see a non-ok-status fetch response and report
// `sent: false` — exactly the wire shape we want to pin for tests.
globalThis.fetch = vi.fn(async () => ({
  ok: false,
  status: 503,
  text: async () => 'test-stub: mailgun not called from unit tests',
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
      // Sensitive fields the envelope MUST NOT leak:
      tenantId: 9,
      signature: 'data:image/png;base64,xxx',
      documentId: 1234,
      signerEmail: 'asha@example.com',
    });

    const res = await request(makeApp()).get('/api/signatures/sign/tok-good');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      documentType: 'Contract',
      signerName: 'Asha Patel',
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

  test('201 happy path: defaults expiresInDays=7, generates signToken, returns emailDelivered=false (no mailgun key)', async () => {
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
    expect(res.body.emailDelivered).toBe(false); // Mailgun not configured in tests.

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
