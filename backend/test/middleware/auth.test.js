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

function makeReqResNext({ headers = {}, user = null } = {}) {
  const req = { headers, user };
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
    expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="api"');
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

  test('403 when role does not match', () => {
    const mw = verifyRole(['ADMIN']);
    const { req, res, next } = makeReqResNext({
      user: { userId: 1, role: 'USER' },
    });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Insufficient Role Permissions. System Admin Required.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when req.user is null', () => {
    const mw = verifyRole(['ADMIN']);
    const { req, res, next } = makeReqResNext({ user: null });
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
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
