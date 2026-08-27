/**
 * workflowSchema.js — the single source of truth for the workflow builder's
 * vocabulary: which triggers exist, which actions exist, which condition
 * operators are legal, and which entities an action may mutate.
 *
 * Why this file exists
 * ────────────────────
 * Before the parity wave the same lists were maintained in THREE places that
 * had already drifted apart:
 *
 *   • `routes/workflows.js`  — TRIGGER_TYPES / ACTION_TYPES / VALID_CONDITION_OPS
 *   • `lib/eventBus.js`      — WORKFLOW_ENTITIES + a second operator switch
 *   • `frontend/.../Workflows.jsx` — TRIGGERS / ACTIONS / OPERATORS / FIELD_OPTIONS
 *
 * The drift was not theoretical. `nin` and `exists` were implemented in the
 * engine and accepted by the route validator but missing from the frontend's
 * OPERATORS array, so they were unreachable from the UI. `invoice.overdue` was
 * advertised in the route's TRIGGER_TYPES and rendered in the builder but no
 * code path anywhere emitted it. Two of the frontend's trigger labels claimed
 * "created or updated" for events that only ever fire on update.
 *
 * Everything is now defined once, here, and served to the frontend over
 * GET /api/workflows/triggers|actions|operators|fields so the builder can
 * never again advertise something the engine cannot honour.
 *
 * NOTE ON `emitted`
 * ─────────────────
 * Each trigger declares whether a real emit site exists in the codebase. The
 * route filters `emitted: false` entries out of the public catalogue, which is
 * how a half-built trigger stops reaching the dropdown. Grep the `emitSites`
 * comment on each entry before flipping one to true.
 */

'use strict';

// ── Modules ───────────────────────────────────────────────────────────
// A "module" is the record type a workflow runs for. It scopes the trigger
// list, the condition field list, and which actions are offered.
const MODULES = [
  { value: 'contact', label: 'Contacts' },
  { value: 'deal', label: 'Deals' },
  { value: 'task', label: 'Tasks' },
  { value: 'ticket', label: 'Tickets' },
  { value: 'invoice', label: 'Invoices' },
  { value: 'payment', label: 'Payments' },
  { value: 'lead', label: 'Leads' },
  { value: 'approval', label: 'Approvals' },
];

// ── Triggers ──────────────────────────────────────────────────────────
// `module`  — which module tab surfaces this trigger in the builder.
// `emitted` — an emit site exists. false ⇒ hidden from the public catalogue.
// `kind`    — 'event' (fired by a route/cron) | 'scheduled' (fired by the
//             workflowScheduler cron from the rule's own scheduleConfig).
const TRIGGER_TYPES = [
  // ── Contacts / leads ────────────────────────────────────────────────
  { value: 'contact.created', module: 'contact', kind: 'event', emitted: true, label: 'When a contact is created', description: 'Fires when a new contact is added' },
  { value: 'contact.updated', module: 'contact', kind: 'event', emitted: true, label: 'When a contact is updated', description: 'Fires when an existing contact is modified' },
  { value: 'contact.created_or_updated', module: 'contact', kind: 'event', emitted: true, label: 'When a contact is created or updated', description: 'Fires on both contact.created and contact.updated' },
  { value: 'lead.converted', module: 'lead', kind: 'event', emitted: true, label: 'When a lead is converted', description: 'Fires when a contact’s status flips from Lead to Customer' },

  // ── Deals ───────────────────────────────────────────────────────────
  { value: 'deal.created', module: 'deal', kind: 'event', emitted: true, label: 'When a deal is created', description: 'Fires when a new deal is created' },
  // Label corrected: this fires on UPDATE only. The builder previously read
  // "When deal is created or updated", which is what deal.created is for.
  { value: 'deal.updated', module: 'deal', kind: 'event', emitted: true, label: 'When a deal is updated', description: 'Fires when an existing deal is modified' },
  { value: 'deal.stage_changed', module: 'deal', kind: 'event', emitted: true, label: 'When a deal stage changes', description: 'Fires when a deal moves pipeline stages. Payload carries fromStage and toStage.' },
  { value: 'deal.won', module: 'deal', kind: 'event', emitted: true, label: 'When a deal is won', description: 'Fires when a deal reaches the won stage, however it got there' },
  { value: 'deal.lost', module: 'deal', kind: 'event', emitted: true, label: 'When a deal is lost', description: 'Fires when a deal reaches the lost stage, however it got there' },

  // ── Tasks ───────────────────────────────────────────────────────────
  { value: 'task.created', module: 'task', kind: 'event', emitted: true, label: 'When a task is created', description: 'Fires when a task is created' },
  { value: 'task.completed', module: 'task', kind: 'event', emitted: true, label: 'When a task is completed', description: 'Fires on the Pending → Completed transition only' },

  // ── Tickets ─────────────────────────────────────────────────────────
  { value: 'ticket.created', module: 'ticket', kind: 'event', emitted: true, label: 'When a ticket is created', description: 'Fires when a support ticket is opened' },
  // Label corrected: update-only, same reason as deal.updated above.
  { value: 'ticket.updated', module: 'ticket', kind: 'event', emitted: true, label: 'When a ticket is updated', description: 'Fires when an existing ticket is modified' },
  { value: 'sla.breached', module: 'ticket', kind: 'event', emitted: true, label: 'When a ticket SLA is breached', description: 'Fires when a ticket misses its first-response SLA (cron: every 5 min)' },

  // ── Invoices / payments ─────────────────────────────────────────────
  { value: 'invoice.created', module: 'invoice', kind: 'event', emitted: true, label: 'When an invoice is created', description: 'Fires when an invoice is generated' },
  { value: 'invoice.paid', module: 'invoice', kind: 'event', emitted: true, label: 'When an invoice is paid', description: 'Fires when an invoice is marked as paid' },
  { value: 'invoice.completed', module: 'invoice', kind: 'event', emitted: true, label: 'When an invoice is completed', description: 'Fires when an invoice reaches its terminal PAID state' },
  { value: 'invoice.voided', module: 'invoice', kind: 'event', emitted: true, label: 'When an invoice is voided', description: 'Fires when an invoice is voided' },
  { value: 'invoice.refunded', module: 'invoice', kind: 'event', emitted: true, label: 'When an invoice is refunded', description: 'Fires when a PAID invoice is refunded' },
  // Was advertised for months with zero emit sites anywhere in the repo. Now
  // emitted by cron/workflowScheduler.js on the UNPAID → past-due transition.
  { value: 'invoice.overdue', module: 'invoice', kind: 'event', emitted: true, label: 'When an invoice becomes overdue', description: 'Fires once per invoice when it passes its due date unpaid (cron: hourly)' },
  { value: 'payment.collected', module: 'payment', kind: 'event', emitted: true, label: 'When a payment is collected', description: 'Fires when payment is captured (gateway success or manual mark-paid)' },

  // ── Approvals ───────────────────────────────────────────────────────
  { value: 'approval.created', module: 'approval', kind: 'event', emitted: true, label: 'When an approval is created', description: 'Fires when an approval request is created' },
  { value: 'approval.approved', module: 'approval', kind: 'event', emitted: true, label: 'When an approval is approved', description: 'Fires when an approval request is approved' },
  { value: 'approval.rejected', module: 'approval', kind: 'event', emitted: true, label: 'When an approval is rejected', description: 'Fires when an approval request is rejected' },

  // ── Time-based ──────────────────────────────────────────────────────
  // The second half of the Freshsales workflow feature. These carry no emit
  // site by design: cron/workflowScheduler.js drives them from the rule's own
  // scheduleConfig column. Available on every module.
  // Values, labels and config validation are owned by lib/workflowSchedule.js
  // (SCHEDULE_TRIGGERS / validateScheduleConfig). Mirrored here only so the
  // trigger whitelist in routes/workflows.js is a single lookup.
  { value: 'schedule.date_field', module: '*', kind: 'scheduled', emitted: true, label: 'Before / after a date field', description: 'Runs once per record, a set number of days either side of a date on that record (expected close, birthday, due date…).' },
  { value: 'schedule.recurring', module: '*', kind: 'scheduled', emitted: true, label: 'On a recurring schedule', description: 'Runs hourly, daily, weekly, or monthly over every record that matches the conditions.' },

  // ── Wellness vertical ───────────────────────────────────────────────
  // Kept for the wellness tenants that already depend on them. `module: null`
  // keeps them out of the generic builder's module tabs while leaving them
  // valid for rules created before the parity wave.
  { value: 'wallet.topup', module: null, kind: 'event', emitted: true, label: 'Wallet Top-up', description: 'Fires on every wallet credit' },
  { value: 'wallet.spent', module: null, kind: 'event', emitted: true, label: 'Wallet Spent', description: 'Fires on every wallet debit' },
  { value: 'cashback.credited', module: null, kind: 'event', emitted: true, label: 'Cashback Credited', description: 'Fires when cashback is credited for a completed visit' },
  { value: 'giftcard.issued', module: null, kind: 'event', emitted: true, label: 'Gift Card Issued', description: 'Fires when a gift card is issued' },
  { value: 'giftcard.redeemed', module: null, kind: 'event', emitted: true, label: 'Gift Card Redeemed', description: 'Fires when a gift card is redeemed' },
  { value: 'membership.plan_created', module: null, kind: 'event', emitted: true, label: 'Membership Plan Created', description: 'Fires when a membership plan is created' },
  { value: 'membership.enrolled', module: null, kind: 'event', emitted: true, label: 'Membership Enrolled', description: 'Fires on first-time enrollment in a plan' },
  { value: 'membership.renewed', module: null, kind: 'event', emitted: true, label: 'Membership Renewed', description: 'Fires when a patient repurchases a plan they previously held' },
  { value: 'membership.benefit_applied', module: null, kind: 'event', emitted: true, label: 'Membership Benefit Applied', description: 'Fires when a service is redeemed against a membership balance' },
  { value: 'membership.expired', module: null, kind: 'event', emitted: true, label: 'Membership Expired', description: 'Fires on the active→expired transition' },
  { value: 'membership.cancelled', module: null, kind: 'event', emitted: true, label: 'Membership Cancelled', description: 'Fires when a membership is cancelled' },
  { value: 'membership.renewal_due', module: null, kind: 'event', emitted: true, label: 'Membership Renewal Due (T-7)', description: 'Fires once per membership when it enters the 7-day expiry window' },
  { value: 'attendance.checked_in', module: null, kind: 'event', emitted: true, label: 'Attendance Clock-In', description: 'Fires when a staff member clocks in' },
  { value: 'attendance.checked_out', module: null, kind: 'event', emitted: true, label: 'Attendance Clock-Out', description: 'Fires when a staff member clocks out' },
  { value: 'shift.opened', module: null, kind: 'event', emitted: true, label: 'POS Shift Opened', description: 'Fires when a cashier opens a register shift' },
  { value: 'shift.closed', module: null, kind: 'event', emitted: true, label: 'POS Shift Closed', description: 'Fires when a register shift is closed; payload includes variance' },
];

// ── Actions ───────────────────────────────────────────────────────────
// `config`  — the config keys the builder renders inputs for.
// `modules` — restricts the action to those modules; null = every module.
const ACTION_TYPES = [
  { value: 'send_email', label: 'Send email', config: ['to', 'templateId', 'subject', 'body', 'cc', 'bcc', 'fromName'], modules: null },
  { value: 'send_sms', label: 'Send SMS', config: ['to', 'message'], modules: null },
  { value: 'send_notification', label: 'Send notification', config: ['userId', 'title', 'message'], modules: null },
  { value: 'create_task', label: 'Create task', config: ['title', 'dueInDays', 'assignToId', 'priority', 'taskType', 'notes'], modules: null },
  { value: 'create_appointment', label: 'Create appointment', config: ['title', 'inDays', 'timeOfDay', 'durationMinutes', 'location', 'assignToId', 'description'], modules: null },
  { value: 'create_deal', label: 'Create deal', config: ['title', 'amount', 'stage', 'currency', 'ownerId', 'expectedCloseInDays'], modules: null },
  { value: 'update_field', label: 'Update field', config: ['entity', 'entityId', 'field', 'value'], modules: ['contact', 'deal', 'task', 'ticket'] },
  { value: 'add_tag', label: 'Add tag', config: ['tags'], modules: ['contact', 'lead'] },
  { value: 'remove_tag', label: 'Remove tag', config: ['tags'], modules: ['contact', 'lead'] },
  { value: 'assign_agent', label: 'Assign owner', config: ['entity', 'mode', 'userId', 'userIds'], modules: ['contact', 'deal', 'task', 'ticket'] },
  { value: 'add_to_sequence', label: 'Add to sales sequence', config: ['sequenceId'], modules: ['contact', 'lead', 'deal'] },
  { value: 'remove_from_sequence', label: 'Remove from sales sequence', config: ['sequenceId'], modules: ['contact', 'lead', 'deal'] },
  { value: 'send_webhook', label: 'Trigger webhook', config: ['url', 'method', 'encoding', 'headers', 'bodyMode', 'bodyTemplate'], modules: null },
  { value: 'create_approval', label: 'Create approval request', config: ['entity', 'reasonTemplate'], modules: null },
  { value: 'wait', label: 'Wait / delay', config: ['delayMinutes'], modules: null },
  // Destructive, so it is deliberately last and restricted. Soft-deletes
  // wherever the model has a deletedAt column (Contact, Task); hard-deletes
  // only where it does not.
  { value: 'delete_record', label: 'Delete record', config: ['entity', 'confirm'], modules: ['contact', 'deal', 'task', 'ticket'] },
];

// ── Condition operators ───────────────────────────────────────────────
// `arity` — 'value' needs a right-hand operand, 'none' does not (is empty),
//           'list' takes a comma-separated list the route splits into an array.
// Every operator here is implemented in eventBus.evaluateCondition. The set is
// exported so the route validator and the builder cannot drift from it.
const CONDITION_OPS = [
  { value: 'eq', label: 'is', arity: 'value' },
  { value: 'neq', label: 'is not', arity: 'value' },
  { value: 'contains', label: 'contains', arity: 'value' },
  { value: 'icontains', label: 'contains (ignore case)', arity: 'value' },
  { value: 'startsWith', label: 'starts with', arity: 'value' },
  { value: 'endsWith', label: 'ends with', arity: 'value' },
  { value: 'gt', label: 'greater than', arity: 'value' },
  { value: 'gte', label: 'at least', arity: 'value' },
  { value: 'lt', label: 'less than', arity: 'value' },
  { value: 'lte', label: 'at most', arity: 'value' },
  { value: 'in', label: 'is any of', arity: 'list' },
  { value: 'nin', label: 'is none of', arity: 'list' },
  // Previously implemented in the engine but absent from the builder's
  // operator list, so unreachable from the UI.
  { value: 'exists', label: 'is not empty', arity: 'none' },
  { value: 'not_exists', label: 'is empty', arity: 'none' },
  // Relative-date operators. `value` is a whole number of days.
  { value: 'date_within_next', label: 'is within the next (days)', arity: 'value' },
  { value: 'date_within_past', label: 'is within the past (days)', arity: 'value' },
  { value: 'date_before', label: 'is before (days from now)', arity: 'value' },
  { value: 'date_after', label: 'is after (days from now)', arity: 'value' },
  // Change-tracking operators. These read the `previous` sub-object that
  // update emitters now attach to their payloads, which is what makes
  // "stage changed from Proposal to Won" expressible at last.
  { value: 'changed', label: 'has changed', arity: 'none' },
  { value: 'changed_to', label: 'changed to', arity: 'value' },
  { value: 'changed_from', label: 'changed from', arity: 'value' },
];

const CONDITION_OP_VALUES = CONDITION_OPS.map((op) => op.value);
const LIST_OPS = new Set(CONDITION_OPS.filter((op) => op.arity === 'list').map((op) => op.value));
const NO_VALUE_OPS = new Set(CONDITION_OPS.filter((op) => op.arity === 'none').map((op) => op.value));

// ── Mutable entities ──────────────────────────────────────────────────
// Which Prisma model an entity name maps to, which payload key carries its
// id, which column holds its owner, and which fields update_field may write.
// The allow-list is the security boundary: without it `update_field` would be
// an arbitrary-column-write primitive against any authenticated user's rule.
const WORKFLOW_ENTITIES = {
  contact: {
    model: 'contact',
    idKey: 'contactId',
    assigneeField: 'assignedToId',
    labelField: 'name',
    softDelete: true,
    mutableFields: new Set(['name', 'email', 'phone', 'company', 'title', 'status', 'source', 'assignedToId', 'aiScore', 'subBrand']),
  },
  deal: {
    model: 'deal',
    idKey: 'dealId',
    assigneeField: 'ownerId',
    labelField: 'title',
    softDelete: true,
    mutableFields: new Set(['title', 'amount', 'currency', 'probability', 'stage', 'expectedClose', 'lostReason', 'ownerId']),
  },
  task: {
    model: 'task',
    idKey: 'taskId',
    assigneeField: 'userId',
    labelField: 'title',
    softDelete: true,
    mutableFields: new Set(['title', 'dueDate', 'status', 'priority', 'notes', 'userId', 'type', 'outcome']),
  },
  ticket: {
    model: 'ticket',
    idKey: 'ticketId',
    assigneeField: 'assigneeId',
    labelField: 'subject',
    softDelete: false,
    mutableFields: new Set(['subject', 'description', 'status', 'priority', 'assigneeId']),
  },
};

// ── Condition field catalogue ─────────────────────────────────────────
// Drives the builder's field dropdown. `type` lets the UI pick the right
// input widget and lets the route reject a date operator on a string field.
const FIELD_OPTIONS = {
  contact: [
    { value: 'contactId', label: 'Contact ID', type: 'number' },
    { value: 'name', label: 'Name', type: 'string' },
    { value: 'email', label: 'Email', type: 'string' },
    { value: 'phone', label: 'Phone', type: 'string' },
    { value: 'company', label: 'Company', type: 'string' },
    { value: 'title', label: 'Job title', type: 'string' },
    { value: 'status', label: 'Status', type: 'string' },
    { value: 'source', label: 'Source', type: 'string' },
    { value: 'tags', label: 'Tags', type: 'string' },
    { value: 'aiScore', label: 'AI score', type: 'number' },
    { value: 'assignedToId', label: 'Owner (user ID)', type: 'number' },
    { value: 'firstTouchSource', label: 'First touch source', type: 'string' },
    { value: 'lastTouchSource', label: 'Last touch source', type: 'string' },
    { value: 'callifiedLeadStatus', label: 'Callified lead status', type: 'string' },
    { value: 'callifiedLeadStatusReason', label: 'Callified status reason', type: 'string' },
    { value: 'externalId', label: 'External ID', type: 'string' },
    { value: 'metaLeadgenId', label: 'Meta leadgen ID', type: 'string' },
    { value: 'metaSignal', label: 'Meta signal', type: 'string' },
    { value: 'metaIsJunk', label: 'Meta: is junk', type: 'boolean' },
    { value: 'metaIsQualified', label: 'Meta: is qualified', type: 'boolean' },
    { value: 'changedFields', label: 'Changed fields', type: 'string' },
    { value: 'createdAt', label: 'Created date', type: 'date' },
  ],
  deal: [
    { value: 'dealId', label: 'Deal ID', type: 'number' },
    { value: 'title', label: 'Title', type: 'string' },
    { value: 'amount', label: 'Amount', type: 'number' },
    { value: 'currency', label: 'Currency', type: 'string' },
    { value: 'stage', label: 'Stage', type: 'string' },
    { value: 'probability', label: 'Probability', type: 'number' },
    // These two were carried on the deal.stage_changed payload all along but
    // were absent from the builder's field list, which is why "stage changed
    // from X to Y" was impossible to express in the UI.
    { value: 'fromStage', label: 'Previous stage', type: 'string' },
    { value: 'toStage', label: 'New stage', type: 'string' },
    { value: 'lostReason', label: 'Lost reason', type: 'string' },
    { value: 'expectedClose', label: 'Expected close date', type: 'date' },
    { value: 'contactId', label: 'Contact ID', type: 'number' },
    { value: 'ownerId', label: 'Owner (user ID)', type: 'number' },
    { value: 'userId', label: 'Acting user ID', type: 'number' },
  ],
  task: [
    { value: 'taskId', label: 'Task ID', type: 'number' },
    { value: 'title', label: 'Title', type: 'string' },
    { value: 'status', label: 'Status', type: 'string' },
    { value: 'priority', label: 'Priority', type: 'string' },
    { value: 'type', label: 'Type', type: 'string' },
    { value: 'outcome', label: 'Outcome', type: 'string' },
    { value: 'dueDate', label: 'Due date', type: 'date' },
    { value: 'contactId', label: 'Contact ID', type: 'number' },
    { value: 'userId', label: 'Assignee (user ID)', type: 'number' },
  ],
  ticket: [
    { value: 'ticketId', label: 'Ticket ID', type: 'number' },
    { value: 'subject', label: 'Subject', type: 'string' },
    { value: 'description', label: 'Description', type: 'string' },
    { value: 'status', label: 'Status', type: 'string' },
    { value: 'priority', label: 'Priority', type: 'string' },
    { value: 'contactId', label: 'Contact ID', type: 'number' },
    { value: 'assigneeId', label: 'Assignee (user ID)', type: 'number' },
  ],
  invoice: [
    { value: 'invoiceId', label: 'Invoice ID', type: 'number' },
    { value: 'invoiceNum', label: 'Invoice number', type: 'string' },
    { value: 'status', label: 'Status', type: 'string' },
    { value: 'amount', label: 'Amount', type: 'number' },
    { value: 'dueDate', label: 'Due date', type: 'date' },
    { value: 'daysOverdue', label: 'Days overdue', type: 'number' },
    { value: 'contactId', label: 'Contact ID', type: 'number' },
    { value: 'dealId', label: 'Deal ID', type: 'number' },
  ],
  payment: [
    { value: 'paymentId', label: 'Payment ID', type: 'number' },
    { value: 'invoiceId', label: 'Invoice ID', type: 'number' },
    { value: 'contactId', label: 'Contact ID', type: 'number' },
    { value: 'amount', label: 'Amount', type: 'number' },
    { value: 'currency', label: 'Currency', type: 'string' },
    { value: 'status', label: 'Status', type: 'string' },
    { value: 'method', label: 'Method', type: 'string' },
  ],
  lead: [
    { value: 'contactId', label: 'Lead ID', type: 'number' },
    { value: 'name', label: 'Name', type: 'string' },
    { value: 'email', label: 'Email', type: 'string' },
    { value: 'phone', label: 'Phone', type: 'string' },
    { value: 'company', label: 'Company', type: 'string' },
    { value: 'source', label: 'Source', type: 'string' },
    { value: 'status', label: 'Status', type: 'string' },
    { value: 'tags', label: 'Tags', type: 'string' },
    { value: 'aiScore', label: 'AI score', type: 'number' },
    { value: 'assignedToId', label: 'Owner (user ID)', type: 'number' },
  ],
  approval: [
    { value: 'approvalId', label: 'Approval ID', type: 'number' },
    { value: 'entity', label: 'Entity', type: 'string' },
    { value: 'entityId', label: 'Entity ID', type: 'number' },
    { value: 'status', label: 'Status', type: 'string' },
    { value: 'reason', label: 'Reason', type: 'string' },
    { value: 'requesterId', label: 'Requester (user ID)', type: 'number' },
  ],
};

const TRIGGER_VALUES = TRIGGER_TYPES.map((t) => t.value);
const ACTION_VALUES = ACTION_TYPES.map((a) => a.value);
const SCHEDULED_TRIGGERS = new Set(
  TRIGGER_TYPES.filter((t) => t.kind === 'scheduled').map((t) => t.value),
);

/** Triggers safe to advertise: those with a real emit site. */
function publicTriggers() {
  return TRIGGER_TYPES.filter((t) => t.emitted !== false);
}

/** Actions offered for a module (null `modules` = every module). */
function actionsForModule(module) {
  return ACTION_TYPES.filter((a) => !a.modules || a.modules.includes(module));
}

/** Triggers offered for a module. `module: '*'` entries appear everywhere. */
function triggersForModule(module) {
  return publicTriggers().filter((t) => t.module === module || t.module === '*');
}

function isScheduledTrigger(triggerType) {
  return SCHEDULED_TRIGGERS.has(triggerType);
}

module.exports = {
  MODULES,
  TRIGGER_TYPES,
  ACTION_TYPES,
  CONDITION_OPS,
  CONDITION_OP_VALUES,
  LIST_OPS,
  NO_VALUE_OPS,
  WORKFLOW_ENTITIES,
  FIELD_OPTIONS,
  TRIGGER_VALUES,
  ACTION_VALUES,
  SCHEDULED_TRIGGERS,
  publicTriggers,
  actionsForModule,
  triggersForModule,
  isScheduledTrigger,
};
