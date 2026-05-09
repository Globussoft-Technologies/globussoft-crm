// @ts-check
/**
 * Unit tests for the PRD Gap §12 #4d notification path —
 * runMembershipExpiryForTenant() in backend/cron/wellnessOpsEngine.js.
 *
 * Engine under test: every hourly tick scans active Memberships whose
 * endDate falls in [now, now+7d] AND expiryNotifiedAt IS NULL, fires
 * one Notification per recipient (every ADMIN/MANAGER user in the
 * tenant), then stamps expiryNotifiedAt so the next tick skips the row.
 *
 * Why this file exists:
 *   - The membership-expiry path is a NEW notification creation site
 *     (Wave 6B). The dedup-via-marker-field strategy MUST be pinned at
 *     the unit level so a future "let's just query Notification for
 *     dedup" refactor (which would re-fire on every tick) trips a red
 *     test, not a phantom production bug.
 *
 * Branches covered:
 *   - Window: only memberships with endDate in [now, now+7d] → notified
 *     ones outside the window are NOT picked up by query (assertion is
 *     on the WHERE shape, since the mock returns whatever we give it).
 *   - status='active' filter — cancelled/expired memberships ignored.
 *   - expiryNotifiedAt:null in WHERE — already-notified memberships skip.
 *   - Notification fan-out: one row per ADMIN/MANAGER recipient.
 *   - Marker stamping: expiryNotifiedAt updated AFTER notifications
 *     create, so a transient notification failure leaves the marker
 *     null and the next tick retries.
 *   - Empty membership set: short-circuit, no user query, no writes.
 *   - Empty recipient set: marker still stamped (one-shot lifetime per
 *     membership), notifications skipped.
 *
 * Mocking strategy: monkey-patch the prisma singleton (same pattern as
 * lowStockEngine.test.js + wellnessOpsEngine.test.js). The SUT is inlined
 * via vitest.config.js so its `require('../lib/prisma')` resolves to the
 * same instance under test.
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import { runMembershipExpiryForTenant } from '../../cron/wellnessOpsEngine.js';

beforeAll(() => {
  prisma.membership = prisma.membership || {};
  prisma.membership.findMany = vi.fn();
  prisma.membership.update = vi.fn();
  prisma.notification = prisma.notification || {};
  prisma.notification.createMany = vi.fn();
  prisma.user = prisma.user || {};
  prisma.user.findMany = vi.fn();
});

beforeEach(() => {
  prisma.membership.findMany.mockReset();
  prisma.membership.update.mockReset();
  prisma.notification.createMany.mockReset();
  prisma.user.findMany.mockReset();

  prisma.membership.findMany.mockResolvedValue([]);
  prisma.membership.update.mockResolvedValue({});
  prisma.notification.createMany.mockResolvedValue({ count: 0 });
  prisma.user.findMany.mockResolvedValue([]);
});

const TENANT_ID = 42;

function membership({
  id,
  patientId = 100,
  endDate = new Date(Date.now() + 3 * 86400000),
  patientName = 'Kavita Reddy',
  planName = 'Glow Quarterly',
}) {
  return {
    id,
    patientId,
    endDate,
    plan: { id: 1, name: planName },
    patient: { id: patientId, name: patientName },
  };
}

// ─── Query shape ────────────────────────────────────────────────────────────

describe('cron/wellnessOpsEngine — runMembershipExpiryForTenant query shape', () => {
  test('issues ONE membership.findMany per tenant', async () => {
    await runMembershipExpiryForTenant(TENANT_ID);
    expect(prisma.membership.findMany).toHaveBeenCalledTimes(1);
  });

  test('WHERE scopes tenantId + status=active + expiryNotifiedAt:null + endDate in 7d window', async () => {
    const before = Date.now();
    await runMembershipExpiryForTenant(TENANT_ID);

    const arg = prisma.membership.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(TENANT_ID);
    expect(arg.where.status).toBe('active');
    expect(arg.where.expiryNotifiedAt).toBeNull();
    expect(arg.where.endDate).toHaveProperty('gte');
    expect(arg.where.endDate).toHaveProperty('lte');

    const gte = arg.where.endDate.gte.getTime();
    const lte = arg.where.endDate.lte.getTime();
    // gte ~ now; lte ~ now + 7d
    expect(gte).toBeGreaterThanOrEqual(before - 100);
    expect(gte).toBeLessThanOrEqual(Date.now() + 50);
    const sevenDays = 7 * 86400000;
    expect(lte - gte).toBeGreaterThanOrEqual(sevenDays - 100);
    expect(lte - gte).toBeLessThanOrEqual(sevenDays + 100);
  });

  test('include hydrates patient + plan for the message body', async () => {
    await runMembershipExpiryForTenant(TENANT_ID);
    const arg = prisma.membership.findMany.mock.calls[0][0];
    expect(arg.include).toBeDefined();
    expect(arg.include.patient).toBeDefined();
    expect(arg.include.plan).toBeDefined();
  });
});

// ─── Empty path ─────────────────────────────────────────────────────────────

describe('cron/wellnessOpsEngine — runMembershipExpiryForTenant empty path', () => {
  test('zero expiring memberships → returns zeros and writes nothing', async () => {
    prisma.membership.findMany.mockResolvedValueOnce([]);

    const res = await runMembershipExpiryForTenant(TENANT_ID);

    expect(res).toEqual({ notified: 0, notifications: 0 });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(prisma.membership.update).not.toHaveBeenCalled();
  });
});

// ─── Happy path: notifications fan out + marker stamped ────────────────────

describe('cron/wellnessOpsEngine — runMembershipExpiryForTenant happy path', () => {
  test('one expiring membership + 2 ADMIN/MANAGER → 2 notifications + marker stamped', async () => {
    prisma.membership.findMany.mockResolvedValueOnce([
      membership({ id: 1, patientName: 'Kavita Reddy' }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 11 }, { id: 12 }]);

    const res = await runMembershipExpiryForTenant(TENANT_ID);

    expect(res).toEqual({ notified: 1, notifications: 2 });
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.membership.update).toHaveBeenCalledTimes(1);

    const notifArg = prisma.notification.createMany.mock.calls[0][0];
    expect(notifArg.data).toHaveLength(2);
    notifArg.data.forEach((n) => {
      expect(n.tenantId).toBe(TENANT_ID);
      expect(n.type).toBe('warning');
      expect(n.title).toContain('Kavita Reddy');
      expect(n.message).toContain('Kavita Reddy');
      expect(n.message).toContain('Glow Quarterly');
      expect(n.link).toBe('/wellness/patients/100');
    });
    expect(notifArg.data.map((n) => n.userId).sort()).toEqual([11, 12]);
  });

  test('user.findMany scopes to ADMIN/MANAGER within tenant', async () => {
    prisma.membership.findMany.mockResolvedValueOnce([membership({ id: 1 })]);
    prisma.user.findMany.mockResolvedValueOnce([]);

    await runMembershipExpiryForTenant(TENANT_ID);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(TENANT_ID);
    expect(arg.where.role).toEqual({ in: ['ADMIN', 'MANAGER'] });
  });

  test('marker is stamped for EACH membership processed', async () => {
    prisma.membership.findMany.mockResolvedValueOnce([
      membership({ id: 1 }),
      membership({ id: 2 }),
      membership({ id: 3 }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 11 }]);

    await runMembershipExpiryForTenant(TENANT_ID);

    expect(prisma.membership.update).toHaveBeenCalledTimes(3);
    const ids = prisma.membership.update.mock.calls.map((c) => c[0].where.id).sort();
    expect(ids).toEqual([1, 2, 3]);
    prisma.membership.update.mock.calls.forEach((c) => {
      expect(c[0].data.expiryNotifiedAt).toBeInstanceOf(Date);
    });
  });

  test('zero recipients → notifications skipped, marker still stamped', async () => {
    prisma.membership.findMany.mockResolvedValueOnce([membership({ id: 1 })]);
    prisma.user.findMany.mockResolvedValueOnce([]); // no admins/managers

    const res = await runMembershipExpiryForTenant(TENANT_ID);

    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(prisma.membership.update).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ notified: 1, notifications: 0 });
  });
});

// ─── Idempotency: re-running on an empty result → no double-fire ────────────

describe('cron/wellnessOpsEngine — runMembershipExpiryForTenant idempotency', () => {
  test('repeat tick after marker stamped (engine returns empty) → zero new notifications', async () => {
    // First tick: 1 expiring membership → notified.
    prisma.membership.findMany.mockResolvedValueOnce([membership({ id: 1 })]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 11 }]);
    await runMembershipExpiryForTenant(TENANT_ID);

    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.membership.update).toHaveBeenCalledTimes(1);

    // Second tick: WHERE filters expiryNotifiedAt:null so the prior row is
    // excluded by the DB layer. Mock returns empty.
    prisma.membership.findMany.mockResolvedValueOnce([]);
    const res = await runMembershipExpiryForTenant(TENANT_ID);

    expect(res).toEqual({ notified: 0, notifications: 0 });
    // Still only the first run's createMany call.
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.membership.update).toHaveBeenCalledTimes(1);
  });

  test('per-row error containment: update throws → sibling still processed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.membership.findMany.mockResolvedValueOnce([
      membership({ id: 1, patientName: 'Aarav' }),
      membership({ id: 2, patientName: 'Priya' }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 11 }]);
    prisma.membership.update
      .mockRejectedValueOnce(new Error('marker write failed'))
      .mockResolvedValueOnce({});

    const res = await runMembershipExpiryForTenant(TENANT_ID);

    // First row's update threw → "notified++" line never ran for it.
    // Second row succeeded → notified=1.
    expect(res.notified).toBe(1);
    // Both rows attempted notification.createMany before the failing update.
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
