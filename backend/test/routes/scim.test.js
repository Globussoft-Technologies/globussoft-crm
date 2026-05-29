// @ts-check
/**
 * Unit tests for backend/routes/scim.js — pins the SCIM v2 user-provisioning
 * surface + token-management endpoints that sit at /api/scim.
 *
 * Why this file exists
 * ────────────────────
 * routes/scim.js is the IdP / SCIM bridge — it lets an external Identity
 * Provider (Okta, Azure AD, Google Workspace) push User CRUD into the CRM
 * using SCIM v2 + Bearer-token auth that is DIFFERENT from the rest of the
 * platform (NOT JWT — a bcrypt-hashed token in the ScimToken table). That
 * makes it a security-critical surface with its own auth path, its own
 * shape language (urn:ietf:params:scim:* schemas), and its own status-code
 * conventions (201 on create, 204 on delete, 409 on duplicate userName).
 * Until this commit the route was 344 LOC of untested code.
 *
 * Two halves of the file:
 *   • /tokens, /tokens, /tokens/:id  — sit behind the GLOBAL JWT guard
 *     (req.user from verifyToken). The router does NOT mount verifyToken
 *     itself; it expects req.user to be populated by server.js's global
 *     guard. These endpoints mint plaintext tokens ONCE and bcrypt-store
 *     them for later compare.
 *   • /v2/Users, /v2/Users/:id, /v2/Groups — gated by the local scimAuth
 *     middleware that ONLY accepts a "Bearer <plaintext>" against a row
 *     in ScimToken (bcrypt.compare loop). Returns the SCIM error envelope
 *     (schemas: [...scim:api:messages:2.0:Error], status, detail) on auth
 *     failure, NOT the JWT-style { error: "Unauthorized" }.
 *
 * What this file pins (15 cases)
 * ──────────────────────────────
 *   1.  GET /tokens lists tokens for req.user.tenantId only, mask-formatted
 *       (plaintext is never re-readable — only last 4 chars of the HASH).
 *   2.  GET /tokens without req.user → 401 (JWT-style envelope).
 *   3.  POST /tokens happy path: returns plaintext ONCE with warning,
 *       stores bcrypt hash (NOT the plaintext) in ScimToken.
 *   4.  POST /tokens with empty name → 400 "name required".
 *   5.  DELETE /tokens/:id tenant isolation: a row from another tenant →
 *       404 (the findFirst is tenant-scoped, delete only runs if found).
 *   6.  POST /v2/Users without Bearer header → 401 SCIM error envelope
 *       (NOT the JWT { error } shape).
 *   7.  POST /v2/Users with an invalid Bearer token → 401 SCIM error
 *       (bcrypt.compare loop exhausted with no match).
 *   8.  GET /v2/Users happy path: returns ListResponse envelope with
 *       totalResults / startIndex / itemsPerPage / Resources, every user
 *       converted by toScimUser (schemas + meta + name parts).
 *   9.  GET /v2/Users?filter=userName eq "x" narrows the where clause to
 *       email='x' (the minimal SCIM filter the route supports).
 *  10.  GET /v2/Users honors pagination: ?startIndex=11&count=5 maps to
 *       skip:10, take:5 — the route subtracts 1 from startIndex (SCIM is
 *       1-indexed, Prisma's skip is 0-indexed).
 *  11.  POST /v2/Users happy path: returns 201 + SCIM User resource with
 *       schemas:[...:User]; persists bcrypt-hashed password (never the
 *       plaintext); pulls tenantId from req.scim NOT from body.
 *  12.  POST /v2/Users without userName → 400 SCIM error.
 *  13.  POST /v2/Users on duplicate email → 409 SCIM error.
 *  14.  GET /v2/Users/:id cross-tenant isolation: a row belonging to
 *       another tenant → 404 SCIM error.
 *  15.  PATCH /v2/Users/:id replace userName: updates email column,
 *       returns updated SCIM resource.
 *  16.  DELETE /v2/Users/:id returns 204 No Content + calls prisma.user.delete.
 *  17.  GET /v2/Groups returns an empty SCIM ListResponse (groups not modeled).
 *
 * Pattern mirrors backend/test/routes/admin.test.js (CJS-self-mocking
 * seam) — we let the GLOBAL guard be bypassed via a fake auth middleware
 * mounted by the test (for the /tokens half), and we drive the SCIM half
 * by populating prisma.scimToken.findMany with a row whose bcrypt-hashed
 * token matches the plaintext the test presents. bcrypt is NOT mocked
 * (the SUT's auth-time compare is the exact contract we're pinning).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const bcrypt = requireCJS('bcryptjs');

// ── Prisma singleton patching (MUST happen before the router is required) ──
prisma.scimToken = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  update: vi.fn().mockResolvedValue({}),
};
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.user.findFirst = vi.fn();
prisma.user.findUnique = vi.fn();
prisma.user.create = vi.fn();
prisma.user.update = vi.fn();
prisma.user.delete = vi.fn();
prisma.user.count = vi.fn();

import express from 'express';
import request from 'supertest';

const scimRouter = requireCJS('../../routes/scim');

/**
 * Build an express app that injects a fake req.user (mirrors what
 * server.js's global JWT guard does once a Bearer JWT is validated).
 * Pass `noUser:true` to simulate the unauthenticated case for the
 * /tokens half — the SCIM v2 half uses its OWN Bearer header so it
 * does not care whether req.user is set.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN', noUser = false } = {}) {
  const app = express();
  app.use(express.json());
  if (!noUser) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/scim', scimRouter);
  return app;
}

beforeEach(() => {
  prisma.scimToken.findMany.mockReset();
  prisma.scimToken.findFirst.mockReset();
  prisma.scimToken.create.mockReset();
  prisma.scimToken.delete.mockReset();
  prisma.scimToken.update.mockReset().mockResolvedValue({});
  prisma.user.findMany.mockReset();
  prisma.user.findFirst.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.user.create.mockReset();
  prisma.user.update.mockReset();
  prisma.user.delete.mockReset();
  prisma.user.count.mockReset();
  // Schema-drift compat: SCIM route uses findFirst for email dup-checks
  // because User.email is composite-unique with tenantId. Existing tests
  // mock findUnique; delegate so per-test mockResolvedValue calls cover
  // both code paths.
  prisma.user.findFirst.mockImplementation((...args) => prisma.user.findUnique(...args));
});

// Helper: build a ScimToken row whose `token` column is a real bcrypt
// hash of the given plaintext. The SCIM auth middleware iterates over
// prisma.scimToken.findMany({}) and runs bcrypt.compare for each row —
// we cannot mock bcrypt because that's exactly the contract we want to
// exercise.
async function tokenRow({ id = 1, tenantId = 1, plaintext = 'scim_testplain' } = {}) {
  const hash = await bcrypt.hash(plaintext, 4); // low rounds → faster test
  return { id, tenantId, name: 'IdP', token: hash, lastUsed: null, createdAt: new Date() };
}

// ════════════════════════════════════════════════════════════════════
// /tokens — JWT-gated management surface
// ════════════════════════════════════════════════════════════════════

describe('GET /tokens — list tokens for current tenant', () => {
  test('returns masked tokens for req.user.tenantId only', async () => {
    prisma.scimToken.findMany.mockResolvedValue([
      { id: 1, name: 'Okta', token: '$2a$10$abcd1234abcd1234abcdef', lastUsed: null, createdAt: new Date() },
      { id: 2, name: 'AzureAD', token: '$2a$10$wxyz1234wxyz1234wxyz9876', lastUsed: new Date(), createdAt: new Date() },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/scim/tokens');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    // Tenant scoping passed through to Prisma
    expect(prisma.scimToken.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
      orderBy: { createdAt: 'desc' },
    });
    // Mask format: scim_••••••••<last4-of-HASH> — and the body NEVER
    // contains the raw bcrypt hash.
    for (const t of res.body) {
      expect(t.token).toMatch(/^scim_•{8}[A-Za-z0-9$./]{4}$/);
      expect(t.token).not.toContain('$2a$');
    }
  });

  test('without req.user → 401 (JWT-style envelope, NOT SCIM)', async () => {
    const res = await request(makeApp({ noUser: true })).get('/api/scim/tokens');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });
});

describe('POST /tokens — generate plaintext token (shown ONCE)', () => {
  test('happy path: returns plaintext + bcrypt-stores hash', async () => {
    let storedHash = null;
    prisma.scimToken.create.mockImplementation(({ data }) => {
      storedHash = data.token;
      return Promise.resolve({
        id: 100,
        name: data.name,
        createdAt: new Date('2026-05-25T00:00:00Z'),
        tenantId: data.tenantId,
        token: data.token,
      });
    });

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/scim/tokens')
      .send({ name: 'IdP-Bootstrap' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(100);
    expect(res.body.name).toBe('IdP-Bootstrap');
    expect(res.body.token).toMatch(/^scim_[a-f0-9]{64}$/);
    expect(res.body.warning).toMatch(/never be shown again/i);

    // The persisted column is a bcrypt hash, NOT the plaintext.
    expect(storedHash).toBeTruthy();
    expect(storedHash).toMatch(/^\$2[aby]\$/);
    expect(storedHash).not.toBe(res.body.token);
    // And the hash actually verifies against the returned plaintext.
    const ok = await bcrypt.compare(res.body.token, storedHash);
    expect(ok).toBe(true);

    // Tenant pulled from req.user, not the body.
    const callArgs = prisma.scimToken.create.mock.calls[0][0];
    expect(callArgs.data.tenantId).toBe(42);
  });

  test('missing name → 400', async () => {
    const res = await request(makeApp()).post('/api/scim/tokens').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name required' });
    expect(prisma.scimToken.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /tokens/:id — tenant isolation', () => {
  test('cross-tenant id → 404 + delete is NOT called', async () => {
    prisma.scimToken.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/scim/tokens/999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Token not found' });
    // findFirst was scoped by tenantId — the tenant isolation contract.
    expect(prisma.scimToken.findFirst).toHaveBeenCalledWith({
      where: { id: 999, tenantId: 1 },
    });
    expect(prisma.scimToken.delete).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// /v2/Users — SCIM Bearer-token authenticated
// ════════════════════════════════════════════════════════════════════

describe('SCIM v2 auth gate (scimAuth middleware)', () => {
  test('no Bearer header → 401 with SCIM error envelope', async () => {
    const res = await request(makeApp({ noUser: true })).get('/api/scim/v2/Users');
    expect(res.status).toBe(401);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(res.body.status).toBe('401');
    expect(res.body.detail).toMatch(/bearer/i);
    // Never reaches prisma.user
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  test('invalid Bearer token → 401 SCIM error', async () => {
    // The middleware runs prisma.scimToken.findMany({}) and bcrypt.compares
    // every row. With ONE row whose hash does NOT match, we exhaust the
    // loop and the rejection path fires.
    const row = await tokenRow({ plaintext: 'real_token_xyz' });
    prisma.scimToken.findMany.mockResolvedValue([row]);

    const res = await request(makeApp({ noUser: true }))
      .get('/api/scim/v2/Users')
      .set('Authorization', 'Bearer some_wrong_token');
    expect(res.status).toBe(401);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(res.body.detail).toMatch(/invalid scim token/i);
  });
});

describe('GET /v2/Users — list users in SCIM tenant', () => {
  test('happy path: returns ListResponse + toScimUser-shaped Resources', async () => {
    const plaintext = 'scim_listplain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 5, plaintext })]);
    prisma.user.count.mockResolvedValue(2);
    prisma.user.findMany.mockResolvedValue([
      { id: 1, email: 'a@x.io', name: 'Alice Anderson', createdAt: new Date('2026-01-01') },
      { id: 2, email: 'b@x.io', name: 'Bob Brown', createdAt: new Date('2026-02-02') },
    ]);

    const res = await request(makeApp({ noUser: true }))
      .get('/api/scim/v2/Users')
      .set('Authorization', `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
    expect(res.body.totalResults).toBe(2);
    expect(res.body.startIndex).toBe(1);
    expect(res.body.itemsPerPage).toBe(2);
    expect(res.body.Resources).toHaveLength(2);
    // Each resource is SCIM-shaped
    const r0 = res.body.Resources[0];
    expect(r0.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:User']);
    expect(r0.id).toBe('1'); // stringified
    expect(r0.userName).toBe('a@x.io');
    expect(r0.name).toEqual({ givenName: 'Alice', familyName: 'Anderson', formatted: 'Alice Anderson' });
    expect(r0.emails[0]).toEqual({ value: 'a@x.io', primary: true, type: 'work' });
    expect(r0.meta.location).toBe('/api/scim/v2/Users/1');
    // Tenant scoping on findMany
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 5 },
    }));
  });

  test('filter=userName eq "x" narrows to email match', async () => {
    const plaintext = 'scim_filterplain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 5, plaintext })]);
    prisma.user.count.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([
      { id: 9, email: 'target@x.io', name: 'Target User', createdAt: new Date() },
    ]);

    const res = await request(makeApp({ noUser: true }))
      .get('/api/scim/v2/Users?filter=' + encodeURIComponent('userName eq "target@x.io"'))
      .set('Authorization', `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 5, email: 'target@x.io' },
    }));
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { tenantId: 5, email: 'target@x.io' },
    });
  });

  test('honors pagination: startIndex=11&count=5 → skip:10, take:5', async () => {
    const plaintext = 'scim_pageplain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 5, plaintext })]);
    prisma.user.count.mockResolvedValue(100);
    prisma.user.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ noUser: true }))
      .get('/api/scim/v2/Users?startIndex=11&count=5')
      .set('Authorization', `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.startIndex).toBe(11);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 10, // startIndex - 1
      take: 5,
    }));
  });
});

describe('POST /v2/Users — create', () => {
  test('happy path: 201 + SCIM resource + bcrypt-stored password + tenantId from req.scim', async () => {
    const plaintext = 'scim_createplain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 42, plaintext })]);
    prisma.user.findUnique.mockResolvedValue(null); // no duplicate

    let createCall = null;
    prisma.user.create.mockImplementation(({ data }) => {
      createCall = data;
      return Promise.resolve({
        id: 555,
        email: data.email,
        name: data.name,
        createdAt: new Date('2026-05-25'),
        tenantId: data.tenantId,
      });
    });

    const res = await request(makeApp({ noUser: true }))
      .post('/api/scim/v2/Users')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({
        userName: 'new.user@x.io',
        name: { givenName: 'New', familyName: 'User' },
        password: 'p@ssw0rd!',
      });

    expect(res.status).toBe(201);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:User']);
    expect(res.body.id).toBe('555');
    expect(res.body.userName).toBe('new.user@x.io');
    expect(res.body.name).toEqual({ givenName: 'New', familyName: 'User', formatted: 'New User' });

    // Tenant pulled from the matched ScimToken row, NOT from any body field.
    expect(createCall.tenantId).toBe(42);
    // Password stored as bcrypt hash, NEVER plaintext.
    expect(createCall.password).toMatch(/^\$2[aby]\$/);
    expect(createCall.password).not.toBe('p@ssw0rd!');
    const ok = await bcrypt.compare('p@ssw0rd!', createCall.password);
    expect(ok).toBe(true);
    // Role defaults to USER (RBAC floor for IdP-provisioned accounts).
    expect(createCall.role).toBe('USER');
  });

  test('no userName + no emails → 400 SCIM error', async () => {
    const plaintext = 'scim_400plain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 42, plaintext })]);

    const res = await request(makeApp({ noUser: true }))
      .post('/api/scim/v2/Users')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({ name: { givenName: 'X' } });

    expect(res.status).toBe(400);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(res.body.status).toBe('400');
    expect(res.body.detail).toMatch(/userName/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  test('duplicate email → 409 SCIM error', async () => {
    const plaintext = 'scim_dupplain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 42, plaintext })]);
    prisma.user.findUnique.mockResolvedValue({ id: 1, email: 'dup@x.io' });

    const res = await request(makeApp({ noUser: true }))
      .post('/api/scim/v2/Users')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({ userName: 'dup@x.io' });

    expect(res.status).toBe(409);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(res.body.status).toBe('409');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe('GET /v2/Users/:id — single-user fetch', () => {
  test('cross-tenant id → 404 SCIM error', async () => {
    const plaintext = 'scim_404plain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 42, plaintext })]);
    prisma.user.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ noUser: true }))
      .get('/api/scim/v2/Users/999')
      .set('Authorization', `Bearer ${plaintext}`);

    expect(res.status).toBe(404);
    expect(res.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(res.body.status).toBe('404');
    // Lookup was tenant-scoped (the isolation contract).
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 999, tenantId: 42 },
    });
  });
});

describe('PATCH /v2/Users/:id — partial update', () => {
  test('replace userName updates email column + returns updated resource', async () => {
    const plaintext = 'scim_patchplain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 42, plaintext })]);
    const existing = { id: 7, email: 'old@x.io', name: 'Old Name', createdAt: new Date() };
    prisma.user.findFirst.mockResolvedValue(existing);
    prisma.user.update.mockResolvedValue({ ...existing, email: 'new@x.io' });
    prisma.user.findUnique.mockResolvedValue({ ...existing, email: 'new@x.io' });

    const res = await request(makeApp({ noUser: true }))
      .patch('/api/scim/v2/Users/7')
      .set('Authorization', `Bearer ${plaintext}`)
      .send({
        Operations: [{ op: 'replace', path: 'userName', value: 'new@x.io' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.userName).toBe('new@x.io');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { email: 'new@x.io' },
    });
  });
});

describe('DELETE /v2/Users/:id', () => {
  test('returns 204 No Content + calls prisma.user.delete', async () => {
    const plaintext = 'scim_delplain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 42, plaintext })]);
    prisma.user.findFirst.mockResolvedValue({ id: 11, email: 'gone@x.io', name: 'Gone', createdAt: new Date() });
    prisma.user.delete.mockResolvedValue({});

    const res = await request(makeApp({ noUser: true }))
      .delete('/api/scim/v2/Users/11')
      .set('Authorization', `Bearer ${plaintext}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe(''); // No Content body
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 11 } });
  });
});

describe('GET /v2/Groups — groups not modeled', () => {
  test('returns empty SCIM ListResponse', async () => {
    const plaintext = 'scim_grpplain';
    prisma.scimToken.findMany.mockResolvedValue([await tokenRow({ tenantId: 42, plaintext })]);

    const res = await request(makeApp({ noUser: true }))
      .get('/api/scim/v2/Groups')
      .set('Authorization', `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
      Resources: [],
    });
  });
});
