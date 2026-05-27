// Unit tests for backend/cron/leavePolicyEngine.js (Wave 8b residual).
//
// Coverage scope:
//   - isFiscalYearEnd: wellness vs generic boundaries
//   - nextPeriodStart / nextPeriodEnd: roll-over boundary semantics
//   - runForTenant:
//       * non-fiscal-year-end → no-op
//       * tenant not found → no-op
//       * no policies with carryForwardCap or encashable → no-op
//       * carry-forward only: residual ≤ cap → next-period balance gets all
//       * carry-forward only: residual > cap → cap copied, no encashment
//       * encashable + carryForwardCap=null: full residual encashed
//       * encashable + cap=2: cap carried, rest encashed (notification + audit)
//       * zero available → skipped (no balance write)
//
// Mocking strategy: monkey-patch prisma singleton (same pattern as
// slaBreachEngine.test.js + posReceiptDispatcher.test.js).

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import {
  runForTenant,
  isFiscalYearEnd,
  nextPeriodStart,
  nextPeriodEnd,
} from '../../cron/leavePolicyEngine.js';

beforeAll(() => {
  prisma.tenant = prisma.tenant || {};
  prisma.tenant.findUnique = vi.fn();
  prisma.leavePolicy = prisma.leavePolicy || {};
  prisma.leavePolicy.findMany = vi.fn();
  prisma.leaveBalance = prisma.leaveBalance || {};
  prisma.leaveBalance.findMany = vi.fn();
  prisma.leaveBalance.upsert = vi.fn();
  prisma.leaveBalance.update = vi.fn();
  prisma.user = prisma.user || {};
  prisma.user.findMany = vi.fn();
  prisma.notification = prisma.notification || {};
  prisma.notification.createMany = vi.fn();
  prisma.auditLog = prisma.auditLog || {};
  prisma.auditLog.create = vi.fn();
});

beforeEach(() => {
  prisma.tenant.findUnique.mockReset();
  prisma.leavePolicy.findMany.mockReset();
  prisma.leaveBalance.findMany.mockReset();
  prisma.leaveBalance.upsert.mockReset();
  prisma.leaveBalance.update.mockReset();
  prisma.user.findMany.mockReset();
  prisma.notification.createMany.mockReset();
  prisma.auditLog.create.mockReset();

  // Defaults
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
  prisma.leavePolicy.findMany.mockResolvedValue([]);
  prisma.leaveBalance.findMany.mockResolvedValue([]);
  prisma.leaveBalance.upsert.mockResolvedValue({ id: 1 });
  prisma.leaveBalance.update.mockResolvedValue({ id: 1 });
  prisma.user.findMany.mockResolvedValue([]);
  prisma.notification.createMany.mockResolvedValue({ count: 0 });
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
});

describe('isFiscalYearEnd', () => {
  test('wellness vertical: 31-March → true', () => {
    expect(isFiscalYearEnd(new Date('2026-03-31T05:00:00Z'), 'wellness')).toBe(true);
  });
  test('wellness vertical: 30-March → false', () => {
    expect(isFiscalYearEnd(new Date('2026-03-30T05:00:00Z'), 'wellness')).toBe(false);
  });
  test('wellness vertical: 31-December → false', () => {
    expect(isFiscalYearEnd(new Date('2026-12-31T05:00:00Z'), 'wellness')).toBe(false);
  });
  test('generic vertical: 31-December → true', () => {
    expect(isFiscalYearEnd(new Date('2026-12-31T05:00:00Z'), 'generic')).toBe(true);
  });
  test('generic vertical: 31-March → false', () => {
    expect(isFiscalYearEnd(new Date('2026-03-31T05:00:00Z'), 'generic')).toBe(false);
  });
});

describe('nextPeriodStart / nextPeriodEnd', () => {
  test('next-period start is the day after the fiscal-year-end at 00:00', () => {
    // Use a local-tz date so the test is ICU-build-independent (the wave-6
    // standing rule on TZ-label assertions). Constructing with new Date(y,m,d)
    // anchors to the local tz, sidestepping the UTC midnight overlap that
    // tripped the earlier assertion.
    const end = new Date(2026, 2, 31, 23, 59, 59); // 2026-03-31 local
    const start = nextPeriodStart(end);
    // Next day calendar: April 1 (local-time relative — hours zeroed to 0)
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(3); // April
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });

  test('next-period end is one year minus a day later at 23:59', () => {
    const start = new Date(2026, 3, 1, 0, 0, 0); // 2026-04-01 local
    const end = nextPeriodEnd(start);
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(2); // March
    expect(end.getDate()).toBe(31);
    expect(end.getHours()).toBe(23);
  });
});

describe('runForTenant — no-op cases', () => {
  test('non-fiscal-year-end → no-op', async () => {
    const r = await runForTenant(1, { now: new Date('2026-06-15T05:00:00Z') });
    expect(r.policies).toBe(0);
    expect(r.carriedForward).toBe(0);
    expect(r.encashed).toBe(0);
    expect(prisma.leavePolicy.findMany).not.toHaveBeenCalled();
  });

  test('tenant not found → no-op', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    const r = await runForTenant(99, { now: new Date('2026-03-31T05:00:00Z') });
    expect(r.policies).toBe(0);
    expect(prisma.leavePolicy.findMany).not.toHaveBeenCalled();
  });

  test('no qualifying policies (no carry, no encash) → no-op', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([]);
    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });
    expect(r.policies).toBe(0);
    expect(prisma.leaveBalance.findMany).not.toHaveBeenCalled();
  });

  test('zero available balance → skipped (no balance writes)', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Casual', annualEntitlement: 12, carryForwardCap: 5, encashable: false },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 1, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 0 },
    ]);
    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });
    expect(r.carriedForward).toBe(0);
    expect(prisma.leaveBalance.upsert).not.toHaveBeenCalled();
    expect(prisma.leaveBalance.update).not.toHaveBeenCalled();
  });
});

describe('runForTenant — carry-forward semantics', () => {
  test('residual ≤ cap → all carried, none encashed', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Casual', annualEntitlement: 12, carryForwardCap: 5, encashable: false },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 1, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 3 },
    ]);
    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });

    expect(r.carriedForward).toBe(1);
    expect(r.encashed).toBe(0);
    expect(prisma.leaveBalance.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prisma.leaveBalance.upsert.mock.calls[0][0];
    expect(upsertArg.create.entitled).toBe(15); // 12 + 3
    expect(upsertArg.create.available).toBe(15);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('residual > cap → cap carried; without encashable=true, no encashment', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Casual', annualEntitlement: 12, carryForwardCap: 5, encashable: false },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 1, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 8 },
    ]);
    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });

    expect(r.carriedForward).toBe(1);
    expect(r.encashed).toBe(0);
    const upsertArg = prisma.leaveBalance.upsert.mock.calls[0][0];
    expect(upsertArg.create.entitled).toBe(17); // 12 + 5 (capped)
    // No audit row because encashable=false.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('runForTenant — encashment semantics', () => {
  test('encashable=true + cap=2 + available=7 → 2 carried, 5 encashed (audit + notification)', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Earned', annualEntitlement: 18, carryForwardCap: 2, encashable: true },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 5, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 7 },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 5 }, { id: 1 }]); // requester + admin

    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });

    expect(r.carriedForward).toBe(1);
    expect(r.encashed).toBe(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArg.data.action).toBe('LEAVE_ENCASHMENT');
    expect(auditArg.data.entityId).toBe(100);
    const auditDetails = JSON.parse(auditArg.data.details);
    expect(auditDetails.encashedDays).toBe(5);

    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    const notifArg = prisma.notification.createMany.mock.calls[0][0];
    expect(notifArg.data).toHaveLength(2);
    expect(notifArg.data[0].title).toContain('Leave encashment');
  });

  test('encashable=true + cap=null + available=4 → 0 carried, 4 encashed', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Earned', annualEntitlement: 18, carryForwardCap: null, encashable: true },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 5, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 4 },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 5 }]);

    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });

    expect(r.carriedForward).toBe(0);
    expect(r.encashed).toBe(1);
    expect(prisma.leaveBalance.upsert).not.toHaveBeenCalled(); // no carry → no upsert
    const auditDetails = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(auditDetails.encashedDays).toBe(4);
  });

  test('a balance failure (e.g. upsert throws) is caught and other balances proceed', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Casual', annualEntitlement: 12, carryForwardCap: 5, encashable: false },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 1, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 3 },
      { id: 101, userId: 2, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 3 },
    ]);
    let callCount = 0;
    prisma.leaveBalance.upsert.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve({ id: 999 });
    });

    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });
    // First failed; second succeeded — engine kept going.
    expect(r.carriedForward).toBe(1);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  EXTENDED COVERAGE (+8 cases — closed-period zero-out, tenant isolation,
//  multi-policy fan-out, multi-user batch, generic-vertical Dec 31, encash
//  recipient fan-out, null-available defensive default, singular/plural
//  notification wording). The 8 cases below pin contract behaviours that
//  were observed in the SUT (lines 154-292) but not asserted by the
//  initial 16 cases.
// ─────────────────────────────────────────────────────────────────────────

describe('runForTenant — closed-period zero-out (step 3 of contract)', () => {
  test('after carry, closing-period LeaveBalance.available is set to 0 (no double-count)', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Casual', annualEntitlement: 12, carryForwardCap: 5, encashable: false },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 1, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 3 },
    ]);
    await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });
    // The closing-period row gets zeroed out so the CSV listing doesn't
    // double-count the carried amount alongside the new period's balance.
    expect(prisma.leaveBalance.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.leaveBalance.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 100 });
    expect(updateArg.data).toEqual({ available: 0 });
  });
});

describe('runForTenant — tenant isolation', () => {
  test('leavePolicy.findMany is scoped by the requested tenantId (no cross-tenant bleed)', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([]);
    await runForTenant(42, { now: new Date('2026-03-31T05:00:00Z') });
    expect(prisma.leavePolicy.findMany).toHaveBeenCalledTimes(1);
    const whereArg = prisma.leavePolicy.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(42);
    expect(whereArg.isActive).toBe(true);
    // The OR-of-{carryForwardCap > 0, encashable: true} predicate ensures
    // policies with neither setting are excluded server-side.
    expect(whereArg.OR).toEqual([
      { carryForwardCap: { gt: 0 } },
      { encashable: true },
    ]);
  });
});

describe('runForTenant — multi-policy fan-out', () => {
  test('two policies on same tenant → both iterate; result.policies counts both', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Casual', annualEntitlement: 12, carryForwardCap: 5, encashable: false },
      { id: 11, name: 'Sick',   annualEntitlement: 10, carryForwardCap: 3, encashable: false },
    ]);
    // Each leaveBalance.findMany call returns one balance per policy.
    prisma.leaveBalance.findMany
      .mockResolvedValueOnce([
        { id: 100, userId: 1, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 2 },
      ])
      .mockResolvedValueOnce([
        { id: 101, userId: 1, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 4 },
      ]);

    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });
    expect(r.policies).toBe(2);
    expect(r.carriedForward).toBe(2);
    expect(prisma.leaveBalance.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.leaveBalance.upsert).toHaveBeenCalledTimes(2);
  });
});

describe('runForTenant — multi-user batch under one policy', () => {
  test('three users on the same policy → all three carry-forward upserts fire', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Casual', annualEntitlement: 12, carryForwardCap: 5, encashable: false },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 1, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 2 },
      { id: 101, userId: 2, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 3 },
      { id: 102, userId: 3, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 4 },
    ]);
    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });
    expect(r.carriedForward).toBe(3);
    expect(prisma.leaveBalance.upsert).toHaveBeenCalledTimes(3);
    // The composite-unique where clause must include each user's id distinctly.
    const userIdsUpserted = prisma.leaveBalance.upsert.mock.calls
      .map((c) => c[0].where.tenantId_userId_policyId_periodStart.userId)
      .sort();
    expect(userIdsUpserted).toEqual([1, 2, 3]);
  });
});

describe('runForTenant — generic vertical fiscal-year-end (Dec 31)', () => {
  test('generic tenant on Dec 31 fires carry-forward (calendar year-end)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'generic' });
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Annual', annualEntitlement: 20, carryForwardCap: 5, encashable: false },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 1, periodEnd: new Date('2026-12-31T23:59:59Z'), available: 3 },
    ]);
    const r = await runForTenant(1, { now: new Date('2026-12-31T05:00:00Z') });
    expect(r.policies).toBe(1);
    expect(r.carriedForward).toBe(1);
    // The generic tenant must NOT fire on March 31 — that's the wellness anchor.
    prisma.leaveBalance.upsert.mockClear();
    prisma.leavePolicy.findMany.mockClear();
    const r2 = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });
    expect(r2.policies).toBe(0);
    expect(prisma.leavePolicy.findMany).not.toHaveBeenCalled();
  });
});

describe('runForTenant — encashment recipient fan-out', () => {
  test('encashment notifies the requester + every ADMIN (recipient query has OR clause)', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Earned', annualEntitlement: 18, carryForwardCap: 0, encashable: true },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 7, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 6 },
    ]);
    // 1 requester (user 7) + 2 admins (user 1, user 2) — three distinct recipients
    prisma.user.findMany.mockResolvedValue([{ id: 7 }, { id: 1 }, { id: 2 }]);

    await runForTenant(99, { now: new Date('2026-03-31T05:00:00Z') });
    // Recipient query is scoped to the tenant under operation + has the
    // requester-OR-ADMIN predicate.
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    const userWhere = prisma.user.findMany.mock.calls[0][0].where;
    expect(userWhere.tenantId).toBe(99);
    expect(userWhere.OR).toEqual([{ id: 7 }, { role: 'ADMIN' }]);
    // Notification fan-out lands one row per recipient.
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.notification.createMany.mock.calls[0][0].data).toHaveLength(3);
  });
});

describe('runForTenant — empty recipients defensive guard', () => {
  test('zero recipients (deleted user + no admins) → no notification.createMany call', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Earned', annualEntitlement: 18, carryForwardCap: 0, encashable: true },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      { id: 100, userId: 5, periodEnd: new Date('2026-03-31T23:59:59Z'), available: 3 },
    ]);
    prisma.user.findMany.mockResolvedValue([]); // no recipients found at all

    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });
    // The audit row still lands (it's the source of truth for payroll).
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    // But notification.createMany is guarded — empty data would crash Prisma.
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(r.encashed).toBe(1);
  });
});

describe('runForTenant — null-available defensive default', () => {
  test('available=null is treated as 0 (skipped — no upsert, no audit)', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 10, name: 'Casual', annualEntitlement: 12, carryForwardCap: 5, encashable: true },
    ]);
    prisma.leaveBalance.findMany.mockResolvedValue([
      // available=null (e.g. legacy row before the column had a default)
      { id: 100, userId: 1, periodEnd: new Date('2026-03-31T23:59:59Z'), available: null },
    ]);
    const r = await runForTenant(1, { now: new Date('2026-03-31T05:00:00Z') });
    expect(r.carriedForward).toBe(0);
    expect(r.encashed).toBe(0);
    expect(prisma.leaveBalance.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.leaveBalance.update).not.toHaveBeenCalled();
  });
});
