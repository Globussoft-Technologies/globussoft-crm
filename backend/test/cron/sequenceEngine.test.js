/**
 * Unit tests for backend/cron/sequenceEngine.js — drip-sequence step
 * executor running every minute (cron: `* * * * *`).
 *
 * Why this file exists (regression class — sole untested cron engine):
 *   The sequence engine was the LAST untested file in backend/cron/ (the
 *   other 21 engines all have sibling tests in backend/test/cron/). It
 *   carries two coexisting execution paths and a reply-detection layer
 *   that together make the engine awkward to exercise via API specs:
 *
 *     1. NEW step-list path (#9 rebuild): SequenceStep rows referenced
 *        by Sequence.steps, with explicit kind in {email, sms, wait,
 *        condition}. Cursor = enrollment.currentStep (0-based int).
 *     2. LEGACY ReactFlow canvas path: Sequence.nodes/edges as JSON,
 *        cursor = enrollment.currentNode (string id). Preserved as a
 *        fallback so pre-rebuild sequences keep firing.
 *     3. Inbound-reply detection: scans EmailMessage WHERE
 *        direction=INBOUND AND threadId LIKE 'seq-%' AND
 *        sequenceReplyHandled IS NULL — and pauses the parked enrollment
 *        IF the step it sits on has pauseOnReply=true (or always, for
 *        legacy canvases).
 *
 * Functions / branches covered (every exported function):
 *
 *   - processStep (NEW step-list dispatcher):
 *     ✅ kind='email' + emailTemplate present → renders subject+body via
 *        renderTemplate against {{contact.*}} context + writes EmailMessage
 *        row with threadId='seq-<enrollmentId>'; advances cursor.
 *     ✅ kind='email' + no emailTemplate → falls back to "Sequence: step
 *        N" subject + empty body; still writes EmailMessage; advances.
 *     ✅ kind='email' + contact has no email → skips silently, returns
 *        { advance: true } (cursor still advances — engine never gets
 *        stuck on a contactless enrollment).
 *     ✅ kind='sms' + contact has phone → writes SmsMessage row with
 *        rendered body + status='QUEUED'; advances.
 *     ✅ kind='sms' + contact has no phone → no write, still advances.
 *     ✅ kind='wait' with delayMinutes>0 → returns { advance: true,
 *        nextRun: <date> } — cursor advances PAST the wait so the next
 *        tick after nextRun fires the FOLLOWING step.
 *     ✅ kind='wait' with delayMinutes=0 → advance only, no nextRun.
 *     ✅ kind='wait' with negative/NaN delayMinutes → coerced to 0 via
 *        Math.max(parseInt || 0, 0); pure-advance.
 *     ✅ kind='condition' truthy → jumpTo trueNextPosition (or fallback
 *        position+1 when trueNextPosition is null).
 *     ✅ kind='condition' falsy → jumpTo falseNextPosition (or fallback).
 *     ✅ Unknown kind → fail-safe: { advance: true } (enrollment
 *        progresses rather than wedging).
 *
 *   - processStepListEnrollment:
 *     ✅ Happy walk over kind=email steps with no wait → multiple
 *        EmailMessage rows written + enrollment.currentStep ends past
 *        the last position + status='Completed' + nextRun=null.
 *     ✅ Wait step → loop exits after parking with currentStep advanced
 *        + nextRun set on the enrollment.
 *     ✅ Condition step → cursor jumps to the trueNext/falseNext
 *        position (verifies jumpTo branch in processStepListEnrollment).
 *     ✅ Past last position on initial entry → enrollment immediately
 *        marked Completed (cursor outpaced steps).
 *     ✅ Safety guard: a malformed condition that loops back to itself
 *        bails after 50 iterations and persists Active rather than
 *        running away.
 *
 *   - processInboundReplies (#7):
 *     ✅ Inbound seq-<id> reply on Active enrollment whose step has
 *        pauseOnReply=true → enrollment flipped to Paused, nextRun=null,
 *        message marked handled.
 *     ✅ Same with pauseOnReply=false → enrollment stays Active;
 *        message still marked handled (idempotency).
 *     ✅ Inbound on already-Paused enrollment → no status change;
 *        message marked handled.
 *     ✅ Legacy canvas (no SequenceStep row at cursor) → default-pause
 *        on reply.
 *     ✅ Inbound with threadId NOT matching seq-<int> → marked handled
 *        anyway (don't re-scan forever).
 *     ✅ Inbound for nonexistent enrollmentId → marked handled, no
 *        status flip.
 *     ✅ findMany throws → engine catches + logs, does NOT propagate
 *        (cron-resilience contract: one DB blip doesn't crash the tick).
 *
 *   - tickSequenceEngine (top-level):
 *     ✅ Calls processInboundReplies BEFORE picking up active
 *        enrollments (so a reply that just arrived pauses BEFORE we
 *        advance an enrollment that just got it).
 *     ✅ Picks up enrollments with status=Active AND (nextRun=null OR
 *        nextRun<=now) — pinned via where-shape inspection.
 *     ✅ Skips enrollments whose sequence.isActive=false (paused
 *        sequence shouldn't fire).
 *     ✅ Routes step-list-bearing enrollment through
 *        processStepListEnrollment; routes canvas-only enrollment
 *        through the legacy path.
 *     ✅ Top-level exception in scheduledEmail/enrollment loop is
 *        caught + logged (cron-resilience contract).
 *
 * NOT covered (intentional):
 *   - initSequenceCron — schedules a real node-cron job; invoking it
 *     would register a live cron. Thin shell over tickSequenceEngine
 *     which is exhaustively covered.
 *   - trySendGridSend — best-effort fire-and-forget HTTP call; not
 *     exported, and the EmailMessage row write is the engine's
 *     source-of-truth (covered above). SendGrid HTTP-shape pinning lives
 *     in scheduledEmailEngine.test.js where the same SendGrid client is
 *     exercised directly.
 *
 * Mocking strategy (per writing-vitest-unit-test skill + CLAUDE.md
 * 2026-05-24 CJS self-mocking-seam cron-learning):
 *   - prisma singleton monkey-patched (mirrors leadScoringEngine.test.js
 *     + scheduledEmailEngine.test.js + sentimentEngine.test.js); the
 *     vitest.config.js inline list covers /backend/cron/ so the engine's
 *     `require('../lib/prisma')` resolves to the same singleton.
 *   - processStep / processStepListEnrollment / processInboundReplies are
 *     all exported (engine ships exports for unit-testing per #616), so
 *     we drive them directly. The engine does NOT use the CJS
 *     self-mocking-seam pattern (no inter-function calls re-routed
 *     through module.exports), so no spy-on-exports gymnastics needed.
 *   - eventBus's renderTemplate + evaluateCondition are pure-fn helpers
 *     the engine require()s synchronously at module load. We let them
 *     execute for real and assert on the rendered output (deterministic
 *     by construction).
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  processStep,
  processStepListEnrollment,
  processInboundReplies,
  tickSequenceEngine,
} from '../../cron/sequenceEngine.js';

beforeAll(() => {
  prisma.emailMessage = {
    create: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  };
  prisma.smsMessage = {
    create: vi.fn(),
  };
  prisma.whatsAppMessage = {
    create: vi.fn(),
  };
  prisma.sequenceEnrollment = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  prisma.sequenceStep = {
    findFirst: vi.fn(),
  };
});

let originalSendgridKey;
beforeEach(() => {
  prisma.emailMessage.create.mockReset();
  prisma.emailMessage.findMany.mockReset();
  prisma.emailMessage.update.mockReset();
  prisma.smsMessage.create.mockReset();
  prisma.whatsAppMessage.create.mockReset();
  prisma.sequenceEnrollment.findMany.mockReset();
  prisma.sequenceEnrollment.findUnique.mockReset();
  prisma.sequenceEnrollment.update.mockReset();
  prisma.sequenceStep.findFirst.mockReset();

  prisma.emailMessage.create.mockResolvedValue({ id: 'em-1' });
  prisma.emailMessage.findMany.mockResolvedValue([]);
  prisma.emailMessage.update.mockResolvedValue({});
  prisma.smsMessage.create.mockResolvedValue({ id: 'sms-1' });
  prisma.whatsAppMessage.create.mockResolvedValue({ id: 'wa-1' });
  prisma.sequenceEnrollment.findMany.mockResolvedValue([]);
  prisma.sequenceEnrollment.findUnique.mockResolvedValue(null);
  prisma.sequenceEnrollment.update.mockResolvedValue({});
  prisma.sequenceStep.findFirst.mockResolvedValue(null);

  // The engine reads SENDGRID_API_KEY at module top and triggers a
  // best-effort fire-and-forget fetch when an email step fires. We
  // unset it for the suite so processStep's email branch is purely
  // synchronous (no background HTTP attempt that could leak between
  // tests). Tests do NOT depend on the SendGrid client — they assert
  // on the EmailMessage row write, which is the source of truth.
  originalSendgridKey = process.env.SENDGRID_API_KEY;
  delete process.env.SENDGRID_API_KEY;
});

afterEach(() => {
  if (originalSendgridKey === undefined) {
    delete process.env.SENDGRID_API_KEY;
  } else {
    process.env.SENDGRID_API_KEY = originalSendgridKey;
  }
});

// Helpers — minimal shapes that mirror what the engine reads. Each test
// overrides just the surface it cares about.

function enrollmentWith(overrides = {}) {
  return {
    id: 100,
    tenantId: 'tenant-A',
    sequenceId: 50,
    status: 'Active',
    currentStep: 0,
    currentNode: null,
    nextRun: null,
    contact: {
      id: 7,
      name: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+1-415-5550000',
      company: 'Acme',
      status: 'Lead',
    },
    ...overrides,
  };
}

function stepWith(overrides = {}) {
  return {
    id: 1,
    sequenceId: 50,
    position: 0,
    kind: 'email',
    emailTemplate: null,
    smsBody: null,
    delayMinutes: null,
    conditionJson: null,
    trueNextPosition: null,
    falseNextPosition: null,
    pauseOnReply: false,
    ...overrides,
  };
}

// ─── processStep — email branch ────────────────────────────────────────────

describe('cron/sequenceEngine — processStep email', () => {
  test('happy path: renders template + writes EmailMessage + advances', async () => {
    const enrollment = enrollmentWith();
    const step = stepWith({
      kind: 'email',
      position: 2,
      emailTemplate: {
        subject: 'Hi {{contact.name}}',
        body: 'Hello {{contact.name}} from Acme.',
      },
    });

    const result = await processStep(step, enrollment);

    expect(result).toEqual({ advance: true });
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const arg = prisma.emailMessage.create.mock.calls[0][0];
    expect(arg.data.subject).toBe('Hi Jane Doe');
    expect(arg.data.body).toBe('Hello Jane Doe from Acme.');
    expect(arg.data.to).toBe('jane@example.com');
    expect(arg.data.direction).toBe('OUTBOUND');
    expect(arg.data.threadId).toBe('seq-100'); // seq-<enrollmentId>
    expect(arg.data.contactId).toBe(7);
    expect(arg.data.tenantId).toBe('tenant-A');
    expect(arg.data.read).toBe(true);
  });

  test('fallback subject "Sequence: step N" when no emailTemplate linked', async () => {
    const enrollment = enrollmentWith();
    const step = stepWith({ kind: 'email', position: 4, emailTemplate: null });

    await processStep(step, enrollment);

    const arg = prisma.emailMessage.create.mock.calls[0][0];
    expect(arg.data.subject).toBe('Sequence: step 4');
    expect(arg.data.body).toBe('');
  });

  test('contact has no email → skip silently but still advance', async () => {
    const enrollment = enrollmentWith({
      contact: { id: 7, name: 'X', email: null, phone: '+15555550000' },
    });
    const step = stepWith({ kind: 'email', emailTemplate: { subject: 'X', body: 'Y' } });

    const result = await processStep(step, enrollment);

    expect(result).toEqual({ advance: true });
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });
});

// ─── processStep — sms branch ──────────────────────────────────────────────

describe('cron/sequenceEngine — processStep sms', () => {
  test('contact has phone → writes SmsMessage with rendered body + QUEUED', async () => {
    const enrollment = enrollmentWith();
    const step = stepWith({
      kind: 'sms',
      smsBody: 'Hi {{contact.name}}, reminder from {{contact.company}}.',
    });

    const result = await processStep(step, enrollment);

    expect(result).toEqual({ advance: true });
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    const arg = prisma.smsMessage.create.mock.calls[0][0];
    expect(arg.data.to).toBe('+1-415-5550000');
    expect(arg.data.body).toBe('Hi Jane Doe, reminder from Acme.');
    expect(arg.data.direction).toBe('OUTBOUND');
    expect(arg.data.status).toBe('QUEUED');
    expect(arg.data.contactId).toBe(7);
    expect(arg.data.tenantId).toBe('tenant-A');
  });

  test('contact has no phone → no write, still advances', async () => {
    const enrollment = enrollmentWith({
      contact: { id: 7, name: 'X', email: 'x@y.com', phone: null },
    });
    const step = stepWith({ kind: 'sms', smsBody: 'Hi' });

    const result = await processStep(step, enrollment);

    expect(result).toEqual({ advance: true });
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });
});

// ─── processStep — wait branch ─────────────────────────────────────────────

describe('cron/sequenceEngine — processStep wait', () => {
  test('delayMinutes > 0 → returns advance:true + nextRun ~ now+minutes', async () => {
    const before = Date.now();
    const result = await processStep(stepWith({ kind: 'wait', delayMinutes: 60 }), enrollmentWith());
    const after = Date.now();

    expect(result.advance).toBe(true);
    expect(result.nextRun).toBeInstanceOf(Date);
    const nextMs = result.nextRun.getTime();
    // Window: [before+60min, after+60min].
    expect(nextMs).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(nextMs).toBeLessThanOrEqual(after + 60 * 60_000);
  });

  test('delayMinutes = 0 → pure advance, no nextRun', async () => {
    const result = await processStep(stepWith({ kind: 'wait', delayMinutes: 0 }), enrollmentWith());
    expect(result).toEqual({ advance: true });
  });

  test('delayMinutes negative → coerced to 0 via Math.max', async () => {
    const result = await processStep(stepWith({ kind: 'wait', delayMinutes: -30 }), enrollmentWith());
    expect(result).toEqual({ advance: true });
  });

  test('delayMinutes NaN/garbage → coerced to 0', async () => {
    const result = await processStep(
      stepWith({ kind: 'wait', delayMinutes: 'not-a-number' }),
      enrollmentWith(),
    );
    expect(result).toEqual({ advance: true });
  });
});

// ─── processStep — condition branch ────────────────────────────────────────

describe('cron/sequenceEngine — processStep condition', () => {
  test('truthy condition → jumpTo trueNextPosition', async () => {
    // evaluateCondition returns true when conditionJson is empty/null.
    const step = stepWith({
      kind: 'condition',
      position: 3,
      conditionJson: null, // → truthy
      trueNextPosition: 10,
      falseNextPosition: 99,
    });

    const result = await processStep(step, enrollmentWith());
    expect(result).toEqual({ advance: false, jumpTo: 10 });
  });

  test('falsy condition → jumpTo falseNextPosition', async () => {
    // Clause: contact.status == "Customer" — our contact.status is "Lead",
    // so the eq clause fails → evaluateCondition returns false.
    const step = stepWith({
      kind: 'condition',
      position: 3,
      conditionJson: JSON.stringify([{ field: 'contact.status', op: 'eq', value: 'Customer' }]),
      trueNextPosition: 10,
      falseNextPosition: 99,
    });

    const result = await processStep(step, enrollmentWith());
    expect(result).toEqual({ advance: false, jumpTo: 99 });
  });

  test('falsy condition + falseNextPosition null → fallback position+1', async () => {
    const step = stepWith({
      kind: 'condition',
      position: 5,
      conditionJson: JSON.stringify([{ field: 'contact.status', op: 'eq', value: 'Customer' }]),
      trueNextPosition: 10,
      falseNextPosition: null,
    });

    const result = await processStep(step, enrollmentWith());
    expect(result).toEqual({ advance: false, jumpTo: 6 }); // 5 + 1
  });
});

// ─── processStep — unknown kind ────────────────────────────────────────────

describe('cron/sequenceEngine — processStep unknown kind', () => {
  test('unknown kind → fail-safe advance:true (enrollment never wedges)', async () => {
    const result = await processStep(
      stepWith({ kind: 'whatsapp-typo' }),
      enrollmentWith(),
    );
    expect(result).toEqual({ advance: true });
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });
});

// ─── processStepListEnrollment ─────────────────────────────────────────────

describe('cron/sequenceEngine — processStepListEnrollment', () => {
  test('happy walk: multi-step no-wait flow completes the enrollment', async () => {
    const enrollment = enrollmentWith({ currentStep: 0 });
    const steps = [
      stepWith({ position: 0, kind: 'email', emailTemplate: { subject: 'S0', body: 'B0' } }),
      stepWith({ position: 1, kind: 'email', emailTemplate: { subject: 'S1', body: 'B1' } }),
      stepWith({ position: 2, kind: 'email', emailTemplate: { subject: 'S2', body: 'B2' } }),
    ];

    await processStepListEnrollment(enrollment, steps);

    // 3 email sends.
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(3);
    // Final update: status=Completed, currentStep past last position, nextRun=null.
    const updateCalls = prisma.sequenceEnrollment.update.mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1][0];
    expect(lastCall.where).toEqual({ id: 100 });
    expect(lastCall.data.status).toBe('Completed');
    expect(lastCall.data.nextRun).toBeNull();
  });

  test('wait step parks enrollment with advanced cursor + nextRun set', async () => {
    const enrollment = enrollmentWith({ currentStep: 0 });
    const steps = [
      stepWith({ position: 0, kind: 'wait', delayMinutes: 120 }),
      stepWith({ position: 1, kind: 'email', emailTemplate: { subject: 'S', body: 'B' } }),
    ];

    await processStepListEnrollment(enrollment, steps);

    // Engine parks BEFORE firing step 1 — no EmailMessage row this tick.
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledTimes(1);
    const arg = prisma.sequenceEnrollment.update.mock.calls[0][0];
    // Cursor advanced PAST the wait so next tick fires step 1.
    expect(arg.data.currentStep).toBe(1);
    expect(arg.data.nextRun).toBeInstanceOf(Date);
    // Status NOT flipped to Completed — enrollment is still Active.
    expect(arg.data.status).toBeUndefined();
  });

  test('condition step jumpTo branch advances cursor correctly', async () => {
    const enrollment = enrollmentWith({ currentStep: 0 });
    const steps = [
      stepWith({
        position: 0,
        kind: 'condition',
        conditionJson: null, // truthy
        trueNextPosition: 2,
        falseNextPosition: 99,
      }),
      stepWith({ position: 1, kind: 'email', emailTemplate: { subject: 'should-not-fire', body: '' } }),
      stepWith({ position: 2, kind: 'email', emailTemplate: { subject: 'fired', body: 'B' } }),
    ];

    await processStepListEnrollment(enrollment, steps);

    // Condition jumped from position 0 directly to position 2, skipping 1.
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.emailMessage.create.mock.calls[0][0];
    expect(createArg.data.subject).toBe('fired');
    // Then sequence completes after firing step 2.
    const updateCalls = prisma.sequenceEnrollment.update.mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1][0];
    expect(lastCall.data.status).toBe('Completed');
  });

  test('cursor already past last step → marks Completed immediately', async () => {
    const enrollment = enrollmentWith({ currentStep: 99 });
    const steps = [stepWith({ position: 0, kind: 'email', emailTemplate: { subject: 'S', body: 'B' } })];

    await processStepListEnrollment(enrollment, steps);

    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledTimes(1);
    const arg = prisma.sequenceEnrollment.update.mock.calls[0][0];
    expect(arg.data.status).toBe('Completed');
    expect(arg.data.currentStep).toBe(99);
    expect(arg.data.nextRun).toBeNull();
  });

  test('runaway condition loop bails after 50 iterations (safety guard)', async () => {
    // Self-referential condition: position 0 jumps to position 0 on truthy.
    const enrollment = enrollmentWith({ currentStep: 0 });
    const steps = [
      stepWith({
        position: 0,
        kind: 'condition',
        conditionJson: null, // truthy
        trueNextPosition: 0, // → loops to self
        falseNextPosition: 99,
      }),
    ];

    await processStepListEnrollment(enrollment, steps);

    // Engine bailed via safety guard. The final persist does NOT set
    // status=Completed (so the next tick can retry). currentStep stays 0
    // (the loop cursor never moved past position 0).
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledTimes(1);
    const arg = prisma.sequenceEnrollment.update.mock.calls[0][0];
    expect(arg.data.status).toBeUndefined();
    expect(arg.data.currentStep).toBe(0);
  });
});

// ─── processInboundReplies ─────────────────────────────────────────────────

describe('cron/sequenceEngine — processInboundReplies', () => {
  test('pauseOnReply=true on parked step → enrollment flipped to Paused', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-1', threadId: 'seq-100', sequenceReplyHandled: null },
    ]);
    prisma.sequenceEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentWith({ id: 100, status: 'Active', currentStep: 2 }),
    );
    prisma.sequenceStep.findFirst.mockResolvedValueOnce(
      stepWith({ position: 2, pauseOnReply: true }),
    );

    await processInboundReplies();

    // Enrollment paused.
    const enrollmentUpdate = prisma.sequenceEnrollment.update.mock.calls[0][0];
    expect(enrollmentUpdate.where).toEqual({ id: 100 });
    expect(enrollmentUpdate.data.status).toBe('Paused');
    expect(enrollmentUpdate.data.nextRun).toBeNull();
    // Message marked handled (idempotency).
    const msgUpdate = prisma.emailMessage.update.mock.calls[0][0];
    expect(msgUpdate.where).toEqual({ id: 'msg-1' });
    expect(msgUpdate.data.sequenceReplyHandled).toBeInstanceOf(Date);
  });

  test('pauseOnReply=false on parked step → enrollment stays Active; reply still marked handled', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-1', threadId: 'seq-100', sequenceReplyHandled: null },
    ]);
    prisma.sequenceEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentWith({ id: 100, status: 'Active', currentStep: 2 }),
    );
    prisma.sequenceStep.findFirst.mockResolvedValueOnce(
      stepWith({ position: 2, pauseOnReply: false }),
    );

    await processInboundReplies();

    // No enrollment update issued.
    expect(prisma.sequenceEnrollment.update).not.toHaveBeenCalled();
    // Message still marked handled.
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.update.mock.calls[0][0].data.sequenceReplyHandled).toBeInstanceOf(Date);
  });

  test('reply on already-Paused enrollment → no status change; message marked handled', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-1', threadId: 'seq-100', sequenceReplyHandled: null },
    ]);
    prisma.sequenceEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentWith({ id: 100, status: 'Paused', currentStep: 2 }),
    );

    await processInboundReplies();

    expect(prisma.sequenceEnrollment.update).not.toHaveBeenCalled();
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(1);
  });

  test('legacy canvas enrollment (no SequenceStep row at cursor) → default-pause on reply', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-1', threadId: 'seq-100', sequenceReplyHandled: null },
    ]);
    prisma.sequenceEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentWith({ id: 100, status: 'Active', currentStep: 0 }),
    );
    prisma.sequenceStep.findFirst.mockResolvedValueOnce(null); // legacy

    await processInboundReplies();

    const enrollmentUpdate = prisma.sequenceEnrollment.update.mock.calls[0][0];
    expect(enrollmentUpdate.data.status).toBe('Paused');
  });

  test('threadId NOT matching seq-<int> → message marked handled, no enrollment lookup', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-bogus', threadId: 'seq-abc', sequenceReplyHandled: null },
    ]);

    await processInboundReplies();

    expect(prisma.sequenceEnrollment.findUnique).not.toHaveBeenCalled();
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.update.mock.calls[0][0].where).toEqual({ id: 'msg-bogus' });
  });

  test('reply for missing enrollment → message marked handled, no enrollment update', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 'msg-orphan', threadId: 'seq-9999', sequenceReplyHandled: null },
    ]);
    prisma.sequenceEnrollment.findUnique.mockResolvedValueOnce(null);

    await processInboundReplies();

    expect(prisma.sequenceEnrollment.update).not.toHaveBeenCalled();
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(1);
  });

  test('findMany throws → engine catches + logs, does NOT propagate', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.emailMessage.findMany.mockRejectedValueOnce(new Error('DB down'));

    await expect(processInboundReplies()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('findMany WHERE shape: direction=INBOUND + threadId.startsWith=seq- + handled=null + take=200 + asc', async () => {
    await processInboundReplies();
    expect(prisma.emailMessage.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(arg.where.direction).toBe('INBOUND');
    expect(arg.where.threadId).toEqual({ startsWith: 'seq-' });
    expect(arg.where.sequenceReplyHandled).toBeNull();
    expect(arg.take).toBe(200);
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
  });
});

// ─── tickSequenceEngine — top-level orchestration ──────────────────────────

describe('cron/sequenceEngine — tickSequenceEngine', () => {
  test('processes inbound replies BEFORE picking up active enrollments', async () => {
    // Two findMany calls happen against emailMessage + sequenceEnrollment.
    // We assert ordering via call-order: emailMessage.findMany (reply scan)
    // is called BEFORE sequenceEnrollment.findMany.
    const callOrder = [];
    prisma.emailMessage.findMany.mockImplementationOnce(async () => {
      callOrder.push('replies');
      return [];
    });
    prisma.sequenceEnrollment.findMany.mockImplementationOnce(async () => {
      callOrder.push('enrollments');
      return [];
    });

    await tickSequenceEngine();

    expect(callOrder).toEqual(['replies', 'enrollments']);
  });

  test('enrollment query shape: status=Active + (nextRun=null OR nextRun<=now) + includes sequence.steps + contact', async () => {
    await tickSequenceEngine();
    const arg = prisma.sequenceEnrollment.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe('Active');
    expect(Array.isArray(arg.where.OR)).toBe(true);
    const nullClause = arg.where.OR.find((c) => c.nextRun === null);
    const lteClause = arg.where.OR.find((c) => c.nextRun && c.nextRun.lte);
    expect(nullClause).toBeDefined();
    expect(lteClause).toBeDefined();
    expect(lteClause.nextRun.lte).toBeInstanceOf(Date);
    // Include shape — sequence.steps with emailTemplate; contact.
    expect(arg.include.contact).toBe(true);
    expect(arg.include.sequence.include.steps.include.emailTemplate).toBe(true);
    expect(arg.include.sequence.include.steps.orderBy).toEqual({ position: 'asc' });
  });

  test('skips enrollment whose sequence.isActive=false', async () => {
    prisma.sequenceEnrollment.findMany.mockResolvedValueOnce([
      {
        ...enrollmentWith(),
        sequence: {
          id: 50,
          isActive: false, // paused sequence
          steps: [stepWith({ position: 0, kind: 'email', emailTemplate: { subject: 'S', body: 'B' } })],
          nodes: null,
        },
      },
    ]);

    await tickSequenceEngine();

    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.update).not.toHaveBeenCalled();
  });

  test('routes step-list-bearing enrollment through processStepListEnrollment', async () => {
    prisma.sequenceEnrollment.findMany.mockResolvedValueOnce([
      {
        ...enrollmentWith(),
        sequence: {
          id: 50,
          isActive: true,
          steps: [
            stepWith({ position: 0, kind: 'email', emailTemplate: { subject: 'S0', body: 'B0' } }),
          ],
          nodes: null,
        },
      },
    ]);

    await tickSequenceEngine();

    // EmailMessage write happened → step-list path ran.
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    // Enrollment was advanced + marked Completed (only one step).
    const updateCalls = prisma.sequenceEnrollment.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[updateCalls.length - 1][0].data.status).toBe('Completed');
  });

  test('routes canvas-only enrollment (no steps) through legacy path', async () => {
    // Single email node, no edges → legacy path fires one EmailMessage
    // then completes (no follow-on node).
    const nodes = JSON.stringify([
      { id: 'n1', type: 'input', data: { label: 'ACTION: Send Email — welcome' } },
    ]);
    prisma.sequenceEnrollment.findMany.mockResolvedValueOnce([
      {
        ...enrollmentWith({ currentNode: null }),
        sequence: {
          id: 50,
          isActive: true,
          steps: [], // no step-list rows → falls through to legacy path
          nodes,
          edges: '[]',
        },
      },
    ]);

    await tickSequenceEngine();

    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const arg = prisma.emailMessage.create.mock.calls[0][0];
    // Legacy path uses a different subject prefix.
    expect(arg.data.subject).toContain('Automated Sequence');
    // Legacy path completes when no follow-on edge.
    const updateCalls = prisma.sequenceEnrollment.update.mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1][0];
    expect(lastCall.data.status).toBe('Completed');
    expect(lastCall.data.currentNode).toBeNull();
  });

  test('top-level findMany throw → engine catches + logs (cron-resilience)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // processInboundReplies' own findMany call resolves clean (default mock);
    // the enrollment-findMany rejects.
    prisma.sequenceEnrollment.findMany.mockRejectedValueOnce(new Error('DB down'));

    await expect(tickSequenceEngine()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
