// @ts-check
/**
 * Arc 2 #903 slice 10 — GET /api/travel/suppliers/search autocomplete.
 *
 * Pins the contract for the supplier-picker autocomplete endpoint added
 * to backend/routes/travel_suppliers.js. The picker is consumed by the
 * quote-line / invoice-line forms — operators searching "hilton" should
 * find suppliers whose name contains "hilton" (case-insensitive), ranked
 * alphabetically, capped at the top 10 by default.
 *
 * What's pinned
 * -------------
 *   - Happy path:     q="hilton" → returns matching suppliers (200).
 *   - Validation:     missing q / empty q / q >100 chars → 400 INVALID_QUERY.
 *   - Filter:         ?supplierCategory=hotel narrows the where clause.
 *   - Filter:         ?subBrand=tmc narrows the where clause.
 *   - Limit:          ?limit=5 caps to 5 take rows.
 *   - Limit:          ?limit=100 clamps to 50 (max).
 *   - Limit:          invalid limit (0/-1/non-int) → 400 INVALID_LIMIT.
 *   - Invalid cat:    bad supplierCategory → 400 INVALID_SUPPLIER_CATEGORY.
 *   - Invalid brand:  bad subBrand → 400 INVALID_SUB_BRAND.
 *   - Sub-brand acc:  MANAGER scoped to ['tmc'] can't see ?subBrand=rfu
 *                     → query substitutes "__none__".
 *   - isActive only:  the where clause always pins isActive=true.
 *   - Case-insens:    "HILTON" matches "Hilton Mumbai" via Prisma's
 *                     mode:'insensitive' on contains.
 *
 * Test pattern mirrors backend/test/routes/travel_suppliers.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with real HS256 JWTs signed with the same fallback
 * secret the middleware uses in dev.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findMany = vi.fn();
prisma.travelSupplier.findFirst = vi.fn();
prisma.travelSupplier.count = vi.fn();
prisma.travelSupplier.create = vi.fn();
prisma.travelSupplier.update = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
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
const travelSuppliersRouter = requireCJS('../../routes/travel_suppliers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelSuppliersRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.travelSupplier.findMany.mockReset();
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplier.count.mockReset();
  prisma.travelSupplier.create.mockReset();
  prisma.travelSupplier.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/suppliers/search', () => {
  test('happy path: q="hilton" returns matching suppliers (200)', async () => {
    const rows = [
      { id: 1, name: 'Grand Hilton Mumbai', supplierCategory: 'hotel', subBrand: 'tmc', email: null, phone: null },
      { id: 2, name: 'Hilton Garden Delhi', supplierCategory: 'hotel', subBrand: 'tmc', email: null, phone: null },
      { id: 3, name: 'Hilton Singapore', supplierCategory: 'hotel', subBrand: 'tmc', email: null, phone: null },
    ];
    prisma.travelSupplier.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/search?q=hilton')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3 });
    expect(res.body.suppliers).toHaveLength(3);
    // Where clause must pin tenantId + isActive=true + case-insensitive contains
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          isActive: true,
          name: { contains: 'hilton', mode: 'insensitive' },
        }),
        orderBy: { name: 'asc' },
        take: 10,
      }),
    );
  });

  test('missing q returns 400 INVALID_QUERY (no findMany call)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/search')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_QUERY' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('empty q="" returns 400 INVALID_QUERY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/search?q=')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_QUERY' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('q >100 chars returns 400 INVALID_QUERY', async () => {
    const longQ = 'x'.repeat(101);
    const res = await request(makeApp())
      .get(`/api/travel/suppliers/search?q=${longQ}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_QUERY' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('?supplierCategory=hotel narrows the where clause', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/suppliers/search?q=acme&supplierCategory=hotel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          isActive: true,
          supplierCategory: 'hotel',
          name: { contains: 'acme', mode: 'insensitive' },
        }),
      }),
    );
  });

  test('invalid supplierCategory returns 400 INVALID_SUPPLIER_CATEGORY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo&supplierCategory=cruise')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUPPLIER_CATEGORY' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('?subBrand=tmc narrows the where clause', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo&subBrand=tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          isActive: true,
          subBrand: 'tmc',
        }),
      }),
    );
  });

  test('invalid subBrand returns 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo&subBrand=umrah')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('?limit=5 caps take to 5', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo&limit=5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });

  test('?limit=100 clamps to 50 (max)', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo&limit=100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  test('?limit=0 returns 400 INVALID_LIMIT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo&limit=0')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_LIMIT' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand-restricted MANAGER requesting ?subBrand=rfu (out-of-scope) gets "__none__"', async () => {
    // MANAGER scoped to only ['tmc'] — RFU is forbidden.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelSupplier.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo&subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    // Should substitute "__none__" so the query returns empty rather than 403'ing.
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subBrand: '__none__' }),
      }),
    );
  });

  test('sub-brand-restricted MANAGER without ?subBrand sees only allowed brands', async () => {
    // MANAGER scoped to ['tmc', 'rfu'] — no explicit subBrand filter on the URL.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc', 'rfu']),
    });
    prisma.travelSupplier.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    // Where clause should pin subBrand to an `in: [...allowed]` shape.
    const calledWhere = prisma.travelSupplier.findMany.mock.calls[0][0].where;
    expect(calledWhere.subBrand).toMatchObject({ in: expect.arrayContaining(['tmc', 'rfu']) });
  });

  test('case-insensitive: "HILTON" finds "Hilton Mumbai" via mode:insensitive', async () => {
    // The actual case-insensitive matching is delegated to Prisma + the
    // underlying DB collation. We can only pin that the route forwards
    // the `mode: 'insensitive'` flag along with the verbatim user input.
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 1, name: 'Hilton Mumbai', supplierCategory: 'hotel', subBrand: 'tmc', email: null, phone: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/search?q=HILTON')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: 'HILTON', mode: 'insensitive' },
        }),
      }),
    );
  });

  test('projection is slim: id, name, supplierCategory, subBrand, email, phone', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          name: true,
          supplierCategory: true,
          subBrand: true,
          email: true,
          phone: true,
        },
      }),
    );
  });

  test('alphabetical order by name', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/suppliers/search?q=foo')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } }),
    );
  });
});
