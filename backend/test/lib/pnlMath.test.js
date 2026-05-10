// Unit tests for backend/lib/pnlMath.js — Wave 9 Agent A, 2026-05-10.
//
// What this pins — the canonical wellness P&L revenue contract from
// issue #565 (HI-16). The helper has TWO entry points:
//
//   sumCompleted(visits)      — in-memory reducer, status='completed' only
//   computeRevenue(prisma, t, win) — DB query, status='completed' only
//
// The status filter, the window inclusion, the locationId narrowing, and
// the cross-tenant isolation are all part of the contract. Every assertion
// below traces back to a specific bug-class observed in the original three
// (later five) divergent revenue figures listed in #565's body and the
// 2026-05-07 retest comment.
//
// Why these tests live in lib/ not middleware/ — the helper is a pure
// function over data; it doesn't touch req/res. middleware/ is reserved
// for Express middleware (verifyWellnessRole, sendLimiter, etc.).
//
// stripDangerous reminder (per CLAUDE.md): not relevant — these tests
// don't fire HTTP requests through the global middleware stack.

import { describe, test, expect, vi } from 'vitest';
import { sumCompleted, computeRevenue, CANONICAL_STATUS } from '../../lib/pnlMath.js';

describe('CANONICAL_STATUS export', () => {
  test('is exactly "completed" — the canonical bookkeeping status', () => {
    // Pinned because changing this string is a CROSS-CUTTING shape change
    // that would silently flip every revenue surface.  If a future product
    // call wants to broaden (e.g. include 'in-progress'), make sure to
    // update routes/wellness.js status filters in lockstep AND audit the
    // 2026-05-07 retest comment on #565.
    expect(CANONICAL_STATUS).toBe('completed');
  });
});

describe('sumCompleted — in-memory reducer', () => {
  test('empty array returns zeroes', () => {
    const r = sumCompleted([]);
    expect(r).toEqual({ revenue: 0, count: 0, totalCount: 0 });
  });

  test('non-array input returns zeroes (defensive)', () => {
    expect(sumCompleted(null)).toEqual({ revenue: 0, count: 0, totalCount: 0 });
    expect(sumCompleted(undefined)).toEqual({ revenue: 0, count: 0, totalCount: 0 });
    expect(sumCompleted({})).toEqual({ revenue: 0, count: 0, totalCount: 0 });
  });

  test('single completed visit: revenue and count', () => {
    const r = sumCompleted([{ status: 'completed', amountCharged: 1500 }]);
    expect(r.revenue).toBe(1500);
    expect(r.count).toBe(1);
    expect(r.totalCount).toBe(1);
  });

  test('multi-completed visit sum', () => {
    const r = sumCompleted([
      { status: 'completed', amountCharged: 100 },
      { status: 'completed', amountCharged: 250 },
      { status: 'completed', amountCharged: 50 },
    ]);
    expect(r.revenue).toBe(400);
    expect(r.count).toBe(3);
    expect(r.totalCount).toBe(3);
  });

  test('CANCELLED visits excluded — pre-fix this was the bug shape', () => {
    // Issue #565 body: yesterday.revenue summed amountCharged over ALL
    // yesterday's visits, so a cancellation with stale amountCharged
    // inflated revenue.  Pin the fix.
    const r = sumCompleted([
      { status: 'completed', amountCharged: 1000 },
      { status: 'cancelled', amountCharged: 500 },  // ← buggy data shape
      { status: 'no-show',   amountCharged: 750 },  // ← buggy data shape
    ]);
    expect(r.revenue).toBe(1000);  // NOT 2250
    expect(r.count).toBe(1);
    expect(r.totalCount).toBe(3);  // header still sees the full set
  });

  test('BOOKED visits excluded — projected != realised', () => {
    // The dashboard's "today's expected revenue" tile sums booked +
    // completed visits.  That's a different scope (alternative A in
    // pnlMath.js header).  Canonical excludes booked.
    const r = sumCompleted([
      { status: 'booked',    amountCharged: 800 },
      { status: 'completed', amountCharged: 200 },
    ]);
    expect(r.revenue).toBe(200);
    expect(r.count).toBe(1);
  });

  test('null/undefined amountCharged treated as 0 (no NaN propagation)', () => {
    const r = sumCompleted([
      { status: 'completed', amountCharged: null },
      { status: 'completed', amountCharged: undefined },
      { status: 'completed', amountCharged: 'not-a-number' },
      { status: 'completed', amountCharged: 100 },
    ]);
    // First three contribute 0; only the 100 lands.  count includes all
    // four (the row IS completed; just lacks a billed amount).
    expect(r.revenue).toBe(100);
    expect(r.count).toBe(4);
  });

  test('string-typed amountCharged parsed via parseFloat (Prisma Decimal shape)', () => {
    // Prisma's Decimal columns hydrate as strings in older configurations.
    // The helper must coerce.
    const r = sumCompleted([
      { status: 'completed', amountCharged: '199.99' },
      { status: 'completed', amountCharged: '1500.00' },
    ]);
    expect(r.revenue).toBeCloseTo(1699.99, 2);
    expect(r.count).toBe(2);
  });

  test('null entries in array do not crash', () => {
    const r = sumCompleted([null, undefined, { status: 'completed', amountCharged: 50 }]);
    expect(r.revenue).toBe(50);
    expect(r.count).toBe(1);
    expect(r.totalCount).toBe(3);
  });

  test('mixed-status reducer is order-independent', () => {
    const a = sumCompleted([
      { status: 'cancelled', amountCharged: 100 },
      { status: 'completed', amountCharged: 200 },
      { status: 'completed', amountCharged: 300 },
    ]);
    const b = sumCompleted([
      { status: 'completed', amountCharged: 300 },
      { status: 'completed', amountCharged: 200 },
      { status: 'cancelled', amountCharged: 100 },
    ]);
    expect(a.revenue).toBe(b.revenue);
    expect(a.count).toBe(b.count);
  });
});

describe('computeRevenue — DB-bound entry point', () => {
  function makePrismaMock({ visits = [] } = {}) {
    return {
      visit: {
        findMany: vi.fn().mockResolvedValue(visits),
      },
    };
  }

  test('builds a tenant-scoped + status="completed" + window where clause', async () => {
    const prisma = makePrismaMock({
      visits: [{ status: 'completed', amountCharged: 1500 }],
    });
    const from = new Date('2026-05-01T00:00:00.000Z');
    const to = new Date('2026-05-31T23:59:59.999Z');
    const r = await computeRevenue(prisma, 2, { from, to });

    expect(prisma.visit.findMany).toHaveBeenCalledOnce();
    const call = prisma.visit.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(2);
    expect(call.where.status).toBe('completed');
    expect(call.where.visitDate.gte).toBe(from);
    expect(call.where.visitDate.lte).toBe(to);
    // locationId not requested → not present in where
    expect(call.where.locationId).toBeUndefined();
    expect(r.revenue).toBe(1500);
    expect(r.count).toBe(1);
  });

  test('locationId narrows the where clause when provided', async () => {
    const prisma = makePrismaMock({ visits: [] });
    await computeRevenue(prisma, 2, {
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-31T23:59:59Z'),
      locationId: 7,
    });
    const call = prisma.visit.findMany.mock.calls[0][0];
    expect(call.where.locationId).toBe(7);
  });

  test('locationId=null does NOT add the narrow clause', async () => {
    const prisma = makePrismaMock({ visits: [] });
    await computeRevenue(prisma, 2, {
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-31T23:59:59Z'),
      locationId: null,
    });
    const call = prisma.visit.findMany.mock.calls[0][0];
    // null is treated the same as undefined — no narrowing
    expect(call.where.locationId).toBeUndefined();
  });

  test('cross-tenant isolation: the where clause pins tenantId', async () => {
    // Defence-in-depth: even if a caller passed an "evil" tenantId, the
    // helper never reaches across.
    const prismaA = makePrismaMock({
      visits: [{ status: 'completed', amountCharged: 999 }],
    });
    const prismaB = makePrismaMock({
      visits: [{ status: 'completed', amountCharged: 111 }],
    });
    const win = {
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-31T23:59:59Z'),
    };
    const a = await computeRevenue(prismaA, 1, win);
    const b = await computeRevenue(prismaB, 2, win);
    expect(a.revenue).toBe(999);
    expect(b.revenue).toBe(111);
    expect(prismaA.visit.findMany.mock.calls[0][0].where.tenantId).toBe(1);
    expect(prismaB.visit.findMany.mock.calls[0][0].where.tenantId).toBe(2);
  });

  test('IST midnight boundary — caller passes already-widened Dates', async () => {
    // The helper does NOT re-widen YYYY-MM-DD strings — its contract is
    // "pass me already-widened Dates".  Verify a 1-day window in IST
    // round-trips correctly.  start = 2026-05-10T00:00 IST = 2026-05-09T18:30Z;
    // end = 2026-05-10T23:59:59.999 IST = 2026-05-10T18:29:59.999Z.
    const istStart = new Date('2026-05-09T18:30:00.000Z');
    const istEnd = new Date('2026-05-10T18:29:59.999Z');
    const prisma = makePrismaMock({ visits: [{ status: 'completed', amountCharged: 500 }] });
    await computeRevenue(prisma, 2, { from: istStart, to: istEnd });
    const call = prisma.visit.findMany.mock.calls[0][0];
    expect(call.where.visitDate.gte.toISOString()).toBe('2026-05-09T18:30:00.000Z');
    expect(call.where.visitDate.lte.toISOString()).toBe('2026-05-10T18:29:59.999Z');
  });

  test('rejects non-Date from/to input', async () => {
    const prisma = makePrismaMock();
    await expect(computeRevenue(prisma, 2, { from: '2026-05-01', to: new Date() }))
      .rejects.toThrow(/from must be a valid Date/);
    await expect(computeRevenue(prisma, 2, { from: new Date(), to: 'tomorrow' }))
      .rejects.toThrow(/to must be a valid Date/);
  });

  test('rejects non-numeric tenantId', async () => {
    const prisma = makePrismaMock();
    await expect(computeRevenue(prisma, '2', {
      from: new Date(),
      to: new Date(),
    })).rejects.toThrow(/tenantId/);
  });

  test('rejects bad prisma client (defensive against undefined import)', async () => {
    await expect(computeRevenue(null, 2, {
      from: new Date(),
      to: new Date(),
    })).rejects.toThrow(/prisma\.visit\.findMany/);
    await expect(computeRevenue({}, 2, {
      from: new Date(),
      to: new Date(),
    })).rejects.toThrow(/prisma\.visit\.findMany/);
  });

  test('still applies status filter even if Prisma somehow returned mixed statuses', async () => {
    // Belt-and-braces: if a future Prisma plugin / proxy mutated the where
    // clause and a non-completed row leaked through, sumCompleted re-applies
    // the filter so revenue stays accurate.
    const prisma = makePrismaMock({
      visits: [
        { status: 'completed', amountCharged: 100 },
        { status: 'cancelled', amountCharged: 200 },  // shouldn't be in DB result, but defend
        { status: 'completed', amountCharged: 300 },
      ],
    });
    const r = await computeRevenue(prisma, 2, {
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-31T23:59:59Z'),
    });
    expect(r.revenue).toBe(400);  // 100 + 300, NOT 600
    expect(r.count).toBe(2);
  });
});
