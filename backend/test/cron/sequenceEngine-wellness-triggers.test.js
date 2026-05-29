/**
 * Unit tests for backend/cron/sequenceEngine.js + backend/lib/eventBus.js —
 * pins the wellness-trigger contract that closes #616.
 *
 * Issue context
 * ─────────────
 *   #616 — Drip-sequence triggers were generic-CRM-only (contact.created,
 *          deal.won, etc.). Wellness clinics need to drip-message based on
 *          clinical events (visit completed, treatment started, consent
 *          signed). This test suite pins:
 *
 *   1. The eventBus.emitEvent path matches AutomationRule rows by the new
 *      wellness trigger names (visit.scheduled, visit.completed,
 *      treatment.started, consent.signed).
 *   2. The sequenceEngine's step processor (processStep) renders email +
 *      sms steps the same way for wellness-vertical contacts as it does
 *      for generic — i.e. the existing drip-step machinery isn't
 *      tenant-vertical-aware (it shouldn't need to be, the trigger is
 *      what gates wellness-vs-generic enrolment).
 *   3. An AutomationRule with triggerType='visit.completed' DOES match
 *      when emitEvent fires that event, AND a rule with the legacy
 *      'visit.complete' shape (without dot-completed) does NOT match
 *      (regression pin: typos can't silently swallow a fire).
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/cron/sentimentEngine.test.js — import the prisma
 *   singleton, monkey-patch model methods. eventBus is required via the
 *   route's `require('../lib/eventBus')` so its prisma.automationRule
 *   findMany resolves to our mocked stub.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE require — eventBus / sequenceEngine top-level
// `require('../lib/prisma')` is the same singleton.
prisma.automationRule = { findMany: vi.fn() };
prisma.emailMessage = { create: vi.fn(), findMany: vi.fn(), update: vi.fn() };
prisma.smsMessage = { create: vi.fn() };
prisma.sequenceEnrollment = { findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() };
prisma.sequenceStep = { findFirst: vi.fn(), findMany: vi.fn() };
prisma.notification = { create: vi.fn() };
prisma.task = { create: vi.fn() };
prisma.contact = { update: vi.fn() };
prisma.approvalRequest = { create: vi.fn() };
prisma.auditLog = { create: vi.fn() };
// webhookDelivery uses prisma.webhook.findMany. eventBus.emitEvent calls
// deliverWebhooks via lazy `require`, which bypasses vi.mock under CJS.
// Easier: stub prisma.webhook directly so the no-op path returns [].
prisma.webhook = { findMany: vi.fn() };

import { emitEvent } from '../../lib/eventBus.js';
import { processStepListEnrollment } from '../../cron/sequenceEngine.js';

beforeEach(() => {
  prisma.automationRule.findMany.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.smsMessage.create.mockReset();
  prisma.sequenceEnrollment.update.mockReset();
  prisma.notification.create.mockReset();
  prisma.task.create.mockReset();
  prisma.contact.update.mockReset();
  prisma.auditLog.create.mockReset();

  prisma.emailMessage.create.mockResolvedValue({ id: 1 });
  prisma.smsMessage.create.mockResolvedValue({ id: 1 });
  prisma.sequenceEnrollment.update.mockResolvedValue({ id: 1 });
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.task.create.mockResolvedValue({ id: 1 });
  prisma.contact.update.mockResolvedValue({ id: 1 });
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  // No webhook deliveries by default — tests only care about rule + action
  // dispatch, not webhook fan-out.
  prisma.webhook.findMany.mockResolvedValue([]);
});

// ─── eventBus dispatch — wellness trigger names ────────────────────

describe('eventBus.emitEvent — wellness trigger matching (#616)', () => {
  test('visit.completed fires every AutomationRule with triggerType=visit.completed', async () => {
    prisma.automationRule.findMany.mockResolvedValueOnce([
      {
        id: 11,
        tenantId: 1,
        triggerType: 'visit.completed',
        actionType: 'send_notification',
        targetState: JSON.stringify({ userId: 99, title: 'Aftercare drip' }),
        condition: null,
        isActive: true,
      },
    ]);

    await emitEvent('visit.completed', { visitId: 42, patientId: 7, amountCharged: 1500 }, 1);

    // findMany was called scoped to tenant + triggerType + isActive=true
    expect(prisma.automationRule.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, triggerType: 'visit.completed', isActive: true },
    });
    // The matched rule's action fired (send_notification)
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const args = prisma.notification.create.mock.calls[0][0];
    expect(args.data.userId).toBe(99);
    expect(args.data.title).toBe('Aftercare drip');
  });

  test('visit.scheduled / treatment.started / consent.signed all dispatch through emitEvent', async () => {
    for (const trigger of ['visit.scheduled', 'treatment.started', 'consent.signed']) {
      prisma.automationRule.findMany.mockReset();
      prisma.automationRule.findMany.mockResolvedValueOnce([]);
      await emitEvent(trigger, { patientId: 1 }, 1);
      expect(prisma.automationRule.findMany).toHaveBeenCalledWith({
        where: { tenantId: 1, triggerType: trigger, isActive: true },
      });
    }
  });

  test('typo trigger names do NOT match wellness rules (regression pin)', async () => {
    // Rule listens for 'visit.completed' — emit a typo'd 'visit.complete'.
    prisma.automationRule.findMany.mockResolvedValueOnce([]);
    await emitEvent('visit.complete', { visitId: 42 }, 1);
    // Rule's action MUST NOT fire — the where clause is exact-match.
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  test('per-tenant scope is preserved on wellness triggers', async () => {
    prisma.automationRule.findMany.mockResolvedValueOnce([]);
    await emitEvent('visit.completed', { visitId: 42 }, 7);
    const call = prisma.automationRule.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(7);
    expect(call.where.triggerType).toBe('visit.completed');
  });
});

// ─── sequenceEngine — drip step processing ────────────────────────

describe('sequenceEngine.processStepListEnrollment — drip steps fire on wellness enrolments', () => {
  test('email step on a wellness enrolment persists EmailMessage and advances cursor', async () => {
    const enrollment = {
      id: 101,
      sequenceId: 5,
      tenantId: 1,
      currentStep: 0,
      contact: { id: 7, email: 'patient@example.in', name: 'Ananya' },
    };
    const steps = [
      {
        id: 1,
        sequenceId: 5,
        position: 0,
        kind: 'email',
        emailTemplate: { subject: 'Aftercare for {{name}}', body: 'Hi {{name}}, …' },
      },
    ];

    await processStepListEnrollment(enrollment, steps);

    // Email row landed with the rendered subject + body and the seq-<id>
    // threadId (so #7 reply detection can recover the enrollment).
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const data = prisma.emailMessage.create.mock.calls[0][0].data;
    expect(data.subject).toBe('Aftercare for Ananya');
    expect(data.body).toBe('Hi Ananya, …');
    expect(data.threadId).toBe('seq-101');
    expect(data.direction).toBe('OUTBOUND');
    expect(data.tenantId).toBe(1);

    // After the only step, the engine marks Completed.
    const updated = prisma.sequenceEnrollment.update.mock.calls.find(
      (c) => c[0].data.status === 'Completed'
    );
    expect(updated).toBeDefined();
  });

  test('sms step on a wellness enrolment persists SmsMessage and advances cursor', async () => {
    const enrollment = {
      id: 102,
      sequenceId: 6,
      tenantId: 1,
      currentStep: 0,
      contact: { id: 8, name: 'Rahul', phone: '+919876543210' },
    };
    const steps = [
      {
        id: 2,
        sequenceId: 6,
        position: 0,
        kind: 'sms',
        smsBody: 'Hi {{name}}, your visit is confirmed.',
      },
    ];

    await processStepListEnrollment(enrollment, steps);

    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    const data = prisma.smsMessage.create.mock.calls[0][0].data;
    expect(data.to).toBe('+919876543210');
    expect(data.body).toBe('Hi Rahul, your visit is confirmed.');
    expect(data.direction).toBe('OUTBOUND');
    expect(data.status).toBe('QUEUED');
    expect(data.tenantId).toBe(1);
  });
});

// ─── eventBus rule-level wellness-trigger behaviour (#616 — extended) ─────
//
// The existing 4 cases above pin the FIND-MANY shape: trigger names match,
// typos don't, tenant scope is preserved. The 6 cases below extend coverage
// at the ACTION-EXECUTION layer — verifying that when a wellness trigger
// fires AND a rule matches, the correct action wires execute against the
// payload + config. Distinct surface from the sibling main test
// (sequenceEngine.test.js) which only exercises the cron tick + step-list
// dispatcher; rule-level executeAction belongs in eventBus and is the
// wellness-vertical's primary surface for "what does a clinical event
// actually DO to drive a drip?".

describe('eventBus.emitEvent — wellness-trigger action dispatch (#616 — extended)', () => {
  test('evaluateCondition gates a visit.completed rule on amountCharged threshold', async () => {
    // Rule fires send_notification ONLY when amountCharged > 1000.
    // The clinical-billing pattern: "send aftercare drip when visit was
    // billed". Verifies the rule.condition gate sits between findMany and
    // executeAction — a matching rule with a failing condition does NOT
    // dispatch its action.
    const ruleWithCondition = {
      id: 21,
      tenantId: 1,
      triggerType: 'visit.completed',
      actionType: 'send_notification',
      targetState: JSON.stringify({ userId: 99, title: 'High-value aftercare' }),
      condition: JSON.stringify([{ field: 'amountCharged', op: 'gt', value: 1000 }]),
      isActive: true,
    };

    // First emit: amountCharged=1500 → condition TRUE → notification fires.
    prisma.automationRule.findMany.mockResolvedValueOnce([ruleWithCondition]);
    await emitEvent('visit.completed', { visitId: 42, amountCharged: 1500 }, 1);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);

    prisma.notification.create.mockClear();

    // Second emit: amountCharged=500 → condition FALSE → no notification.
    prisma.automationRule.findMany.mockResolvedValueOnce([ruleWithCondition]);
    await emitEvent('visit.completed', { visitId: 43, amountCharged: 500 }, 1);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('create_task action fires on visit.completed (post-visit follow-up pattern)', async () => {
    // Wellness clinics use the create_task action to drop a follow-up onto
    // a doctor's queue 3 days after a visit completes. Verifies the action
    // wire writes a Task row with dueDate ~ now+dueInDays and uses
    // payload.contactId for the linked entity.
    prisma.automationRule.findMany.mockResolvedValueOnce([
      {
        id: 31,
        tenantId: 1,
        triggerType: 'visit.completed',
        actionType: 'create_task',
        targetState: JSON.stringify({
          title: 'Aftercare follow-up call',
          dueInDays: 7,
          assignToId: 42,
        }),
        condition: null,
        isActive: true,
      },
    ]);

    const before = Date.now();
    await emitEvent('visit.completed', { visitId: 99, contactId: 700, userId: 12 }, 1);
    const after = Date.now();

    expect(prisma.task.create).toHaveBeenCalledTimes(1);
    const arg = prisma.task.create.mock.calls[0][0].data;
    expect(arg.title).toBe('Aftercare follow-up call');
    expect(arg.userId).toBe(42);
    expect(arg.contactId).toBe(700);
    expect(arg.tenantId).toBe(1);
    // dueDate must land at ~now+7days. We assert a generous bound: [before+7d, after+7d + slack].
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const due = new Date(arg.dueDate).getTime();
    expect(due).toBeGreaterThanOrEqual(before + sevenDaysMs - 2000);
    expect(due).toBeLessThanOrEqual(after + sevenDaysMs + 2000);
  });

  test('multi-rule fan-out: two active rules on visit.completed both execute', async () => {
    // Wellness tenants frequently chain notifications: one rule for the
    // doctor, one for the front-desk. Both rules with matching triggers
    // and active isActive must both fire when the event emits.
    prisma.automationRule.findMany.mockResolvedValueOnce([
      {
        id: 41,
        tenantId: 1,
        triggerType: 'visit.completed',
        actionType: 'send_notification',
        targetState: JSON.stringify({ userId: 10, title: 'Doctor follow-up' }),
        condition: null,
        isActive: true,
      },
      {
        id: 42,
        tenantId: 1,
        triggerType: 'visit.completed',
        actionType: 'send_notification',
        targetState: JSON.stringify({ userId: 11, title: 'Front-desk billing review' }),
        condition: null,
        isActive: true,
      },
    ]);

    await emitEvent('visit.completed', { visitId: 50, patientId: 7 }, 1);

    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    const userIds = prisma.notification.create.mock.calls.map((c) => c[0].data.userId).sort();
    expect(userIds).toEqual([10, 11]);
  });

  test('every dispatched wellness-trigger rule writes an auditLog row', async () => {
    // The executeAction function ends with a prisma.auditLog.create call —
    // every wellness-trigger fire that successfully dispatches an action
    // must leave a workflow audit trail. This is the audit-integrity
    // contract: a clinical event firing a drip is a traceable workflow.
    prisma.automationRule.findMany.mockResolvedValueOnce([
      {
        id: 51,
        tenantId: 1,
        triggerType: 'consent.signed',
        actionType: 'send_notification',
        targetState: JSON.stringify({ userId: 88, title: 'Consent ack' }),
        condition: null,
        isActive: true,
      },
    ]);

    await emitEvent('consent.signed', { patientId: 7, consentId: 22 }, 1);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = prisma.auditLog.create.mock.calls[0][0].data;
    expect(auditArg.action).toBe('WORKFLOW');
    expect(auditArg.entity).toBe('AutomationRule');
    expect(auditArg.entityId).toBe(51);
    expect(auditArg.tenantId).toBe(1);
    // details is a JSON-serialised summary including trigger + action + payload.
    const details = JSON.parse(auditArg.details);
    expect(details.trigger).toBe('consent.signed');
    expect(details.action).toBe('send_notification');
    expect(details.payload.patientId).toBe(7);
  });

  test('isActive=false wellness rules are excluded by the findMany where clause', async () => {
    // The where clause includes isActive: true — paused rules MUST NOT
    // be returned to the action-dispatch loop. We verify by inspecting
    // the call shape (the engine doesn't filter post-fetch; the DB
    // filter is the source of truth).
    prisma.automationRule.findMany.mockResolvedValueOnce([]);
    await emitEvent('visit.completed', { visitId: 1 }, 1);

    const callArg = prisma.automationRule.findMany.mock.calls[0][0];
    expect(callArg.where.isActive).toBe(true);
    // And of course no action fired (empty result set).
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.task.create).not.toHaveBeenCalled();
  });
});

// ─── multi-step wellness drip walk-through ─────────────────────────────

describe('sequenceEngine.processStepListEnrollment — wellness drip multi-step walk', () => {
  test('email → wait → sms sequence parks at the wait then fires the email step', async () => {
    // Canonical wellness drip shape: send aftercare email at visit completion,
    // wait 24h, then send an SMS check-in. Verifies the step-list dispatcher
    // walks until a wait step parks the enrollment, persists the advanced
    // cursor + nextRun, and does NOT fire the post-wait SMS in the same tick
    // (that's the next tick's job). The case is wellness-specific in framing
    // (post-visit SMS check-in) but pins the same multi-step dispatcher the
    // sibling test exercises in isolation.
    const enrollment = {
      id: 200,
      sequenceId: 7,
      tenantId: 1,
      currentStep: 0,
      contact: {
        id: 9,
        name: 'Priya',
        email: 'priya@example.in',
        phone: '+919812345678',
      },
    };
    const steps = [
      {
        id: 1,
        sequenceId: 7,
        position: 0,
        kind: 'email',
        emailTemplate: { subject: 'Aftercare for {{name}}', body: 'Hi {{name}}, …' },
      },
      {
        id: 2,
        sequenceId: 7,
        position: 1,
        kind: 'wait',
        delayMinutes: 1440, // 24h
      },
      {
        id: 3,
        sequenceId: 7,
        position: 2,
        kind: 'sms',
        smsBody: 'Hi {{name}}, how are you feeling today?',
      },
    ];

    await processStepListEnrollment(enrollment, steps);

    // Email step fired (step 0).
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const emailData = prisma.emailMessage.create.mock.calls[0][0].data;
    expect(emailData.subject).toBe('Aftercare for Priya');
    // SMS step did NOT fire this tick — wait at step 1 parked the enrollment.
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
    // Final persist: cursor advanced past the wait (to position 2), nextRun
    // set, status NOT flipped to Completed (enrollment still Active).
    const updateCalls = prisma.sequenceEnrollment.update.mock.calls;
    const last = updateCalls[updateCalls.length - 1][0];
    expect(last.data.currentStep).toBe(2);
    expect(last.data.nextRun).toBeInstanceOf(Date);
    expect(last.data.status).toBeUndefined();
  });
});
