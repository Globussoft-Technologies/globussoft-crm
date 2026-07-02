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

  test('returns 401 on malformed key (does not match glbs_<hex48+>)', async () => {
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
      headers: { 'x-api-key': 'glbs_' + 'a'.repeat(48) },
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
      headers: { 'x-api-key': 'glbs_' + 'b'.repeat(48) },
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
      headers: { 'x-api-key': 'glbs_' + 'c'.repeat(48) },
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
      keySecret: 'glbs_' + 'd'.repeat(48),
      tenant,
    };
    findUniqueMock.mockResolvedValueOnce(apiKey);
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'd'.repeat(48) },
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
      keySecret: 'glbs_' + 'e'.repeat(48),
      tenant,
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'e'.repeat(48) },
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
      headers: { 'x-api-key': 'glbs_' + 'f'.repeat(48) },
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
      headers: { 'X-API-Key': 'glbs_' + '1'.repeat(48) },
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
      headers: { 'x-api-key': 'glbs_' + '2'.repeat(48) },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Authentication failure',
    });
    errSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Extension wave (+6 cases): whitespace handling, hex-too-short malformation,
  // case-insensitive hex acceptance, prisma query shape, sub-brand helper
  // wiring (null vs set), and the requireSubBrandMatchOrSend 403 surface.
  // -------------------------------------------------------------------------

  test('whitespace-only X-API-Key trims to empty and returns 401 missing', async () => {
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': '   \t  ' },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Missing X-API-Key header',
    });
    expect(next).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('returns 401 malformed when hex segment is shorter than 32 chars', async () => {
    // Per regex /^glbs_[a-f0-9]{32,}$/i — 31 hex chars fails.
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'a'.repeat(31) },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Malformed API key' });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('accepts uppercase hex characters in the key (case-insensitive regex)', async () => {
    const upperKey = 'glbs_' + 'A'.repeat(48);
    findUniqueMock.mockResolvedValueOnce({
      id: 50,
      tenantId: 3,
      userId: 9,
      keySecret: upperKey,
      tenant: { id: 3, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': upperKey },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { keySecret: upperKey },
      include: { tenant: true },
    });
  });

  test('trims surrounding whitespace before lookup (token passed without padding)', async () => {
    const cleanKey = 'glbs_' + '7'.repeat(48);
    findUniqueMock.mockResolvedValueOnce({
      id: 71,
      tenantId: 8,
      userId: 12,
      keySecret: cleanKey,
      tenant: { id: 8, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': `   ${cleanKey}  \t` },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    // Confirm the trimmed token (not the padded form) was used in the DB lookup.
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { keySecret: cleanKey },
      include: { tenant: true },
    });
  });

  test('tenant-wide key (subBrand=null) installs req.apiKeySubBrand=null and requireSubBrandMatch passes any target', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 200,
      tenantId: 4,
      userId: 1,
      subBrand: null,
      tenant: { id: 4, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + '3'.repeat(48) },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.apiKeySubBrand).toBeNull();
    // A tenant-wide key should accept any sub-brand target.
    expect(typeof req.requireSubBrandMatch).toBe('function');
    expect(req.requireSubBrandMatch('rfu')).toBe(true);
    expect(req.requireSubBrandMatch('tmc')).toBe(true);
  });

  test('scoped key (subBrand=rfu) installs helper that 403s via requireSubBrandMatchOrSend on mismatch', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 201,
      tenantId: 4,
      userId: 1,
      subBrand: 'rfu',
      tenant: { id: 4, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + '4'.repeat(48) },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.apiKeySubBrand).toBe('rfu');
    // Match path: returns true.
    expect(req.requireSubBrandMatch('rfu')).toBe(true);
    // Mismatch path through the *OrSend variant: writes 403 SUB_BRAND_MISMATCH and returns false.
    const fakeRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const ok = req.requireSubBrandMatchOrSend('tmc', fakeRes);
    expect(ok).toBe(false);
    expect(fakeRes.status).toHaveBeenCalledWith(403);
    expect(fakeRes.json).toHaveBeenCalledWith({
      error: "API key scoped to 'rfu' cannot post for sub-brand 'tmc'",
      code: 'SUB_BRAND_MISMATCH',
    });
  });

  // -------------------------------------------------------------------------
  // Raw hex key support wave (+6 cases): accept raw hex keys from external
  // partners (e.g. GlobusPhone) without glbs_ prefix. Both formats valid.
  // -------------------------------------------------------------------------

  test('accepts raw hex key (48 chars) without glbs_ prefix', async () => {
    const rawKey = '83000168aabbccddeeff0011223344556677889900112233445566778899';
    findUniqueMock.mockResolvedValueOnce({
      id: 300,
      tenantId: 9,
      userId: 5,
      keySecret: rawKey,
      tenant: { id: 9, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': rawKey },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { keySecret: rawKey },
      include: { tenant: true },
    });
  });

  test('accepts raw hex key at maximum length (96 chars)', async () => {
    const rawKey = 'a'.repeat(96);
    findUniqueMock.mockResolvedValueOnce({
      id: 301,
      tenantId: 10,
      userId: 6,
      keySecret: rawKey,
      tenant: { id: 10, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': rawKey },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 malformed when raw hex is too short (< 48 chars)', async () => {
    const tooShort = 'a'.repeat(47);
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': tooShort },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Malformed API key' });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('returns 401 malformed when raw hex is too long (> 96 chars)', async () => {
    const tooLong = 'b'.repeat(97);
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': tooLong },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Malformed API key' });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('returns 401 invalid when raw hex key not found in database', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const rawKey = 'c'.repeat(48);
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': rawKey },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
  });

  test('accepts raw hex key with mixed case (A-F uppercase)', async () => {
    const mixedKey = 'F'.repeat(24) + '0'.repeat(24);
    findUniqueMock.mockResolvedValueOnce({
      id: 302,
      tenantId: 11,
      userId: 7,
      keySecret: mixedKey,
      tenant: { id: 11, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': mixedKey },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
