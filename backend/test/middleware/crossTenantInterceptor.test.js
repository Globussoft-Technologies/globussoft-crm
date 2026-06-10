// @ts-check
/**
 * Unit tests for backend/middleware/crossTenantInterceptor.js — PRD_TRAVEL_
 * SECURITY_ARCHITECTURE FR-3.7 (S5).
 *
 * The middleware sits in front of `/:id`-bearing routes and asserts the row
 * at `:id` actually belongs to the requesting tenant BEFORE the handler
 * runs. On cross-tenant mismatch: write a SecurityIncident row +
 * 404 NOT_FOUND. Same-tenant / no row / no auth / unknown model: pass
 * through.
 *
 * What this file pins
 * ───────────────────
 *   1. Same-tenant access → next() called, no incident write, no response.
 *   2. Cross-tenant access → SecurityIncident.create called with the right
 *      shape AND 404 returned with body { error: 'NOT_FOUND' }.
 *   3. Row doesn't exist → next() called (handler will 404 naturally), no
 *      incident write.
 *   4. Invalid :id param (NaN / 0 / negative) → next() called, no DB hit.
 *   5. Unauthenticated request (no req.user) → next() called, no DB hit.
 *   6. Unknown model name → next() called (defensive no-op), no DB hit.
 *   7. Prisma findUnique throws → next() called (handler still tries),
 *      no incident write.
 *   8. Incident persist throws → still 404 (telemetry never blocks
 *      response).
 *   9. SecurityIncident.create receives the canonical fields
 *      (attemptedModel, attemptedRowId, attemptedRowTenantId,
 *      requestingUserId, requestPath, requestMethod) in reportJson.
 *
 * Pattern: monkey-patch prisma singleton's delegates with vi.fn() surfaces
 * BEFORE the middleware is required. The middleware is pure with respect
 * to express — pass a fake req/res/next directly.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Replace the Prisma delegates the middleware touches BEFORE requiring it.
// We don't need any real Prisma client behavior — the middleware destructures
// `prisma.<modelName>` and calls .findUnique on it.
prisma.contact = {
  findUnique: vi.fn(),
};
prisma.securityIncident = {
  create: vi.fn(),
};

const { interceptCrossTenant } = requireCJS(
  '../../middleware/crossTenantInterceptor',
);

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status: vi.fn(function (c) {
      this.statusCode = c;
      return this;
    }),
    json: vi.fn(function (data) {
      this.body = data;
      return this;
    }),
  };
  return res;
}

function makeReq({
  id = '5',
  tenantId = 1,
  userId = 7,
  withAuth = true,
  url = '/api/contacts/5',
  method = 'GET',
} = {}) {
  return {
    params: { id },
    user: withAuth ? { userId, tenantId } : undefined,
    headers: { 'user-agent': 'vitest-agent' },
    ip: '127.0.0.1',
    originalUrl: url,
    url,
    method,
  };
}

beforeEach(() => {
  prisma.contact.findUnique.mockReset();
  prisma.securityIncident.create.mockReset();
  prisma.securityIncident.create.mockResolvedValue({ id: 99 });
});

// ─────────────────────────────────────────────────────────────────────
// 1. Same-tenant access — pass through
// ─────────────────────────────────────────────────────────────────────

describe('interceptCrossTenant — same-tenant access', () => {
  test('row.tenantId matches req.user.tenantId → next() called, no incident', async () => {
    prisma.contact.findUnique.mockResolvedValue({ tenantId: 1 });
    const req = makeReq({ tenantId: 1 });
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(prisma.securityIncident.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Cross-tenant access — incident + 404
// ─────────────────────────────────────────────────────────────────────

describe('interceptCrossTenant — cross-tenant access', () => {
  test('row.tenantId ≠ req.user.tenantId → 404 + incident persisted', async () => {
    prisma.contact.findUnique.mockResolvedValue({ tenantId: 99 });
    const req = makeReq({ id: '42', tenantId: 1, userId: 7 });
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
    expect(prisma.securityIncident.create).toHaveBeenCalledTimes(1);
    const data = prisma.securityIncident.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(1); // the REQUESTING tenant, not the target
    expect(data.incidentType).toBe('cross-tenant-attempt');
    expect(data.severity).toBe('high');
    expect(data.ipAddress).toBe('127.0.0.1');
    expect(data.userAgent).toBe('vitest-agent');
    expect(data.url).toBe('/api/contacts/5'); // NB: makeReq default id=5 here
  });

  test('reportJson carries the canonical attempt fields', async () => {
    prisma.contact.findUnique.mockResolvedValue({ tenantId: 99 });
    const req = makeReq({
      id: '42',
      tenantId: 1,
      userId: 7,
      url: '/api/contacts/42',
      method: 'GET',
    });
    const res = makeRes();
    await interceptCrossTenant('contact')(req, res, vi.fn());
    const reportJson =
      prisma.securityIncident.create.mock.calls[0][0].data.reportJson;
    const parsed = JSON.parse(reportJson);
    expect(parsed.attemptedModel).toBe('contact');
    expect(parsed.attemptedRowId).toBe(42);
    expect(parsed.attemptedRowTenantId).toBe(99);
    expect(parsed.requestingUserId).toBe(7);
    expect(parsed.requestPath).toBe('/api/contacts/42');
    expect(parsed.requestMethod).toBe('GET');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Row doesn't exist
// ─────────────────────────────────────────────────────────────────────

describe('interceptCrossTenant — row missing', () => {
  test('findUnique returns null → next() called, no incident', async () => {
    prisma.contact.findUnique.mockResolvedValue(null);
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(prisma.securityIncident.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Invalid :id param
// ─────────────────────────────────────────────────────────────────────

describe('interceptCrossTenant — invalid id param', () => {
  test('id="abc" → next() called, no DB hit', async () => {
    const req = makeReq({ id: 'abc' });
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('id="0" → next() called (Prisma auto-inc starts at 1)', async () => {
    const req = makeReq({ id: '0' });
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('id="-1" → next() called', async () => {
    const req = makeReq({ id: '-1' });
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('id missing entirely → next() called', async () => {
    const req = { params: {}, user: { userId: 7, tenantId: 1 }, headers: {} };
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. Unauthenticated
// ─────────────────────────────────────────────────────────────────────

describe('interceptCrossTenant — unauthenticated', () => {
  test('req.user undefined → next() called, no DB hit', async () => {
    const req = makeReq({ withAuth: false });
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('req.user.tenantId missing → next() called', async () => {
    const req = {
      params: { id: '5' },
      user: { userId: 7 },
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Unknown model name
// ─────────────────────────────────────────────────────────────────────

describe('interceptCrossTenant — unknown model', () => {
  test('non-existent prisma delegate → next() called, no DB hit', async () => {
    // 'doesNotExist' is not a prisma delegate
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('doesNotExist')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. Prisma findUnique throws
// ─────────────────────────────────────────────────────────────────────

describe('interceptCrossTenant — Prisma error', () => {
  test('findUnique throws → next() called (handler can still attempt)', async () => {
    prisma.contact.findUnique.mockRejectedValue(new Error('DB down'));
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(prisma.securityIncident.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. Telemetry persist failure
// ─────────────────────────────────────────────────────────────────────

describe('interceptCrossTenant — incident persist failure', () => {
  test('SecurityIncident.create throws → still 404 (telemetry never blocks)', async () => {
    prisma.contact.findUnique.mockResolvedValue({ tenantId: 99 });
    prisma.securityIncident.create.mockRejectedValue(new Error('disk full'));
    const req = makeReq({ tenantId: 1 });
    const res = makeRes();
    const next = vi.fn();
    await interceptCrossTenant('contact')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
    expect(next).not.toHaveBeenCalled();
  });
});
