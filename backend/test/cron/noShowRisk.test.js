// @ts-check
/**
 * Unit tests for the PRD Gap §12 #4e notification path —
 * runNoShowRiskForTenant() in backend/cron/appointmentRemindersEngine.js.
 *
 * Engine under test: daily 08:30 IST, scans booked Visits in [now, now+48h],
 * scores them with the same rule-set as the dashboard's noShowRisk
 * (past no-show +30, missing reminder +20, first-visit +15, off-hours +10,
 * loyalty -10), and fires one Notification per (visit, recipient) for any
 * visit scoring ≥ NOSHOW_THRESHOLD (60). Recipients = the visit's doctor
 * + every ADMIN/MANAGER in the tenant.
 *
 * Idempotency: dedup by Notification(tenantId, userId, link, type='warning').
 * Repeated cron ticks find the existing notification row and skip the
 * insert. Pinning this here means a refactor that drops the dedup query
 * surfaces as a red unit test, not a notification-spam production bug.
 *
 * Branches covered:
 *   - Empty visit set: no further DB work.
 *   - Score ≥ 60 → notification fires; score < 60 → skipped.
 *   - Recipient set: doctor + ADMIN/MANAGER, deduped (doctor=admin → one row).
 *   - Dedup: alreadyNotifiedNoShow=true → notification.create skipped.
 *   - LoyaltyTransaction missing model: try/catch keeps the engine alive.
 *
 * Mocking strategy: monkey-patch prisma singleton (same pattern as
 * appointmentRemindersEngine.test.js).
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runNoShowRiskForTenant,
} from '../../cron/appointmentRemindersEngine.js';

beforeAll(() => {
  prisma.visit = prisma.visit || {};
  prisma.visit.findMany = vi.fn();
  prisma.smsMessage = prisma.smsMessage || {};
  prisma.smsMessage.findMany = vi.fn();
  prisma.loyaltyTransaction = prisma.loyaltyTransaction || {};
  prisma.loyaltyTransaction.findMany = vi.fn();
  prisma.user = prisma.user || {};
  prisma.user.findMany = vi.fn();
  prisma.notification = prisma.notification || {};
  prisma.notification.findFirst = vi.fn();
  prisma.notification.create = vi.fn();
});

beforeEach(() => {
  prisma.visit.findMany.mockReset();
  prisma.smsMessage.findMany.mockReset();
  prisma.loyaltyTransaction.findMany.mockReset();
  prisma.user.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();

  // Defaults: empty signal sets so each test only seeds what it cares about.
  prisma.visit.findMany.mockResolvedValue([]);
  prisma.smsMessage.findMany.mockResolvedValue([]);
  prisma.loyaltyTransaction.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({});
});

const TENANT_ID = 7;

// Build an upcoming visit shape that matches the engine's include shape.
// Score components engineered to land >= 60 reliably:
//   - past no-show in 90d  → +30
//   - first-visit (no anyVisits) → +15
//   - off-hours (e.g. 7am or 8pm)  → +10
//   - missing SMS reminder in T-24..T-1h → +20
//   Total possible: ~75. We seed 3+ to clear the 60 bar.
function highRiskVisit({ id = 1, patientId = 100, doctorId = 50 }) {
  // 6 hours out → inside (1, 24) hours window so missing-reminder bonus applies.
  const visitDate = new Date(Date.now() + 6 * 3600 * 1000);
  return {
    id,
    patientId,
    visitDate,
    doctor: { id: doctorId },
    patient: { id: patientId, name: 'Risky Patient', phone: '+91 99999 11111' },
  };
}

// Low-risk visit: ~30h out (outside missing-reminder window), and we won't
// seed the past-no-show set, so total score stays below 60.
function lowRiskVisit({ id = 2, patientId = 200, doctorId = 50 }) {
  const visitDate = new Date(Date.now() + 30 * 3600 * 1000);
  return {
    id,
    patientId,
    visitDate,
    doctor: { id: doctorId },
    patient: { id: patientId, name: 'Safe Patient', phone: '+91 99999 22222' },
  };
}

// ─── Empty path ─────────────────────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — runNoShowRiskForTenant empty path', () => {
  test('no upcoming visits → returns zeros, no signal queries, no writes', async () => {
    prisma.visit.findMany.mockResolvedValueOnce([]); // upcoming empty

    const res = await runNoShowRiskForTenant(TENANT_ID);

    expect(res).toEqual({ scored: 0, flagged: 0, notified: 0 });
    // Only the upcoming-visits query runs; signal queries skipped.
    expect(prisma.visit.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

// ─── Score gate ─────────────────────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — runNoShowRiskForTenant scoring + dispatch', () => {
  test('high-risk visit → notification fires for doctor + admins', async () => {
    const v = highRiskVisit({ id: 1, patientId: 100, doctorId: 50 });
    // upcoming
    prisma.visit.findMany.mockResolvedValueOnce([v]);
    // pastNoShows: this patient HAS a past no-show → +30
    prisma.visit.findMany.mockResolvedValueOnce([{ patientId: 100 }]);
    // anyVisits: empty → first-visit bonus +15
    prisma.visit.findMany.mockResolvedValueOnce([]);
    // smsSent: empty → missing-reminder bonus +20 (visit is 6h out, in window)
    prisma.smsMessage.findMany.mockResolvedValueOnce([]);
    // loyalty: empty (no penalty)
    prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([]);
    // owners: 2 ADMIN/MANAGER users, one of which is also the doctor (id=50)
    prisma.user.findMany.mockResolvedValueOnce([{ id: 50 }, { id: 99 }]);

    const res = await runNoShowRiskForTenant(TENANT_ID);

    expect(res.scored).toBe(1);
    expect(res.flagged).toBe(1);
    // Doctor 50 is dedup'd against admin 50 → 2 unique recipients (50, 99).
    expect(res.notified).toBe(2);
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });

  test('low-risk visit (score < 60) → no notification', async () => {
    const v = lowRiskVisit({ id: 2 });
    prisma.visit.findMany.mockResolvedValueOnce([v]);
    // No past no-show, no first-visit bonus negation, etc.
    prisma.visit.findMany.mockResolvedValueOnce([]); // pastNoShows empty
    prisma.visit.findMany.mockResolvedValueOnce([{ patientId: 200 }]); // any prior visit (visited before, no first-visit bonus)
    prisma.smsMessage.findMany.mockResolvedValueOnce([]);
    prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 99 }]);

    const res = await runNoShowRiskForTenant(TENANT_ID);

    expect(res.scored).toBe(1);
    expect(res.flagged).toBe(0);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});

// ─── Notification shape ─────────────────────────────────────────────────────

describe('cron/appointmentRemindersEngine — runNoShowRiskForTenant notification shape', () => {
  test('notification carries type=warning, link=/wellness/visits/<id>, tenant scope', async () => {
    const v = highRiskVisit({ id: 42, patientId: 100, doctorId: 50 });
    prisma.visit.findMany.mockResolvedValueOnce([v]);
    prisma.visit.findMany.mockResolvedValueOnce([{ patientId: 100 }]); // past no-show
    prisma.visit.findMany.mockResolvedValueOnce([]); // any visits
    prisma.smsMessage.findMany.mockResolvedValueOnce([]);
    prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 99 }]);

    await runNoShowRiskForTenant(TENANT_ID);

    expect(prisma.notification.create).toHaveBeenCalled();
    const arg = prisma.notification.create.mock.calls[0][0];
    expect(arg.data.tenantId).toBe(TENANT_ID);
    expect(arg.data.type).toBe('warning');
    expect(arg.data.link).toBe('/wellness/visits/42');
    expect(arg.data.title).toContain('Risky Patient');
    expect(arg.data.message).toMatch(/risk score/i);
  });
});

// ─── Idempotency: dedup via Notification.findFirst ─────────────────────────

describe('cron/appointmentRemindersEngine — runNoShowRiskForTenant idempotency', () => {
  test('alreadyNotifiedNoShow=true → notification.create NOT called', async () => {
    const v = highRiskVisit({ id: 7, patientId: 100, doctorId: 50 });
    prisma.visit.findMany.mockResolvedValueOnce([v]);
    prisma.visit.findMany.mockResolvedValueOnce([{ patientId: 100 }]);
    prisma.visit.findMany.mockResolvedValueOnce([]);
    prisma.smsMessage.findMany.mockResolvedValueOnce([]);
    prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 99 }]);
    // Both recipients already received the notification (prior tick).
    prisma.notification.findFirst.mockResolvedValue({ id: 'prior' });

    const res = await runNoShowRiskForTenant(TENANT_ID);

    expect(res.flagged).toBe(1);
    expect(res.notified).toBe(0);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('partial dedup: doctor already notified, admin not → only admin gets new row', async () => {
    const v = highRiskVisit({ id: 7, patientId: 100, doctorId: 50 });
    prisma.visit.findMany.mockResolvedValueOnce([v]);
    prisma.visit.findMany.mockResolvedValueOnce([{ patientId: 100 }]);
    prisma.visit.findMany.mockResolvedValueOnce([]);
    prisma.smsMessage.findMany.mockResolvedValueOnce([]);
    prisma.loyaltyTransaction.findMany.mockResolvedValueOnce([]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 99 }]); // admin 99 only

    // First check (doctor 50): already notified.
    // Second check (admin 99): fresh.
    // Order isn't deterministic across Set iteration in different JS engines,
    // so handle both orderings: one returns "prior", the other null.
    prisma.notification.findFirst
      .mockResolvedValueOnce({ id: 'prior' })
      .mockResolvedValueOnce(null);

    const res = await runNoShowRiskForTenant(TENANT_ID);

    expect(res.flagged).toBe(1);
    expect(res.notified).toBe(1);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });
});

// ─── Defensive: loyaltyTransaction model missing ───────────────────────────

describe('cron/appointmentRemindersEngine — runNoShowRiskForTenant defensive', () => {
  test('LoyaltyTransaction.findMany throws → engine treats loyalty set as empty, continues', async () => {
    const v = highRiskVisit({ id: 1 });
    prisma.visit.findMany.mockResolvedValueOnce([v]);
    prisma.visit.findMany.mockResolvedValueOnce([{ patientId: 100 }]);
    prisma.visit.findMany.mockResolvedValueOnce([]);
    prisma.smsMessage.findMany.mockResolvedValueOnce([]);
    // Loyalty model unhealthy
    prisma.loyaltyTransaction.findMany.mockRejectedValueOnce(new Error('table missing'));
    prisma.user.findMany.mockResolvedValueOnce([{ id: 99 }]);

    const res = await runNoShowRiskForTenant(TENANT_ID);

    // Engine still scored, still flagged, still notified.
    expect(res.scored).toBe(1);
    expect(res.flagged).toBe(1);
    expect(res.notified).toBeGreaterThanOrEqual(1);
  });
});
