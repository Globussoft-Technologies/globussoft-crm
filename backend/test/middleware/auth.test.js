// Unit tests for backend/middleware/auth.js
// Covers verifyToken (header presence, JWT validity, expired tokens, portal
// token rejection, awaiting2FA, tenantId backfill, RevokedToken lookup with
// fail-open) and verifyRole (role allow-list).
//
// Note on mocking: vi.mock can't reliably intercept the SUT's CommonJS
// `require('../lib/prisma')` under the current Vitest+config in this repo,
// so we monkey-patch `prisma.revokedToken.findUnique` on the real (but
// unconnected) PrismaClient before each test. No DB connection is opened
// because Prisma connects lazily on first query, and our patched stubs
// never reach the real client.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

const prisma = require('../../lib/prisma');
const auth = require('../../middleware/auth.js');

const { verifyToken, verifyRole } = auth;
const SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// `revokedToken` may not exist on the generated Prisma client in this
// dev tree (regen has lagged behind schema). Stand it up if absent so we
// can patch findUnique.
let originalRevokedToken;
let findUniqueMock;

beforeEach(() => {
  originalRevokedToken = prisma.revokedToken;
  findUniqueMock = vi.fn();
  prisma.revokedToken = { findUnique: findUniqueMock };
});

afterEach(() => {
  if (originalRevokedToken === undefined) {
    delete prisma.revokedToken;
  } else {
    prisma.revokedToken = originalRevokedToken;
  }
});

function makeReqResNext({ headers = {}, cookies = {}, user = null } = {}) {
  // #914 slice 2: cookies are populated by the global cookie-parser
  // middleware in server.js (line 132); under unit tests we synthesise
  // the same shape — a plain object keyed by cookie name. Default to
  // `{}` so every existing test path (header-only) still passes the
  // `req.cookies && req.cookies[TOKEN_COOKIE]` falsy check and falls
  // through to the Authorization header parse.
  const req = { headers, cookies, user };
  let statusCode = 200;
  const res = {
    status: vi.fn(function (code) {
      statusCode = code;
      return this;
    }),
    json: vi.fn(function (data) {
      this.body = data;
      return this;
    }),
    // #537 (PT-05): the unauthorized() helper sets the standard
    // WWW-Authenticate response header on every 401 (RFC 7235 §4.1).
    // Mock the setter so calls don't throw "res.set is not a function".
    set: vi.fn(function () { return this; }),
    get statusCode() {
      return statusCode;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('verifyToken', () => {
  // #537 (PT-05) RFC 7235: missing Authorization header now returns 401
  // (was 403). 403 is reserved for "authenticated but not allowed". Body
  // also tightened — "Access Denied" → "Authentication required". The
  // unauthorized() helper sets the standard WWW-Authenticate response
  // header (asserted below).
  test('returns 401 when no Authorization header (was 403 — #537)', async () => {
    const { req, res, next } = makeReqResNext();
    await verifyToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 on malformed/bad token', async () => {
    const { req, res, next } = makeReqResNext({
      headers: { authorization: 'Bearer not-a-real-jwt' },
    });
    await verifyToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid Authentication Token',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 with session-expired message when token expired', async () => {
    const token = jwt.sign({ userId: 1, role: 'ADMIN', tenantId: 1 }, SECRET, {
      expiresIn: -1,
    });
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Session expired, please log in again',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects portal token (has patientId, no userId)', async () => {
    const token = jwt.sign({ patientId: 99, tenantId: 2 }, SECRET);
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid staff token (portal tokens are not allowed here)',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects token with no userId at all', async () => {
    const token = jwt.sign({ role: 'ADMIN', tenantId: 1 }, SECRET);
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects awaiting2FA temp tokens', async () => {
    const token = jwt.sign(
      { userId: 1, role: 'ADMIN', tenantId: 1, awaiting2FA: true },
      SECRET
    );
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error:
        'Two-factor authentication required. Complete 2FA verification first.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('happy path sets req.user and calls next', async () => {
    const token = jwt.sign({ userId: 7, role: 'USER', tenantId: 3 }, SECRET);
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({
      userId: 7,
      role: 'USER',
      tenantId: 3,
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  test('backfills tenantId=1 when missing from token', async () => {
    const token = jwt.sign({ userId: 5, role: 'USER' }, SECRET);
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user.tenantId).toBe(1);
  });

  test('backfills tenantId=1 when null in token', async () => {
    const token = jwt.sign(
      { userId: 5, role: 'USER', tenantId: null },
      SECRET
    );
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user.tenantId).toBe(1);
  });

  // #555 (HI-06): the SPA's tenant switcher mirrors the chosen tenantId
  // into the X-Active-Tenant header on every API call. Today the only
  // legal value is the JWT's own tenantId (single-tenant data model);
  // cross-tenant values are silently ignored so a stale localStorage
  // value from a previous session can't 401 the user.
  test('X-Active-Tenant matching the JWT tenantId is mirrored into req.user.activeTenantId', async () => {
    const token = jwt.sign({ userId: 7, role: 'USER', tenantId: 3 }, SECRET);
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}`, 'x-active-tenant': '3' },
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user.activeTenantId).toBe(3);
  });

  test('X-Active-Tenant NOT matching the JWT tenantId is silently ignored', async () => {
    const token = jwt.sign({ userId: 7, role: 'USER', tenantId: 3 }, SECRET);
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}`, 'x-active-tenant': '99' },
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user.activeTenantId).toBeUndefined();
    expect(req.user.tenantId).toBe(3);
  });

  test('returns 401 Session revoked when jti is in RevokedToken', async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 42 });
    const token = jwt.sign(
      { userId: 1, role: 'ADMIN', tenantId: 1, jti: 'revoked-jti' },
      SECRET
    );
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { jti: 'revoked-jti' },
      select: { id: true },
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Session revoked. Please log in again.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('passes through when jti is NOT revoked', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const token = jwt.sign(
      { userId: 1, role: 'ADMIN', tenantId: 1, jti: 'fresh-jti' },
      SECRET
    );
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user.jti).toBe('fresh-jti');
  });

  test('fails open when revokedToken lookup throws (DB blip)', async () => {
    findUniqueMock.mockRejectedValueOnce(new Error('DB down'));
    const token = jwt.sign(
      { userId: 1, role: 'ADMIN', tenantId: 1, jti: 'some-jti' },
      SECRET
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ userId: 1, jti: 'some-jti' });
    errSpy.mockRestore();
  });

  test('skips revoked-token lookup when jti claim is absent', async () => {
    const token = jwt.sign({ userId: 1, role: 'ADMIN', tenantId: 1 }, SECRET);
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    await verifyToken(req, res, next);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  // ───────────────────────────────────────────────────────────────────────
  // #914 slice 2 — auth_token cookie read path.
  //
  // Slice 1 (commit f9ded16f) began sending an HttpOnly `auth_token` cookie
  // alongside the response-body JWT on every auth-success path (login,
  // signup, register, 2fa-verify). Slice 2 is the corresponding READ side:
  // verifyToken now consults `req.cookies.auth_token` BEFORE falling back
  // to the Authorization header. Header path stays valid (additive, no
  // breaking change) so the entire migration window — frontend +
  // localStorage, every e2e spec, every Playwright API spec, every SDK
  // consumer — keeps working unchanged.
  //
  // The four cases below pin: (a) cookie alone authenticates; (b) header
  // alone still authenticates (regression guard on existing path);
  // (c) HEADER wins when both are present (precedence — see below for
  // why this was inverted from the initial cookie-first design); (d)
  // neither still 401s with the canonical "Authentication required"
  // envelope (no new failure-mode copy).
  //
  // Precedence note (revised from cookie-first): Playwright's api request
  // fixture persists cookies across specs in the same context. A spec
  // that authenticated set a cookie (from slice 1's Set-Cookie) that then
  // overrode the next spec's explicit `Authorization: Bearer <X>` header.
  // For api_tests / e2e correctness, header MUST win when both are
  // present — the explicit Authorization header is the load-bearing
  // identity signal in every existing test and SDK consumer. Cookies
  // remain the auth path for cookie-only browser clients (slice 3+).
  // ───────────────────────────────────────────────────────────────────────
  test('#914 slice 2: authenticates from auth_token cookie when no Authorization header', async () => {
    const token = jwt.sign({ userId: 11, role: 'USER', tenantId: 3 }, SECRET);
    const { req, res, next } = makeReqResNext({
      cookies: { auth_token: token },
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ userId: 11, role: 'USER', tenantId: 3 });
    expect(res.status).not.toHaveBeenCalled();
  });

  test('#914 slice 2: header path still works when no cookie is present (no regression)', async () => {
    const token = jwt.sign({ userId: 12, role: 'ADMIN', tenantId: 1 }, SECRET);
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ userId: 12, role: 'ADMIN', tenantId: 1 });
    expect(res.status).not.toHaveBeenCalled();
  });

  test('#914 slice 2 (revised): HEADER wins precedence when BOTH cookie and Authorization header are present', async () => {
    // The initial slice-2 design had cookie-first but that broke
    // api_tests because Playwright's request fixture persists cookies
    // across specs in the same context — a spec that authenticated set
    // a cookie that then overrode the next spec's explicit Bearer header,
    // picking the first spec's user for tenant-isolation assertions.
    // Token payloads differ so we can assert which one populated req.user.
    const cookieToken = jwt.sign({ userId: 100, role: 'ADMIN', tenantId: 5 }, SECRET);
    const headerToken = jwt.sign({ userId: 999, role: 'USER', tenantId: 9 }, SECRET);
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${headerToken}` },
      cookies: { auth_token: cookieToken },
    });
    await verifyToken(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    // Header's userId=999 wins, cookie's userId=100 ignored.
    expect(req.user.userId).toBe(999);
    expect(req.user.tenantId).toBe(9);
    expect(req.user.role).toBe('USER');
  });

  test('#914 slice 2: 401 with canonical envelope when NEITHER cookie nor Authorization header is present', async () => {
    const { req, res, next } = makeReqResNext({ cookies: {}, headers: {} });
    await verifyToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('verifyRole', () => {
  test('next() when role matches', () => {
    const mw = verifyRole(['ADMIN']);
    const { req, res, next } = makeReqResNext({
      user: { userId: 1, role: 'ADMIN' },
    });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('next() when role is one of several allowed', () => {
    const mw = verifyRole(['ADMIN', 'MANAGER']);
    const { req, res, next } = makeReqResNext({
      user: { userId: 1, role: 'MANAGER' },
    });
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  // #590 / #591: canonical RBAC denial envelope. Pre-fix, three
  // different denial strings shipped — verifyRole's "Insufficient Role
  // Permissions. System Admin Required." leaked the role name "System
  // Admin" (enumeration-helpful) and was inconsistent with
  // verifyWellnessRole's separate copy. Now both gates emit the SAME
  // neutral message (no role-taxonomy leakage) plus a stable code so
  // SDKs / frontend / specs can distinguish RBAC from generic 403s.
  test('403 with canonical RBAC_DENIED envelope when role does not match (#590 / #591)', () => {
    const mw = verifyRole(['ADMIN']);
    const { req, res, next } = makeReqResNext({
      user: { userId: 1, role: 'USER' },
    });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error:
        "You don't have permission to perform this action. Contact your administrator.",
      code: 'RBAC_DENIED',
    });
    // No role-taxonomy leakage — body must NOT mention internal role
    // tokens ("System Admin", "ADMIN", "wellness role", "doctor", etc.)
    // per #591. The neutral copy contains the word "administrator"
    // which is the user-facing escalation path, not a role-token —
    // we explicitly check for the leaked taxonomy strings.
    const body = res.json.mock.calls[0][0];
    expect(body.error).not.toMatch(/system admin|wellness role|\bADMIN\b|\bMANAGER\b|\bdoctor\b|\bprofessional\b|\btelecaller\b|\bhelper\b/i);
    expect(next).not.toHaveBeenCalled();
  });

  test('403 with canonical RBAC_DENIED envelope when req.user is null (#590 / #591)', () => {
    const mw = verifyRole(['ADMIN']);
    const { req, res, next } = makeReqResNext({ user: null });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error:
        "You don't have permission to perform this action. Contact your administrator.",
      code: 'RBAC_DENIED',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when req.user is undefined', () => {
    const mw = verifyRole(['ADMIN']);
    const req = { headers: {} };
    let statusCode = 200;
    const res = {
      status: vi.fn(function (c) {
        statusCode = c;
        return this;
      }),
      json: vi.fn(),
      get statusCode() {
        return statusCode;
      },
    };
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
