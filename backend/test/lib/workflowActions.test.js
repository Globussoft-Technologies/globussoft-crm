// @ts-check
/**
 * Unit tests for backend/lib/workflowActions.js — the workflow actions added
 * in the Freshsales-parity wave.
 *
 * Standing contract for this module: EVERY function throws on failure. That is
 * the direct fix for the failure mode the parity audit found, where a
 * misconfigured action fell out of the engine's switch having done nothing and
 * the engine then wrote a "WORKFLOW" success row — so a rule that had never
 * created a single approval request showed a perfectly clean run history. Most
 * of the cases below therefore assert a rejection, not a silent skip.
 *
 * Mock strategy mirrors test/lib/eventBus.test.js: monkey-patch the prisma
 * singleton (vitest.config.js inlines backend/lib) rather than vi.mock.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS('../../lib/prisma');
const sut = requireCJS('../../lib/workflowActions');
const { WORKFLOW_ENTITIES } = requireCJS('../../lib/workflowSchema');

const {
  parseTags,
  normaliseTags,
  applyTags,
  addToSequence,
  removeFromSequence,
  deleteRecord,
  resolveAssignee,
  resolveEmailContent,
  createDeal,
  createAppointment,
  scheduleRemainingActions,
  MAX_DELAY_MINUTES,
} = sut;

const RULE = { id: 5, name: 'Test rule', triggerType: 'contact.created' };
const render = (template) => String(template ?? '');

beforeAll(() => {
  prisma.contact = prisma.contact || {};
  prisma.contact.findFirst = vi.fn();
  prisma.contact.update = vi.fn();
  prisma.deal = prisma.deal || {};
  prisma.deal.findFirst = vi.fn();
  prisma.deal.update = vi.fn();
  prisma.deal.create = vi.fn();
  prisma.deal.groupBy = vi.fn();
  prisma.task = prisma.task || {};
  prisma.task.findFirst = vi.fn();
  prisma.task.update = vi.fn();
  prisma.user = prisma.user || {};
  prisma.user.findFirst = vi.fn();
  prisma.user.findMany = vi.fn();
  prisma.sequence = prisma.sequence || {};
  prisma.sequence.findFirst = vi.fn();
  prisma.sequenceEnrollment = prisma.sequenceEnrollment || {};
  prisma.sequenceEnrollment.findFirst = vi.fn();
  prisma.sequenceEnrollment.create = vi.fn();
  prisma.sequenceEnrollment.updateMany = vi.fn();
  prisma.emailTemplate = prisma.emailTemplate || {};
  prisma.emailTemplate.findFirst = vi.fn();
  prisma.calendarEvent = prisma.calendarEvent || {};
  prisma.calendarEvent.create = vi.fn();
  prisma.workflowExecution = prisma.workflowExecution || {};
  prisma.workflowExecution.count = vi.fn();
  prisma.workflowScheduledAction = prisma.workflowScheduledAction || {};
  prisma.workflowScheduledAction.create = vi.fn();
});

beforeEach(() => {
  for (const model of ['contact', 'deal', 'task', 'user', 'sequence', 'sequenceEnrollment', 'emailTemplate', 'calendarEvent', 'workflowExecution', 'workflowScheduledAction']) {
    for (const fn of Object.values(prisma[model])) {
      if (typeof fn?.mockReset === 'function') fn.mockReset();
    }
  }
  prisma.contact.findFirst.mockResolvedValue({ id: 3, tagsJson: null });
  prisma.contact.update.mockResolvedValue({});
  prisma.workflowExecution.count.mockResolvedValue(0);
  prisma.workflowScheduledAction.create.mockResolvedValue({ id: 1, runAt: new Date() });
});

// ─────────────────────────────────────────────────────────────────────────
// Tag helpers
// ─────────────────────────────────────────────────────────────────────────

describe('parseTags / normaliseTags', () => {
  test('parseTags reads the JSON string column', () => {
    expect(parseTags(JSON.stringify(['vip', 'hot']))).toEqual(['vip', 'hot']);
  });

  test('parseTags returns [] for empty input', () => {
    for (const empty of [null, undefined, '']) {
      expect(parseTags(empty)).toEqual([]);
    }
  });

  test('parseTags falls back to CSV for legacy non-JSON rows', () => {
    // Deliberate tolerance: tagsJson is the JSON column, but rows written
    // before it was standardised hold a bare comma-separated string. Treating
    // those as one opaque tag would be worse than splitting them.
    expect(parseTags('vip,hot lead')).toEqual(['vip', 'hot lead']);
    expect(parseTags('{not json')).toEqual(['{not json']);
  });

  test('parseTags stringifies non-string members rather than dropping them', () => {
    expect(parseTags(JSON.stringify(['ok', 42]))).toEqual(['ok', '42']);
  });

  test('normaliseTags splits a comma string and de-duplicates case-insensitively', () => {
    expect(normaliseTags('vip, VIP , hot lead')).toEqual(['vip', 'hot lead']);
  });

  test('normaliseTags accepts an array too', () => {
    expect(normaliseTags(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('normaliseTags returns [] for empty input', () => {
    expect(normaliseTags('')).toEqual([]);
    expect(normaliseTags(null)).toEqual([]);
    expect(normaliseTags('  ,  , ')).toEqual([]);
  });
});

describe('applyTags', () => {
  test('adds new tags, preserving existing ones', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 3, tagsJson: JSON.stringify(['existing']) });
    const result = await applyTags({ tags: 'vip, hot' }, { contactId: 3 }, 42, { remove: false });

    expect(result.tags).toEqual(['existing', 'vip', 'hot']);
    expect(JSON.parse(prisma.contact.update.mock.calls[0][0].data.tagsJson))
      .toEqual(['existing', 'vip', 'hot']);
  });

  test('adding an already-present tag is a no-op write', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 3, tagsJson: JSON.stringify(['vip']) });
    const result = await applyTags({ tags: 'VIP' }, { contactId: 3 }, 42, { remove: false });

    expect(result.unchanged).toBe(true);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('removes tags case-insensitively', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 3, tagsJson: JSON.stringify(['VIP', 'keep']) });
    await applyTags({ tags: 'vip' }, { contactId: 3 }, 42, { remove: true });

    expect(JSON.parse(prisma.contact.update.mock.calls[0][0].data.tagsJson)).toEqual(['keep']);
  });

  test('clearing the last tag writes NULL, not an empty array string', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 3, tagsJson: JSON.stringify(['vip']) });
    await applyTags({ tags: 'vip' }, { contactId: 3 }, 42, { remove: true });
    expect(prisma.contact.update.mock.calls[0][0].data.tagsJson).toBeNull();
  });

  test('throws when no tag is configured', async () => {
    await expect(applyTags({ tags: '' }, { contactId: 3 }, 42, { remove: false }))
      .rejects.toThrow(/at least one tag/);
  });

  test('throws when the contact is in another tenant', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    await expect(applyTags({ tags: 'vip' }, { contactId: 3 }, 42, { remove: false }))
      .rejects.toThrow(/not found in this tenant/);
  });

  test('scopes the lookup to the tenant and excludes soft-deleted contacts', async () => {
    await applyTags({ tags: 'vip' }, { contactId: 3 }, 42, { remove: false });
    expect(prisma.contact.findFirst.mock.calls[0][0].where)
      .toMatchObject({ id: 3, tenantId: 42, deletedAt: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Sequences
// ─────────────────────────────────────────────────────────────────────────

describe('addToSequence', () => {
  beforeEach(() => {
    prisma.sequence.findFirst.mockResolvedValue({ id: 8, isActive: true });
    prisma.contact.findFirst.mockResolvedValue({ id: 3 });
    prisma.sequenceEnrollment.findFirst.mockResolvedValue(null);
    prisma.sequenceEnrollment.create.mockResolvedValue({ id: 55 });
  });

  test('enrols the contact and marks it due immediately', async () => {
    const result = await addToSequence({ sequenceId: 8 }, { contactId: 3 }, 42);
    expect(result.enrollmentId).toBe(55);
    const data = prisma.sequenceEnrollment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ sequenceId: 8, contactId: 3, status: 'Active', tenantId: 42 });
    expect(data.nextRun).toBeInstanceOf(Date);
  });

  test('an existing ACTIVE enrolment is a no-op, not a duplicate', async () => {
    // Re-enrolling would restart the cadence and re-send every step the
    // contact has already received.
    prisma.sequenceEnrollment.findFirst.mockResolvedValue({ id: 41 });
    const result = await addToSequence({ sequenceId: 8 }, { contactId: 3 }, 42);

    expect(result.alreadyEnrolled).toBe(true);
    expect(prisma.sequenceEnrollment.create).not.toHaveBeenCalled();
  });

  test('throws when the sequence belongs to another tenant', async () => {
    prisma.sequence.findFirst.mockResolvedValue(null);
    await expect(addToSequence({ sequenceId: 8 }, { contactId: 3 }, 42))
      .rejects.toThrow(/Sequence not found/);
  });

  test('throws when no sequence is configured', async () => {
    await expect(addToSequence({}, { contactId: 3 }, 42)).rejects.toThrow(/sequence/i);
  });

  test('throws when the payload has no contact', async () => {
    await expect(addToSequence({ sequenceId: 8 }, {}, 42)).rejects.toThrow(/contact/i);
  });
});

describe('removeFromSequence', () => {
  test('unenrols rather than deleting, preserving history', async () => {
    prisma.sequenceEnrollment.updateMany.mockResolvedValue({ count: 2 });
    const result = await removeFromSequence({}, { contactId: 3 }, 42);

    expect(result.unenrolled).toBe(2);
    const args = prisma.sequenceEnrollment.updateMany.mock.calls[0][0];
    expect(args.data.status).toBe('Unenrolled');
    expect(args.where).toMatchObject({ contactId: 3, tenantId: 42, status: 'Active' });
  });

  test('scopes to one sequence when configured', async () => {
    prisma.sequenceEnrollment.updateMany.mockResolvedValue({ count: 1 });
    await removeFromSequence({ sequenceId: 8 }, { contactId: 3 }, 42);
    expect(prisma.sequenceEnrollment.updateMany.mock.calls[0][0].where.sequenceId).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// delete_record
// ─────────────────────────────────────────────────────────────────────────

describe('deleteRecord', () => {
  test('refuses to run without an explicit confirmation', async () => {
    // A half-configured action dragged in from the palette must never be able
    // to delete anything.
    await expect(deleteRecord({ entity: 'contact', entityId: 3 }, {}, 42))
      .rejects.toThrow(/confirmation/i);
  });

  test('soft-deletes when confirmed', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 3, deletedAt: null });
    const result = await deleteRecord({ entity: 'contact', entityId: 3, confirm: true }, {}, 42);

    expect(result.deleted).toBe(true);
    expect(prisma.contact.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  test('an already-deleted record is a no-op', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 3, deletedAt: new Date() });
    const result = await deleteRecord({ entity: 'contact', entityId: 3, confirm: true }, {}, 42);

    expect(result.alreadyDeleted).toBe(true);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('refuses a model with no soft-delete column rather than hard-deleting', async () => {
    // Ticket has no deletedAt. A workflow silently hard-deleting support
    // history is not a trade worth making.
    expect(WORKFLOW_ENTITIES.ticket.softDelete).toBe(false);
    await expect(deleteRecord({ entity: 'ticket', entityId: 3, confirm: true }, {}, 42))
      .rejects.toThrow(/no soft-delete column/);
  });

  test('throws for an unsupported entity', async () => {
    await expect(deleteRecord({ entity: 'unicorn', entityId: 1, confirm: true }, {}, 42))
      .rejects.toThrow(/entity/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// assign_agent
// ─────────────────────────────────────────────────────────────────────────

describe('resolveAssignee', () => {
  const contactEntity = WORKFLOW_ENTITIES.contact;
  const dealEntity = WORKFLOW_ENTITIES.deal;

  test('specific mode returns the configured user (unchanged pre-parity behaviour)', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 88 });
    const id = await resolveAssignee({ mode: 'specific', userId: 88 }, {}, 42, RULE, contactEntity);
    expect(id).toBe(88);
  });

  test('specific mode defaults when no mode is set', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 88 });
    expect(await resolveAssignee({ userId: 88 }, {}, 42, RULE, contactEntity)).toBe(88);
  });

  test('specific mode rejects a user from another tenant', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(resolveAssignee({ userId: 88 }, {}, 42, RULE, contactEntity))
      .rejects.toThrow(/not found in this tenant/i);
  });

  test('round_robin rotates across the pool as the rule accrues assignments', async () => {
    // The mode that makes the action genuinely useful — distributing inbound
    // leads across a team was impossible with a fixed user id.
    prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    prisma.workflowExecution.count.mockResolvedValue(0);
    expect(await resolveAssignee({ mode: 'round_robin' }, {}, 42, RULE, contactEntity)).toBe(1);
    prisma.workflowExecution.count.mockResolvedValue(1);
    expect(await resolveAssignee({ mode: 'round_robin' }, {}, 42, RULE, contactEntity)).toBe(2);
    prisma.workflowExecution.count.mockResolvedValue(3);
    expect(await resolveAssignee({ mode: 'round_robin' }, {}, 42, RULE, contactEntity)).toBe(1);
  });

  test('the default pool EXCLUDES customer and patient users', async () => {
    // CUSTOMER and PATIENT rows share the User table in this schema; assigning
    // a deal to a patient is a data-integrity bug, not a poor choice.
    prisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    await resolveAssignee({ mode: 'round_robin' }, {}, 42, RULE, contactEntity);
    expect(prisma.user.findMany.mock.calls[0][0].where.role)
      .toEqual({ notIn: ['CUSTOMER', 'PATIENT'] });
  });

  test('an explicit pool wins over the role filter', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 4 }, { id: 9 }]);
    await resolveAssignee({ mode: 'round_robin', userIds: [4, 9] }, {}, 42, RULE, contactEntity);
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ in: [4, 9] });
    expect(where.role).toBeUndefined();
  });

  test('throws when the pool resolves to nobody', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await expect(resolveAssignee({ mode: 'round_robin' }, {}, 42, RULE, contactEntity))
      .rejects.toThrow(/zero users/);
  });

  test('least_busy counts only OPEN records', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    prisma.deal.groupBy.mockResolvedValue([
      { ownerId: 1, _count: { _all: 9 } },
      { ownerId: 2, _count: { _all: 2 } },
    ]);

    const id = await resolveAssignee({ mode: 'least_busy' }, {}, 42, RULE, dealEntity);
    expect(id).toBe(2);
    // Won/lost deals are nobody's problem any more, so they must not count
    // against a rep's load.
    expect(prisma.deal.groupBy.mock.calls[0][0].where.stage).toEqual({ notIn: ['won', 'lost'] });
  });

  test('least_busy picks a user with no records at all', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    prisma.deal.groupBy.mockResolvedValue([{ ownerId: 1, _count: { _all: 5 } }]);
    expect(await resolveAssignee({ mode: 'least_busy' }, {}, 42, RULE, dealEntity)).toBe(2);
  });

  test('record_owner inherits the owner already on the event', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 12 });
    const id = await resolveAssignee({ mode: 'record_owner' }, { ownerId: 12 }, 42, RULE, dealEntity);
    expect(id).toBe(12);
  });

  test('record_owner throws when the event carries no owner', async () => {
    await expect(resolveAssignee({ mode: 'record_owner' }, {}, 42, RULE, dealEntity))
      .rejects.toThrow(/could not be resolved/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// send_email template resolution
// ─────────────────────────────────────────────────────────────────────────

describe('resolveEmailContent', () => {
  test('passes inline subject/body straight through when no template is set', async () => {
    const result = await resolveEmailContent({ subject: 'Hi', body: 'There' }, 42);
    expect(result).toMatchObject({ subject: 'Hi', body: 'There', templateId: null });
    expect(prisma.emailTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('loads a stored template — the whole point of the templateId field', async () => {
    // Before this the action accepted only a raw subject/body, so every rule
    // duplicated its copy inline and template edits never propagated.
    prisma.emailTemplate.findFirst.mockResolvedValue({ id: 4, subject: 'T subject', body: 'T body' });
    const result = await resolveEmailContent({ templateId: 4 }, 42);
    expect(result).toMatchObject({ subject: 'T subject', body: 'T body', templateId: 4 });
  });

  test('an inline override beats the template', async () => {
    prisma.emailTemplate.findFirst.mockResolvedValue({ id: 4, subject: 'T subject', body: 'T body' });
    const result = await resolveEmailContent({ templateId: 4, subject: 'Override' }, 42);
    expect(result.subject).toBe('Override');
    expect(result.body).toBe('T body');
  });

  test('throws for a template from another tenant', async () => {
    prisma.emailTemplate.findFirst.mockResolvedValue(null);
    await expect(resolveEmailContent({ templateId: 4 }, 42)).rejects.toThrow(/template/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// create_deal / create_appointment
// ─────────────────────────────────────────────────────────────────────────

describe('createDeal', () => {
  beforeEach(() => {
    prisma.deal.create.mockResolvedValue({ id: 77, title: 'New deal', amount: 0 });
  });

  test('inherits the owner carried on the triggering event', async () => {
    // A workflow-created deal must not land unassigned in a bucket nobody
    // looks at, so the event's own owner column is the fallback.
    const result = await createDeal(
      { title: 'New deal', stage: 'lead' }, { contactId: 3, assignedToId: 11 }, 42, RULE, render,
    );
    expect(result.dealId).toBe(77);
    const data = prisma.deal.create.mock.calls[0][0].data;
    expect(data.ownerId).toBe(11);
    expect(data.contactId).toBe(3);
    expect(data.tenantId).toBe(42);
  });

  test('an explicit ownerId beats the payload', async () => {
    await createDeal({ title: 'x', ownerId: 4 }, { contactId: 3, assignedToId: 11 }, 42, RULE, render);
    expect(prisma.deal.create.mock.calls[0][0].data.ownerId).toBe(4);
  });

  test('throws when the title renders empty rather than creating an untitled deal', async () => {
    await expect(createDeal({ title: '   ' }, { contactId: 3 }, 42, RULE, render))
      .rejects.toThrow(/title/i);
  });

  test('a non-numeric amount falls back to 0 instead of writing NaN', async () => {
    await createDeal({ title: 'x', amount: 'lots' }, { contactId: 3 }, 42, RULE, render);
    expect(prisma.deal.create.mock.calls[0][0].data.amount).toBe(0);
  });

  test('expectedCloseInDays becomes a real future date', async () => {
    await createDeal({ title: 'x', expectedCloseInDays: 30 }, { contactId: 3 }, 42, RULE, render);
    const { expectedClose } = prisma.deal.create.mock.calls[0][0].data;
    expect(expectedClose).toBeInstanceOf(Date);
    expect(expectedClose.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('createAppointment', () => {
  test('creates a CRM-provider calendar event with a collision-proof external id', async () => {
    // The organiser is verified against the tenant before the event is written.
    prisma.user.findFirst.mockResolvedValue({ id: 6 });
    prisma.calendarEvent.create.mockResolvedValue({ id: 21 });
    const result = await createAppointment(
      { title: 'Call', inDays: 2, timeOfDay: '10:30', durationMinutes: 45, assignToId: 6 },
      { contactId: 3 }, 42, RULE, render,
    );

    expect(result.calendarEventId).toBe(21);
    const data = prisma.calendarEvent.create.mock.calls[0][0].data;
    expect(data.provider).toBe('crm');
    // CalendarEvent is unique on (tenantId, provider, externalId); a synthetic
    // id keeps workflow events from colliding with synced Google/Microsoft ones.
    expect(data.externalId).toMatch(/^wf-5-/);
    expect(data.endTime.getTime() - data.startTime.getTime()).toBe(45 * 60 * 1000);
  });

  test('throws when no organiser can be resolved', async () => {
    // CalendarEvent.userId is NOT NULL, so this cannot be defaulted away.
    await expect(createAppointment({ title: 'Call' }, {}, 42, RULE, render))
      .rejects.toThrow(/organiser/i);
  });

  test('throws when the organiser belongs to another tenant', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(createAppointment({ title: 'Call', assignToId: 6 }, {}, 42, RULE, render))
      .rejects.toThrow(/not found in this tenant/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// wait
// ─────────────────────────────────────────────────────────────────────────

describe('scheduleRemainingActions', () => {
  const remaining = [{ type: 'send_email', config: {} }];

  test('parks the remaining actions with a future runAt', async () => {
    const result = await scheduleRemainingActions(
      { delayMinutes: 60 }, remaining, { contactId: 3 }, 42, RULE, 'contactId:3',
    );

    expect(result.deferred).toBe(true);
    const data = prisma.workflowScheduledAction.create.mock.calls[0][0].data;
    expect(data.status).toBe('PENDING');
    expect(JSON.parse(data.actionsJson)).toEqual(remaining);
    expect(data.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('freezes the payload and strips the rendered body', async () => {
    await scheduleRemainingActions(
      { delayMinutes: 5 }, remaining, { contactId: 3, body: 'x'.repeat(1000) }, 42, RULE, null,
    );
    const frozen = JSON.parse(prisma.workflowScheduledAction.create.mock.calls[0][0].data.payloadJson);
    expect(frozen.contactId).toBe(3);
    expect(frozen.body).toBeUndefined();
  });

  test('a TEST fire runs the chain now instead of waiting days to find a bug', async () => {
    const result = await scheduleRemainingActions(
      { delayMinutes: 2880 }, remaining, { contactId: 3, _test: true }, 42, RULE, null,
    );
    expect(result.deferred).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(prisma.workflowScheduledAction.create).not.toHaveBeenCalled();
  });

  test('a trailing wait with nothing after it is a no-op, not a row', async () => {
    const result = await scheduleRemainingActions({ delayMinutes: 60 }, [], { contactId: 3 }, 42, RULE, null);
    expect(result.deferred).toBe(false);
    expect(prisma.workflowScheduledAction.create).not.toHaveBeenCalled();
  });

  test('rejects a non-positive delay', async () => {
    for (const bad of [0, -5, undefined, 'soon']) {
      await expect(scheduleRemainingActions({ delayMinutes: bad }, remaining, {}, 42, RULE, null))
        .rejects.toThrow(/positive delay/);
    }
  });

  test('rejects a delay beyond the ceiling', async () => {
    // Guards a typo silently creating a row nothing will ever drain.
    await expect(scheduleRemainingActions(
      { delayMinutes: MAX_DELAY_MINUTES + 1 }, remaining, {}, 42, RULE, null,
    )).rejects.toThrow(/cannot exceed/);
  });
});
