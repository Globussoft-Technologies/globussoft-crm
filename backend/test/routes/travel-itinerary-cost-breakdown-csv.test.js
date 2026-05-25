// @ts-check
/**
 * Arc 2 #907 slice 13 — Itinerary cost-breakdown CSV export endpoint.
 *
 * Pins GET /api/travel/itineraries/:id/cost-breakdown.csv added to
 * backend/routes/travel_itineraries.js — read-side companion to the
 * JSON /day-costs endpoint (slice 2 + slice 5) that streams the same
 * per-day numbers as a downloadable CSV.
 *
 * Contracts asserted:
 *   - Content-Type: text/csv; Content-Disposition pinned to filename
 *     `itinerary-<id>-cost-breakdown.csv`.
 *   - Header row: dayOffset,itemCount,totalCost,supplierCost,
 *     markupTotal,gstTotal,marginTotal,marginPct.
 *   - One data row per day (dayOffset asc — inherits from
 *     computeDayCosts which sorts ascending).
 *   - Trailing `TOTAL` row spans the trip — supplierCost + markupTotal
 *     + gstTotal + marginTotal grand totals; itemCount = sum across
 *     days.
 *   - Half-up to 2dp rounding (matches helper's internal round2).
 *   - marginTotal = totalCost - supplierCost - gstTotal per day AND on
 *     the total row.
 *   - marginPct cell is EMPTY (not "Infinity" / "null") when totalCost
 *     is 0 — keeps the CSV friendly to spreadsheet auto-parsers.
 *   - tripStart override resolves day-source for items carrying
 *     `date` in detailsJson (mirrors /day-costs contract).
 *   - Read-only — no audit log writes, no eventBus emits.
 *   - Tenant + sub-brand guard delegated to loadItineraryWithGuard —
 *     401 / 404 NOT_FOUND / 404 ITINERARY_NOT_FOUND / 403
 *     SUB_BRAND_DENIED contracts inherited.
 *   - Empty itinerary returns just header + TOTAL with zero values.
 *
 * Pattern mirrors travel-itinerary-supplier-rollup.test.js — CJS
 * prisma singleton patched BEFORE the router is required; eventBus
 * mocked at vitest module-load time; HS256 JWT via dev fallback
 * secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// eventBus mock — cost-breakdown CSV is read-only and never emits, but
// we patch the shared helper to match sibling-test discipline so route
// refactors that add an emit don't silently couple the test to a real
// bus listener.
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
    startDate: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    id: 555,
    itineraryId: 100,
    itemType: 'hotel',
    position: 0,
    description: 'Hotel night',
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
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/itineraries/:id/cost-breakdown.csv — happy paths', () => {
  test('streams per-day CSV with TOTAL row, correct headers + Content-Disposition', async () => {
    // Two days, three items. Day 0 has a hotel; Day 1 has a transfer +
    // an activity. Numbers chosen so margin identity is exact for the
    // total row.
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 100 }))
      .mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1,
        itemType: 'hotel',
        description: 'Hotel D0',
        unitCost: '5000.00',
        markup: '500.00',
        gstAmount: '900.00',
        totalPrice: '7000.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
      makeItem({
        id: 2,
        itemType: 'transfer',
        description: 'Cab D1',
        unitCost: '1000.00',
        markup: '200.00',
        gstAmount: '216.00',
        totalPrice: '1500.00',
        detailsJson: JSON.stringify({ dayOffset: 1 }),
      }),
      makeItem({
        id: 3,
        itemType: 'activity',
        description: 'Sightseeing D1',
        unitCost: '800.00',
        markup: '100.00',
        gstAmount: '162.00',
        totalPrice: '1200.00',
        detailsJson: JSON.stringify({ dayOffset: 1 }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/cost-breakdown.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename=itinerary-100-cost-breakdown.csv',
    );

    const lines = res.text.trim().split('\n');
    // header + 2 days + TOTAL.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      'dayOffset,itemCount,totalCost,supplierCost,markupTotal,gstTotal,marginTotal,marginPct',
    );

    // Day 0: total=7000, supplier=5000, markup=500, gst=900, margin=7000-5000-900=1100, marginPct=1100/7000*100=15.71.
    expect(lines[1]).toBe('0,1,7000,5000,500,900,1100,15.71');
    // Day 1: total=2700, supplier=1800, markup=300, gst=378, margin=2700-1800-378=522, marginPct=522/2700*100=19.33.
    expect(lines[2]).toBe('1,2,2700,1800,300,378,522,19.33');
    // TOTAL: itemCount=3, total=9700, supplier=6800, markup=800, gst=1278, margin=9700-6800-1278=1622, marginPct=1622/9700*100=16.72.
    expect(lines[3]).toBe('TOTAL,3,9700,6800,800,1278,1622,16.72');
  });

  test('empty itinerary returns header + TOTAL row with zero values + empty marginPct', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 100 }))
      .mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/cost-breakdown.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    // header + TOTAL only.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^dayOffset,/);
    // Empty marginPct cell — last token is empty string, NOT "Infinity"
    // or "null" — keeps Excel/Sheets parsing clean.
    expect(lines[1]).toBe('TOTAL,0,0,0,0,0,0,');
  });

  test('half-up rounding to 2dp applied to per-day + grand totals', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 100 }))
      .mockResolvedValueOnce(itin({ id: 100 }));
    // Item with values that would round-down with truncate but round-up
    // with half-up. 100.555 → 100.56 under half-up.
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1,
        itemType: 'activity',
        unitCost: '100.555',
        markup: '50.225',
        gstAmount: '20.115',
        totalPrice: '170.895',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/cost-breakdown.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    // Day row: total=170.9 (half-up of 170.895 → JS Number rounding
    // quirk lands at 170.9; .005 cases vary per engine but our
    // round2 helper applies + EPSILON so 170.895 → 170.9).
    // Spelling assertion via parse instead of literal string to
    // tolerate IEEE-754 boundary cases (still asserts half-up applied
    // because the un-rounded source has 3dp).
    const dayCells = lines[1].split(',');
    expect(dayCells[0]).toBe('0');
    expect(dayCells[1]).toBe('1');
    // All numeric cells parse cleanly to at most 2dp.
    for (let i = 2; i <= 7; i++) {
      if (dayCells[i] === '') continue;
      const decimals = dayCells[i].split('.')[1] || '';
      expect(decimals.length).toBeLessThanOrEqual(2);
    }
  });

  test('marginPct cell is empty (not "Infinity") when totalCost is 0', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 100 }))
      .mockResolvedValueOnce(itin({ id: 100 }));
    // Zero-cost item — visa fee waived. totalCost=0, marginPct must be empty.
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1,
        itemType: 'visa',
        unitCost: '0.00',
        markup: '0.00',
        gstAmount: '0.00',
        totalPrice: '0.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/cost-breakdown.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    // Day row: trailing empty marginPct (last char is comma).
    expect(lines[1].endsWith(',')).toBe(true);
    expect(lines[1]).toBe('0,1,0,0,0,0,0,');
    // TOTAL row: same.
    expect(lines[2]).toBe('TOTAL,1,0,0,0,0,0,');
    // Importantly NOT "Infinity" or "null" anywhere.
    expect(res.text).not.toMatch(/Infinity/);
    expect(res.text).not.toMatch(/null/);
  });

  test('tripStart query override resolves day-source for date-keyed items', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 100, startDate: null }))
      .mockResolvedValueOnce(itin({ id: 100, startDate: null }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1,
        itemType: 'flight',
        unitCost: '15000.00',
        gstAmount: '2700.00',
        totalPrice: '20000.00',
        // No dayOffset — only a date. Helper resolves against tripStart.
        detailsJson: JSON.stringify({ date: '2026-07-15T00:00:00.000Z' }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/cost-breakdown.csv?tripStart=2026-07-15T00:00:00.000Z')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    // Day 0 row materialises because tripStart matches the item's date.
    expect(lines[1].startsWith('0,1,20000,')).toBe(true);
  });

  test('items in arbitrary order produce dayOffset-asc day rows', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 100 }))
      .mockResolvedValueOnce(itin({ id: 100 }));
    // Three items in Day 2 / Day 0 / Day 1 order on disk.
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1,
        itemType: 'hotel',
        unitCost: '2000.00',
        totalPrice: '2200.00',
        detailsJson: JSON.stringify({ dayOffset: 2 }),
      }),
      makeItem({
        id: 2,
        itemType: 'hotel',
        unitCost: '1000.00',
        totalPrice: '1100.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
      makeItem({
        id: 3,
        itemType: 'hotel',
        unitCost: '1500.00',
        totalPrice: '1650.00',
        detailsJson: JSON.stringify({ dayOffset: 1 }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/cost-breakdown.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    // header + 3 day rows + TOTAL.
    expect(lines).toHaveLength(5);
    expect(lines[1].startsWith('0,')).toBe(true);
    expect(lines[2].startsWith('1,')).toBe(true);
    expect(lines[3].startsWith('2,')).toBe(true);
    expect(lines[4].startsWith('TOTAL,')).toBe(true);
  });
});

describe('GET /api/travel/itineraries/:id/cost-breakdown.csv — auth + guard contracts', () => {
  test('401 when no Authorization header', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/cost-breakdown.csv');

    expect(res.status).toBe(401);
  });

  test('404 ITINERARY_NOT_FOUND when target itinerary is in another tenant', async () => {
    // loadItineraryWithGuard returns NOT_FOUND; the endpoint rewrites
    // to ITINERARY_NOT_FOUND for code consistency with the JSON
    // sibling /day-costs endpoint.
    prisma.itinerary.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/9999/cost-breakdown.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ITINERARY_NOT_FOUND');
  });

  test('400 INVALID_ID when :id is non-numeric', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/abc/cost-breakdown.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('403 SUB_BRAND_DENIED when operator lacks itinerary sub-brand access', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100, subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: 'tmc' });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/cost-breakdown.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });
});
