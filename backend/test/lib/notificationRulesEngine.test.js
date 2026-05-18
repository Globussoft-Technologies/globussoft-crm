// Unit tests for backend/lib/notificationRulesEngine.js
//
// What this module does:
//   Registers in-process EventEmitter listeners on the shared `bus` for 10
//   workflow events. Each listener queries prisma for the affected entity
//   + the set of users to notify (admins/managers/assignee/requester) and
//   fans out via notificationService.notify(). Per-event try/catch so a
//   thrown error is logged but never aborts other listeners.
//
//   Events covered:
//     - sla.breached            (ticket SLA breach → admins + assignee)
//     - lead.sla_breached       (lead SLA → admins+managers + assignee)
//     - approval.created        (admins+managers)
//     - approval.approved       (requester)
//     - approval.rejected       (requester)
//     - expense.created         (admins+managers)
//     - expense.approved        (submitter)
//     - expense.rejected        (submitter, with rejection reason)
//     - leave.requested         (admins)
//     - leave.approved          (requester)
//     - leave.denied            (requester)
//
// Surface area covered:
//   - module shape: exports { init }
//   - init(io) wires every listener on the bus (event names match)
//   - For each listener:
//       - happy path: notify() called with the expected category/type/title
//       - tenant scoping: prisma .findMany WHERE { tenantId } pinned
//       - role filter for admin vs. admin+manager fan-out
//       - assignee/requester is unioned into the notify set
//       - missing entity (findUnique returns null) early-returns gracefully
//       - thrown error is caught (no throw out of the listener)
//       - io is propagated through to notify() (socket.io passthrough)
//
// Mocking strategy (per CLAUDE.md cron-learning 2026-05-09 wave-3c):
//   The notificationService module is CJS and exported as an object with
//   `notify` on it. Per vitest.config.js, backend/lib/ is inlined; the
//   notificationService module loaded via `require()` from the SUT shares
//   the same instance the test imports. We replace `notify` on that
//   instance with a vi.fn() spy and observe the calls.
//
//   prisma model methods are singleton-patched the same way as
//   eventBus.test.js / slaBreachEngine.test.js — monkey-patch the model
//   .findMany / .findUnique methods on the imported prisma client.
//
//   Listeners are async and dispatched via setImmediate by Node's
//   EventEmitter. We `await flushAsync()` (a small Promise.resolve loop)
//   after each `bus.emit` to give the async tail time to settle before
//   we assert.
//
// stripDangerous reminder (per CLAUDE.md): not relevant — pure lib module,
// no Express req/res.

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCjs = createRequire(import.meta.url);

// Patch the real CJS module.exports of notificationService so the SUT's
// runtime `require('./notificationService')` returns our stub.
const notificationService = requireCjs('../../lib/notificationService.js');

// Import bus + the engine itself. The engine registers listeners on
// the bus during init(io) — not at import time. So we import then call
// init() exactly once below.
const { bus } = requireCjs('../../lib/eventBus.js');
import engine from '../../lib/notificationRulesEngine.js';

// Helper: yield to the event loop a few times so async listener tails
// (await prisma.foo.findMany + await notify(...)) flush before we assert.
async function flushAsync() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

const FAKE_IO = { emit: vi.fn() };

// ──────────────────────────────────────────────────────────────────────────
// One-time setup: patch prisma + notificationService.notify, then init the
// engine so all 11 listeners are wired up on the shared bus.

let initialized = false;

beforeAll(() => {
  // Patch prisma model methods used by the engine.
  prisma.ticket = { findUnique: vi.fn() };
  prisma.contact = { findUnique: vi.fn() };
  prisma.user = { findMany: vi.fn(), findUnique: vi.fn() };

  // Stub notificationService.notify on the shared CJS module.exports object.
  notificationService.notify = vi.fn();

  // Initialise the engine once. Subsequent init() calls would just register
  // a SECOND listener for every event and double-fire — we only want one.
  if (!initialized) {
    engine.init(FAKE_IO);
    initialized = true;
  }
});

beforeEach(() => {
  prisma.ticket.findUnique.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.user.findMany.mockReset();
  prisma.user.findUnique.mockReset();
  notificationService.notify.mockReset();
  notificationService.notify.mockResolvedValue({ id: 1 });
  FAKE_IO.emit.mockReset();
});

// ──────────────────────────────────────────────────────────────────────────

describe('module shape', () => {
  test('exports { init }', () => {
    expect(typeof engine.init).toBe('function');
  });
});

describe('listener registration', () => {
  test('init() registers a listener for every supported event', () => {
    const supportedEvents = [
      'sla.breached',
      'lead.sla_breached',
      'approval.created',
      'approval.approved',
      'approval.rejected',
      'expense.created',
      'expense.approved',
      'expense.rejected',
      'leave.requested',
      'leave.approved',
      'leave.denied',
    ];
    for (const eventName of supportedEvents) {
      expect(bus.listenerCount(eventName)).toBeGreaterThanOrEqual(1);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────

describe('sla.breached → ticket SLA listener', () => {
  test('notifies admins + the ticket assignee', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce({
      id: 100,
      subject: 'Server down',
      assignedToId: 7,
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    bus.emit('sla.breached', {
      payload: { ticketId: 100 },
      tenantId: 42,
    });
    await flushAsync();

    expect(prisma.ticket.findUnique).toHaveBeenCalledWith({
      where: { id: 100 },
      select: { id: true, subject: true, assignedToId: true },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, role: 'ADMIN' },
      select: { id: true },
    });
    // 2 admins + 1 assignee = 3 notifications. The Set dedups so an admin
    // who is ALSO assignee would only be notified once.
    expect(notificationService.notify).toHaveBeenCalledTimes(3);

    const args = notificationService.notify.mock.calls[0][0];
    expect(args.category).toBe('ticket');
    expect(args.type).toBe('sla_breach');
    expect(args.priority).toBe('high');
    expect(args.tenantId).toBe(42);
    expect(args.entityType).toBe('ticket');
    expect(args.entityId).toBe(100);
    expect(args.io).toBe(FAKE_IO);
  });

  test('early-returns when ticket is null', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce(null);
    bus.emit('sla.breached', {
      payload: { ticketId: 999 },
      tenantId: 42,
    });
    await flushAsync();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(notificationService.notify).not.toHaveBeenCalled();
  });

  test('dedupes when assignee is also an admin', async () => {
    prisma.ticket.findUnique.mockResolvedValueOnce({
      id: 100,
      subject: 'Server down',
      assignedToId: 1, // same as admin id 1 below
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    bus.emit('sla.breached', {
      payload: { ticketId: 100 },
      tenantId: 42,
    });
    await flushAsync();

    expect(notificationService.notify).toHaveBeenCalledTimes(2); // 1, 2 — not 3
  });

  test('catches downstream errors without throwing out of the listener', async () => {
    prisma.ticket.findUnique.mockRejectedValueOnce(new Error('DB transient'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      bus.emit('sla.breached', { payload: { ticketId: 1 }, tenantId: 42 })
    ).not.toThrow();
    await flushAsync();
    errSpy.mockRestore();
    expect(notificationService.notify).not.toHaveBeenCalled();
  });
});

describe('lead.sla_breached → lead SLA listener', () => {
  test('notifies admins + managers + the lead assignee', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce({
      id: 50,
      name: 'Rishu Sharma',
      assignedToId: 5,
    });
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);

    bus.emit('lead.sla_breached', {
      payload: { contactId: 50 },
      tenantId: 42,
    });
    await flushAsync();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, role: { in: ['ADMIN', 'MANAGER'] } },
      select: { id: true },
    });
    // 3 managers/admins + 1 assignee = 4 notifies
    expect(notificationService.notify).toHaveBeenCalledTimes(4);

    const args = notificationService.notify.mock.calls[0][0];
    expect(args.category).toBe('lead');
    expect(args.type).toBe('sla_breach');
    expect(args.priority).toBe('high');
    expect(args.entityType).toBe('lead');
    expect(args.entityId).toBe(50);
  });

  test('early-returns when contact is null', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(null);
    bus.emit('lead.sla_breached', {
      payload: { contactId: 9999 },
      tenantId: 42,
    });
    await flushAsync();
    expect(notificationService.notify).not.toHaveBeenCalled();
  });
});

describe('approval.created → ADMIN+MANAGER fan-out', () => {
  test('notifies every admin and manager in the tenant', async () => {
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);

    bus.emit('approval.created', {
      payload: { approvalId: 77 },
      tenantId: 42,
    });
    await flushAsync();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, role: { in: ['ADMIN', 'MANAGER'] } },
      select: { id: true },
    });
    expect(notificationService.notify).toHaveBeenCalledTimes(3);

    const args = notificationService.notify.mock.calls[0][0];
    expect(args.category).toBe('approval');
    expect(args.type).toBe('pending_approval');
    expect(args.priority).toBe('normal');
    expect(args.entityType).toBe('approval');
    expect(args.entityId).toBe(77);
  });

  test('zero approvers → no notify calls (no-op)', async () => {
    prisma.user.findMany.mockResolvedValueOnce([]);
    bus.emit('approval.created', {
      payload: { approvalId: 1 },
      tenantId: 42,
    });
    await flushAsync();
    expect(notificationService.notify).not.toHaveBeenCalled();
  });
});

describe('approval.approved → notify requester only', () => {
  test('notifies the requesterId directly (no prisma read needed)', async () => {
    bus.emit('approval.approved', {
      payload: { requesterId: 88, approvalId: 7 },
      tenantId: 42,
    });
    await flushAsync();

    expect(notificationService.notify).toHaveBeenCalledTimes(1);
    const args = notificationService.notify.mock.calls[0][0];
    expect(args.userId).toBe(88);
    expect(args.tenantId).toBe(42);
    expect(args.category).toBe('approval');
    expect(args.type).toBe('info');
    expect(args.priority).toBe('low');
    expect(args.entityType).toBe('approval');
    expect(args.entityId).toBe(7);
  });
});

describe('approval.rejected → notify requester with warning priority', () => {
  test('notifies the requester with warning type + normal priority', async () => {
    bus.emit('approval.rejected', {
      payload: { requesterId: 88, approvalId: 7 },
      tenantId: 42,
    });
    await flushAsync();

    expect(notificationService.notify).toHaveBeenCalledTimes(1);
    const args = notificationService.notify.mock.calls[0][0];
    expect(args.userId).toBe(88);
    expect(args.type).toBe('warning');
    expect(args.priority).toBe('normal');
    expect(args.entityType).toBe('approval');
  });
});

describe('expense.created → ADMIN+MANAGER fan-out with amount in message', () => {
  test('notifies admins+managers and renders submitter + amount + title', async () => {
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);

    bus.emit('expense.created', {
      payload: {
        expenseId: 10,
        submitterName: 'Rishu',
        submitterId: 99,
        amount: 1500,
        title: 'Lunch',
      },
      tenantId: 42,
      io: FAKE_IO,
    });
    await flushAsync();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, role: { in: ['ADMIN', 'MANAGER'] } },
      select: { id: true, name: true },
    });
    expect(notificationService.notify).toHaveBeenCalledTimes(2);

    const args = notificationService.notify.mock.calls[0][0];
    expect(args.category).toBe('expense');
    expect(args.type).toBe('expense_pending');
    expect(args.priority).toBe('normal');
    expect(args.entityType).toBe('expense');
    expect(args.entityId).toBe(10);
    // Message should contain submitter, title, and amount.
    expect(args.message).toContain('Rishu');
    expect(args.message).toContain('Lunch');
    expect(args.message).toContain('1500');
  });
});

describe('expense.approved → notify submitter only', () => {
  test('notifies the submitterId with success type', async () => {
    bus.emit('expense.approved', {
      payload: {
        expenseId: 10,
        submitterId: 99,
        title: 'Lunch',
        amount: 1500,
      },
      tenantId: 42,
      io: FAKE_IO,
    });
    await flushAsync();

    expect(notificationService.notify).toHaveBeenCalledTimes(1);
    const args = notificationService.notify.mock.calls[0][0];
    expect(args.userId).toBe(99);
    expect(args.category).toBe('expense');
    expect(args.type).toBe('success');
    expect(args.priority).toBe('low');
    expect(args.message).toContain('Lunch');
    expect(args.message).toContain('1500');
  });

  test('warns and skips notify when submitterId missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.emit('expense.approved', {
      payload: { expenseId: 10, title: 'Lunch', amount: 1500 },
      tenantId: 42,
      io: FAKE_IO,
    });
    await flushAsync();
    warnSpy.mockRestore();
    expect(notificationService.notify).not.toHaveBeenCalled();
  });
});

describe('expense.rejected → notify submitter with rejection reason', () => {
  test('notifies the submitter with error type + high priority + reason in message', async () => {
    bus.emit('expense.rejected', {
      payload: {
        expenseId: 10,
        submitterId: 99,
        title: 'Lunch',
        amount: 1500,
        rejectionReason: 'Out of policy',
      },
      tenantId: 42,
      io: FAKE_IO,
    });
    await flushAsync();

    expect(notificationService.notify).toHaveBeenCalledTimes(1);
    const args = notificationService.notify.mock.calls[0][0];
    expect(args.userId).toBe(99);
    expect(args.type).toBe('error');
    expect(args.priority).toBe('high');
    expect(args.message).toContain('Out of policy');
    expect(args.message).toContain('Lunch');
  });

  test('skips when submitterId is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.emit('expense.rejected', {
      payload: { expenseId: 10, title: 'Lunch' },
      tenantId: 42,
      io: FAKE_IO,
    });
    await flushAsync();
    warnSpy.mockRestore();
    expect(notificationService.notify).not.toHaveBeenCalled();
  });
});

describe('leave.requested → ADMIN-only fan-out', () => {
  test('notifies every admin and includes requester name', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ name: 'Rishu' });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    bus.emit('leave.requested', {
      payload: { leaveRequestId: 33, requesterId: 99 },
      tenantId: 42,
    });
    await flushAsync();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, role: 'ADMIN' },
      select: { id: true },
    });
    expect(notificationService.notify).toHaveBeenCalledTimes(2);

    const args = notificationService.notify.mock.calls[0][0];
    expect(args.category).toBe('leave');
    expect(args.type).toBe('leave_pending');
    expect(args.entityType).toBe('leave');
    expect(args.entityId).toBe(33);
    expect(args.message).toContain('Rishu');
  });
});

describe('leave.approved → notify requester', () => {
  test('notifies the requesterId with info type', async () => {
    bus.emit('leave.approved', {
      payload: { leaveRequestId: 33, requesterId: 99 },
      tenantId: 42,
    });
    await flushAsync();

    expect(notificationService.notify).toHaveBeenCalledTimes(1);
    const args = notificationService.notify.mock.calls[0][0];
    expect(args.userId).toBe(99);
    expect(args.category).toBe('leave');
    expect(args.type).toBe('info');
    expect(args.priority).toBe('low');
    expect(args.entityId).toBe(33);
  });
});

describe('leave.denied → notify requester with warning', () => {
  test('notifies the requester with warning type + normal priority', async () => {
    bus.emit('leave.denied', {
      payload: { leaveRequestId: 33, requesterId: 99 },
      tenantId: 42,
    });
    await flushAsync();

    expect(notificationService.notify).toHaveBeenCalledTimes(1);
    const args = notificationService.notify.mock.calls[0][0];
    expect(args.userId).toBe(99);
    expect(args.type).toBe('warning');
    expect(args.priority).toBe('normal');
  });
});

describe('tenant isolation', () => {
  test('every prisma.user.findMany call is scoped to the supplied tenantId', async () => {
    prisma.user.findMany.mockResolvedValueOnce([]); // ticket sla
    prisma.ticket.findUnique.mockResolvedValueOnce({ id: 1, subject: 's', assignedToId: null });
    bus.emit('sla.breached', { payload: { ticketId: 1 }, tenantId: 11 });
    await flushAsync();
    expect(prisma.user.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 11 }) })
    );

    prisma.user.findMany.mockResolvedValueOnce([]); // approval.created
    bus.emit('approval.created', { payload: { approvalId: 1 }, tenantId: 22 });
    await flushAsync();
    expect(prisma.user.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 22 }) })
    );
  });
});

describe('error containment', () => {
  test('a rejected notify() does not throw out of the listener', async () => {
    notificationService.notify.mockRejectedValueOnce(new Error('socket down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      bus.emit('approval.approved', {
        payload: { requesterId: 99, approvalId: 1 },
        tenantId: 42,
      })
    ).not.toThrow();
    await flushAsync();
    errSpy.mockRestore();
  });

  test('a rejected prisma read does not throw out of the listener', async () => {
    prisma.user.findMany.mockRejectedValueOnce(new Error('DB down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      bus.emit('approval.created', {
        payload: { approvalId: 1 },
        tenantId: 42,
      })
    ).not.toThrow();
    await flushAsync();
    errSpy.mockRestore();
  });
});
