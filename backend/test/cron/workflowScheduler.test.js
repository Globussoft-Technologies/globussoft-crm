// @ts-check
/**
 * Unit tests for backend/cron/workflowScheduler.js — the clock side of the
 * workflow engine.
 *
 * Three responsibilities, each of which fixes something that was previously
 * either absent or actively broken:
 *
 *   1. Time-based rules (schedule.date_field / schedule.recurring). Entirely
 *      new — every trigger in the CRM was record-event driven.
 *   2. The `wait` action's resume queue. A delay was inexpressible because all
 *      actions ran synchronously inside the triggering HTTP request.
 *   3. `invoice.overdue`. The trigger sat in the builder's dropdown for months
 *      with ZERO emit sites anywhere in the repo, so every rule built on it was
 *      inert.
 *
 * Mock strategy mirrors test/cron/slaBreachEngine.test.js: monkey-patch the
 * prisma singleton (vitest.config.js inlines backend/cron + backend/lib, so the
 * SUT's CJS require sees the patched object) and patch eventBus's exports
 * before exercising the tick.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS('../../lib/prisma');
const eventBus = requireCJS('../../lib/eventBus');

const sut = requireCJS('../../cron/workflowScheduler');
const {
  processScheduledRules,
  processDeferredActions,
  processOverdueInvoices,
  runScheduledRule,
  candidateWhere,
  isDueNow,
} = sut;

const NOW = new Date('2026-08-27T10:00:00');

beforeAll(() => {
  prisma.automationRule = prisma.automationRule || {};
  prisma.automationRule.findMany = vi.fn();
  prisma.automationRule.update = vi.fn();
  prisma.workflowExecution = prisma.workflowExecution || {};
  prisma.workflowExecution.findFirst = vi.fn();
  prisma.workflowExecution.create = vi.fn();
  prisma.workflowScheduledAction = prisma.workflowScheduledAction || {};
  prisma.workflowScheduledAction.findMany = vi.fn();
  prisma.workflowScheduledAction.updateMany = vi.fn();
  prisma.workflowScheduledAction.update = vi.fn();
  prisma.invoice = prisma.invoice || {};
  prisma.invoice.findMany = vi.fn();
  prisma.invoice.updateMany = vi.fn();
  prisma.deal = prisma.deal || {};
  prisma.deal.findMany = vi.fn();
  prisma.contact = prisma.contact || {};
  prisma.contact.findMany = vi.fn();
});

beforeEach(() => {
  prisma.automationRule.findMany.mockReset().mockResolvedValue([]);
  prisma.automationRule.update.mockReset().mockResolvedValue({});
  prisma.workflowExecution.findFirst.mockReset().mockResolvedValue(null);
  prisma.workflowExecution.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.workflowScheduledAction.findMany.mockReset().mockResolvedValue([]);
  prisma.workflowScheduledAction.updateMany.mockReset().mockResolvedValue({ count: 1 });
  prisma.workflowScheduledAction.update.mockReset().mockResolvedValue({});
  prisma.invoice.findMany.mockReset().mockResolvedValue([]);
  prisma.invoice.updateMany.mockReset().mockResolvedValue({ count: 1 });
  prisma.deal.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.findMany.mockReset().mockResolvedValue([]);

  eventBus.executeAction = vi.fn().mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  eventBus.runActionList = vi.fn().mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  eventBus.recordWorkflowExecution = vi.fn().mockResolvedValue(undefined);
  eventBus.updateRuleHealth = vi.fn().mockResolvedValue(undefined);
  eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
  eventBus.getIO = vi.fn().mockReturnValue(null);
  eventBus.evaluateCondition = vi.fn().mockReturnValue(true);
});

const dateFieldRule = (overrides = {}) => ({
  id: 10,
  name: 'Renewal reminder',
  tenantId: 42,
  triggerType: 'schedule.date_field',
  isActive: true,
  condition: null,
  targetState: JSON.stringify({ actions: [{ type: 'create_task', config: {} }] }),
  scheduleConfig: JSON.stringify({
    mode: 'date_field', entity: 'deal', field: 'expectedClose',
    offsetDays: -3, timeOfDay: '09:00', lookbackDays: 2, maxRecords: 500,
  }),
  ...overrides,
});

const recurringRule = (overrides = {}) => ({
  id: 20,
  name: 'Weekly sweep',
  tenantId: 42,
  triggerType: 'schedule.recurring',
  isActive: true,
  condition: null,
  targetState: JSON.stringify({ actions: [{ type: 'send_notification', config: {} }] }),
  scheduleConfig: JSON.stringify({
    mode: 'recurring', entity: 'deal', frequency: 'daily',
    timeOfDay: '09:00', maxRecords: 200,
  }),
  nextScheduledAt: null,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────
// candidateWhere / isDueNow
// ─────────────────────────────────────────────────────────────────────────

describe('candidateWhere', () => {
  const dealEntity = { model: 'deal', idKey: 'dealId', softDelete: true, dateFields: [] };

  test('scopes to the tenant and excludes soft-deleted records', () => {
    const where = candidateWhere({ tenantId: 42 }, { mode: 'recurring', entity: 'deal' }, dealEntity, NOW);
    expect(where.tenantId).toBe(42);
    expect(where.deletedAt).toBeNull();
  });

  test('omits deletedAt for a model that has no soft-delete column', () => {
    const ticketEntity = { model: 'ticket', idKey: 'ticketId', softDelete: false, dateFields: [] };
    const where = candidateWhere({ tenantId: 1 }, { mode: 'recurring', entity: 'ticket' }, ticketEntity, NOW);
    expect('deletedAt' in where).toBe(false);
  });

  test('narrows on the anchor column so the scan stays indexed', () => {
    // Without this the cron would read the whole table every tick on a large
    // tenant, then filter in JS.
    const where = candidateWhere(
      { tenantId: 42 },
      { mode: 'date_field', entity: 'deal', field: 'expectedClose', offsetDays: -3, lookbackDays: 2 },
      dealEntity,
      NOW,
    );
    expect(where.expectedClose.gte).toBeInstanceOf(Date);
    expect(where.expectedClose.lte).toBeInstanceOf(Date);
  });

  test('an annual anchor only requires the column to be set', () => {
    const contactEntity = { model: 'contact', idKey: 'contactId', softDelete: true, dateFields: [] };
    const where = candidateWhere(
      { tenantId: 42 },
      { mode: 'date_field', entity: 'contact', field: 'birthDate', annual: true, offsetDays: 0 },
      contactEntity,
      NOW,
    );
    expect(where.birthDate).toEqual({ not: null });
  });
});

describe('isDueNow', () => {
  const config = { field: 'expectedClose', offsetDays: -3, timeOfDay: '09:00', lookbackDays: 2 };

  test('returns the occurrence for a record that is due', () => {
    // Closing on the 30th, 3 days before = the 27th at 09:00, and now is 10:00.
    const due = isDueNow({ expectedClose: new Date('2026-08-30T00:00:00') }, config, NOW);
    expect(due).toBeInstanceOf(Date);
    expect(due.getDate()).toBe(27);
  });

  test('returns null for a record whose occurrence is still in the future', () => {
    expect(isDueNow({ expectedClose: new Date('2026-12-30T00:00:00') }, config, NOW)).toBeNull();
  });

  test('returns null for an occurrence older than the lookback window', () => {
    // Long past: firing it now would spam ancient records on first deploy.
    expect(isDueNow({ expectedClose: new Date('2025-01-01T00:00:00') }, config, NOW)).toBeNull();
  });

  test('returns null when the anchor column is empty', () => {
    expect(isDueNow({ expectedClose: null }, config, NOW)).toBeNull();
    expect(isDueNow({}, config, NOW)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runScheduledRule
// ─────────────────────────────────────────────────────────────────────────

describe('runScheduledRule — date_field', () => {
  test('fires for a due record and stamps an occurrence-scoped record key', () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 5, title: 'Acme renewal', expectedClose: new Date('2026-08-30T00:00:00'), ownerId: 3 },
    ]);

    return runScheduledRule(dateFieldRule(), NOW, null).then((result) => {
      expect(result.fired).toBe(1);
      expect(eventBus.executeAction).toHaveBeenCalledTimes(1);
      const payload = eventBus.executeAction.mock.calls[0][1];
      expect(payload.dealId).toBe(5);
      // The occurrence date rides on the key so that moving the close date
      // re-arms the reminder, while a repeated tick does not double-fire.
      expect(payload.__recordKey).toBe('dealId:5@2026-08-27');
      expect(payload.userId).toBe(3);
    });
  });

  test('skips a record that has already fired for this occurrence', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 5, expectedClose: new Date('2026-08-30T00:00:00') },
    ]);
    prisma.workflowExecution.findFirst.mockResolvedValue({ id: 900 });

    const result = await runScheduledRule(dateFieldRule(), NOW, null);
    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(eventBus.executeAction).not.toHaveBeenCalled();
  });

  test('skips a record whose occurrence has not arrived yet', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 6, expectedClose: new Date('2027-01-01T00:00:00') },
    ]);
    const result = await runScheduledRule(dateFieldRule(), NOW, null);
    expect(result.fired).toBe(0);
    expect(eventBus.executeAction).not.toHaveBeenCalled();
  });

  test("respects the rule's own conditions", async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 5, expectedClose: new Date('2026-08-30T00:00:00') },
    ]);
    eventBus.evaluateCondition.mockReturnValue(false);

    const result = await runScheduledRule(dateFieldRule(), NOW, null);
    expect(result.fired).toBe(0);
    expect(eventBus.executeAction).not.toHaveBeenCalled();
  });

  test('a failing record is logged and does NOT abort the rest of the batch', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, expectedClose: new Date('2026-08-30T00:00:00') },
      { id: 2, expectedClose: new Date('2026-08-30T00:00:00') },
    ]);
    eventBus.executeAction
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ attempted: 1, succeeded: 1, failed: 0 });

    const result = await runScheduledRule(dateFieldRule(), NOW, null);
    expect(result.fired).toBe(1);
    expect(eventBus.recordWorkflowExecution).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 42,
      expect.objectContaining({ status: 'FAILED' }),
    );
  });

  test('does nothing when scheduleConfig is unusable', async () => {
    const result = await runScheduledRule(dateFieldRule({ scheduleConfig: '{not json' }), NOW, null);
    expect(result.fired).toBe(0);
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('TRUNCATION IS NEVER SILENT — logs a SKIPPED execution row when capped', async () => {
    // A capped run must not be mistakable for a complete one.
    const config = {
      mode: 'date_field', entity: 'deal', field: 'expectedClose',
      offsetDays: -3, timeOfDay: '09:00', lookbackDays: 2, maxRecords: 2,
    };
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, expectedClose: new Date('2026-08-30T00:00:00') },
      { id: 2, expectedClose: new Date('2026-08-30T00:00:00') },
      { id: 3, expectedClose: new Date('2026-08-30T00:00:00') },
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runScheduledRule(
      dateFieldRule({ scheduleConfig: JSON.stringify(config) }), NOW, null,
    );
    warnSpy.mockRestore();

    expect(result.truncated).toBe(1);
    expect(result.examined).toBe(2);
    expect(prisma.workflowExecution.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'SKIPPED' }),
    }));
  });

  test('queries with take = maxRecords + 1 so truncation can be detected', async () => {
    await runScheduledRule(dateFieldRule(), NOW, null);
    expect(prisma.deal.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 501 }));
  });
});

describe('runScheduledRule — recurring', () => {
  test('does not run before nextScheduledAt', async () => {
    const rule = recurringRule({ nextScheduledAt: new Date('2026-12-01T09:00:00') });
    const result = await runScheduledRule(rule, NOW, null);
    expect(result.fired).toBe(0);
    // Gated before touching the record table at all.
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('runs when due and advances nextScheduledAt', async () => {
    prisma.deal.findMany.mockResolvedValue([{ id: 9, title: 'Open deal' }]);
    const result = await runScheduledRule(recurringRule(), NOW, null);

    expect(result.fired).toBe(1);
    expect(prisma.automationRule.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 20 },
      data: expect.objectContaining({ nextScheduledAt: expect.any(Date) }),
    }));
  });

  test('keys each record on the occurrence day so it fires once per occurrence', async () => {
    prisma.deal.findMany.mockResolvedValue([{ id: 9 }]);
    await runScheduledRule(recurringRule(), NOW, null);
    expect(eventBus.executeAction.mock.calls[0][1].__recordKey).toBe('dealId:9@2026-08-27');
  });
});

describe('processScheduledRules', () => {
  test('only selects active scheduled rules', async () => {
    await processScheduledRules(NOW, null);
    expect(prisma.automationRule.findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        triggerType: { in: ['schedule.date_field', 'schedule.recurring'] },
      },
    });
  });

  test('one failing rule does not stop the others', async () => {
    prisma.automationRule.findMany.mockResolvedValue([
      dateFieldRule({ id: 1 }),
      dateFieldRule({ id: 2 }),
    ]);
    prisma.deal.findMany
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const totals = await processScheduledRules(NOW, null);
    errSpy.mockRestore();
    expect(totals.rules).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Deferred (`wait`) queue
// ─────────────────────────────────────────────────────────────────────────

describe('processDeferredActions', () => {
  const pendingRow = (overrides = {}) => ({
    id: 100,
    ruleId: 10,
    tenantId: 42,
    runAt: new Date('2026-08-27T09:00:00'),
    status: 'PENDING',
    attempts: 0,
    actionsJson: JSON.stringify([{ type: 'send_email', config: {} }]),
    payloadJson: JSON.stringify({ contactId: 3 }),
    rule: { id: 10, name: 'Onboarding', isActive: true, triggerType: 'deal.won' },
    ...overrides,
  });

  test('claims a due row with a compare-and-set before running it', async () => {
    prisma.workflowScheduledAction.findMany.mockResolvedValue([pendingRow()]);
    await processDeferredActions(NOW, null);

    // The claim is what stops two app instances double-firing the same action.
    const claim = prisma.workflowScheduledAction.updateMany.mock.calls[0][0];
    expect(claim.where.id).toBe(100);
    expect(claim.where.status).toBe('PENDING');
    expect(claim.data.lockedBy).toMatch(/^wf-sched-/);
  });

  test('skips a row another worker already claimed', async () => {
    prisma.workflowScheduledAction.findMany.mockResolvedValue([pendingRow()]);
    prisma.workflowScheduledAction.updateMany.mockResolvedValue({ count: 0 });

    const result = await processDeferredActions(NOW, null);
    expect(result.resumed).toBe(0);
    expect(eventBus.runActionList).not.toHaveBeenCalled();
  });

  test('resumes the remaining actions and marks the row DONE', async () => {
    prisma.workflowScheduledAction.findMany.mockResolvedValue([pendingRow()]);
    const result = await processDeferredActions(NOW, null);

    expect(result.resumed).toBe(1);
    expect(eventBus.runActionList).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10 }),
      [{ type: 'send_email', config: {} }],
      { contactId: 3 },
      42, null, 0,
    );
    expect(prisma.workflowScheduledAction.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'DONE' }),
    }));
  });

  test('CANCELS a deferred action whose rule was switched off during the wait', async () => {
    // Honouring the pause button is the entire point of it.
    prisma.workflowScheduledAction.findMany.mockResolvedValue([
      pendingRow({ rule: { id: 10, name: 'Onboarding', isActive: false } }),
    ]);
    await processDeferredActions(NOW, null);

    expect(eventBus.runActionList).not.toHaveBeenCalled();
    expect(prisma.workflowScheduledAction.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CANCELLED' }),
    }));
  });

  test('retries a failure with a back-off, then gives up at the attempt ceiling', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    eventBus.runActionList.mockRejectedValue(new Error('smtp down'));

    prisma.workflowScheduledAction.findMany.mockResolvedValue([pendingRow({ attempts: 0 })]);
    await processDeferredActions(NOW, null);
    expect(prisma.workflowScheduledAction.update.mock.calls[0][0].data.status).toBe('PENDING');

    prisma.workflowScheduledAction.update.mockClear();
    prisma.workflowScheduledAction.findMany.mockResolvedValue([
      pendingRow({ attempts: sut.MAX_DEFERRED_ATTEMPTS - 1 }),
    ]);
    await processDeferredActions(NOW, null);
    expect(prisma.workflowScheduledAction.update.mock.calls[0][0].data.status).toBe('FAILED');

    errSpy.mockRestore();
  });

  test('closes out a row with nothing left to run', async () => {
    prisma.workflowScheduledAction.findMany.mockResolvedValue([
      pendingRow({ actionsJson: '[]' }),
    ]);
    await processDeferredActions(NOW, null);
    expect(eventBus.runActionList).not.toHaveBeenCalled();
    expect(prisma.workflowScheduledAction.update.mock.calls[0][0].data.status).toBe('DONE');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// invoice.overdue
// ─────────────────────────────────────────────────────────────────────────

describe('processOverdueInvoices', () => {
  const invoice = (overrides = {}) => ({
    id: 7, invoiceNum: 'INV-7', amount: 500,
    dueDate: new Date('2026-08-20T00:00:00'),
    contactId: 3, dealId: null, tenantId: 42,
    ...overrides,
  });

  test('selects only UNPAID invoices past their due date', async () => {
    await processOverdueInvoices(NOW, null);
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.where.status).toBe('UNPAID');
    expect(args.where.dueDate.lt).toBe(NOW);
  });

  test('flips the status and emits invoice.overdue with daysOverdue', async () => {
    // The trigger existed in the builder with no emitter anywhere, so every
    // rule built on it was inert.
    prisma.invoice.findMany.mockResolvedValue([invoice()]);
    const result = await processOverdueInvoices(NOW, null);

    expect(result.emitted).toBe(1);
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 7, status: 'UNPAID' },
      data: { status: 'OVERDUE' },
    });
    const [eventName, payload, tenantId] = eventBus.emitEvent.mock.calls[0];
    expect(eventName).toBe('invoice.overdue');
    expect(tenantId).toBe(42);
    expect(payload.invoiceId).toBe(7);
    expect(payload.invoiceNum).toBe('INV-7');
    expect(payload.daysOverdue).toBe(7);
    expect(payload.previous).toEqual({ status: 'UNPAID' });
  });

  test('does NOT emit when the status flip matched no rows', async () => {
    // Someone paid or voided it between the read and the write — emitting
    // would tell a workflow an invoice is overdue when it has just been paid.
    prisma.invoice.findMany.mockResolvedValue([invoice()]);
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

    const result = await processOverdueInvoices(NOW, null);
    expect(result.emitted).toBe(0);
    expect(eventBus.emitEvent).not.toHaveBeenCalled();
  });

  test('one bad invoice does not stop the others', async () => {
    prisma.invoice.findMany.mockResolvedValue([invoice({ id: 1 }), invoice({ id: 2 })]);
    prisma.invoice.updateMany
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ count: 1 });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await processOverdueInvoices(NOW, null);
    errSpy.mockRestore();
    expect(result.emitted).toBe(1);
  });
});
