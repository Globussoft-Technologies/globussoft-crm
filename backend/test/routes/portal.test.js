// @ts-check
/**
 * Unit tests for backend/routes/portal.js — pins the customer-portal route
 * contract because the portal is the public-facing surface that lets
 * end-customers (contacts, not staff) log in to view their tickets, invoices,
 * and contracts. Every authz boundary here is a tenant-isolation gate that
 * MUST NOT regress.
 *
 * Authentication model
 * ────────────────────
 *   Portal auth is email + password → bcrypt verify → JWT with kind {type:
 *   'PORTAL'}. This is DISTINCT from the staff JWT (type: undefined / role:
 *   ADMIN|MANAGER|USER) and is verified by an INLINE verifyPortalToken
 *   middleware in routes/portal.js (NOT middleware/auth.js's verifyToken).
 *
 *   The route uses prisma.contact.findFirst (NOT findUnique) for email
 *   lookups because Contact.email isn't @unique in schema — the same email
 *   can belong to contacts in DIFFERENT tenants (multi-tenant compat). The
 *   contract pinned here ensures that quirk doesn't accidentally cross
 *   tenants.
 *
 * Surface pinned (8 endpoints)
 * ────────────────────────────
 *   PUBLIC (no auth):
 *     POST /api/portal/login         — email/password → PORTAL JWT
 *     POST /api/portal/set-password  — set initial or change password
 *     POST /api/portal/forgot        — request reset link (never enumerates)
 *     POST /api/portal/reset         — exchange reset token for new password
 *   PORTAL JWT REQUIRED:
 *     GET  /api/portal/me            — current contact profile
 *     GET  /api/portal/tickets       — list tickets (scoped to tenant)
 *     POST /api/portal/tickets       — create ticket on behalf of contact
 *     GET  /api/portal/invoices      — list invoices (scoped to contact)
 *     GET  /api/portal/contracts     — list contracts (scoped to contact)
 *
 * What this file pins (16 cases)
 * ──────────────────────────────
 *    1. login: missing email or password → 400.
 *    2. login: contact not found → 401 "Invalid credentials" (does NOT
 *       enumerate — same shape as wrong-password).
 *    3. login: contact found but no portalPasswordHash (never set up
 *       portal) → 401 "Invalid credentials" (do not enumerate).
 *    4. login: correct password → 200 + JWT whose decoded claims carry
 *       type:'PORTAL', contactId, tenantId. Critical: tenantId comes from
 *       the contact's row, NOT from the request body.
 *    5. login: wrong password → 401 "Invalid credentials".
 *    6. set-password: missing email or newPassword → 400; password
 *       shorter than 6 chars → 400.
 *    7. set-password: contact not found → 404 (this IS allowed to
 *       distinguish because the caller already has knowledge of email).
 *    8. set-password: existing hash + wrong currentPassword → 401.
 *    9. set-password: first-time set (no existing hash) → 200, no
 *       currentPassword check.
 *   10. forgot: never enumerates — returns 200 ack whether the email
 *       exists or not (canonical anti-enumeration contract).
 *   11. reset: invalid/expired token → 400.
 *   12. verifyPortalToken: missing Authorization → 401.
 *   13. verifyPortalToken: STAFF JWT (type undefined or non-PORTAL) →
 *       401 "Invalid portal token". This is the cross-token-class gate —
 *       a staff JWT must NOT unlock portal endpoints, else any logged-in
 *       staff could impersonate any contact.
 *   14. verifyPortalToken: expired PORTAL token → 401 "session expired".
 *   15. GET /me: returns ONLY the authenticated contact's row (uses
 *       portal.contactId from the decoded JWT, never the request body).
 *   16. GET /invoices: cross-contact isolation — Prisma where-clause
 *       includes BOTH contactId AND tenantId from the JWT, so a forged
 *       contactId in another tenant can't leak invoices. (Pinned by
 *       inspecting the where-args passed to prisma.invoice.findMany.)
 *
 * Test pattern mirrors backend/test/routes/auth-stepup.test.js — prisma
 * singleton monkey-patch BEFORE requiring the router (CJS load semantics
 * bypass vi.mock()), supertest against a real express() app, real bcrypt
 * + real jsonwebtoken (no crypto mocks).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patch (MUST happen BEFORE the router is require()d,
// because the router captures the singleton at load time via lib/prisma).
// The CJS route loader bypasses vi.mock() so we patch the singleton itself.
prisma.contact = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn().mockResolvedValue({}),
  create: vi.fn(),
};
prisma.tenant = {
  findUnique: vi.fn(),
};
prisma.ticket = {
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn().mockResolvedValue({}),
};
prisma.invoice = {
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.contract = {
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.slaPolicy = {
  findFirst: vi.fn().mockResolvedValue(null),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const portalRouter = requireCJS('../../routes/portal');

// JWT_SECRET resolution mirrors config/secrets.js — the route uses the
// same secret to sign and verify the PORTAL JWT, so tests sign with the
// same constant. (PORTAL_JWT_SECRET falls back to JWT_SECRET which falls
// back to the dev fallback when no env is set.)
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal', portalRouter);
  return app;
}

// Build a real PORTAL Bearer token that verifyPortalToken accepts.
function portalBearer({ contactId = 42, tenantId = 1, expiresIn = '7d' } = {}) {
  return 'Bearer ' + jwt.sign(
    { contactId, tenantId, type: 'PORTAL' },
    JWT_SECRET,
    { expiresIn }
  );
}

// Build a STAFF bearer (mimics middleware/auth.js sign shape — no type
// claim, has role + userId). This is the CROSS-CLASS attack token — must
// be rejected by verifyPortalToken.
function staffBearer({ userId = 7, tenantId = 1, role = 'USER' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '5m' });
}

beforeEach(() => {
  prisma.contact.findFirst.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.contact.update.mockReset().mockResolvedValue({});
  prisma.contact.create.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.ticket.findMany.mockReset().mockResolvedValue([]);
  prisma.ticket.create.mockReset();
  prisma.invoice.findMany.mockReset().mockResolvedValue([]);
  prisma.contract.findMany.mockReset().mockResolvedValue([]);
  prisma.slaPolicy.findFirst.mockReset().mockResolvedValue(null);
});

// ── POST /api/portal/login ─────────────────────────────────────────────

describe('POST /login — body validation + auth', () => {
  test('missing email → 400', async () => {
    const res = await request(makeApp())
      .post('/api/portal/login')
      .send({ password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email and password are required/i);
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('contact not found → 401 "Invalid credentials" (no enumeration)', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/portal/login')
      .send({ email: 'noone@x.com', password: 'anything' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('contact found but no portalPasswordHash → 401 (do not enumerate "no portal account")', async () => {
    // Critical: same response shape as not-found. Else attackers learn
    // which emails are contacts vs which have portal access.
    prisma.contact.findFirst.mockResolvedValue({
      id: 99, tenantId: 1, email: 'never-onboarded@x.com',
      portalPasswordHash: null,
    });
    const res = await request(makeApp())
      .post('/api/portal/login')
      .send({ email: 'never-onboarded@x.com', password: 'guess' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('correct password → 200 + PORTAL JWT carrying contactId + tenantId from CONTACT ROW', async () => {
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.contact.findFirst.mockResolvedValue({
      id: 99, tenantId: 1, email: 'alice@example.com',
      name: 'Alice Sharma', company: 'Acme Co',
      portalPasswordHash: pwHash,
    });
    const res = await request(makeApp())
      .post('/api/portal/login')
      .send({ email: 'alice@example.com', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.contact).toEqual({
      id: 99, name: 'Alice Sharma',
      email: 'alice@example.com', company: 'Acme Co',
      // Login response includes the portal avatar (routes/portal.js maps
      // `avatarUrl: contact.avatarUrl || null`). This mock contact has no
      // avatarUrl set, so the route returns null.
      avatarUrl: null,
    });
    // Token claim shape — tenantId MUST come from contact row, NOT request body
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.type).toBe('PORTAL');
    expect(decoded.contactId).toBe(99);
    expect(decoded.tenantId).toBe(1);
  });

  test('wrong password → 401 "Invalid credentials"', async () => {
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.contact.findFirst.mockResolvedValue({
      id: 99, tenantId: 1, email: 'alice@example.com',
      portalPasswordHash: pwHash,
    });
    const res = await request(makeApp())
      .post('/api/portal/login')
      .send({ email: 'alice@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });
});

// ── POST /api/portal/set-password ──────────────────────────────────────

describe('POST /set-password', () => {
  test('newPassword shorter than 6 chars → 400', async () => {
    const res = await request(makeApp())
      .post('/api/portal/set-password')
      .send({ email: 'alice@x.com', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 6 characters/i);
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('contact not found → 404 (caller already supplied the email so this is fine)', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/portal/set-password')
      .send({ email: 'noone@x.com', newPassword: 'newpass1' });
    expect(res.status).toBe(404);
  });

  test('existing hash + wrong currentPassword → 401 (cannot change without proving identity)', async () => {
    const pwHash = await bcrypt.hash('old-password', 10);
    prisma.contact.findFirst.mockResolvedValue({
      id: 99, tenantId: 1, portalPasswordHash: pwHash,
    });
    const res = await request(makeApp())
      .post('/api/portal/set-password')
      .send({
        email: 'alice@x.com',
        currentPassword: 'WRONG-old',
        newPassword: 'new-password',
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/current password is incorrect/i);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('first-time set (no existing hash) → 200, no currentPassword check', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 99, tenantId: 1, portalPasswordHash: null,
    });
    const res = await request(makeApp())
      .post('/api/portal/set-password')
      .send({ email: 'alice@x.com', newPassword: 'first-time-password' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('PORTAL_PASSWORD_SET');
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 99 },
        data: expect.objectContaining({ portalPasswordHash: expect.any(String) }),
      })
    );
  });
});

// ── POST /api/portal/forgot ────────────────────────────────────────────

describe('POST /forgot — anti-enumeration', () => {
  test('always returns 200 ack — whether email matches or not (anti-enumeration)', async () => {
    // First call: matching contact
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 99, tenantId: 1 });
    const res1 = await request(makeApp())
      .post('/api/portal/forgot')
      .send({ email: 'alice@x.com' });
    expect(res1.status).toBe(200);
    expect(res1.body.code).toBe('RESET_LINK_REQUESTED');

    // Second call: NO matching contact — MUST return same shape
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    const res2 = await request(makeApp())
      .post('/api/portal/forgot')
      .send({ email: 'noone@x.com' });
    expect(res2.status).toBe(200);
    expect(res2.body.code).toBe('RESET_LINK_REQUESTED');
    // Same response shape — attacker cannot distinguish.
    expect(res2.body).toEqual(res1.body);
  });
});

// ── POST /api/portal/reset ─────────────────────────────────────────────

describe('POST /reset', () => {
  test('invalid/unknown token → 400 "Invalid or expired token"', async () => {
    const res = await request(makeApp())
      .post('/api/portal/reset')
      .send({ token: 'never-issued-token', newPassword: 'whatever1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired token/i);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });
});

// ── verifyPortalToken middleware (auth gate) ───────────────────────────

describe('verifyPortalToken — auth gate', () => {
  test('missing Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/portal/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/portal token required/i);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('STAFF JWT (type !== PORTAL) → 401 "Invalid portal token" — cross-class attack defense', async () => {
    // A logged-in staff member must NOT be able to use their staff JWT to
    // hit portal endpoints. This is the load-bearing class gate.
    const res = await request(makeApp())
      .get('/api/portal/me')
      .set('Authorization', staffBearer({ userId: 7, tenantId: 1, role: 'ADMIN' }));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid portal token/i);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('expired PORTAL token → 401 "Portal session expired"', async () => {
    // expiresIn must be a NEGATIVE duration so the JWT lib accepts the
    // sign but marks it past-exp.
    const expired = 'Bearer ' + jwt.sign(
      { contactId: 42, tenantId: 1, type: 'PORTAL' },
      JWT_SECRET,
      { expiresIn: -10 }
    );
    const res = await request(makeApp())
      .get('/api/portal/me')
      .set('Authorization', expired);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/portal session expired/i);
  });
});

// ── GET /api/portal/me ─────────────────────────────────────────────────

describe('GET /me — authenticated profile', () => {
  test('returns ONLY the authenticated contact (uses portal.contactId from JWT)', async () => {
    prisma.contact.findUnique.mockResolvedValue({
      id: 42, name: 'Alice Sharma', email: 'alice@x.com',
      phone: '+91 99999 00000', company: 'Acme', title: 'Buyer',
      status: 'active', tenantId: 1,
      createdAt: new Date('2026-01-01'),
    });
    const res = await request(makeApp())
      .get('/api/portal/me')
      .set('Authorization', portalBearer({ contactId: 42, tenantId: 1 }));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
    // The where-clause MUST come from the decoded JWT, not from the request.
    expect(prisma.contact.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42 } })
    );
  });
});

// ── GET /api/portal/invoices — cross-contact isolation gate ────────────

describe('GET /invoices — cross-contact + cross-tenant isolation', () => {
  test('Prisma where-clause scopes by BOTH contactId AND tenantId from JWT', async () => {
    // The defensive contract: the route MUST pass BOTH contactId AND
    // tenantId to prisma.invoice.findMany. Either alone would be a leak:
    //   - contactId alone: a forged token claiming a contactId in another
    //     tenant could read that contact's invoices.
    //   - tenantId alone: any portal user in the tenant could read any
    //     other contact's invoices in the same tenant.
    prisma.invoice.findMany.mockResolvedValue([
      { id: 1, contactId: 42, tenantId: 1, total: 5000 },
    ]);
    const res = await request(makeApp())
      .get('/api/portal/invoices')
      .set('Authorization', portalBearer({ contactId: 42, tenantId: 1 }));
    expect(res.status).toBe(200);
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactId: 42, tenantId: 1 },
      })
    );
  });
});

// ── GET /api/portal/invoices?fields=summary — #920 slice 33 ────────────

describe('GET /invoices ?fields=summary — slim-shape opt-in', () => {
  // #920 slice 33 pins the additive opt-in projection contract on the
  // portal invoice list. Mirrors slices 1-30. Pre-existing callers (no
  // ?fields, ?fields=full, ?fields=anything-else) MUST continue to get
  // the full default row shape (no Prisma select). ?fields=summary is
  // an exact-string opt-in that swaps default shape → minimal column
  // projection. Cross-contact + cross-tenant scoping MUST be preserved
  // identically under both code paths — the slim shape is purely a
  // column-set narrowing, never a filter relaxation.

  test('default (no ?fields) → findMany has NO select; tenant+contact scope preserved', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/portal/invoices')
      .set('Authorization', portalBearer({ contactId: 42, tenantId: 1 }));
    expect(res.status).toBe(200);
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('select');
    expect(args.where).toEqual({ contactId: 42, tenantId: 1 });
    expect(args.orderBy).toEqual({ issuedDate: 'desc' });
  });

  test('?fields=summary → slim Prisma select applied with the minimal column set', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/portal/invoices?fields=summary')
      .set('Authorization', portalBearer({ contactId: 42, tenantId: 1 }));
    expect(res.status).toBe(200);
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.select).toEqual({
      id: true,
      invoiceNum: true,
      amount: true,
      status: true,
      dueDate: true,
      issuedDate: true,
    });
    // No leakage of heavy columns into the slim projection.
    expect(args.select).not.toHaveProperty('isRecurring');
    expect(args.select).not.toHaveProperty('recurFrequency');
    expect(args.select).not.toHaveProperty('nextRecurDate');
    expect(args.select).not.toHaveProperty('parentInvoiceId');
    expect(args.select).not.toHaveProperty('visitId');
    expect(args.select).not.toHaveProperty('legalEntityCode');
    expect(args.select).not.toHaveProperty('paidAt');
    expect(args.select).not.toHaveProperty('tenantId');
  });

  test('?fields=summary preserves BOTH contactId AND tenantId scope (no filter relaxation)', async () => {
    // Regression pin: slim-shape MUST NOT silently drop the cross-
    // contact / cross-tenant isolation. The where-clause is identical
    // to the default path.
    prisma.invoice.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/portal/invoices?fields=summary')
      .set('Authorization', portalBearer({ contactId: 42, tenantId: 1 }));
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ contactId: 42, tenantId: 1 });
  });

  test('?fields=full (or any non-exact value) → falls back to default shape, no select', async () => {
    // Exact-string opt-in: only the literal "summary" enables slim.
    // Common typos / case variants get the default row shape so
    // existing callers never silently see narrower data.
    prisma.invoice.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/portal/invoices?fields=full')
      .set('Authorization', portalBearer({ contactId: 42, tenantId: 1 }));
    let args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('select');

    prisma.invoice.findMany.mockClear();
    await request(makeApp())
      .get('/api/portal/invoices?fields=Summary') // case-sensitive
      .set('Authorization', portalBearer({ contactId: 42, tenantId: 1 }));
    args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('select');
  });

  test('?fields=summary still requires portal JWT (no auth bypass via query param)', async () => {
    // Defensive: the slim-shape opt-in lives INSIDE the verifyPortalToken
    // wrapper. An unauthenticated caller passing ?fields=summary must
    // still 401 — the query param doesn't bypass auth.
    const res = await request(makeApp())
      .get('/api/portal/invoices?fields=summary');
    expect(res.status).toBe(401);
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });
});

// ── POST /api/portal/register ──────────────────────────────────────────
describe('POST /register — travel customer self-service sign-up', () => {
  test('missing email or password → 400', async () => {
    const res = await request(makeApp())
      .post('/api/portal/register')
      .send({ password: 'Pass1234' });
    expect(res.status).toBe(400);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  test('weak password (no number) → 400', async () => {
    const res = await request(makeApp())
      .post('/api/portal/register')
      .send({ email: 'new@x.com', password: 'onlyletters', registrationTenantId: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8 characters/i);
  });

  test('non-travel tenant → 400 (portal sign-up is travel-only)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: 'wellness' });
    const res = await request(makeApp())
      .post('/api/portal/register')
      .send({ email: 'new@x.com', password: 'Pass1234', registrationTenantId: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/travel/i);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('new travel customer → 201 + PORTAL JWT + creates Contact with portalPasswordHash', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 3, vertical: 'travel' });
    prisma.contact.findFirst.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 501, tenantId: 3, name: 'New Cust', email: 'new@x.com' });
    const res = await request(makeApp())
      .post('/api/portal/register')
      .send({ email: 'New@X.com', password: 'Pass1234', name: 'New Cust', registrationTenantId: 3 });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.type).toBe('PORTAL');
    expect(decoded.contactId).toBe(501);
    // Contact created with a bcrypt portalPasswordHash + LOWERCASED email.
    const createArg = prisma.contact.create.mock.calls[0][0].data;
    expect(createArg.email).toBe('new@x.com');
    expect(createArg.tenantId).toBe(3);
    expect(typeof createArg.portalPasswordHash).toBe('string');
    expect(await bcrypt.compare('Pass1234', createArg.portalPasswordHash)).toBe(true);
  });

  test('email already has a portal account → 409 (no duplicate create)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 3, vertical: 'travel' });
    prisma.contact.findFirst.mockResolvedValue({ id: 77, portalPasswordHash: 'existing-hash', name: 'X' });
    const res = await request(makeApp())
      .post('/api/portal/register')
      .send({ email: 'dup@x.com', password: 'Pass1234', registrationTenantId: 3 });
    expect(res.status).toBe(409);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('existing lead without portal password → 201 + links hash via update (no new contact)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 3, vertical: 'travel' });
    prisma.contact.findFirst.mockResolvedValue({ id: 88, portalPasswordHash: null, name: 'Lead Larry' });
    prisma.contact.update.mockResolvedValue({ id: 88, tenantId: 3, name: 'Lead Larry', email: 'lead@x.com' });
    const res = await request(makeApp())
      .post('/api/portal/register')
      .send({ email: 'lead@x.com', password: 'Pass1234', registrationTenantId: 3 });
    expect(res.status).toBe(201);
    expect(prisma.contact.create).not.toHaveBeenCalled();
    const updArg = prisma.contact.update.mock.calls[0][0];
    expect(updArg.where).toEqual({ id: 88 });
    expect(typeof updArg.data.portalPasswordHash).toBe('string');
  });
});
