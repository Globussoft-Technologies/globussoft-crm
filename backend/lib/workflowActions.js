/**
 * workflowActions.js — implementations for the workflow actions that need more
 * than a few lines of prisma.
 *
 * lib/eventBus.js keeps the action `switch` (it owns logging, retries, and the
 * execution-record write). The branches that grew real logic during the
 * Freshsales-parity wave live here so that switch stays readable:
 *
 *   resolveEmailContent      — EmailTemplate lookup for `send_email`
 *   createAppointment        — `create_appointment`
 *   createDeal               — `create_deal`
 *   applyTags                — `add_tag` / `remove_tag`
 *   addToSequence            — `add_to_sequence`
 *   removeFromSequence       — `remove_from_sequence`
 *   deleteRecord             — `delete_record`
 *   resolveAssignee          — `assign_agent` rotation strategies
 *   scheduleRemainingActions — `wait`
 *
 * Contract: every function THROWS on failure. eventBus turns a throw into a
 * FAILED WorkflowExecution row and a consecutive-failure increment. Returning
 * quietly on a problem is what let the old `create_approval` branch log green
 * executions for approvals it never created, so no function here reports
 * success for work it did not do.
 *
 * There is deliberately no `require("./eventBus")` at module scope — eventBus
 * requires this file, and a top-level back-require would be a cycle. The two
 * places that need to emit take the emitter as an argument instead.
 */

'use strict';

const prisma = require('./prisma');
const { WORKFLOW_ENTITIES } = require('./workflowSchema');

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

/** Resolve the entity + record id an action targets. */
function resolveTarget(config, payload, { allowPayloadFallback = true } = {}) {
  const explicit = String(config.entity || '').toLowerCase();
  const entity = explicit
    || (allowPayloadFallback
      ? Object.keys(WORKFLOW_ENTITIES).find((key) => payload[WORKFLOW_ENTITIES[key].idKey] != null)
      : '')
    || '';
  const entityConfig = WORKFLOW_ENTITIES[entity];
  if (!entityConfig) throw new Error(`Unsupported workflow entity: ${entity || 'missing'}`);
  const entityId = Number(config.entityId || payload[entityConfig.idKey]);
  if (!Number.isInteger(entityId) || entityId < 1) {
    throw new Error(`Missing ${entityConfig.idKey} for this action`);
  }
  return { entity, entityConfig, entityId };
}

/** Contact id an action should operate on: explicit config, else the payload. */
function resolveContactId(config, payload) {
  const contactId = Number(config.contactId ?? payload.contactId);
  if (!Number.isInteger(contactId) || contactId < 1) {
    throw new Error('This action needs a contact, and none was resolved from the event');
  }
  return contactId;
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ─────────────────────────────────────────────────────────────────────
// send_email — template resolution
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the subject/body a `send_email` action should use.
 *
 * A `templateId` pulls from EmailTemplate — the same records that already back
 * sequences and campaigns. Workflows were the only sender that could not reach
 * them, so every rule had to have its copy pasted into the rule itself, and a
 * wording change meant editing every workflow by hand.
 *
 * An inline subject/body still WINS over the template's, because overriding
 * just the subject line while reusing a template body is the common case.
 */
async function resolveEmailContent(config, tenantId) {
  const templateId = toPositiveInt(config.templateId);
  if (!templateId) {
    return { subject: config.subject || '', body: config.body || '', templateId: null };
  }

  const template = await prisma.emailTemplate.findFirst({
    where: { id: templateId, tenantId },
    select: { id: true, subject: true, body: true },
  });
  // Throw rather than silently falling back to the inline body: a rule whose
  // template was deleted should surface in the failure log, not quietly start
  // sending a blank email.
  if (!template) throw new Error(`Email template ${templateId} not found in this tenant`);

  return {
    subject: config.subject || template.subject || '',
    body: config.body || template.body || '',
    templateId: template.id,
  };
}

// ─────────────────────────────────────────────────────────────────────
// create_appointment
// ─────────────────────────────────────────────────────────────────────

/**
 * Create a calendar appointment.
 *
 * Writes a CalendarEvent rather than a Task, because routes/calendar.js reads
 * CalendarEvent exclusively — an appointment modelled as a Task would never
 * appear on the calendar the user is looking at.
 *
 * `provider`/`externalId` are NOT NULL and jointly unique per tenant (they
 * exist for Google/Microsoft sync dedupe). A CRM-authored event uses the
 * 'crm' provider and a rule-scoped id so it can never collide with a synced
 * event.
 */
async function createAppointment(config, payload, tenantId, rule, renderTemplate) {
  const inDays = Number.isFinite(Number(config.inDays)) ? Number(config.inDays) : 1;
  const durationMinutes = toPositiveInt(config.durationMinutes) || 30;

  const startTime = new Date();
  startTime.setDate(startTime.getDate() + inDays);
  if (config.timeOfDay && /^\d{1,2}:\d{2}$/.test(String(config.timeOfDay))) {
    const [hours, minutes] = String(config.timeOfDay).split(':').map(Number);
    startTime.setHours(Math.min(23, hours), Math.min(59, minutes), 0, 0);
  } else {
    startTime.setSeconds(0, 0);
  }
  const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

  const userId = toPositiveInt(config.assignToId)
    || toPositiveInt(payload.ownerId)
    || toPositiveInt(payload.assignedToId)
    || toPositiveInt(payload.userId);
  // CalendarEvent.userId is NOT NULL — an appointment with no organiser cannot
  // be written at all, so this is a hard failure rather than a default.
  if (!userId) throw new Error('create_appointment needs an organiser (set "Assign to", or emit a userId)');

  const owner = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
  if (!owner) throw new Error('create_appointment organiser not found in this tenant');

  const event = await prisma.calendarEvent.create({
    data: {
      provider: 'crm',
      externalId: `wf-${rule.id}-${Date.now()}`,
      title: renderTemplate(config.title || `Meeting: ${rule.name}`, payload),
      description: config.description ? renderTemplate(config.description, payload) : null,
      location: config.location ? renderTemplate(config.location, payload) : null,
      startTime,
      endTime,
      userId: owner.id,
      contactId: toPositiveInt(payload.contactId),
      dealId: toPositiveInt(payload.dealId),
      tenantId,
    },
  });

  return { calendarEventId: event.id, startTime, endTime, userId: owner.id };
}

// ─────────────────────────────────────────────────────────────────────
// create_deal
// ─────────────────────────────────────────────────────────────────────

async function createDeal(config, payload, tenantId, rule, renderTemplate) {
  const title = renderTemplate(config.title || `Deal for {{name}}`, payload).trim();
  if (!title) throw new Error('create_deal needs a title');

  const amount = Number(renderTemplate(String(config.amount ?? ''), payload));
  const expectedCloseInDays = Number(config.expectedCloseInDays);
  let expectedClose = null;
  if (Number.isFinite(expectedCloseInDays)) {
    expectedClose = new Date();
    expectedClose.setDate(expectedClose.getDate() + expectedCloseInDays);
  }

  const ownerId = toPositiveInt(config.ownerId)
    || toPositiveInt(payload.assignedToId)
    || toPositiveInt(payload.ownerId)
    || null;

  const deal = await prisma.deal.create({
    data: {
      title,
      amount: Number.isFinite(amount) ? amount : 0,
      currency: config.currency || undefined,
      stage: config.stage || undefined,
      expectedClose,
      ownerId,
      // Link the deal to the contact that triggered the rule. A deal created
      // off a contact event with no contactId is an orphan nobody finds again.
      contactId: toPositiveInt(payload.contactId),
      tenantId,
    },
  });

  return { dealId: deal.id, title: deal.title, amount: deal.amount };
}

// ─────────────────────────────────────────────────────────────────────
// add_tag / remove_tag
// ─────────────────────────────────────────────────────────────────────

/** Contact.tagsJson is a JSON-encoded string[]; tolerate legacy CSV rows. */
function parseTags(tagsJson) {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson);
    if (Array.isArray(parsed)) return parsed.map((tag) => String(tag));
  } catch (_e) { /* fall through to CSV */ }
  return String(tagsJson).split(',').map((tag) => tag.trim()).filter(Boolean);
}

function normaliseTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out = [];
  for (const entry of list) {
    const tag = String(entry).trim();
    if (!tag) continue;
    if (!out.some((existing) => existing.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

/**
 * Add or remove tags on the contact the event is about.
 *
 * Tag comparison is case-insensitive (adding "VIP" when "vip" is present is a
 * no-op) but the author's casing is what gets stored.
 *
 * The unchanged-short-circuit matters more than it looks: a rule triggered by
 * `contact.created_or_updated` that writes a tag would emit another
 * contact.updated, re-trigger itself, and only stop at MAX_EVENT_CHAIN_DEPTH.
 * Skipping the write when nothing changed breaks that loop at the source.
 */
async function applyTags(config, payload, tenantId, { remove = false } = {}) {
  const contactId = resolveContactId(config, payload);
  const tags = normaliseTags(config.tags ?? config.value);
  if (tags.length === 0) throw new Error(`${remove ? 'remove_tag' : 'add_tag'} needs at least one tag`);

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId, deletedAt: null },
    select: { id: true, tagsJson: true },
  });
  if (!contact) throw new Error('Contact not found in this tenant');

  const current = parseTags(contact.tagsJson);
  const lower = new Set(tags.map((tag) => tag.toLowerCase()));
  const next = remove
    ? current.filter((tag) => !lower.has(tag.toLowerCase()))
    : [...current, ...tags.filter((tag) => !current.some((existing) => existing.toLowerCase() === tag.toLowerCase()))];

  const unchanged = next.length === current.length && next.every((tag, i) => tag === current[i]);
  if (unchanged) return { contactId, tags: current, unchanged: true };

  await prisma.contact.update({
    where: { id: contact.id },
    data: { tagsJson: next.length ? JSON.stringify(next) : null },
  });

  return { contactId, tags: next, added: remove ? [] : tags, removed: remove ? tags : [] };
}

// ─────────────────────────────────────────────────────────────────────
// Sequences
// ─────────────────────────────────────────────────────────────────────

/**
 * Enrol the event's contact into a sales sequence.
 *
 * Freshsales treats "add to sequence" as a headline workflow action — it is
 * how a qualified lead gets dropped into a nurture cadence automatically.
 * Sequences already existed here; workflows just had no way to reach them.
 *
 * An existing Active enrolment is a no-op, not an error: re-enrolling would
 * restart the cadence and re-send every step the contact already received.
 */
async function addToSequence(config, payload, tenantId) {
  const sequenceId = toPositiveInt(config.sequenceId);
  if (!sequenceId) throw new Error('add_to_sequence needs a sequence');
  const contactId = resolveContactId(config, payload);

  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, tenantId },
    select: { id: true, isActive: true },
  });
  if (!sequence) throw new Error('Sequence not found in this tenant');

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!contact) throw new Error('Contact not found in this tenant');

  const existing = await prisma.sequenceEnrollment.findFirst({
    where: { sequenceId, contactId, tenantId, status: 'Active' },
    select: { id: true },
  });
  if (existing) {
    return { sequenceId, contactId, enrollmentId: existing.id, alreadyEnrolled: true };
  }

  const enrollment = await prisma.sequenceEnrollment.create({
    data: {
      sequenceId,
      contactId,
      tenantId,
      status: 'Active',
      currentStep: 0,
      // Due immediately — sequenceEngine's next tick picks it up. Leaving
      // nextRun null would park the enrolment until something else set it.
      nextRun: new Date(),
    },
  });

  return {
    sequenceId,
    contactId,
    enrollmentId: enrollment.id,
    // Surfaced so the history row explains why nothing was sent when an
    // author enrols into a sequence they forgot to switch on.
    sequenceInactive: !sequence.isActive || undefined,
  };
}

/**
 * Pull the contact out of a sequence. With no `sequenceId` configured it
 * unenrols them from ALL live sequences, which is the shape an unsubscribe or
 * went-cold rule wants.
 */
async function removeFromSequence(config, payload, tenantId) {
  const contactId = resolveContactId(config, payload);
  const sequenceId = toPositiveInt(config.sequenceId);

  const where = { contactId, tenantId, status: 'Active' };
  if (sequenceId) where.sequenceId = sequenceId;

  const result = await prisma.sequenceEnrollment.updateMany({
    where,
    data: { status: 'Unenrolled' },
  });

  return { contactId, sequenceId: sequenceId || 'all', unenrolled: result.count };
}

// ─────────────────────────────────────────────────────────────────────
// delete_record
// ─────────────────────────────────────────────────────────────────────

/**
 * Delete the record the rule fired on.
 *
 * Two deliberate guards, because this is the only destructive action:
 *   1. `confirm: true` must be set in the action config. The builder puts a
 *      checkbox behind it; a mis-clicked action type cannot silently start
 *      deleting records.
 *   2. Entities WITHOUT a `deletedAt` column are refused outright rather than
 *      hard-deleted. Ticket is the one that hits this — an unrecoverable
 *      automated delete of a support record is not a reasonable default.
 */
async function deleteRecord(config, payload, tenantId) {
  if (config.confirm !== true && config.confirm !== 'true') {
    throw new Error('delete_record requires the confirmation checkbox to be ticked');
  }
  const { entity, entityConfig, entityId } = resolveTarget(config, payload, { allowPayloadFallback: false });
  if (!entityConfig.softDelete) {
    throw new Error(`${entity} records cannot be deleted by a workflow — the model has no soft-delete column`);
  }

  const record = await prisma[entityConfig.model].findFirst({
    where: { id: entityId, tenantId },
    select: { id: true, deletedAt: true },
  });
  if (!record) throw new Error(`${entity} record not found in this tenant`);
  if (record.deletedAt) return { entity, entityId: record.id, alreadyDeleted: true };

  await prisma[entityConfig.model].update({
    where: { id: record.id },
    data: { deletedAt: new Date() },
  });

  return { entity, entityId: record.id, deleted: true };
}

// ─────────────────────────────────────────────────────────────────────
// assign_agent — rotation strategies
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the candidate pool for a rotating assignment.
 *
 * Explicit `userIds` wins; then a `role` filter; otherwise every staff user.
 * CUSTOMER and PATIENT rows live in the same User table in this schema, so the
 * default MUST exclude them — assigning a deal to a patient is a data-integrity
 * bug, not just a poor choice.
 */
async function resolveAssigneePool(config, tenantId) {
  const explicit = (Array.isArray(config.userIds) ? config.userIds : [])
    .map(toPositiveInt)
    .filter(Boolean);

  const where = { tenantId };
  if (explicit.length > 0) where.id = { in: explicit };
  else if (config.role) where.role = String(config.role).toUpperCase();
  else where.role = { notIn: ['CUSTOMER', 'PATIENT'] };

  return prisma.user.findMany({
    where,
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });
}

/**
 * Resolve who a record should be assigned to.
 *
 * Modes:
 *   specific     — a fixed user id. The pre-parity behaviour, byte for byte.
 *   round_robin  — rotate across the pool. This is the mode that made the
 *                  action actually useful: distributing inbound leads across a
 *                  sales team is the single most common real use of assignment
 *                  automation, and a fixed-id-only action could not express it.
 *   least_busy   — whoever currently holds the fewest OPEN records of that
 *                  entity.
 *   record_owner — inherit the owner already on the triggering record; used to
 *                  route a generated task back to the rep who owns the deal.
 *
 * Rotation position is derived from the rule's own successful assign_agent
 * execution count rather than a stored cursor: no extra column, no cross-
 * instance race on a counter, and identical fairness for the distribute-N-over-M
 * case. It is not strictly fair when executions fail midway — an acceptable
 * trade against a mutable counter two app instances would fight over.
 */
async function resolveAssignee(config, payload, tenantId, rule, entityConfig) {
  const mode = String(config.mode || 'specific').toLowerCase();

  if (mode === 'record_owner') {
    const ownerId = toPositiveInt(payload.ownerId)
      || toPositiveInt(payload.assignedToId)
      || toPositiveInt(payload.assigneeId)
      || toPositiveInt(payload.userId);
    if (!ownerId) throw new Error('assign_agent: the record owner could not be resolved from the event');
    const owner = await prisma.user.findFirst({ where: { id: ownerId, tenantId }, select: { id: true } });
    if (!owner) throw new Error('assign_agent: the resolved record owner is not a user in this tenant');
    return owner.id;
  }

  if (mode === 'round_robin' || mode === 'least_busy') {
    const pool = await resolveAssigneePool(config, tenantId);
    if (pool.length === 0) throw new Error('assign_agent: the assignment pool resolved to zero users');

    if (mode === 'round_robin') {
      const priorAssignments = await prisma.workflowExecution.count({
        where: {
          tenantId,
          ruleId: rule.id,
          actionType: 'assign_agent',
          status: 'SUCCESS',
          isTest: false,
        },
      });
      return pool[priorAssignments % pool.length].id;
    }

    // least_busy — count only records that are still someone's problem.
    const openFilter = { tenantId, [entityConfig.assigneeField]: { in: pool.map((u) => u.id) } };
    if (entityConfig.softDelete) openFilter.deletedAt = null;
    if (entityConfig.model === 'deal') openFilter.stage = { notIn: ['won', 'lost'] };
    if (entityConfig.model === 'task') openFilter.status = { not: 'Completed' };
    if (entityConfig.model === 'ticket') openFilter.status = { notIn: ['Resolved', 'Closed', 'Cancelled'] };

    const grouped = await prisma[entityConfig.model].groupBy({
      by: [entityConfig.assigneeField],
      where: openFilter,
      _count: { _all: true },
    });

    const load = new Map(pool.map((user) => [user.id, 0]));
    for (const row of grouped) {
      const assignee = row[entityConfig.assigneeField];
      if (assignee != null && load.has(assignee)) load.set(assignee, row._count._all);
    }
    // Ties break on the pool's id-ascending order, so the choice is stable.
    return pool.reduce((best, user) => (load.get(user.id) < load.get(best.id) ? user : best), pool[0]).id;
  }

  const userId = toPositiveInt(config.userId);
  if (!userId) throw new Error('assign_agent: a valid assignee user ID is required');
  const user = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
  if (!user) throw new Error('assign_agent: assignee not found in this tenant');
  return user.id;
}

// ─────────────────────────────────────────────────────────────────────
// wait
// ─────────────────────────────────────────────────────────────────────

// A rule cannot park work further out than this. Guards against a typo
// (90000 minutes) silently creating a row nothing will ever drain.
const MAX_DELAY_MINUTES = 365 * 24 * 60;

/**
 * Park the actions that follow a `wait` step.
 *
 * The whole point of the WorkflowScheduledAction table: before it, every
 * action ran synchronously inside the triggering HTTP request, so "wait 2 days
 * then send the follow-up" could not be expressed at all — and actually
 * sleeping would pin a request and a pooled DB connection open for days.
 *
 * The payload is FROZEN at this moment rather than re-read on resume. That is
 * a real semantic choice: the follow-up email renders the values as they were
 * when the rule fired, which is what an author means by "then email them about
 * this". `body` is stripped because it can be a whole rendered email and this
 * column is only a resume envelope.
 */
async function scheduleRemainingActions(config, remainingActions, payload, tenantId, rule, recordKey) {
  const actions = (remainingActions || []).filter((action) => action && action.type);
  if (actions.length === 0) {
    // A trailing wait has nothing to defer. Not an error — just a no-op the
    // history row explains.
    return { deferred: false, reason: 'no actions follow this wait step' };
  }

  const delayMinutes = Number(config.delayMinutes);
  if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) {
    throw new Error('wait needs a positive delay in minutes');
  }
  if (delayMinutes > MAX_DELAY_MINUTES) {
    throw new Error(`wait delay cannot exceed ${MAX_DELAY_MINUTES} minutes (365 days)`);
  }

  // A test fire must run the whole chain now. Waiting two days to discover
  // that step 3 is misconfigured is not a test.
  if (payload._test) {
    return { deferred: false, dryRun: true, delayMinutes, wouldDefer: actions.length };
  }

  // Drop `body` from the frozen copy: on webhook-ish payloads it can be a
  // large blob, and a delayed action has no use for it. Underscore-prefixed
  // for the no-unused-vars omit-pattern.
  const { body: _body, ...frozenPayload } = payload || {};
  const runAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  const row = await prisma.workflowScheduledAction.create({
    data: {
      ruleId: rule.id,
      tenantId,
      runAt,
      status: 'PENDING',
      triggerType: rule.triggerType,
      actionsJson: JSON.stringify(actions),
      payloadJson: JSON.stringify(frozenPayload),
      recordKey: recordKey || null,
    },
  });

  return { deferred: true, scheduledActionId: row.id, runAt, actions: actions.length };
}

module.exports = {
  resolveEmailContent,
  createAppointment,
  createDeal,
  applyTags,
  addToSequence,
  removeFromSequence,
  deleteRecord,
  resolveAssignee,
  resolveAssigneePool,
  scheduleRemainingActions,
  // Exported for the scheduler cron and unit tests.
  parseTags,
  normaliseTags,
  resolveTarget,
  resolveContactId,
  MAX_DELAY_MINUTES,
};
