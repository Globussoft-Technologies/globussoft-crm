// Unit tests for backend/lib/eventBus.js
//
// Coverage scope (v3.4.15 expansion — wave-3 Agent OO):
//   - lookupField (pure)
//   - evaluateCondition (pure — every operator branch)
//   - renderTemplate (pure)
//   - emitEvent: synchronous bus.emit step + prisma async tail (rules
//     fan-out, condition gating, downstream executeAction routing,
//     deliverWebhooks delegation).
//   - executeAction: every actionType (send_email, send_notification,
//     create_task, update_field, assign_agent, send_sms, send_webhook,
//     create_approval, default/unknown) + auditLog write.
//
// MOCK STRATEGY (updated 2026-05-09):
//   The earlier file header claimed `vi.mock('../../lib/prisma')` couldn't
//   intercept the SUT's CJS require. That is no longer accurate — the
//   vitest.config.js inlines `backend/lib/`, `backend/cron/` etc., so
//   monkey-patching model methods on the imported `prisma` singleton (the
//   exact same pattern used by test/cron/slaBreachEngine.test.js) DOES
//   propagate to the SUT's view of the module. We use that pattern below
//   to drive executeAction + emitEvent's async tail through the same
//   prisma singleton.
//
// Reused pattern: backend/test/cron/slaBreachEngine.test.js — singleton
//   patch on imported prisma, .mockReset() per test, default-return then
//   per-test override.

import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import sut from '../../lib/eventBus.js';

const { emitEvent, evaluateCondition, renderTemplate, lookupField, executeAction, bus } = sut;

describe('module shape', () => {
  test('exports the expected helpers', () => {
    expect(typeof emitEvent).toBe('function');
    expect(typeof evaluateCondition).toBe('function');
    expect(typeof renderTemplate).toBe('function');
    expect(typeof lookupField).toBe('function');
    expect(typeof sut.executeAction).toBe('function');
    expect(bus).toBeDefined();
    expect(typeof bus.emit).toBe('function');
  });
});

describe('lookupField', () => {
  test('returns undefined for null payload', () => {
    expect(lookupField('foo', null)).toBeUndefined();
  });
  test('returns undefined for undefined payload', () => {
    expect(lookupField('foo', undefined)).toBeUndefined();
  });
  test('returns undefined for non-object payload', () => {
    expect(lookupField('foo', 'string')).toBeUndefined();
    expect(lookupField('foo', 42)).toBeUndefined();
  });
  test('walks nested path', () => {
    expect(lookupField('deal.amount', { deal: { amount: 1000 } })).toBe(1000);
  });
  test('walks 3-deep nested path', () => {
    expect(lookupField('a.b.c', { a: { b: { c: 'hit' } } })).toBe('hit');
  });
  test('falls back to flat last-segment when nested path absent', () => {
    expect(lookupField('deal.amount', { dealId: 42, amount: 1000 })).toBe(1000);
  });
  test('returns undefined when neither nested nor flat match', () => {
    expect(lookupField('a.b.c', { d: 1 })).toBeUndefined();
  });
  test('handles single-segment path', () => {
    expect(lookupField('foo', { foo: 'bar' })).toBe('bar');
  });
  test('returns undefined when intermediate is non-object', () => {
    expect(lookupField('a.b', { a: 'string' })).toBeUndefined();
  });
  test('returns 0 for explicit zero (not undefined)', () => {
    expect(lookupField('amount', { amount: 0 })).toBe(0);
  });
  test('returns false for explicit false (not undefined)', () => {
    expect(lookupField('flag', { flag: false })).toBe(false);
  });
});

describe('evaluateCondition — empty/malformed inputs', () => {
  test('null condition is true (backwards-compat)', () => {
    expect(evaluateCondition(null, {})).toBe(true);
  });
  test('empty-string condition is true', () => {
    expect(evaluateCondition('', {})).toBe(true);
  });
  test('empty-array condition is true', () => {
    expect(evaluateCondition('[]', {})).toBe(true);
  });
  test('malformed JSON returns false (fail-closed)', () => {
    expect(evaluateCondition('{not-json', {})).toBe(false);
  });
  test('non-array JSON returns false', () => {
    expect(evaluateCondition('{"foo":"bar"}', {})).toBe(false);
  });
  test('null clause returns false', () => {
    expect(evaluateCondition(JSON.stringify([null]), { foo: 1 })).toBe(false);
  });
  test('non-object clause returns false', () => {
    expect(evaluateCondition(JSON.stringify(['nope']), { foo: 1 })).toBe(false);
  });
  test('clause missing field returns false', () => {
    expect(evaluateCondition(JSON.stringify([{ op: 'eq', value: 1 }]), { foo: 1 })).toBe(false);
  });
  test('clause missing op returns false', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'foo', value: 1 }]), { foo: 1 })).toBe(false);
  });
  test('unknown op returns false', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'foo', op: 'wat', value: 1 }]), { foo: 1 })).toBe(false);
  });
});

describe('evaluateCondition — operator matrix', () => {
  // eq
  test('eq matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }]), { status: 'open' })).toBe(true);
  });
  test('eq fails when not equal', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }]), { status: 'closed' })).toBe(false);
  });
  test('eq uses loose equality (string vs number)', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amt', op: 'eq', value: 10 }]), { amt: '10' })).toBe(true);
  });

  // neq
  test('neq matches when different', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'status', op: 'neq', value: 'open' }]), { status: 'closed' })).toBe(true);
  });
  test('neq fails when equal', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'status', op: 'neq', value: 'open' }]), { status: 'open' })).toBe(false);
  });

  // gt
  test('gt matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gt', value: 100 }]), { amount: 150 })).toBe(true);
  });
  test('gt fails on equal', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gt', value: 100 }]), { amount: 100 })).toBe(false);
  });
  test('gt fails on less', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gt', value: 100 }]), { amount: 50 })).toBe(false);
  });
  test('gt coerces strings to numbers', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gt', value: '100' }]), { amount: '150' })).toBe(true);
  });

  // gte
  test('gte matches at boundary', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gte', value: 100 }]), { amount: 100 })).toBe(true);
  });
  test('gte matches above', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gte', value: 100 }]), { amount: 200 })).toBe(true);
  });
  test('gte fails when below', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gte', value: 100 }]), { amount: 50 })).toBe(false);
  });

  // lt
  test('lt matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lt', value: 100 }]), { amount: 50 })).toBe(true);
  });
  test('lt fails on equal', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lt', value: 100 }]), { amount: 100 })).toBe(false);
  });
  test('lt fails on greater', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lt', value: 100 }]), { amount: 200 })).toBe(false);
  });

  // lte
  test('lte matches at boundary', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lte', value: 100 }]), { amount: 100 })).toBe(true);
  });
  test('lte matches below', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lte', value: 100 }]), { amount: 50 })).toBe(true);
  });
  test('lte fails when above', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lte', value: 100 }]), { amount: 150 })).toBe(false);
  });

  // in
  test('in matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'in', value: ['a', 'b'] }]), { stage: 'a' })).toBe(true);
  });
  test('in fails when not in list', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'in', value: ['a', 'b'] }]), { stage: 'c' })).toBe(false);
  });
  test('in fails when value is not an array', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'in', value: 'a' }]), { stage: 'a' })).toBe(false);
  });

  // nin
  test('nin matches when not in list', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'nin', value: ['a', 'b'] }]), { stage: 'c' })).toBe(true);
  });
  test('nin fails when in list', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'nin', value: ['a', 'b'] }]), { stage: 'a' })).toBe(false);
  });
  test('nin fails when value is not an array', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'nin', value: 'a' }]), { stage: 'b' })).toBe(false);
  });

  // contains
  test('contains matches substring', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'contains', value: 'foo' }]), { name: 'foobar' })).toBe(true);
  });
  test('contains fails when missing', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'contains', value: 'baz' }]), { name: 'foobar' })).toBe(false);
  });
  test('contains fails when actual is null', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'contains', value: 'foo' }]), { name: null })).toBe(false);
  });
  test('contains coerces actual to string', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'contains', value: '23' }]), { amount: 1234 })).toBe(true);
  });

  // startsWith
  test('startsWith matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'startsWith', value: 'foo' }]), { name: 'foobar' })).toBe(true);
  });
  test('startsWith fails when wrong prefix', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'startsWith', value: 'bar' }]), { name: 'foobar' })).toBe(false);
  });
  test('startsWith fails when actual is null', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'startsWith', value: 'foo' }]), { name: null })).toBe(false);
  });
});

describe('evaluateCondition — composition & path resolution', () => {
  test('AND-joins two clauses (both true)', () => {
    const cond = JSON.stringify([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'amount', op: 'gt', value: 100 },
    ]);
    expect(evaluateCondition(cond, { status: 'open', amount: 200 })).toBe(true);
  });
  test('AND-joins two clauses (first fails)', () => {
    const cond = JSON.stringify([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'amount', op: 'gt', value: 100 },
    ]);
    expect(evaluateCondition(cond, { status: 'closed', amount: 200 })).toBe(false);
  });
  test('AND-joins two clauses (second fails)', () => {
    const cond = JSON.stringify([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'amount', op: 'gt', value: 100 },
    ]);
    expect(evaluateCondition(cond, { status: 'open', amount: 50 })).toBe(false);
  });
  test('AND-joins three clauses', () => {
    const cond = JSON.stringify([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'amount', op: 'gt', value: 100 },
      { field: 'tier', op: 'in', value: ['gold', 'platinum'] },
    ]);
    expect(evaluateCondition(cond, { status: 'open', amount: 500, tier: 'gold' })).toBe(true);
  });
  test('missing field path returns false on eq', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'missing', op: 'eq', value: 'x' }]), {})).toBe(false);
  });
  test('resolves nested field path through lookupField', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'deal.amount', op: 'gt', value: 100 }]), { deal: { amount: 500 } })).toBe(true);
  });
  test('flat-fallback resolution still works inside conditions', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'deal.amount', op: 'eq', value: 500 }]), { dealId: 1, amount: 500 })).toBe(true);
  });
});

describe('renderTemplate', () => {
  test('null template returns empty string', () => {
    expect(renderTemplate(null, {})).toBe('');
  });
  test('undefined template returns empty string', () => {
    expect(renderTemplate(undefined, {})).toBe('');
  });
  test('plain string returns unchanged', () => {
    expect(renderTemplate('hello world', {})).toBe('hello world');
  });
  test('replaces simple key', () => {
    expect(renderTemplate('hi {{name}}', { name: 'Rishu' })).toBe('hi Rishu');
  });
  test('replaces nested path', () => {
    expect(renderTemplate('total: {{deal.amount}}', { deal: { amount: 500 } })).toBe('total: 500');
  });
  test('replaces multiple placeholders', () => {
    expect(renderTemplate('{{a}}-{{b}}', { a: 1, b: 2 })).toBe('1-2');
  });
  test('leaves placeholder when path missing', () => {
    expect(renderTemplate('hi {{missing}}', { name: 'X' })).toBe('hi {{missing}}');
  });
  test('leaves placeholder when value is null', () => {
    expect(renderTemplate('val={{x}}', { x: null })).toBe('val={{x}}');
  });
  test('handles whitespace inside braces', () => {
    expect(renderTemplate('hi {{ name }}', { name: 'Rishu' })).toBe('hi Rishu');
  });
  test('coerces non-string values', () => {
    expect(renderTemplate('count={{n}}', { n: 42 })).toBe('count=42');
  });
  test('coerces non-string template input', () => {
    expect(renderTemplate(12345, {})).toBe('12345');
  });
  test('flat-fallback resolution applies to placeholders', () => {
    expect(renderTemplate('{{deal.title}}', { dealId: 1, title: 'Big Deal' })).toBe('Big Deal');
  });
});

describe('emitEvent — synchronous bus.emit', () => {
  // The synchronous bus.emit happens at the top of emitEvent. The async
  // tail (prisma.automationRule.findMany + executeAction + deliverWebhooks)
  // is covered in the dedicated "emitEvent — prisma async tail" suite below
  // via singleton-patch on the imported prisma module.

  test('synchronously fires the in-process bus before doing async work', () => {
    const listener = (data) => {
      // Listener fires synchronously inside emitEvent (before await).
      expect(data.payload).toEqual({ x: 42 });
      expect(data.tenantId).toBe(7);
    };
    bus.once('test.bus.event.unique', listener);
    // Kick off — we don't await, since the prisma call would hang. The
    // listener has already run synchronously by the time .emit returns.
    emitEvent('test.bus.event.unique', { x: 42 }, 7).catch(() => {
      /* swallow async DB error — not the path under test */
    });
  });
});

// ─── executeAction + emitEvent async tail (singleton patch pattern) ───────
// Mirrors slaBreachEngine.test.js: monkey-patch model methods on the
// imported prisma singleton; both the SUT and the test see the same
// patched object because vitest.config.js inlines backend/lib/ + backend/cron/.

beforeAll(() => {
  prisma.automationRule = { findMany: vi.fn() };
  prisma.notification = { create: vi.fn() };
  prisma.task = { create: vi.fn() };
  prisma.contact = { update: vi.fn() };
  prisma.deal = { update: vi.fn() };
  prisma.approvalRequest = { create: vi.fn() };
  prisma.auditLog = { create: vi.fn() };
  prisma.webhook = { findMany: vi.fn() };
  // send_webhook now resolves the tenant's signing secret via
  // lib/webhookEntitlement.resolveTenantWebhookSecret → webhookCredential.findFirst.
  prisma.webhookCredential = { findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.automationRule.findMany.mockReset().mockResolvedValue([]);
  prisma.notification.create.mockReset().mockResolvedValue({});
  prisma.task.create.mockReset().mockResolvedValue({});
  prisma.contact.update.mockReset().mockResolvedValue({});
  prisma.deal.update.mockReset().mockResolvedValue({});
  prisma.approvalRequest.create.mockReset().mockResolvedValue({
    id: 999, entity: 'Deal', entityId: 7, reason: null,
  });
  prisma.auditLog.create.mockReset().mockResolvedValue({});
  prisma.webhook.findMany.mockReset().mockResolvedValue([]);
  // Default: no per-tenant credential → send_webhook falls back to the env/null
  // secret (unsigned) without a real DB hit.
  prisma.webhookCredential.findFirst.mockReset().mockResolvedValue(null);
});

describe('emitEvent — prisma async tail (rule fan-out + webhook delivery)', () => {
  test('queries automationRule scoped to tenant + eventName + isActive=true', async () => {
    await emitEvent('contact.created', { contactId: 1 }, 42);
    expect(prisma.automationRule.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, triggerType: 'contact.created', isActive: true },
    });
  });

  test('with no matching rules, does not call prisma.notification.create', async () => {
    prisma.automationRule.findMany.mockResolvedValueOnce([]);
    await emitEvent('contact.created', { contactId: 1 }, 42);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('calls deliverWebhooks via webhook.findMany on tenant scope', async () => {
    await emitEvent('deal.won', { dealId: 7 }, 42);
    expect(prisma.webhook.findMany).toHaveBeenCalled();
    const arg = prisma.webhook.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
  });

  test('rule with non-matching condition is skipped (no executeAction)', async () => {
    prisma.automationRule.findMany.mockResolvedValueOnce([
      {
        id: 1, name: 'r', triggerType: 'deal.won',
        actionType: 'send_notification', targetState: null,
        condition: JSON.stringify([{ field: 'amount', op: 'gt', value: 1000 }]),
      },
    ]);
    await emitEvent('deal.won', { dealId: 1, userId: 5, amount: 500 }, 42);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('rule with matching condition fires its action', async () => {
    prisma.automationRule.findMany.mockResolvedValueOnce([
      {
        id: 1, name: 'r', triggerType: 'deal.won',
        actionType: 'send_notification', targetState: null,
        condition: JSON.stringify([{ field: 'amount', op: 'gt', value: 1000 }]),
      },
    ]);
    await emitEvent('deal.won', { dealId: 1, userId: 5, amount: 5000 }, 42);
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  test('rule with empty/null condition fires unconditionally', async () => {
    prisma.automationRule.findMany.mockResolvedValueOnce([
      {
        id: 1, name: 'r', triggerType: 'evt', actionType: 'send_notification',
        targetState: null, condition: null,
      },
    ]);
    await emitEvent('evt', { userId: 5 }, 42);
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  test('rule that throws inside executeAction is logged but does NOT abort siblings', async () => {
    prisma.automationRule.findMany.mockResolvedValueOnce([
      { id: 1, name: 'fail', triggerType: 'evt', actionType: 'send_notification', targetState: null, condition: null },
      { id: 2, name: 'ok', triggerType: 'evt', actionType: 'send_notification', targetState: null, condition: null },
    ]);
    prisma.notification.create
      .mockRejectedValueOnce(new Error('DB transient'))
      .mockResolvedValueOnce({});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await emitEvent('evt', { userId: 5 }, 42);
    errSpy.mockRestore();
    // Both rules attempted — sibling not aborted by predecessor's failure.
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });

  test('breaks a call that already exceeds the configured event chain depth cap', async () => {
    // Calling emitEvent with depth > MAX should short-circuit and warn,
    // preventing runaway cascades from misconfigured rules.
    prisma.automationRule.findMany.mockResolvedValueOnce([
      { id: 1, name: 'loop', triggerType: 'evt', actionType: 'send_sms', condition: null, targetState: null },
    ]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await emitEvent('evt', { userId: 5 }, 42, null, 11);

    const depthWarnings = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Event chain depth exceeded')
    );
    expect(depthWarnings.length).toBeGreaterThanOrEqual(1);
    // No rules should have been evaluated once we short-circuit.
    expect(prisma.automationRule.findMany).not.toHaveBeenCalled();
  });
});

describe('executeAction — send_notification', () => {
  test('creates notification with config userId override', async () => {
    const rule = {
      id: 1, name: 'New deal', triggerType: 'deal.created',
      actionType: 'send_notification',
      targetState: JSON.stringify({ userId: 99, title: 'T', message: 'M' }),
    };
    await executeAction(rule, { userId: 5 }, 42);
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 99, title: 'T', message: 'M', tenantId: 42, type: 'info',
      }),
    });
  });

  test('falls back to payload.userId when config.userId missing', async () => {
    const rule = {
      id: 1, name: 'r', triggerType: 'evt',
      actionType: 'send_notification', targetState: null,
    };
    await executeAction(rule, { userId: 7 }, 42);
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 7, tenantId: 42 }),
    });
  });

  test('skips notification when no userId resolvable', async () => {
    const rule = { id: 1, name: 'r', actionType: 'send_notification', targetState: null };
    await executeAction(rule, {}, 42);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('emits notification_new socket.io event when io provided', async () => {
    const rule = { id: 1, name: 'r', actionType: 'send_notification', targetState: null };
    const io = { emit: vi.fn() };
    await executeAction(rule, { userId: 5 }, 42, io);
    expect(io.emit).toHaveBeenCalledWith('notification_new', { userId: 5 });
  });

  test('skips io.emit when no io passed', async () => {
    const rule = { id: 1, name: 'r', actionType: 'send_notification', targetState: null };
    await executeAction(rule, { userId: 5 }, 42); // no io
    // io.emit shouldn't have been called — just assert no throw + notification created.
    expect(prisma.notification.create).toHaveBeenCalled();
  });
});

describe('executeAction — create_task', () => {
  test('creates a task with default 3-day due date when not configured', async () => {
    const before = Date.now();
    const rule = { id: 1, name: 'Follow up', actionType: 'create_task', targetState: null };
    await executeAction(rule, { userId: 5, contactId: 11 }, 42);
    expect(prisma.task.create).toHaveBeenCalled();
    const arg = prisma.task.create.mock.calls[0][0];
    expect(arg.data.userId).toBe(5);
    expect(arg.data.contactId).toBe(11);
    expect(arg.data.tenantId).toBe(42);
    expect(arg.data.dueDate).toBeInstanceOf(Date);
    // ~3 days from now, within ±10s
    const expected = before + 3 * 24 * 60 * 60 * 1000;
    expect(arg.data.dueDate.getTime()).toBeGreaterThanOrEqual(expected - 10000);
    expect(arg.data.dueDate.getTime()).toBeLessThanOrEqual(expected + 10000);
  });

  test('honours config.dueInDays + assignToId override + missing contactId becomes null', async () => {
    const rule = {
      id: 1, name: 'r', actionType: 'create_task',
      targetState: JSON.stringify({ dueInDays: 7, assignToId: 88, title: 'Custom' }),
    };
    await executeAction(rule, {}, 42);
    const arg = prisma.task.create.mock.calls[0][0];
    expect(arg.data.userId).toBe(88);
    expect(arg.data.contactId).toBeNull();
    expect(arg.data.title).toBe('Custom');
  });
});

describe('executeAction — update_field', () => {
  test('updates contact.field via dynamic prisma model lookup', async () => {
    const rule = {
      id: 1, actionType: 'update_field',
      targetState: JSON.stringify({ entity: 'contact', field: 'status', value: 'qualified' }),
    };
    await executeAction(rule, { contactId: 7 }, 42);
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 7 }, data: { status: 'qualified' },
    });
  });

  test('updates deal.field when payload supplies dealId', async () => {
    const rule = {
      id: 1, actionType: 'update_field',
      targetState: JSON.stringify({ entity: 'deal', field: 'stage', value: 'won' }),
    };
    await executeAction(rule, { dealId: 99 }, 42);
    expect(prisma.deal.update).toHaveBeenCalledWith({
      where: { id: 99 }, data: { stage: 'won' },
    });
  });

  test('honours explicit config.entityId override', async () => {
    const rule = {
      id: 1, actionType: 'update_field',
      targetState: JSON.stringify({ entity: 'contact', entityId: 555, field: 'tier', value: 'gold' }),
    };
    await executeAction(rule, { contactId: 1 }, 42);
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 555 }, data: { tier: 'gold' },
    });
  });

  test('does nothing when entity / entityId / field missing', async () => {
    const rule = { id: 1, actionType: 'update_field', targetState: JSON.stringify({}) };
    await executeAction(rule, {}, 42);
    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(prisma.deal.update).not.toHaveBeenCalled();
  });

  test('does nothing for unknown entity (no matching prisma model)', async () => {
    const rule = {
      id: 1, actionType: 'update_field',
      targetState: JSON.stringify({ entity: 'nonexistent', field: 'x', value: 'y' }),
    };
    await executeAction(rule, { nonexistentId: 1 }, 42);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });
});

describe('executeAction — assign_agent', () => {
  test('assigns contact to a user via update', async () => {
    const rule = {
      id: 1, actionType: 'assign_agent',
      targetState: JSON.stringify({ userId: 88 }),
    };
    await executeAction(rule, { contactId: 7 }, 42);
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 7 }, data: { assignedToId: 88 },
    });
  });

  test('skips when payload.contactId missing', async () => {
    const rule = {
      id: 1, actionType: 'assign_agent',
      targetState: JSON.stringify({ userId: 88 }),
    };
    await executeAction(rule, {}, 42);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('skips when config.userId missing', async () => {
    const rule = { id: 1, actionType: 'assign_agent', targetState: null };
    await executeAction(rule, { contactId: 7 }, 42);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });
});

describe('executeAction — send_email (no SENDGRID_API_KEY → log-only path)', () => {
  // SENDGRID_API_KEY isn't set in the test env (.env loads dotenv but
  // CI / local-dev typically don't define it). The function returns
  // {sent:false, reason:'no_api_key'} without making a network call.
  test('with config.to recipient, calls sendSendGrid (logs-only without API key)', async () => {
    const rule = {
      id: 1, name: 'Welcome', actionType: 'send_email',
      targetState: JSON.stringify({ to: 'a@b.co', subject: 'Hi', body: 'Welcome' }),
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeAction(rule, {}, 42);
    logSpy.mockRestore();
    // No throw — execution reached the audit log step.
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('falls back to payload.email when config.to absent', async () => {
    const rule = { id: 1, name: 'r', actionType: 'send_email', targetState: null };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeAction(rule, { email: 'fallback@x.co' }, 42);
    logSpy.mockRestore();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('warns when no recipient resolvable but still writes the audit row', async () => {
    const rule = { id: 1, name: 'r', actionType: 'send_email', targetState: null };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeAction(rule, {}, 42);
    warnSpy.mockRestore();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});

describe('executeAction — send_sms (placeholder)', () => {
  test('logs the SMS action without throwing', async () => {
    const rule = {
      id: 1, name: 'r', actionType: 'send_sms',
      targetState: JSON.stringify({ to: '+91999', message: 'Hi' }),
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeAction(rule, {}, 42);
    logSpy.mockRestore();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('handles fallback to payload.phone + rule.name when config absent', async () => {
    const rule = { id: 1, name: 'Fallback rule', actionType: 'send_sms', targetState: null };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeAction(rule, { phone: '+91888' }, 42);
    logSpy.mockRestore();
    // Audit fired — engine reached the audit step.
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});

describe('executeAction — send_webhook (delegates to webhookDelivery.deliverSingle)', () => {
  test('reaches the audit row even when webhookDelivery is invoked', async () => {
    // We don't intercept webhookDelivery here (would require module-replace
    // tricks identical to the deliverWebhooks indirection). Instead we
    // confirm: the SUT reaches the audit step after calling deliverSingle —
    // proven by prisma.auditLog.create firing. The real network call is
    // gated by webhookDelivery's own retry/queue logic which is unit-tested
    // elsewhere (test/lib/webhookDelivery.test.js).
    const rule = {
      id: 1, triggerType: 'evt', actionType: 'send_webhook',
      targetState: JSON.stringify({ url: 'https://hooks.example.com/cb' }),
    };
    // webhookDelivery.deliverSingle uses fetch; prevent a real network call
    // by ensuring its internal Webhook.findMany returns []. deliverSingle
    // itself, however, doesn't read webhook table — it POSTs directly. Stub
    // global fetch to capture the network attempt without hitting the wire.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => 'sent' }, text: () => Promise.resolve(''),
    });
    await executeAction(rule, { dealId: 7 }, 42);
    fetchSpy.mockRestore();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});

describe('executeAction — create_approval', () => {
  test('creates an ApprovalRequest with PENDING status', async () => {
    const rule = {
      id: 7, name: 'Discount approval', triggerType: 'deal.discount',
      actionType: 'create_approval',
      targetState: JSON.stringify({ entity: 'Deal', reasonTemplate: 'Discount on {{deal.title}}' }),
    };
    await executeAction(rule, { dealId: 11, userId: 5, deal: { title: 'Big' } }, 42);
    expect(prisma.approvalRequest.create).toHaveBeenCalled();
    const arg = prisma.approvalRequest.create.mock.calls[0][0];
    expect(arg.data.entity).toBe('Deal');
    expect(arg.data.entityId).toBe(11);
    expect(arg.data.status).toBe('PENDING');
    expect(arg.data.requestedBy).toBe(5);
    expect(arg.data.tenantId).toBe(42);
    expect(arg.data.reason).toBe('Discount on Big');
  });

  test('skips when entity is missing', async () => {
    const rule = {
      id: 1, actionType: 'create_approval',
      targetState: JSON.stringify({}),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeAction(rule, { dealId: 1, userId: 5 }, 42);
    warnSpy.mockRestore();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  test('skips when entity is not a string', async () => {
    const rule = {
      id: 1, actionType: 'create_approval',
      targetState: JSON.stringify({ entity: 42 }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeAction(rule, { dealId: 1, userId: 5 }, 42);
    warnSpy.mockRestore();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  test('skips when payload.<entityLower>Id missing', async () => {
    const rule = {
      id: 1, actionType: 'create_approval',
      targetState: JSON.stringify({ entity: 'Deal' }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeAction(rule, { userId: 5 }, 42);
    warnSpy.mockRestore();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  test('skips when no requesterId resolvable (no userId / actorId / createdById)', async () => {
    const rule = {
      id: 1, actionType: 'create_approval',
      targetState: JSON.stringify({ entity: 'Deal' }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeAction(rule, { dealId: 1 }, 42);
    warnSpy.mockRestore();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  test('falls back to actorId when userId absent', async () => {
    const rule = {
      id: 1, actionType: 'create_approval',
      targetState: JSON.stringify({ entity: 'Deal' }),
    };
    await executeAction(rule, { dealId: 1, actorId: 33 }, 42);
    expect(prisma.approvalRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestedBy: 33 }),
    });
  });

  test('falls back to rule.createdById when neither userId nor actorId present', async () => {
    const rule = {
      id: 1, createdById: 77, actionType: 'create_approval',
      targetState: JSON.stringify({ entity: 'Deal' }),
    };
    await executeAction(rule, { dealId: 1 }, 42);
    expect(prisma.approvalRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestedBy: 77 }),
    });
  });

  test('coerces NaN entityId to skip (Number-coercion guard)', async () => {
    const rule = {
      id: 1, actionType: 'create_approval',
      targetState: JSON.stringify({ entity: 'Deal' }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeAction(rule, { dealId: 'not-a-number', userId: 5 }, 42);
    warnSpy.mockRestore();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  test('null reasonTemplate yields null reason on the row', async () => {
    const rule = {
      id: 1, actionType: 'create_approval',
      targetState: JSON.stringify({ entity: 'Deal' }),
    };
    await executeAction(rule, { dealId: 7, userId: 5 }, 42);
    expect(prisma.approvalRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: null }),
    });
  });

  test('chains an approval.created event into emitEvent', async () => {
    const rule = {
      id: 1, actionType: 'create_approval',
      targetState: JSON.stringify({ entity: 'Deal' }),
    };
    // emitEvent re-enters → automationRule.findMany fires AGAIN with
    // triggerType='approval.created'. That second invocation is the proxy
    // signal for the chain.
    await executeAction(rule, { dealId: 7, userId: 5 }, 42);
    const findManyCalls = prisma.automationRule.findMany.mock.calls;
    const approvalCalls = findManyCalls.filter(
      (c) => c[0]?.where?.triggerType === 'approval.created'
    );
    expect(approvalCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('executeAction — malformed targetState', () => {
  test('treats non-JSON targetState as empty config and still writes audit log', async () => {
    const rule = {
      id: 1, name: 'r', triggerType: 'evt', actionType: 'send_sms',
      targetState: 'amount > 100000',
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeAction(rule, { phone: '9999999999' }, 42);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('targetState is not valid JSON')
    );
    warnSpy.mockRestore();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});

describe('executeAction — unknown actionType', () => {
  test('warns but still writes the audit log', async () => {
    const rule = {
      id: 1, name: 'r', actionType: 'something_unsupported', targetState: null,
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeAction(rule, { userId: 5 }, 42);
    warnSpy.mockRestore();
    // No model.create called for an unknown actionType, but auditLog still fires.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.task.create).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });
});

describe('executeAction — auditLog write', () => {
  test('always writes a WORKFLOW audit row scoped to tenant', async () => {
    const rule = {
      id: 7, name: 'r', triggerType: 'evt',
      actionType: 'send_notification', targetState: null,
    };
    await executeAction(rule, { userId: 5 }, 42);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.action).toBe('WORKFLOW');
    expect(arg.data.entity).toBe('AutomationRule');
    expect(arg.data.entityId).toBe(7);
    expect(arg.data.tenantId).toBe(42);
    // payload.body is intentionally redacted (avoid logging email body content).
    const details = JSON.parse(arg.data.details);
    expect(details.trigger).toBe('evt');
    expect(details.action).toBe('send_notification');
    expect(details.payload.body).toBeUndefined();
  });
});
