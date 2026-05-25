// Unit tests for backend/middleware/voyagrAuth.js
//
// Covers the voyagr (OJR) CMS lead-capture endpoint's API-key auth (mounted
// at /api/v1/voyagr/leads in routes/voyagr.js). Mirrors externalAuth.test.js
// in shape — both middlewares share the same ApiKey lookup flow — but
// voyagrAuth diverges in three ways that this suite pins explicitly:
//
//   1. Structured-error response shape: every error response carries
//      { error, code } (e.g. code: 'MISSING_API_KEY' / 'MALFORMED_API_KEY' /
//      'INVALID_API_KEY' / 'TENANT_INACTIVE' / 'AUTH_FAILURE'), matching the
//      rest of the v3.x route surface. externalAuth still emits bare
//      { error } strings.
//
//   2. req.voyagrApiKey alias — populated alongside req.apiKey on the happy
//      path so the route handler can attach the key's name to audit-log
//      payloads for forensic attribution (F1 acceptance criteria).
//
//   3. req.user.userId (not req.user.id) — voyagrAuth follows the project's
//      ESLint-enforced JWT convention. externalAuth predates the rule and
//      still uses `id`.
//
// Plus the shared sub-brand helpers from backend/lib/apiKeyAuth.js are
// installed on the happy path — we pin req.apiKeySubBrand + the two
// require* helper functions exist, but defer the helpers' own semantics
// to backend/test/lib/apiKeyAuth.test.js.
//
// Mocking note: vi.mock can't reliably intercept the SUT's CJS
// `require('../lib/prisma')` here, so we monkey-patch the relevant prisma
// methods on the shared client. Prisma connects lazily — no live DB hit
// because we never invoke the real method.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const prisma = require('../../lib/prisma');
const voyagrAuth = require('../../middleware/voyagrAuth.js');

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

describe('voyagrAuth', () => {
  test('returns 401 MISSING_API_KEY when no X-API-Key header', async () => {
    const { req, res, next } = makeReqResNext();
    await voyagrAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Missing X-API-Key header',
      code: 'MISSING_API_KEY',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 MISSING_API_KEY when header present but only whitespace', async () => {
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': '   ' },
    });
    await voyagrAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Missing X-API-Key header',
      code: 'MISSING_API_KEY',
    });
    expect(next).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('returns 401 MALFORMED_API_KEY on key not matching glbs_<hex32+>', async () => {
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'not-a-key' },
    });
    await voyagrAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Malformed API key',
      code: 'MALFORMED_API_KEY',
    });
    expect(next).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('returns 401 MALFORMED_API_KEY when hex segment is too short (<32 chars)', async () => {
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'a'.repeat(31) },
    });
    await voyagrAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Malformed API key',
      code: 'MALFORMED_API_KEY',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 INVALID_API_KEY when prisma returns null (key not found)', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'a'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid API key',
      code: 'INVALID_API_KEY',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 TENANT_INACTIVE when tenant.isActive is false', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 11,
      tenantId: 5,
      userId: 2,
      tenant: { id: 5, isActive: false, name: 'Stale Inc' },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'b'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Tenant is not active',
      code: 'TENANT_INACTIVE',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 TENANT_INACTIVE when tenant relation is missing entirely', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 12,
      tenantId: 5,
      userId: 2,
      tenant: null,
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'c'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Tenant is not active',
      code: 'TENANT_INACTIVE',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('happy path: populates req.{apiKey,voyagrApiKey,tenant,tenantId,user} and calls next', async () => {
    const tenant = { id: 7, isActive: true, name: 'Travel Tenant' };
    const apiKey = {
      id: 99,
      tenantId: 7,
      userId: 4,
      keySecret: 'glbs_' + 'd'.repeat(32),
      name: 'voyagr-tmc-prod',
      subBrand: null,
      tenant,
    };
    findUniqueMock.mockResolvedValueOnce(apiKey);
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'd'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.apiKey).toBe(apiKey);
    // voyagrAuth-specific: req.voyagrApiKey alias for audit-log forensic attribution.
    expect(req.voyagrApiKey).toBe(apiKey);
    expect(req.tenant).toBe(tenant);
    expect(req.tenantId).toBe(7);
    // voyagrAuth uses userId (JWT convention); externalAuth still uses id.
    expect(req.user).toEqual({ tenantId: 7, userId: 4, apiKeyId: 99 });
  });

  test('happy path: installs sub-brand helpers (tenant-wide key → apiKeySubBrand=null)', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 100,
      tenantId: 7,
      userId: 4,
      keySecret: 'glbs_' + '0'.repeat(32),
      subBrand: null,
      tenant: { id: 7, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + '0'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.apiKeySubBrand).toBeNull();
    expect(typeof req.requireSubBrandMatch).toBe('function');
    expect(typeof req.requireSubBrandMatchOrSend).toBe('function');
    // Tenant-wide keys accept any sub-brand target.
    expect(req.requireSubBrandMatch('tmc')).toBe(true);
  });

  test('happy path: installs sub-brand helpers (scoped key → apiKeySubBrand=tmc)', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 101,
      tenantId: 7,
      userId: 4,
      keySecret: 'glbs_' + '1'.repeat(32),
      subBrand: 'tmc',
      tenant: { id: 7, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + '1'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.apiKeySubBrand).toBe('tmc');
    // Matching sub-brand accepted.
    expect(req.requireSubBrandMatch('tmc')).toBe(true);
    // Mismatched sub-brand throws SUB_BRAND_MISMATCH.
    expect(() => req.requireSubBrandMatch('rfu')).toThrowError(
      /sub-brand scope does not match/i
    );
  });

  test('happy path triggers best-effort lastUsed update', async () => {
    const tenant = { id: 7, isActive: true };
    findUniqueMock.mockResolvedValueOnce({
      id: 99,
      tenantId: 7,
      userId: 4,
      keySecret: 'glbs_' + 'e'.repeat(32),
      subBrand: null,
      tenant,
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'e'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
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
      subBrand: null,
      tenant: { id: 7, isActive: true },
    });
    updateMock.mockRejectedValueOnce(new Error('write failed'));
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + 'f'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    // Allow the swallowed promise to settle so it doesn't leak into another test.
    await Promise.resolve();
  });

  test('accepts X-API-Key header with mixed case', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 1,
      tenantId: 1,
      userId: 1,
      subBrand: null,
      tenant: { id: 1, isActive: true },
    });
    const { req, res, next } = makeReqResNext({
      headers: { 'X-API-Key': 'glbs_' + '1'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('returns 500 AUTH_FAILURE when an unexpected error escapes the try block', async () => {
    findUniqueMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res, next } = makeReqResNext({
      headers: { 'x-api-key': 'glbs_' + '2'.repeat(32) },
    });
    await voyagrAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Authentication failure',
      code: 'AUTH_FAILURE',
    });
    expect(next).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
