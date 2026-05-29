// @ts-check
/**
 * Unit tests for backend/controllers/audienceController.js — pin the wire
 * contract of the only export, `getContactsByStatus`, which powers the
 * GET /api/contacts/by-status surface used by Marketing audience selection.
 *
 * Why this file exists
 * ────────────────────
 * The entire `backend/controllers/` directory had ZERO sibling unit tests
 * — the test-coverage cron's T1 strict-scan walks lib/services/middleware/
 * cron but NOT controllers/, so the layer was silently uncovered. This
 * file backfills audienceController.js (143 LOC, 1 export).
 *
 * The route is mounted at routes/contacts.js:147 under verifyToken — so
 * req.user.tenantId is guaranteed populated by the global auth guard
 * before the controller fires. We invoke the controller function DIRECTLY
 * with a mock req/res (no Express, no JWT) — the controller is a pure
 * (req, res) -> response shape, which makes direct-invocation cleaner than
 * supertest for a single-function surface.
 *
 * The SUT constructs `new PrismaClient()` at module-load (not the shared
 * lib/prisma singleton), so we vi.mock('@prisma/client') with a hoisted
 * factory that hands back our stub before the controller require fires.
 *
 * Cases (12 total)
 * ────────────────
 *   getContactsByStatus (12):
 *     1. happy path — explicit status=Lead returns 200 + contact array
 *     2. default status — no query param falls back to "Customer"
 *     3. empty result — returns 200 with count=0 + empty data + tailored message
 *     4. tenant isolation — query.where always includes req.user.tenantId
 *     5. orderBy — results ordered by createdAt desc
 *     6. case-sensitive status — "lead" (lowercase) used verbatim, not normalised
 *     7. each enum value — Lead/Prospect/Customer/Churned all forwarded as-is
 *     8. arbitrary status string — controller does NOT validate against enum
 *     9. prisma throws — returns 500 with {success:false, message, status:500}
 *    10. count reflects array length, not a separate prisma count() call
 *    11. response includes ALL fields prisma returned (no field stripping)
 *    12. different tenants get different where clauses (cross-tenant guard)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── Mock @prisma/client BEFORE the controller require ──────────────────
// The controller does `const prisma = new PrismaClient()` at module-load.
// Because `controllers/` is NOT in vitest.config.js's `inline` list, the
// SUT's `require('@prisma/client')` bypasses vitest's transformer and
// `vi.mock('@prisma/client')` would never intercept. Workaround: replace
// the `PrismaClient` export on the resolved CJS module with a stub class
// BEFORE requiring the SUT. When the SUT then does `new PrismaClient()`
// it constructs OUR stub, whose `.contact.findMany` is the mock.
//
// Why not prototype-patch: prisma's generated PrismaClient sets `.contact`
// as an INSTANCE property inside the constructor, which shadows any
// prototype property of the same name.
const mockFindMany = vi.fn();
const prismaClientModule = requireCJS('@prisma/client');
prismaClientModule.PrismaClient = class StubPrismaClient {
  constructor() {
    this.contact = { findMany: mockFindMany };
  }
};

const audienceController = requireCJS('../../controllers/audienceController');

function makeReq({ status, tenantId = 1, userId = 7 } = {}) {
  return {
    query: status === undefined ? {} : { status },
    user: { userId, tenantId, role: 'USER' },
  };
}

function makeRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  mockFindMany.mockReset();
});

describe('audienceController.getContactsByStatus — Marketing audience surface', () => {
  it('200 with rows when an explicit status returns contacts', async () => {
    const rows = [
      { id: 1, name: 'Aarti Sharma', email: 'aarti@example.com', status: 'Lead', tenantId: 1, createdAt: new Date('2026-05-20') },
      { id: 2, name: 'Vivek Iyer', email: 'vivek@example.com', status: 'Lead', tenantId: 1, createdAt: new Date('2026-05-19') },
    ];
    mockFindMany.mockResolvedValue(rows);

    const req = makeReq({ status: 'Lead' });
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Contacts fetched successfully',
      count: 2,
      data: rows,
    });
  });

  it('falls back to status="Customer" when no query param is provided', async () => {
    mockFindMany.mockResolvedValue([]);

    const req = makeReq(); // no status
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const callArgs = mockFindMany.mock.calls[0][0];
    expect(callArgs.where.status).toBe('Customer');
  });

  it('returns 200 with count=0 + tailored message when no contacts match', async () => {
    mockFindMany.mockResolvedValue([]);

    const req = makeReq({ status: 'Churned' });
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'No contacts found for status Churned',
      count: 0,
      data: [],
    });
  });

  it('always scopes the prisma query by req.user.tenantId (tenant isolation)', async () => {
    mockFindMany.mockResolvedValue([]);

    const req = makeReq({ status: 'Lead', tenantId: 42 });
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const callArgs = mockFindMany.mock.calls[0][0];
    expect(callArgs.where.tenantId).toBe(42);
    expect(callArgs.where.status).toBe('Lead');
  });

  it('orders results by createdAt desc', async () => {
    mockFindMany.mockResolvedValue([]);

    const req = makeReq({ status: 'Prospect' });
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    const callArgs = mockFindMany.mock.calls[0][0];
    expect(callArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('passes status verbatim without case-normalisation (case-sensitive)', async () => {
    mockFindMany.mockResolvedValue([]);

    const req = makeReq({ status: 'lead' }); // lowercase
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    const callArgs = mockFindMany.mock.calls[0][0];
    expect(callArgs.where.status).toBe('lead'); // not "Lead"
  });

  it.each([
    ['Lead'],
    ['Prospect'],
    ['Customer'],
    ['Churned'],
  ])('forwards documented enum value %s without modification', async (statusValue) => {
    mockFindMany.mockResolvedValue([]);

    const req = makeReq({ status: statusValue });
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    const callArgs = mockFindMany.mock.calls[0][0];
    expect(callArgs.where.status).toBe(statusValue);
  });

  it('does NOT validate status against the documented enum — arbitrary strings pass through', async () => {
    // Surfaces a real contract gap: the swagger docs claim status is an enum
    // [Lead, Prospect, Customer, Churned] but the controller accepts ANY
    // string. Pin current behaviour — if Marketing wants enum validation,
    // it would have to be added explicitly (file an issue then, not now).
    mockFindMany.mockResolvedValue([]);

    const req = makeReq({ status: 'NOT_A_REAL_STATUS' });
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const callArgs = mockFindMany.mock.calls[0][0];
    expect(callArgs.where.status).toBe('NOT_A_REAL_STATUS');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 500 envelope when prisma throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFindMany.mockRejectedValue(new Error('DB connection lost'));

    const req = makeReq({ status: 'Lead' });
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Internal server error',
      status: 500,
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('count reflects contacts.length (no separate prisma.count() call)', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `c${i}`, status: 'Customer', tenantId: 1 }));
    mockFindMany.mockResolvedValue(rows);

    const req = makeReq({ status: 'Customer' });
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      count: 7,
      data: rows,
    }));
  });

  it('returns ALL fields prisma returned without stripping (no field filter)', async () => {
    // Pins that the controller does NOT apply field-level filtering — every
    // column prisma returns lands in the response. Cross-cutting field
    // permissions live in middleware (fieldFilter.js), not this controller.
    const rows = [{
      id: 1,
      name: 'Test',
      email: 'test@example.com',
      phone: '+919876543210',
      company: 'Acme',
      title: 'CEO',
      status: 'Customer',
      source: 'Organic',
      aiScore: 85,
      tenantId: 1,
      createdAt: new Date('2026-05-01'),
      // pretend prisma returned an extra field we didn't declare in swagger
      undocumentedField: 'should-still-pass-through',
    }];
    mockFindMany.mockResolvedValue(rows);

    const req = makeReq({ status: 'Customer' });
    const res = makeRes();
    await audienceController.getContactsByStatus(req, res);

    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody.data[0]).toHaveProperty('undocumentedField', 'should-still-pass-through');
    expect(responseBody.data[0]).toHaveProperty('aiScore', 85);
  });

  it('isolates two different tenants — second call uses second tenantId', async () => {
    mockFindMany.mockResolvedValue([]);

    await audienceController.getContactsByStatus(makeReq({ status: 'Lead', tenantId: 1 }), makeRes());
    await audienceController.getContactsByStatus(makeReq({ status: 'Lead', tenantId: 99 }), makeRes());

    expect(mockFindMany).toHaveBeenCalledTimes(2);
    expect(mockFindMany.mock.calls[0][0].where.tenantId).toBe(1);
    expect(mockFindMany.mock.calls[1][0].where.tenantId).toBe(99);
    // Status filter is identical across both calls — only tenant scope changes.
    expect(mockFindMany.mock.calls[0][0].where.status).toBe('Lead');
    expect(mockFindMany.mock.calls[1][0].where.status).toBe('Lead');
  });
});
