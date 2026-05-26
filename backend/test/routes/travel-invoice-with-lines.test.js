// @ts-check
/**
 * Arc 2 #901 slice 3 — GET /api/travel/invoices/:id?include=lines composite
 * document read (PRD_TRAVEL_BILLING UC-2.5).
 *
 * Pins the include-lines query-param behavior on the existing GET /:id
 * handler:
 *
 *   GET /api/travel/invoices/:id                  → header-only (no `lines`)
 *   GET /api/travel/invoices/:id?include=lines    → header + lines: [...]
 *   GET /api/travel/invoices/:id?include=unknown  → header-only (unknown
 *                                                   tokens silently skipped)
 *   GET /api/travel/invoices/:id?include=lines,x  → header + lines: [...]
 *
 * Contracts asserted:
 *   - WITHOUT the include param the response payload is the bare invoice
 *     header — adding the param is the ONLY way to opt into the embed.
 *     Backward-compatible with every existing GET /:id caller.
 *   - WITH ?include=lines the response gains a `lines` array, ordered by
 *     sortOrder asc then id asc (stable when sortOrder collides).
 *   - Empty-lines case returns `lines: []`, not omitted-field.
 *   - Forward-compat: unknown include tokens (e.g. `payments`) are silently
 *     skipped — caller gets the intersection of "asked for" and "supported".
 *   - Auth + tenant + sub-brand checks fire regardless of include param.
 *     Cross-tenant invoice → 404 (code: NOT_FOUND); sub-brand denied → 403.
 *   - Non-numeric :id → 400 INVALID_ID before any include parsing.
 *
 * DRIFT note: the GET /:id route's 404 code is "NOT_FOUND", not
 * "INVOICE_NOT_FOUND" (the line/PDF endpoints use the latter). This is
 * pre-existing — see backend/routes/travel_invoices.js:272 — and pinned
 * by backend/test/routes/travel_invoices.test.js:375. This spec pins the
 * existing "NOT_FOUND" contract so the slice doesn't perturb sibling
 * tests.
 *
 * Test pattern mirrors backend/test/routes/travel-invoice-lines.test.js
 * (commit 00d629c5) — patch the prisma singleton with vi.fn() shapes BEFORE
 * requiring the router; drive supertest with real HS256 JWTs signed against
 * the dev-fallback secret so verifyToken stays in the chain.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelInvoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoiceLine = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelInvoicesRouter = requireCJS('../../routes/travel_invoices');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelInvoicesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    quoteId: null,
    invoiceNum: 'TINV-2026-0001',
    status: 'Draft',
    totalAmount: '45000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 7 * 86_400_000),
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeLine(overrides = {}) {
  return {
    id: 555,
    tenantId: 1,
    invoiceId: 100,
    lineType: 'per_night',
    description: 'Hilton Mumbai — 3 nights',
    quantity: 3,
    unitPrice: '5000.00',
    amount: '15000.00',
    currency: 'INR',
    sortOrder: 0,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.update.mockReset().mockResolvedValue({});
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/invoices/:id?include=lines (composite document read)', () => {
  test('WITHOUT ?include=lines → header-only, no `lines` field present', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(makeInvoice());

    const res = await request(makeApp())
      .get('/api/travel/invoices/100')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 100,
      invoiceNum: 'TINV-2026-0001',
      status: 'Draft',
    });
    expect(res.body).not.toHaveProperty('lines');
    // The line table should NOT be queried at all when include is absent.
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });

  test('WITH ?include=lines and 2 lines → returns `lines` array of length 2 ordered by sortOrder', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(makeInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 555, sortOrder: 0 }),
      makeLine({
        id: 556,
        sortOrder: 1,
        lineType: 'tax',
        description: 'GST 18%',
        amount: '2700.00',
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100?include=lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 100, invoiceNum: 'TINV-2026-0001' });
    expect(Array.isArray(res.body.lines)).toBe(true);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0]).toMatchObject({ id: 555, lineType: 'per_night' });
    expect(res.body.lines[1]).toMatchObject({ id: 556, lineType: 'tax' });
    expect(prisma.travelInvoiceLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invoiceId: 100, tenantId: 1 },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  test('WITH ?include=lines and 0 lines → returns `lines: []` (not omitted)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(makeInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100?include=lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('lines');
    expect(res.body.lines).toEqual([]);
  });

  test('Unknown include token (?include=unknown) → no `lines` field, no DB query', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(makeInvoice());

    const res = await request(makeApp())
      .get('/api/travel/invoices/100?include=unknown')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('lines');
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });

  test('?include=lines,unknown → `lines` present, unknown silently skipped', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(makeInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 555, sortOrder: 0 }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100?include=lines,payments')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({ id: 555 });
    // No `payments` field — unknown tokens are silently dropped, NOT
    // surfaced as empty arrays.
    expect(res.body).not.toHaveProperty('payments');
  });

  test('Cross-tenant invoice → 404 NOT_FOUND regardless of ?include=lines', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100?include=lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    // DRIFT: GET /:id uses NOT_FOUND, not INVOICE_NOT_FOUND — see header.
    expect(res.body.code).toBe('NOT_FOUND');
    // Lines must NEVER be fetched when the parent invoice doesn't exist.
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });

  test('Sub-brand denied → 403 SUB_BRAND_DENIED regardless of ?include=lines', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(makeInvoice({ subBrand: 'rfu' }));
    // MANAGER restricted to 'tmc' only — ADMINs get role-bypass per
    // travelGuards.getSubBrandAccessSet.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: '["tmc"]',
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/100?include=lines')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });

  test('Non-numeric :id → 400 INVALID_ID before include parsing', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/abc?include=lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });

  test('?include=  (whitespace only) → header-only, no `lines` field', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(makeInvoice());

    const res = await request(makeApp())
      .get('/api/travel/invoices/100?include=%20%20')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('lines');
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });
});
