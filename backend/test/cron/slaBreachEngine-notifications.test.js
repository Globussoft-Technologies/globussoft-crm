// @ts-check
/**
 * Unit tests for the PRD Gap §12 #4b notification path —
 * Notification side-effect inside processTenant() in
 * backend/cron/slaBreachEngine.js.
 *
 * When a Ticket trips its SLA, the engine flips breached=true, emits
 * 'sla.breached', AND fires Notification rows for the assignee (if any)
 * + every ADMIN/MANAGER in the tenant. Idempotency rides on the
 * existing breached=false WHERE precondition: once flipped, the engine
 * never re-enters this code path for that ticket → no duplicate
 * notifications across cron ticks.
 *
 * Why this file exists (not slaBreachEngine.test.js):
 *   The existing slaBreachEngine.test.js pre-mocks prisma.user against
 *   nothing (Notification fan-out wasn't part of its contract). Layering
 *   the new mocks alongside risks subtle order coupling in the existing
 *   tests. A separate file keeps the regression intent explicit and the
 *   failure surface localised.
 *
 * Branches covered:
 *   - assignee+admins → all receive notifications; admin==assignee deduped.
 *   - no assignee → admins/managers still receive.
 *   - no admins/managers + no assignee → no notifications, breach still
 *     recorded, return value still includes the breach.
 *   - notification.createMany throw → caught, breach still committed.
 *   - Idempotency: already-breached ticket excluded by WHERE → next tick
 *     produces zero notifications (proven via mock returning []).
 *
 * Mocking strategy: same prisma-singleton pattern as slaBreachEngine.test.js.
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import { processTenant } from '../../cron/slaBreachEngine.js';

beforeAll(() => {
  prisma.ticket = prisma.ticket || {};
  prisma.ticket.findMany = vi.fn();
  prisma.ticket.update = vi.fn();
  prisma.user = prisma.user || {};
  prisma.user.findMany = vi.fn();
  prisma.notification = prisma.notification || {};
  prisma.notification.createMany = vi.fn();
  // emitEvent's tail touches automationRule.findMany + webhook.findMany
  prisma.automationRule = prisma.automationRule || {};
  prisma.automationRule.findMany = vi.fn();
  prisma.webhook = prisma.webhook || {};
  prisma.webhook.findMany = vi.fn();
});

beforeEach(() => {
  prisma.ticket.findMany.mockReset();
  prisma.ticket.update.mockReset();
  prisma.user.findMany.mockReset();
  prisma.notification.createMany.mockReset();
  prisma.automationRule.findMany.mockReset();
  prisma.webhook.findMany.mockReset();

  prisma.ticket.findMany.mockResolvedValue([]);
  prisma.ticket.update.mockResolvedValue({});
  prisma.user.findMany.mockResolvedValue([]);
  prisma.notification.createMany.mockResolvedValue({ count: 0 });
  prisma.automationRule.findMany.mockResolvedValue([]);
  prisma.webhook.findMany.mockResolvedValue([]);
});

const TENANT = { id: 'tenant-Z', slug: 'support-co' };

function ticket({
  id,
  subject = 'Order not delivered',
  priority = 'High',
  assigneeId = 88,
  slaResponseDue = new Date(Date.now() - 60 * 1000),
  tenantId = 'tenant-Z',
}) {
  return { id, subject, priority, assigneeId, slaResponseDue, tenantId };
}

// ─── Notification fan-out ──────────────────────────────────────────────────

describe('cron/slaBreachEngine — Notification side-effect (PRD §12 #4b)', () => {
  test('breach with assignee + admins → notification.createMany once with deduped recipients', async () => {
    prisma.ticket.findMany.mockResolvedValueOnce([ticket({ id: 1, assigneeId: 88 })]);
    // Admins/managers including the assignee 88 → should be deduped.
    prisma.user.findMany.mockResolvedValueOnce([{ id: 88 }, { id: 99 }, { id: 100 }]);

    const res = await processTenant(TENANT);

    expect(res.breached).toBe(1);
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    const arg = prisma.notification.createMany.mock.calls[0][0];
    const ids = arg.data.map((n) => n.userId).sort((a, b) => a - b);
    // 88 dedup'd → 88, 99, 100 (3 unique).
    expect(ids).toEqual([88, 99, 100]);
    arg.data.forEach((n) => {
      expect(n.tenantId).toBe('tenant-Z');
      expect(n.type).toBe('warning');
      expect(n.title).toContain('Order not delivered');
      expect(n.link).toBe('/tickets/1');
    });
  });

  test('breach with no assignee → admins still receive', async () => {
    prisma.ticket.findMany.mockResolvedValueOnce([ticket({ id: 2, assigneeId: null })]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 99 }]);

    const res = await processTenant(TENANT);

    expect(res.breached).toBe(1);
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(1);
    expect(arg.data[0].userId).toBe(99);
  });

  test('zero recipients (no assignee + no admins) → notification.createMany NOT called; breach still committed', async () => {
    prisma.ticket.findMany.mockResolvedValueOnce([ticket({ id: 3, assigneeId: null })]);
    prisma.user.findMany.mockResolvedValueOnce([]);

    const res = await processTenant(TENANT);

    expect(res.breached).toBe(1);
    expect(prisma.ticket.update).toHaveBeenCalledTimes(1); // breach flip
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  test('notification.createMany throw → caught, breach still recorded', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    prisma.ticket.findMany.mockResolvedValueOnce([ticket({ id: 4, assigneeId: 88 })]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 99 }]);
    prisma.notification.createMany.mockRejectedValueOnce(new Error('DB write failed'));

    const res = await processTenant(TENANT);

    expect(res.breached).toBe(1);
    expect(prisma.ticket.update).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('notification message includes lateness in minutes when breachedBy > 0', async () => {
    // 2 minutes overdue
    const dueAt = new Date(Date.now() - 2 * 60 * 1000);
    prisma.ticket.findMany.mockResolvedValueOnce([
      ticket({ id: 5, assigneeId: 88, slaResponseDue: dueAt }),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 88 }]);

    await processTenant(TENANT);

    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.data[0].message).toMatch(/by\s+\d+\s+min/);
  });
});

// ─── Idempotency: already-breached → no notifications ─────────────────────

describe('cron/slaBreachEngine — Notification idempotency', () => {
  test('candidate query filters breached=false, so already-breached tickets never reach the notification path', async () => {
    // Engine returns no candidates because all are breached=true.
    prisma.ticket.findMany.mockResolvedValueOnce([]);

    const res = await processTenant(TENANT);

    expect(res.breached).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();

    // WHERE pinned for completeness — anti-regression on the dedup gate.
    const arg = prisma.ticket.findMany.mock.calls[0][0];
    expect(arg.where.breached).toBe(false);
  });
});
