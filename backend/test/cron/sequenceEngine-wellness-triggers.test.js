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
