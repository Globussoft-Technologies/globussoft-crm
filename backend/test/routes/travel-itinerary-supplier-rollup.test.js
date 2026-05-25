// @ts-check
/**
 * Arc 2 #907 slice 7 — Itinerary supplier-confirmation rollup endpoint.
 *
 * Pins GET /api/travel/itineraries/:id/supplier-rollup added to
 * backend/routes/travel_itineraries.js.
 *
 * Contracts asserted:
 *   - Read-only — no audit log writes, no eventBus emits.
 *   - Aggregates ItineraryItem rows by supplierId; null-supplier rows
 *     land in a separate `unassigned` bucket.
 *   - Per-supplier rollup carries supplier metadata (name, category,
 *     contactPerson, phone, email) joined from TravelSupplier — fetched
 *     in a single tenant-scoped query for only the supplierIds present.
 *   - totalSupplierCost / totalGst / totalSalePrice rounded half-up to
 *     2dp (paise). marginTotal = sale - cost - gst. marginPct null when
 *     sale=0 to avoid Infinity.
 *   - itemTypes is a sorted unique array of itemType strings.
 *   - suppliers ordered by descending totalSalePrice (biggest spend up
 *     top), tiebreak by supplierId asc.
 *   - grandTotals span suppliers + unassigned.
 *   - Tenant + sub-brand guard delegated to loadItineraryWithGuard —
 *     401 / 404 NOT_FOUND / 403 SUB_BRAND_DENIED contracts inherited.
 *   - Supplier lookup is tenant-scoped (cross-tenant supplier ids
 *     dropped → falls back to "Unknown supplier").
 *
 * Pattern mirrors travel-itinerary-clone-day.test.js — CJS prisma
 * singleton patched BEFORE the router is required; eventBus mocked at
 * vitest module-load time for parity with sibling tests; HS256 JWT via
 * dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// eventBus mock — supplier-rollup is read-only and never emits, but we
// patch the shared helper to match sibling-test discipline (clone-day +
// day-costs) so route refactors that add an emit don't silently couple
// the test to a real bus listener.
vi.mock('../../lib/eventBus.js', () => ({
  default: { emit: vi.fn(), on: vi.fn() },
  emitEvent: vi.fn(),
  safeEmitEvent: vi.fn(),
}));

prisma.itinerary = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.itineraryItem = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelSupplier = {
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'USER', subBrandAccess: null });
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue({ name: 'Test Customer' });
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
const travelItinerariesRouter = requireCJS('../../routes/travel_itineraries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelItinerariesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function itin(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    status: 'sent',
    destination: 'Goa',
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    id: 555,
    itineraryId: 100,
    itemType: 'hotel',
    position: 0,
    description: 'Hotel night 1',
    detailsJson: null,
    supplierId: null,
    unitCost: null,
    markup: null,
    gstAmount: null,
    totalPrice: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.itinerary.findFirst.mockReset();
  prisma.itineraryItem.findMany.mockReset().mockResolvedValue([]);
  prisma.travelSupplier.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/itineraries/:id/supplier-rollup — happy paths', () => {
  test('aggregates two items per supplier with metadata, sale-desc ordering, half-up rounding', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100, subBrand: 'tmc' }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      // Supplier 11 — two hotel nights, biggest spend.
      makeItem({ id: 1, itemType: 'hotel', description: 'Hotel A night 1',
        supplierId: 11, unitCost: '5000.00', gstAmount: '900.00', totalPrice: '7000.00' }),
      makeItem({ id: 2, itemType: 'hotel', description: 'Hotel A night 2',
        supplierId: 11, unitCost: '5000.00', gstAmount: '900.00', totalPrice: '7000.00' }),
      // Supplier 22 — one transfer.
      makeItem({ id: 3, itemType: 'transfer', description: 'Airport pickup',
        supplierId: 22, unitCost: '1200.50', gstAmount: '216.09', totalPrice: '1800.99' }),
    ]);
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 11, name: 'Goa Beach Resort', supplierCategory: 'hotel',
        contactPerson: 'Mr Pinto', phone: '+91-832-1234567', email: 'res@goabeach.in' },
      { id: 22, name: 'Cabs of Goa', supplierCategory: 'transport',
        contactPerson: 'Mr D\'Souza', phone: '+91-832-9876543', email: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.itineraryId).toBe(100);
    expect(res.body.supplierCount).toBe(2);
    expect(res.body.unassigned).toBeNull();

    // Ordering: 11 (sale=14000) before 22 (sale=1800.99).
    const [s11, s22] = res.body.suppliers;
    expect(s11.supplierId).toBe(11);
    expect(s11.supplierName).toBe('Goa Beach Resort');
    expect(s11.supplierCategory).toBe('hotel');
    expect(s11.contactPerson).toBe('Mr Pinto');
    expect(s11.itemCount).toBe(2);
    expect(s11.itemTypes).toEqual(['hotel']);
    expect(s11.totalSupplierCost).toBe(10000);
    expect(s11.totalGst).toBe(1800);
    expect(s11.totalSalePrice).toBe(14000);
    expect(s11.marginTotal).toBe(2200); // 14000 - 10000 - 1800
    expect(s11.marginPct).toBeCloseTo(15.71, 2);
    expect(s11.items).toHaveLength(2);

    expect(s22.supplierId).toBe(22);
    expect(s22.itemCount).toBe(1);
    expect(s22.itemTypes).toEqual(['transfer']);
    expect(s22.totalSupplierCost).toBe(1200.5);
    expect(s22.totalGst).toBe(216.09);
    expect(s22.totalSalePrice).toBe(1800.99);
    expect(s22.marginTotal).toBeCloseTo(384.4, 2);

    // Grand totals.
    expect(res.body.grandTotals.supplierCost).toBe(11200.5);
    expect(res.body.grandTotals.gst).toBe(2016.09);
    expect(res.body.grandTotals.salePrice).toBe(15800.99);
    expect(res.body.grandTotals.marginTotal).toBeCloseTo(2584.4, 2);
  });

  test('null-supplier items land in unassigned bucket with "Unassigned" label', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100, subBrand: 'tmc' }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ id: 1, itemType: 'activity', description: 'Walking tour',
        supplierId: null, unitCost: '500.00', gstAmount: '90.00', totalPrice: '700.00' }),
      makeItem({ id: 2, itemType: 'activity', description: 'Beach sunset',
        supplierId: null, unitCost: '300.00', gstAmount: '54.00', totalPrice: '450.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplierCount).toBe(0);
    expect(res.body.suppliers).toEqual([]);
    expect(res.body.unassigned).not.toBeNull();
    expect(res.body.unassigned.supplierId).toBeNull();
    expect(res.body.unassigned.supplierName).toBe('Unassigned');
    expect(res.body.unassigned.itemCount).toBe(2);
    expect(res.body.unassigned.totalSupplierCost).toBe(800);
    expect(res.body.unassigned.totalGst).toBe(144);
    expect(res.body.unassigned.totalSalePrice).toBe(1150);
    // Grand totals include unassigned bucket.
    expect(res.body.grandTotals.salePrice).toBe(1150);
  });

  test('mixed: some items with supplier + some without — both surfaces co-exist', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ id: 1, itemType: 'hotel', supplierId: 11,
        unitCost: '4000.00', gstAmount: '720.00', totalPrice: '5500.00' }),
      makeItem({ id: 2, itemType: 'activity', supplierId: null,
        unitCost: '200.00', gstAmount: null, totalPrice: '350.00' }),
    ]);
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 11, name: 'Hotel Vendor', supplierCategory: 'hotel',
        contactPerson: null, phone: null, email: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplierCount).toBe(1);
    expect(res.body.suppliers[0].supplierId).toBe(11);
    expect(res.body.unassigned).not.toBeNull();
    expect(res.body.unassigned.itemCount).toBe(1);
    // gstAmount=null in source becomes 0 in totals (Number(null) → 0 path).
    expect(res.body.unassigned.totalGst).toBe(0);
  });

  test('marginPct is null when totalSalePrice is 0 (avoids Infinity)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ id: 1, itemType: 'visa', supplierId: 33,
        unitCost: '0.00', gstAmount: '0.00', totalPrice: '0.00' }),
    ]);
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 33, name: 'Free Visa', supplierCategory: 'visa-consul',
        contactPerson: null, phone: null, email: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.suppliers[0].marginPct).toBeNull();
    expect(res.body.grandTotals.marginPct).toBeNull();
  });

  test('itemTypes contains sorted unique itemType strings per supplier', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ id: 1, itemType: 'hotel', supplierId: 99, totalPrice: '1000.00' }),
      makeItem({ id: 2, itemType: 'transfer', supplierId: 99, totalPrice: '500.00' }),
      makeItem({ id: 3, itemType: 'hotel', supplierId: 99, totalPrice: '1000.00' }),
      makeItem({ id: 4, itemType: 'activity', supplierId: 99, totalPrice: '300.00' }),
    ]);
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 99, name: 'Multi-service vendor', supplierCategory: 'other',
        contactPerson: null, phone: null, email: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.suppliers[0].itemCount).toBe(4);
    // Sorted alphabetically; duplicates removed.
    expect(res.body.suppliers[0].itemTypes).toEqual(['activity', 'hotel', 'transfer']);
  });

  test('empty itinerary returns supplierCount=0, suppliers=[], unassigned=null, zero grandTotals', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplierCount).toBe(0);
    expect(res.body.suppliers).toEqual([]);
    expect(res.body.unassigned).toBeNull();
    expect(res.body.grandTotals.supplierCost).toBe(0);
    expect(res.body.grandTotals.salePrice).toBe(0);
    expect(res.body.grandTotals.marginPct).toBeNull();
  });

  test('cross-tenant supplierId not found in lookup → falls back to "Unknown supplier"', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ id: 1, itemType: 'hotel', supplierId: 12345,
        unitCost: '1000.00', gstAmount: '180.00', totalPrice: '1400.00' }),
    ]);
    // Supplier lookup returns empty (tenant-scoped where clause filtered it out).
    prisma.travelSupplier.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.suppliers[0].supplierId).toBe(12345);
    expect(res.body.suppliers[0].supplierName).toBe('Unknown supplier');
    expect(res.body.suppliers[0].supplierCategory).toBeNull();
    expect(res.body.suppliers[0].itemCount).toBe(1);
  });

  test('supplier-lookup query is tenant-scoped and limited to supplierIds in scope', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100, tenantId: 1 }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ id: 1, itemType: 'hotel', supplierId: 11, totalPrice: '1000.00' }),
      makeItem({ id: 2, itemType: 'transfer', supplierId: 22, totalPrice: '500.00' }),
    ]);
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 11, name: 'A', supplierCategory: 'hotel', contactPerson: null, phone: null, email: null },
      { id: 22, name: 'B', supplierCategory: 'transport', contactPerson: null, phone: null, email: null },
    ]);

    await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    // The lookup must have been called with tenant scope AND only the ids present.
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.travelSupplier.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.id.in.sort()).toEqual([11, 22]);
  });
});

describe('GET /api/travel/itineraries/:id/supplier-rollup — auth + guard contracts', () => {
  test('401 when no Authorization header', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup');

    expect(res.status).toBe(401);
  });

  test('404 NOT_FOUND when target itinerary is in another tenant', async () => {
    // loadItineraryWithGuard returns null → 404 NOT_FOUND on target.
    prisma.itinerary.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/9999/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('400 INVALID_ID when :id is non-numeric', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/abc/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('403 SUB_BRAND_DENIED when operator lacks itinerary sub-brand access', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100, subBrand: 'rfu' }));
    // Operator restricted to TMC only — wellness/empty scope so subBrand check fails.
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: 'tmc' });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/supplier-rollup')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });
});
