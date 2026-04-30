// Unit tests for backend/middleware/externalAuth.js
// Covers X-API-Key validation: missing/malformed key 401s, invalid key 401s,
// inactive tenant 403s, happy path populates req.{apiKey,tenant,tenantId,user}
// and triggers a best-effort lastUsed update.
//
// Mocking note: vi.mock can't reliably intercept the SUT's CJS
// `require('../lib/prisma')` here, so we monkey-patch the relevant prisma
// methods on the shared client. Prisma connects lazily — no live DB hit
// because we never invoke the real method.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const prisma = require('../../lib/prisma');
const externalAuth = require('../../middleware/externalAuth.js');

let originalFindUnique;
let originalUpdate;
let findUniqueMock;
let updateMock;

beforeEach(() => {
  originalFindUnique = prisma.apiKey.findUnique;
  originalUpdate = prisma.apiKey.update;
  findUniqueMock = vi.fn();
  updateMock = vi.fn().mockResolvedValue({});
  prisma.apiKey.findUnique = findUniqueMock;
  prisma.apiKey.update = updateMock;
});

afterEach(() => {
  prisma.apiKey.findUnique = originalFindUnique;
  prisma.apiKey.update = originalUpdate;
});

function makeReqResNext({ headers = {} } = {}) {
  // Lower-case keys; req.header() looks up case-insensitively.
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  const req = {
    headers: lower,
    header(name) {
      return lower[String(name).toLowerCase()];
    },
  };
  let statusCode = 200;
  const res = {
    status: vi.fn(function (c) {
      statusCode = c;
      return this;
    }),
    json: vi.fn(function (data) {
      this.body = data;
      return this;
    }),
    get statusCode() {
      return statusCode;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('externalAuth', () => {
  test('returns 401 when no X-API-Key header', async () => {
    const { req, res, next } = makeReqResNext();
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Missing X-API-Key header',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 on malformed key (does not match glbs_<hex32+>)', async () => {
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'not-a-key' },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Malformed API key' });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 on bogus key (prisma returns null)', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'a'.repeat(32) },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 when tenant is not active', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 11,
      tenantId: 5,
      userId: 2,
      tenant: { id: 5, isActive: false, name: 'Stale Inc' },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'b'.repeat(32) },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Tenant is not active' });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 when tenant is missing entirely', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 12,
      tenantId: 5,
      userId: 2,
      tenant: null,
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'c'.repeat(32) },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('happy path: populates req.user/tenant/apiKey and calls next', async () => {
    const tenant = { id: 7, isActive: true, name: 'Wellness' };
    const apiKey = {
      id: 99,
      tenantId: 7,
      userId: 4,
      keySecret: 'glbs_' + 'd'.repeat(32),
      tenant,
    };
    findUniqueMock.mockResolvedValueOnce(apiKey);
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'd'.repeat(32) },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.apiKey).toBe(apiKey);
    expect(req.tenant).toBe(tenant);
    expect(req.tenantId).toBe(7);
    expect(req.user).toEqual({ tenantId: 7, id: 4, apiKeyId: 99 });
  });

  test('happy path triggers best-effort lastUsed update', async () => {
    const tenant = { id: 7, isActive: true };
    findUniqueMock.mockResolvedValueOnce({
      id: 99,
      tenantId: 7,
      userId: 4,
      keySecret: 'glbs_' + 'e'.repeat(32),
      tenant,
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'e'.repeat(32) },
    });
    await externalAuth(req, res, next);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { lastUsed: expect.any(Date) },
    });
  });

  test('lastUsed update failure is swallowed (still calls next)', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 99,
      tenantId: 7,
      userId: 4,
      tenant: { id: 7, isActive: true },
    });
    updateMock.mockRejectedValueOnce(new Error('write failed'));
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'f'.repeat(32) },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    // Allow the swallowed promise to settle so it doesn't leak into another test.
    await Promise.resolve();
  });

  test('accepts X-API-Key header with mixed case', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 1,
      tenantId: 1,
      userId: 1,
      tenant: { id: 1, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'X-API-Key': 'glbs_' + '1'.repeat(32) },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('returns 500 when an unexpected error escapes the try block', async () => {
    findUniqueMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + '2'.repeat(32) },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Authentication failure',
    });
    errSpy.mockRestore();
  });
});
