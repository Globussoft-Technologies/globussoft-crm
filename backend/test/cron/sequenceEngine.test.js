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
const travelProviderMocks = vi.hoisted(() => {
  const Module = require('node:module');
  const fromBackend = Module.createRequire(process.cwd() + '/');
  const servicePath = fromBackend.resolve('./services/travelSendGrid');
  const resolveSendGridConfig = vi.fn();
  Module._cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: { resolveSendGridConfig },
    children: [],
    paths: [],
  };
  return { resolveSendGridConfig };
});
const { resolveSendGridConfig } = travelProviderMocks;
import prisma from '../../lib/prisma.js';

import {
  processStep,
  processStepListEnrollment,
  processInboundReplies,
  tickSequenceEngine,
  receiverConditionMatches,
  classifyGenericEmailOpen,
  isLikelyHumanGenericEmailOpen,
} from '../../cron/sequenceEngine.js';

beforeAll(() => {
  prisma.activity = { create: vi.fn() };
  prisma.payment = { findFirst: vi.fn().mockResolvedValue(null) };
  prisma.emailMessage = {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  };
  prisma.emailTracking = {
    findMany: vi.fn(),
    create: vi.fn().mockResolvedValue({}),
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
    // Atomic batch-lock added by the cron-race hardening (214017c1): the
    // tick claims candidate rows via updateMany(WHERE lockedAt IS NULL)
    // before re-fetching only the rows this worker won.
    updateMany: vi.fn(),
  };
  prisma.sequenceStep = {
    findFirst: vi.fn(),
  };
  // The legacy ReactFlow path now resolves the from-address via per-tenant
  // settings: getSetting(tenantId, KEYS.EMAIL_FROM_ADDRESS) → prisma.tenant-
  // Setting.findUnique on the singleton (214017c1). Stub it; default null in
  // beforeEach so getSetting falls back to DEFAULTS / the supplied fallback.
  prisma.tenantSetting = {
    findUnique: vi.fn(),
  };
  prisma.tenant = {
    findUnique: vi.fn(),
  };
  prisma.transportPerson = {
    findMany: vi.fn(),
  };
  prisma.task = {
    findFirst: vi.fn(),
  };
});

let originalSendgridKey;
beforeEach(() => {
  prisma.activity.create.mockReset().mockResolvedValue({});
  prisma.emailMessage.create.mockReset();
  prisma.emailMessage.findMany.mockReset();
  prisma.emailMessage.findFirst.mockReset();
  prisma.emailMessage.update.mockReset();
  prisma.emailTracking.findMany.mockReset();
  prisma.smsMessage.create.mockReset();
  prisma.whatsAppMessage.create.mockReset();
  prisma.sequenceEnrollment.findMany.mockReset();
  prisma.sequenceEnrollment.findUnique.mockReset();
  prisma.sequenceEnrollment.update.mockReset();
  prisma.sequenceEnrollment.updateMany.mockReset();
  prisma.sequenceStep.findFirst.mockReset();

  prisma.emailMessage.create.mockResolvedValue({ id: 'em-1' });
  prisma.emailMessage.findMany.mockResolvedValue([]);
  prisma.emailMessage.findFirst.mockResolvedValue(null);
  prisma.emailMessage.update.mockResolvedValue({});
  prisma.emailTracking.findMany.mockResolvedValue([]);
  prisma.smsMessage.create.mockResolvedValue({ id: 'sms-1' });
  prisma.whatsAppMessage.create.mockResolvedValue({ id: 'wa-1' });
  prisma.sequenceEnrollment.findMany.mockResolvedValue([]);
  prisma.sequenceEnrollment.findUnique.mockResolvedValue(null);
  prisma.sequenceEnrollment.update.mockResolvedValue({});
  prisma.sequenceEnrollment.updateMany.mockResolvedValue({ count: 0 });
  prisma.sequenceStep.findFirst.mockResolvedValue(null);
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'generic' });
  prisma.transportPerson.findMany.mockReset().mockResolvedValue([]);
  prisma.task.findFirst.mockReset().mockResolvedValue(null);
  resolveSendGridConfig.mockReset().mockResolvedValue({ apiKey: '', fromEmail: 'platform@example.com' });

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
  vi.useRealTimers();
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

describe('cron/sequenceEngine — Generic CRM open classification', () => {
  test('counts a normal browser user-agent as likely human', () => {
    const tracking = { userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/124.0 Safari/537.36', ipAddress: '203.0.113.10' };
    expect(classifyGenericEmailOpen(tracking)).toBe('likely_human');
    expect(isLikelyHumanGenericEmailOpen(tracking)).toBe(true);
  });

  test('ignores an obvious scanner user-agent', () => {
    const tracking = { userAgent: 'GoogleImageProxy', ipAddress: '203.0.113.11' };
    expect(classifyGenericEmailOpen(tracking)).toBe('automated');
    expect(isLikelyHumanGenericEmailOpen(tracking)).toBe(false);
  });

  test('does not count missing or ambiguous user-agent as a human open', () => {
    expect(classifyGenericEmailOpen({ userAgent: null })).toBe('unknown');
    expect(isLikelyHumanGenericEmailOpen({ userAgent: 'EmailSecurityGateway/1.0' })).toBe(false);
  });

});

describe('cron/sequenceEngine — Generic pickup and site-visit receiver conditions', () => {
  const genericEnrollment = {
    id: 90,
    tenantId: 12,
    contactId: 44,
    sequence: { tenant: { vertical: 'generic' } },
  };

  test('matches only a persisted pickup booking assignment status', async () => {
    prisma.transportPerson.findMany.mockResolvedValueOnce([
      {
        customerIdsJson: JSON.stringify([44]),
        assignmentStatusJson: JSON.stringify({
          'customer-44': { status: 'CONFIRMED', updatedAt: '2026-10-08T10:00:00.000Z' },
        }),
        updatedAt: new Date('2026-10-08T10:00:00.000Z'),
      },
    ]);

    await expect(receiverConditionMatches({ type: 'pickup_booking_status', value: 'CONFIRMED' }, genericEnrollment)).resolves.toBe(true);

    prisma.transportPerson.findMany.mockResolvedValueOnce([]);
    await expect(receiverConditionMatches({ type: 'pickup_booking_status', value: 'ASSIGNED' }, genericEnrollment)).resolves.toBe(false);
  });

  test('matches the latest persisted Site Visit task status', async () => {
    prisma.task.findFirst.mockResolvedValueOnce({ status: 'Completed' });

    await expect(receiverConditionMatches({ type: 'site_visit_status', value: 'Completed' }, genericEnrollment)).resolves.toBe(true);
    expect(prisma.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 12, contactId: 44, type: 'Site Visit', deletedAt: null }),
    }));
  });

  test('does not evaluate these Generic-only categories for another vertical', async () => {
    const travelEnrollment = { ...genericEnrollment, sequence: { tenant: { vertical: 'travel' } } };

    await expect(receiverConditionMatches({ type: 'pickup_booking_status', value: 'CONFIRMED' }, travelEnrollment)).resolves.toBe(false);
    await expect(receiverConditionMatches({ type: 'site_visit_status', value: 'Completed' }, travelEnrollment)).resolves.toBe(false);
    expect(prisma.transportPerson.findMany).not.toHaveBeenCalled();
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });
});

// ─── processStep — email branch ────────────────────────────────────────────

describe('cron/sequenceEngine — processStep email', () => {
  test('Travel uses its tenant sender while Generic and Wellness keep the platform sender', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'travel' });
    resolveSendGridConfig.mockResolvedValue({
      apiKey: '',
      fromEmail: 'sequences@travel.test',
      fromName: 'Acme Travel',
      source: 'tenant',
    });

    await processStep(stepWith(), enrollmentWith({ tenantId: 73 }));

    expect(resolveSendGridConfig).toHaveBeenCalledWith(73);
    expect(prisma.emailMessage.create.mock.calls[0][0].data.from).toBe('Acme Travel <sequences@travel.test>');

    for (const vertical of ['generic', 'wellness']) {
      prisma.emailMessage.create.mockClear();
      resolveSendGridConfig.mockClear();
      prisma.tenant.findUnique.mockResolvedValue({ vertical });
      await processStep(stepWith(), enrollmentWith({ tenantId: 81 }));
      if (vertical === 'generic') expect(resolveSendGridConfig).toHaveBeenCalledWith(81);
      else expect(resolveSendGridConfig).not.toHaveBeenCalled();
      expect(prisma.emailMessage.create.mock.calls[0][0].data.from).toMatch(/@/);
      expect(prisma.emailMessage.create.mock.calls[0][0].data.from).not.toContain('travel.test');
    }
  });
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
  test('delays each Generic email once, resumes when due, and schedules later email delays', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const sequence = { tenant: { vertical: 'generic' } };
    const enrollment = enrollmentWith({ sequence });
    const steps = [stepWith({ position: 0, delayMinutes: 60 }), stepWith({ position: 1, delayMinutes: 30 })];
    await processStepListEnrollment(enrollment, steps);
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    const scheduled = prisma.sequenceEnrollment.update.mock.calls.at(-1)[0].data;
    expect(scheduled).toMatchObject({ currentStep: 0, emailDelayStep: 0, nextRun: new Date('2026-10-08T11:00:00Z') });
    await processStepListEnrollment({ ...enrollment, ...scheduled }, steps);
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-08T11:00:00Z'));
    await processStepListEnrollment({ ...enrollment, ...scheduled }, steps);
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.sequenceEnrollment.update.mock.calls.at(-1)[0].data).toMatchObject({ currentStep: 1, emailDelayStep: 1, nextRun: new Date('2026-10-08T11:30:00Z') });
  });

  test('a preceding wait does not consume the email-specific delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    await processStepListEnrollment(enrollmentWith({ sequence: { tenant: { vertical: 'generic' } }, currentStep: 1, nextRun: new Date('2026-10-08T10:00:00Z') }), [stepWith({ position: 1, delayMinutes: 15 })]);
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.update.mock.calls.at(-1)[0].data.nextRun).toEqual(new Date('2026-10-08T10:15:00Z'));
  });

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

  test('enrollment query shape: status=Active + (nextRun=null OR nextRun<=now) + lockedAt null candidate scan, then locked re-fetch includes sequence.steps + contact', async () => {
    // The cron-race hardening (214017c1) split the single enrollment read
    // into two: (1) a lightweight candidate scan (select id only, WHERE
    // lockedAt IS NULL) and (2) a re-fetch of the rows this worker claimed
    // (WHERE lockedBy = WORKER_ID) carrying the heavy include graph.
    // Make the candidate scan return one row so the re-fetch fires.
    prisma.sequenceEnrollment.findMany
      .mockResolvedValueOnce([{ id: 100 }]) // candidate scan
      .mockResolvedValueOnce([]);           // claimed re-fetch (empty is fine)
    prisma.sequenceEnrollment.updateMany.mockResolvedValueOnce({ count: 1 });

    await tickSequenceEngine();

    // First call — candidate scan: where + select id + lockedAt null.
    const candidateArg = prisma.sequenceEnrollment.findMany.mock.calls[0][0];
    expect(candidateArg.where.status).toBe('Active');
    expect(Array.isArray(candidateArg.where.OR)).toBe(true);
    const nullClause = candidateArg.where.OR.find((c) => c.nextRun === null);
    const lteClause = candidateArg.where.OR.find((c) => c.nextRun && c.nextRun.lte);
    expect(nullClause).toBeDefined();
    expect(lteClause).toBeDefined();
    expect(lteClause.nextRun.lte).toBeInstanceOf(Date);
    expect(candidateArg.where.lockedAt).toBeNull();
    expect(candidateArg.select).toEqual({ id: true });

    // Second call — claimed re-fetch carries the include graph.
    const refetchArg = prisma.sequenceEnrollment.findMany.mock.calls[1][0];
    expect(refetchArg.include.contact.include.leadCustomFieldValues).toBeDefined();
    expect(refetchArg.include.sequence.include.steps.include.emailTemplate).toBe(true);
    expect(refetchArg.include.sequence.include.steps.orderBy).toEqual({ position: 'asc' });
  });

  test.each([
    ['2026-10-08T02:00:00Z', false],
    ['2026-10-10T10:00:00Z', true],
  ])('initial Generic sends respect scheduling at %s', async (date, businessDaysOnly) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(date));
    prisma.sequenceEnrollment.findMany.mockResolvedValueOnce([{ id: 100 }]).mockResolvedValueOnce([
      enrollmentWith({ sequence: { isActive: true, tenant: { vertical: 'generic' }, campaigns: [{ status: 'Active', scheduleFilters: JSON.stringify({ timezone: 'UTC', startHour: 9, endHour: 17, businessDaysOnly }) }], steps: [stepWith()] } }),
    ]);
    await tickSequenceEngine();
    expect(prisma.sequenceEnrollment.updateMany).toHaveBeenCalled();
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({ where: { id: 100 }, data: { lockedAt: null, lockedBy: null } });
  });

  test('does not send when another worker owns the initial enrollment', async () => {
    prisma.sequenceEnrollment.findMany.mockResolvedValueOnce([{ id: 100 }]).mockResolvedValueOnce([]);
    prisma.sequenceEnrollment.updateMany.mockResolvedValue({ count: 0 });
    await tickSequenceEngine();
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  test('skips enrollment whose sequence.isActive=false', async () => {
    prisma.sequenceEnrollment.findMany
      .mockResolvedValueOnce([{ id: 100 }]) // candidate scan
      .mockResolvedValueOnce([              // claimed re-fetch
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
    prisma.sequenceEnrollment.updateMany.mockResolvedValueOnce({ count: 1 });

    await tickSequenceEngine();

    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    // No step processing; but the engine DOES unlock the inactive enrollment
    // (lockedAt/lockedBy → null), which is a sequenceEnrollment.update call.
    const stepUpdates = prisma.sequenceEnrollment.update.mock.calls.filter(
      (c) => c[0].data && (c[0].data.status !== undefined || c[0].data.currentStep !== undefined),
    );
    expect(stepUpdates).toHaveLength(0);
  });

  test('routes step-list-bearing enrollment through processStepListEnrollment', async () => {
    prisma.sequenceEnrollment.findMany
      .mockResolvedValueOnce([{ id: 100 }]) // candidate scan
      .mockResolvedValueOnce([              // claimed re-fetch
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
    prisma.sequenceEnrollment.updateMany.mockResolvedValueOnce({ count: 1 });

    await tickSequenceEngine();

    // EmailMessage write happened → step-list path ran.
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    // Enrollment was advanced + marked Completed (only one step). The tick
    // then issues a final unlock update (lockedAt/lockedBy → null), so we
    // look for the Completed update rather than assuming it's the last call.
    const updateCalls = prisma.sequenceEnrollment.update.mock.calls;
    const completedUpdate = updateCalls.find((c) => c[0].data && c[0].data.status === 'Completed');
    expect(completedUpdate).toBeDefined();
  });

  test('routes canvas-only enrollment (no steps) through legacy path', async () => {
    // Single email node, no edges → legacy path fires one EmailMessage
    // then completes (no follow-on node).
    const nodes = JSON.stringify([
      { id: 'n1', type: 'input', data: { label: 'ACTION: Send Email — welcome' } },
    ]);
    prisma.sequenceEnrollment.findMany
      .mockResolvedValueOnce([{ id: 100 }]) // candidate scan
      .mockResolvedValueOnce([              // claimed re-fetch
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
    prisma.sequenceEnrollment.updateMany.mockResolvedValueOnce({ count: 1 });

    await tickSequenceEngine();

    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const arg = prisma.emailMessage.create.mock.calls[0][0];
    // Legacy path uses a different subject prefix.
    expect(arg.data.subject).toContain('Automated Sequence');
    // Legacy path completes when no follow-on edge. The tick issues a final
    // unlock update afterwards, so locate the Completed update explicitly.
    const updateCalls = prisma.sequenceEnrollment.update.mock.calls;
    const completedCall = updateCalls.find((c) => c[0].data && c[0].data.status === 'Completed');
    expect(completedCall).toBeDefined();
    expect(completedCall[0].data.currentNode).toBeNull();
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
