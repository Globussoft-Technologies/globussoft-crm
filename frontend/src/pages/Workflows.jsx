import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Check,
  CreditCard,
  ChevronDown,
  Copy,
  FileText,
  GripVertical,
  Mail,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Tag as TagIcon,
  Timer,
  UserCheck,
  Trash2,
  Users,
  Webhook,
  X,
} from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

const MODULES = [
  { value: "contact", label: "Contacts", icon: Users },
  { value: "deal", label: "Deals", icon: Activity },
  { value: "task", label: "Tasks", icon: Check },
  { value: "ticket", label: "Tickets", icon: Activity },
  { value: "invoice", label: "Invoices", icon: FileText },
  { value: "payment", label: "Payments", icon: CreditCard },
  { value: "lead", label: "Leads", icon: UserCheck },
  { value: "approval", label: "Approvals", icon: ShieldCheck },
];

const TEMPLATE_CATEGORIES = [
  { value: "all", label: "All templates" },
  { value: "get_started", label: "Get started" },
  { value: "qualify_leads", label: "Qualify leads" },
  { value: "close_deals", label: "Close deals" },
  { value: "increase_productivity", label: "Increase productivity" },
];

// Templates. Every card below now carries a real, runnable configuration —
// trigger, conditions AND a filled-in action. Previously only the junk-lead
// card did: the other fourteen set nothing but `{module, action}`, so "Use
// template" dropped you into a blank action with no conditions, which is not
// what a template is.
const TEMPLATES = [
  {
    name: "Junk Lead Suppression to Meta",
    category: "qualify_leads",
    module: "contact",
    triggerType: "contact.created_or_updated",
    execution: "once",
    description: "Notify Meta when a lead is identified as junk so future campaign data can be improved.",
    groups: [
      {
        name: "Identify junk leads",
        match: "any",
        clauses: [
          { entity: "contact", field: "tags", op: "icontains", value: "junk" },
          { entity: "contact", field: "status", op: "eq", value: "Junk" },
          { entity: "contact", field: "callifiedLeadStatus", op: "eq", value: "junk" },
        ],
      },
      {
        name: "Require Meta lead ID",
        match: "all",
        clauses: [{ entity: "contact", field: "metaLeadgenId", op: "exists", value: true }],
      },
    ],
    actions: [{
      type: "send_webhook",
      config: {
        url: "https://globussoft.ai/wp-json/junk-suppression/v1/webhook",
        method: "POST",
        encoding: "json",
        bodyMode: "advanced",
        bodyTemplate: JSON.stringify({
          event: "junk_lead",
          contact_id: "{{contactId}}",
          meta_leadgen_id: "{{metaLeadgenId}}",
          external_id: "{{externalId}}",
          name: "{{name}}",
          email: "{{email}}",
          phone: "{{phone}}",
          source: "{{source}}",
          tags: "{{tags}}",
          status: "{{status}}",
          callified_lead_status: "{{callifiedLeadStatus}}",
          callified_lead_status_reason: "{{callifiedLeadStatusReason}}",
          meta_signal: "{{metaSignal}}",
        }, null, 2),
      },
    }],
  },
  {
    name: "Send welcome email to new leads",
    category: "get_started",
    module: "contact",
    triggerType: "contact.created",
    execution: "once",
    description: "Greet every new lead the moment they enter the CRM.",
    groups: [{ name: "Has an email address", match: "all", clauses: [{ entity: "contact", field: "email", op: "exists", value: true }] }],
    actions: [{
      type: "send_email",
      config: {
        to: "{{email}}",
        subject: "Thanks for getting in touch, {{name}}",
        body: "Hi {{name}},\n\nThanks for reaching out. A member of our team will be in touch shortly.\n\nBest regards,\nThe team",
      },
    }],
  },
  {
    name: "Set reminder to call new website leads",
    category: "get_started",
    module: "contact",
    triggerType: "contact.created",
    execution: "once",
    description: "Create a same-day call-back task for every lead that arrives from the website.",
    groups: [{ name: "Came from the website", match: "any", clauses: [
      { entity: "contact", field: "source", op: "icontains", value: "web" },
      { entity: "contact", field: "source", op: "eq", value: "Organic" },
    ] }],
    actions: [{ type: "create_task", config: { title: "Call new website lead: {{name}}", dueInDays: 0, priority: "High", taskType: "Call" } }],
  },
  {
    name: "Add deal for qualified leads",
    category: "get_started",
    module: "contact",
    triggerType: "contact.updated",
    execution: "once",
    description: "Open a deal automatically the moment a lead is marked as qualified.",
    groups: [{ name: "Lead became a prospect", match: "all", clauses: [{ entity: "contact", field: "status", op: "changed_to", value: "Prospect" }] }],
    actions: [{ type: "create_deal", config: { title: "{{name}} — new opportunity", stage: "lead", amount: "0", expectedCloseInDays: 30 } }],
  },
  {
    name: "Follow up on new deals",
    category: "close_deals",
    module: "deal",
    triggerType: "deal.created",
    execution: "once",
    description: "Give every new deal an owner task two days out so nothing goes quiet.",
    groups: [{ name: "", match: "all", clauses: [] }],
    actions: [{ type: "create_task", config: { title: "Follow up on {{title}}", dueInDays: 2, priority: "Medium", taskType: "Follow Up" } }],
  },
  {
    name: "Notify your team when deals are won",
    category: "close_deals",
    module: "deal",
    triggerType: "deal.won",
    execution: "every",
    description: "Celebrate closed business — notify the deal owner as soon as a deal is won.",
    groups: [{ name: "", match: "all", clauses: [] }],
    actions: [{ type: "send_notification", config: { title: "Deal won: {{title}}", message: "{{title}} closed at {{amount}}. Nice work!" } }],
  },
  {
    name: "Notify your team when deals are lost",
    category: "close_deals",
    module: "deal",
    triggerType: "deal.lost",
    execution: "every",
    description: "Capture the reason a deal was lost while it is still fresh.",
    groups: [{ name: "", match: "all", clauses: [] }],
    actions: [{ type: "send_notification", config: { title: "Deal lost: {{title}}", message: "{{title}} was marked lost. Reason: {{lostReason}}" } }],
  },
  {
    name: "Change contact status to Interested",
    category: "qualify_leads",
    module: "contact",
    triggerType: "contact.updated",
    execution: "every",
    description: "Promote a lead to Prospect once its AI score clears the qualification bar.",
    groups: [{ name: "High intent", match: "all", clauses: [
      { entity: "contact", field: "aiScore", op: "gte", value: "70" },
      { entity: "contact", field: "status", op: "eq", value: "Lead" },
    ] }],
    actions: [{ type: "update_field", config: { entity: "contact", field: "status", value: "Prospect" } }],
  },
  {
    name: "Follow up on cold leads",
    category: "qualify_leads",
    module: "contact",
    scheduled: true,
    triggerType: "schedule.date_field",
    execution: "once",
    description: "Chase leads that were created 14 days ago and never progressed past Lead.",
    scheduleConfig: { mode: "date_field", entity: "contact", field: "createdAt", offsetDays: 14, timeOfDay: "09:00", lookbackDays: 2, maxRecords: 500 },
    groups: [{ name: "Still a lead", match: "all", clauses: [{ entity: "contact", field: "status", op: "eq", value: "Lead" }] }],
    actions: [{ type: "create_task", config: { title: "Cold lead check-in: {{name}}", dueInDays: 1, priority: "Medium", taskType: "Call" } }],
  },
  {
    name: "Notify your team about new leads",
    category: "qualify_leads",
    module: "contact",
    triggerType: "contact.created",
    execution: "once",
    description: "Ping the lead owner as soon as a new lead lands.",
    groups: [{ name: "", match: "all", clauses: [] }],
    actions: [{ type: "send_notification", config: { title: "New lead: {{name}}", message: "{{name}} ({{email}}) arrived from {{source}}." } }],
  },
  {
    name: "Start customer onboarding after deal closure",
    category: "close_deals",
    module: "deal",
    triggerType: "deal.won",
    execution: "once",
    description: "Kick off onboarding — tag the account, open a kickoff task, and confirm by email.",
    groups: [{ name: "", match: "all", clauses: [] }],
    actions: [
      { type: "add_tag", config: { tags: "customer, onboarding" } },
      { type: "create_task", config: { title: "Onboarding kickoff: {{title}}", dueInDays: 1, priority: "High", taskType: "Meeting" } },
      { type: "wait", config: { delayMinutes: 1440 } },
      { type: "send_email", config: { subject: "Welcome aboard!", body: "Hi {{name}},\n\nWelcome aboard. Your onboarding call is being scheduled and we will confirm the time shortly.\n\nBest regards,\nThe team" } },
    ],
  },
  {
    name: "Follow up on upcoming contract renewal",
    category: "close_deals",
    module: "deal",
    scheduled: true,
    triggerType: "schedule.date_field",
    execution: "once",
    description: "Remind the deal owner 30 days before a deal's expected close date.",
    scheduleConfig: { mode: "date_field", entity: "deal", field: "expectedClose", offsetDays: -30, timeOfDay: "09:00", lookbackDays: 2, maxRecords: 500 },
    groups: [{ name: "Still open", match: "all", clauses: [{ entity: "deal", field: "stage", op: "nin", value: ["won", "lost"] }] }],
    actions: [{ type: "create_task", config: { title: "Renewal outreach: {{title}}", dueInDays: 0, priority: "High", taskType: "Call" } }],
  },
  {
    name: "Manage contact ownership based on account",
    category: "increase_productivity",
    module: "contact",
    triggerType: "contact.created",
    execution: "once",
    description: "Distribute unowned incoming leads evenly across the team, round-robin.",
    groups: [{ name: "Unassigned", match: "all", clauses: [{ entity: "contact", field: "assignedToId", op: "not_exists", value: true }] }],
    actions: [{ type: "assign_agent", config: { entity: "contact", mode: "round_robin", userIds: [] } }],
  },
  {
    name: "Manage deal ownership based on account",
    category: "increase_productivity",
    module: "deal",
    triggerType: "deal.created",
    execution: "once",
    description: "Give a new deal the same owner as the account it belongs to.",
    groups: [{ name: "", match: "all", clauses: [] }],
    actions: [{ type: "assign_agent", config: { entity: "deal", mode: "record_owner" } }],
  },
  {
    name: "Send LinkedIn connection to new leads",
    category: "increase_productivity",
    module: "contact",
    triggerType: "contact.created",
    execution: "once",
    description: "Push new leads to an outreach automation over a webhook.",
    groups: [{ name: "Has a company", match: "all", clauses: [{ entity: "contact", field: "company", op: "exists", value: true }] }],
    actions: [{
      type: "send_webhook",
      config: {
        url: "", method: "POST", encoding: "json", bodyMode: "advanced",
        bodyTemplate: JSON.stringify({ name: "{{name}}", company: "{{company}}", email: "{{email}}", title: "{{title}}" }, null, 2),
      },
    }],
  },
  {
    name: "Chase overdue invoices",
    category: "increase_productivity",
    module: "invoice",
    triggerType: "invoice.overdue",
    execution: "once",
    description: "Email the customer and open a collections task the day an invoice goes past due.",
    groups: [{ name: "", match: "all", clauses: [] }],
    actions: [
      { type: "send_email", config: { subject: "Invoice {{invoiceNum}} is overdue", body: "Hello,\n\nOur records show invoice {{invoiceNum}} for {{amount}} is now {{daysOverdue}} day(s) past its due date.\n\nIf payment is already on its way, please ignore this note.\n\nThank you." } },
      { type: "create_task", config: { title: "Chase invoice {{invoiceNum}}", dueInDays: 1, priority: "High", taskType: "Call" } },
    ],
  },
  {
    name: "Escalate breached ticket SLAs",
    category: "increase_productivity",
    module: "ticket",
    triggerType: "sla.breached",
    execution: "once",
    description: "Raise the priority and alert the team when a ticket misses its first-response SLA.",
    groups: [{ name: "", match: "all", clauses: [] }],
    actions: [
      { type: "update_field", config: { entity: "ticket", field: "priority", value: "Critical" } },
      { type: "send_notification", config: { title: "SLA breached: {{subject}}", message: "Ticket #{{ticketId}} missed its first-response SLA and has been escalated." } },
    ],
  },
  {
    name: "Weekly review of stalled deals",
    category: "close_deals",
    module: "deal",
    scheduled: true,
    triggerType: "schedule.recurring",
    execution: "every",
    description: "Every Monday at 9am, raise a review task for each open deal worth chasing.",
    scheduleConfig: { mode: "recurring", entity: "deal", frequency: "weekly", dayOfWeek: 1, timeOfDay: "09:00", maxRecords: 200 },
    groups: [{ name: "Open and material", match: "all", clauses: [
      { entity: "deal", field: "stage", op: "nin", value: ["won", "lost"] },
      { entity: "deal", field: "amount", op: "gt", value: "0" },
    ] }],
    actions: [{ type: "create_task", config: { title: "Weekly review: {{title}}", dueInDays: 2, priority: "Medium", taskType: "Follow Up" } }],
  },
  {
    name: "Wish contacts a happy birthday",
    category: "increase_productivity",
    module: "contact",
    scheduled: true,
    triggerType: "schedule.date_field",
    execution: "every",
    description: "Send a greeting on each contact's birthday, every year.",
    scheduleConfig: { mode: "date_field", entity: "contact", field: "birthDate", offsetDays: 0, annual: true, timeOfDay: "09:00", lookbackDays: 1, maxRecords: 500 },
    groups: [{ name: "Has an email address", match: "all", clauses: [{ entity: "contact", field: "email", op: "exists", value: true }] }],
    actions: [{ type: "send_email", config: { to: "{{email}}", subject: "Happy birthday, {{name}}!", body: "Hi {{name}},\n\nWishing you a very happy birthday from all of us.\n\nBest regards,\nThe team" } }],
  },
];

// ── Fallback catalogue ────────────────────────────────────────────────
// The builder pulls the authoritative catalogue from GET /api/workflows/schema
// so it can never advertise a trigger, action or operator the engine does not
// implement — that drift is exactly what left `nin`/`exists` unreachable and
// `invoice.overdue` offered but inert. These constants are the offline
// fallback used until that request resolves (and in unit tests).
const FALLBACK_TRIGGERS = [
  { module: "contact", value: "contact.created_or_updated", label: "When a contact is created or updated" },
  { module: "contact", value: "contact.created", label: "When a contact is created" },
  { module: "contact", value: "contact.updated", label: "When a contact is updated" },
  { module: "deal", value: "deal.created", label: "When a deal is created" },
  // Corrected: fires on update only. It used to read "created or updated",
  // which is what deal.created is for.
  { module: "deal", value: "deal.updated", label: "When a deal is updated" },
  { module: "deal", value: "deal.stage_changed", label: "When a deal stage changes" },
  { module: "deal", value: "deal.won", label: "When a deal is won" },
  { module: "deal", value: "deal.lost", label: "When a deal is lost" },
  { module: "task", value: "task.created", label: "When a task is created" },
  { module: "task", value: "task.completed", label: "When a task is completed" },
  { module: "ticket", value: "ticket.created", label: "When a ticket is created" },
  // Corrected: update-only, same reason as deal.updated.
  { module: "ticket", value: "ticket.updated", label: "When a ticket is updated" },
  { module: "ticket", value: "sla.breached", label: "When a ticket SLA is breached" },
  { module: "invoice", value: "invoice.created", label: "When an invoice is created" },
  { module: "invoice", value: "invoice.paid", label: "When an invoice is paid" },
  { module: "invoice", value: "invoice.completed", label: "When an invoice is completed" },
  { module: "invoice", value: "invoice.voided", label: "When an invoice is voided" },
  { module: "invoice", value: "invoice.refunded", label: "When an invoice is refunded" },
  { module: "invoice", value: "invoice.overdue", label: "When an invoice becomes overdue" },
  { module: "payment", value: "payment.collected", label: "When a payment is collected" },
  // `lead.converted` appeared under BOTH the contact and lead modules, so the
  // same trigger showed up twice in the contact tab. It belongs to leads.
  { module: "lead", value: "lead.converted", label: "When a lead is converted" },
  { module: "approval", value: "approval.created", label: "When an approval is created" },
  { module: "approval", value: "approval.approved", label: "When an approval is approved" },
  { module: "approval", value: "approval.rejected", label: "When an approval is rejected" },
  // Time-based. Offered on every module.
  { module: "*", value: "schedule.date_field", label: "Before / after a date field" },
  { module: "*", value: "schedule.recurring", label: "On a recurring schedule" },
];

const FALLBACK_ACTIONS = [
  { value: "send_email", label: "Send email", icon: Mail },
  { value: "send_sms", label: "Send SMS", icon: Send },
  { value: "send_notification", label: "Send notification", icon: Activity },
  { value: "create_task", label: "Create task", icon: Check },
  { value: "create_appointment", label: "Create appointment", icon: CalendarClock },
  { value: "create_deal", label: "Create deal", icon: Activity },
  { value: "update_field", label: "Update field", icon: Pencil },
  { value: "add_tag", label: "Add tag", icon: TagIcon },
  { value: "remove_tag", label: "Remove tag", icon: TagIcon },
  { value: "assign_agent", label: "Assign owner", icon: Users },
  { value: "add_to_sequence", label: "Add to sales sequence", icon: Send },
  { value: "remove_from_sequence", label: "Remove from sales sequence", icon: Send },
  { value: "send_webhook", label: "Trigger webhook", icon: Webhook },
  { value: "create_approval", label: "Create approval request", icon: ShieldCheck },
  { value: "wait", label: "Wait / delay", icon: Timer },
  { value: "delete_record", label: "Delete record", icon: Trash2 },
];

// Which modules each action is offered for. null = every module. Mirrors
// ACTION_TYPES[].modules in backend/lib/workflowSchema.js.
const FALLBACK_ACTION_MODULES = {
  update_field: ["contact", "deal", "task", "ticket"],
  assign_agent: ["contact", "deal", "task", "ticket"],
  delete_record: ["contact", "deal", "task", "ticket"],
  add_tag: ["contact", "lead"],
  remove_tag: ["contact", "lead"],
  add_to_sequence: ["contact", "lead", "deal"],
  remove_from_sequence: ["contact", "lead", "deal"],
};

// `arity` decides which value input the row renders: none = no operand at all
// (is empty / has changed), list = comma-separated, value = a single operand.
const FALLBACK_OPERATORS = [
  { value: "eq", label: "is", arity: "value" },
  { value: "neq", label: "is not", arity: "value" },
  { value: "contains", label: "contains", arity: "value" },
  { value: "icontains", label: "contains (ignore case)", arity: "value" },
  { value: "startsWith", label: "starts with", arity: "value" },
  { value: "endsWith", label: "ends with", arity: "value" },
  { value: "gt", label: "greater than", arity: "value" },
  { value: "gte", label: "at least", arity: "value" },
  { value: "lt", label: "less than", arity: "value" },
  { value: "lte", label: "at most", arity: "value" },
  { value: "in", label: "is any of", arity: "list" },
  // `nin` and `exists` were implemented in the engine and accepted by the API
  // but missing from this list, so neither was reachable from the builder.
  { value: "nin", label: "is none of", arity: "list" },
  { value: "exists", label: "is not empty", arity: "none" },
  { value: "not_exists", label: "is empty", arity: "none" },
  { value: "date_within_next", label: "is within the next (days)", arity: "value" },
  { value: "date_within_past", label: "is within the past (days)", arity: "value" },
  { value: "date_before", label: "is before (days from now)", arity: "value" },
  { value: "date_after", label: "is after (days from now)", arity: "value" },
  { value: "changed", label: "has changed", arity: "none" },
  { value: "changed_to", label: "changed to", arity: "value" },
  { value: "changed_from", label: "changed from", arity: "value" },
];


const FALLBACK_FIELD_OPTIONS = {
  contact: ["contactId", "name", "email", "phone", "company", "title", "status", "source", "tags", "aiScore", "assignedToId", "firstTouchSource", "lastTouchSource", "callifiedLeadStatus", "callifiedLeadStatusReason", "externalId", "metaLeadgenId", "metaSignal", "metaIsJunk", "metaIsQualified", "changedFields", "createdAt"],
  // fromStage / toStage ride on every deal.stage_changed payload but were
  // absent here, which is why "stage changed from X to Y" could not be built.
  deal: ["dealId", "title", "amount", "currency", "stage", "probability", "fromStage", "toStage", "lostReason", "expectedClose", "contactId", "ownerId", "userId"],
  task: ["taskId", "title", "status", "priority", "type", "outcome", "dueDate", "contactId", "userId"],
  ticket: ["ticketId", "subject", "description", "status", "priority", "contactId", "assigneeId"],
  invoice: ["invoiceId", "invoiceNum", "status", "amount", "dueDate", "daysOverdue", "contactId", "dealId"],
  payment: ["paymentId", "invoiceId", "contactId", "amount", "currency", "status", "method"],
  lead: ["contactId", "name", "email", "phone", "company", "source", "status", "tags", "aiScore", "assignedToId"],
  approval: ["approvalId", "entity", "entityId", "status", "reason", "requesterId"],
};

// Date columns a schedule.date_field rule may anchor to. Mirrors
// SCHEDULE_ENTITIES in backend/lib/workflowSchedule.js.
const FALLBACK_SCHEDULE_DATE_FIELDS = {
  contact: [
    { value: "birthDate", label: "Birthday", annual: true },
    { value: "anniversary", label: "Anniversary", annual: true },
    { value: "createdAt", label: "Created date" },
    { value: "firstResponseDueAt", label: "First response due" },
    { value: "lastEnrichedAt", label: "Last enriched" },
  ],
  deal: [
    { value: "expectedClose", label: "Expected close date" },
    { value: "createdAt", label: "Created date" },
  ],
  task: [
    { value: "dueDate", label: "Due date" },
    { value: "createdAt", label: "Created date" },
  ],
  ticket: [
    { value: "slaResponseDue", label: "SLA response due" },
    { value: "slaResolveDue", label: "SLA resolution due" },
    { value: "createdAt", label: "Created date" },
  ],
};

// -- Live catalogue ---------------------------------------------------
// The FALLBACK_* constants above are a hand-mirror of backend
// lib/workflowSchema.js, and a hand-mirror is exactly what produced the drift
// this feature set out to fix: `nin` and `exists` worked in the engine but
// were missing from the builder's operator list, and `invoice.overdue` was
// offered in the dropdown with no emitter behind it.
//
// So they are only the seed. On mount the builder GETs /api/workflows/schema
// and overwrites this registry with the server's answer, which is derived from
// the same module the engine and the route validator read. The fallback covers
// the first paint, a failed/offline request, and unit tests that render the
// page with no server.
//
// A mutable module-level object rather than context: every consumer is a plain
// helper called during render, and threading a provider through four component
// layers to deliver a value that changes exactly once is not worth it. The
// `schemaVersion` state bump in the page component is what triggers re-render.
const catalogue = {
  triggers: FALLBACK_TRIGGERS,
  actions: FALLBACK_ACTIONS,
  actionModules: FALLBACK_ACTION_MODULES,
  operators: FALLBACK_OPERATORS,
  operatorArity: Object.fromEntries(FALLBACK_OPERATORS.map((op) => [op.value, op.arity])),
  fields: FALLBACK_FIELD_OPTIONS,
  scheduleDateFields: FALLBACK_SCHEDULE_DATE_FIELDS,
};

/**
 * Fold a GET /api/workflows/schema response into the live catalogue.
 *
 * Each section is applied independently and only when it arrives non-empty, so
 * a server that predates one of these keys degrades to the fallback for that
 * section rather than blanking a dropdown.
 */
function applyServerSchema(schema) {
  if (!schema || typeof schema !== "object") return false;

  if (Array.isArray(schema.triggers) && schema.triggers.length) {
    // Entries carry {value, module, kind, label, description}. A null module
    // (the wellness-vertical triggers) matches no module tab, which is the
    // backend's intent: they stay valid on existing rules without being
    // offered in the generic builder.
    catalogue.triggers = schema.triggers;
  }

  if (Array.isArray(schema.actions) && schema.actions.length) {
    // Icons are a purely visual concern the API has no business owning, so
    // they stay local and are matched back on by value. An action the server
    // adds that this build has no icon for still renders, with a neutral one.
    const iconFor = new Map(FALLBACK_ACTIONS.map((action) => [action.value, action.icon]));
    catalogue.actions = schema.actions.map((action) => ({
      value: action.value,
      label: action.label,
      icon: iconFor.get(action.value) || Activity,
    }));
    catalogue.actionModules = Object.fromEntries(
      schema.actions
        .filter((action) => Array.isArray(action.modules) && action.modules.length)
        .map((action) => [action.value, action.modules]),
    );
  }

  if (Array.isArray(schema.operators) && schema.operators.length) {
    catalogue.operators = schema.operators;
    catalogue.operatorArity = Object.fromEntries(schema.operators.map((op) => [op.value, op.arity]));
  }

  if (schema.fields && typeof schema.fields === "object") {
    // Server sends [{value,label,type}]; the builder's dropdowns render bare
    // field names, so flatten to the value list the existing markup expects.
    catalogue.fields = Object.fromEntries(
      Object.entries(schema.fields).map(([module, fields]) => [
        module,
        (Array.isArray(fields) ? fields : []).map((field) => (typeof field === "string" ? field : field.value)),
      ]),
    );
  }

  if (schema.scheduleEntities && typeof schema.scheduleEntities === "object") {
    // Server key is `annualDefault` (a default the author may override); the
    // builder's local shape calls it `annual`.
    catalogue.scheduleDateFields = Object.fromEntries(
      Object.entries(schema.scheduleEntities).map(([entity, value]) => [
        entity,
        (value && Array.isArray(value.dateFields) ? value.dateFields : []).map((field) => ({
          value: field.value,
          label: field.label,
          annual: !!field.annualDefault,
        })),
      ]),
    );
  }

  return true;
}

const scheduleEntityValues = () => Object.keys(catalogue.scheduleDateFields);

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const isScheduleTrigger = (triggerType) => String(triggerType || "").startsWith("schedule.");

const defaultWebhookConfig = (module) => ({
  url: "",
  method: "POST",
  encoding: "json",
  bodyMode: "simple",
  selectedFields: catalogue.fields[module] || [],
  headers: [],
  bodyTemplate: JSON.stringify({
    lead_id: "{{contactId}}",
    classification: "{{status}}",
    tags: "{{tags}}",
    source: "{{source}}",
  }, null, 2),
});

// Mirrors WORKFLOW_ENTITIES[].mutableFields in backend/lib/workflowSchema.js —
// the allow-list update_field is checked against server-side.
const MUTABLE_FIELD_OPTIONS = {
  contact: ["name", "email", "phone", "company", "title", "status", "source", "assignedToId", "aiScore", "subBrand"],
  deal: ["title", "amount", "currency", "probability", "stage", "expectedClose", "lostReason", "ownerId"],
  task: ["title", "dueDate", "status", "priority", "notes", "userId", "type", "outcome"],
  ticket: ["subject", "description", "status", "priority", "assigneeId"],
};

const defaultScheduleConfig = (module) => {
  const entity = catalogue.scheduleDateFields[module] ? module : "contact";
  const field = catalogue.scheduleDateFields[entity][0];
  return {
    mode: "date_field",
    entity,
    field: field.value,
    offsetDays: 0,
    annual: !!field.annual,
    timeOfDay: "09:00",
    lookbackDays: 2,
    maxRecords: 500,
  };
};

const defaultTriggerForModule = (module) => catalogue.triggers.find((trigger) => trigger.module === module)?.value || "contact.created";
// `module: "*"` triggers (the time-based ones) are offered on every module.
const triggersForModule = (module) => catalogue.triggers.filter((trigger) => trigger.module === module || trigger.module === "*");
const actionsForModule = (module) => catalogue.actions.filter((action) => !catalogue.actionModules[action.value] || catalogue.actionModules[action.value].includes(module));
const defaultCondition = (module = "contact") => ({ entity: module, field: "", op: "eq", value: "" });
const defaultGroup = (module = "contact") => ({ name: "", match: "all", clauses: [defaultCondition(module)] });
const operatorArity = (op) => catalogue.operatorArity[op] || "value";

function formatDate(value, fallback = "Not run yet") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleDateString();
}

function formatDateTime(value, fallback = "\u2014") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString();
}

function workflowOrder(workflow) {
  try {
    const targetState = typeof workflow.targetState === "string" ? JSON.parse(workflow.targetState) : workflow.targetState;
    const order = Number(targetState?.order);
    return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
  } catch (_error) {
    return Number.POSITIVE_INFINITY;
  }
}

function emptyRule(template) {
  const selected = template || {};
  return {
    id: null,
    name: selected.name || "Untitled workflow",
    description: selected.description || "",
    module: selected.module || "contact",
    triggerType: selected.triggerType || defaultTriggerForModule(selected.module || "contact"),
    execution: selected.execution || "once",
    groups: selected.groups || [defaultGroup(selected.module || "contact")],
    actions: selected.actions || [{ type: selected.action || "send_email", config: selected.actionConfig || {} }],
    scheduleConfig: selected.scheduleConfig
      || (isScheduleTrigger(selected.triggerType) ? defaultScheduleConfig(selected.module || "contact") : null),
    order: null,
    isActive: false,
    health: null,
  };
}

function fromRule(rule) {
  let target = {};
  try { target = rule.targetState ? JSON.parse(rule.targetState) : {}; } catch { target = {}; }
  let groups = [];
  try {
    const parsed = rule.condition ? JSON.parse(rule.condition) : [];
    groups = parsed?.groups || (Array.isArray(parsed) && parsed.length ? [{ name: "", match: "all", clauses: parsed }] : []);
  } catch { groups = []; }
  return {
    id: rule.id,
    name: rule.name || "Untitled workflow",
    description: target.description || "",
    module: target.module || "contact",
    triggerType: rule.triggerType,
    execution: target.execution || "once",
    groups: groups.length ? groups : [defaultGroup(target.module || "contact")],
    actions: target.actions?.length ? target.actions : [{ type: rule.actionType, config: target }],
    scheduleConfig: parseSchedule(rule.scheduleConfig)
      || (isScheduleTrigger(rule.triggerType) ? defaultScheduleConfig(target.module || "contact") : null),
    // sortOrder is a real column now; targetState.order is the fallback for
    // rules saved before the parity migration backfilled it.
    order: Number.isFinite(Number(rule.sortOrder))
      ? Number(rule.sortOrder)
      : (Number.isFinite(Number(target.order)) ? Number(target.order) : null),
    isActive: !!rule.isActive,
    health: {
      lastRunAt: rule.lastRunAt || null,
      lastError: rule.lastError || null,
      consecutiveFailures: rule.consecutiveFailures || 0,
      autoDisabledAt: rule.autoDisabledAt || null,
      nextScheduledAt: rule.nextScheduledAt || null,
    },
  };
}

function parseSchedule(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function Select({ value, onChange, children, "aria-label": ariaLabel, disabled = false }) {
  return <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="workflow-select">{children}</select>;
}

function ConditionGroup({ group, index, module, updateGroup, removeGroup }) {
  const updateClause = (clauseIndex, patch) => {
    const clauses = group.clauses.map((clause, currentIndex) => currentIndex === clauseIndex ? { ...clause, ...patch } : clause);
    updateGroup(index, { clauses });
  };
  return (
    <div className="workflow-condition-group">
      <div className="workflow-group-head">
        <span className="workflow-group-number">{index + 1}</span>
        <input aria-label={`Condition group ${index + 1} name`} value={group.name} onChange={(event) => updateGroup(index, { name: event.target.value })} placeholder="Add a name for this group of conditions" />
        <label className="workflow-match">Match <b>{group.match === "all" ? "ALL" : "ANY"}</b> conditions
          <input type="checkbox" checked={group.match === "any"} onChange={(event) => updateGroup(index, { match: event.target.checked ? "any" : "all" })} />
          <span className="workflow-switch" />
        </label>
        {index > 0 && <button type="button" className="workflow-icon-button" onClick={() => removeGroup(index)} aria-label={`Remove condition group ${index + 1}`}><Trash2 size={15} /></button>}
      </div>
      {group.clauses.map((clause, clauseIndex) => (
        <div className="workflow-condition-row" key={`${index}-${clauseIndex}`}>
          <Select aria-label={`Condition ${index + 1} entity ${clauseIndex + 1}`} value={clause.entity} onChange={(entity) => updateClause(clauseIndex, { entity, field: "" })}>
            {MODULES.map((module) => <option key={module.value} value={module.value}>{module.label.replace(/s$/, "")}</option>)}
          </Select>
          <Select aria-label={`Condition ${index + 1} field ${clauseIndex + 1}`} value={clause.field} onChange={(field) => updateClause(clauseIndex, { field })}>
            <option value="">Select field</option>{(catalogue.fields[clause.entity] || []).map((field) => <option key={field} value={field}>{field}</option>)}
          </Select>
          <Select aria-label={`Condition ${index + 1} operator ${clauseIndex + 1}`} value={clause.op} onChange={(op) => updateClause(clauseIndex, { op })}>
            {catalogue.operators.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
          </Select>
          {/* "is empty" / "has changed" take no operand, so rendering a value
              box for them invites a value the engine will ignore. */}
          {operatorArity(clause.op) === "none"
            ? <span className="workflow-operator-hint">no value needed</span>
            : <input
              aria-label={`Condition ${index + 1} value ${clauseIndex + 1}`}
              value={Array.isArray(clause.value) ? clause.value.join(", ") : clause.value}
              onChange={(event) => updateClause(clauseIndex, { value: event.target.value })}
              placeholder={operatorArity(clause.op) === "list" ? "Comma-separated values" : "Enter value"}
            />}
          <button type="button" className="workflow-icon-button" onClick={() => updateGroup(index, { clauses: group.clauses.filter((_, currentIndex) => currentIndex !== clauseIndex) })} aria-label={`Remove condition ${clauseIndex + 1}`}><Trash2 size={15} /></button>
          {clauseIndex < group.clauses.length - 1 && <span className="workflow-or">{group.match === "any" ? "OR" : "AND"}</span>}
        </div>
      ))}
      <button type="button" className="workflow-link-button" onClick={() => updateGroup(index, { clauses: [...group.clauses, defaultCondition(module)] })}><Plus size={15} /> Add condition</button>
    </div>
  );
}

function WebhookSettingsModal({ initialConfig, module, workflowId, onSave, onClose }) {
  const notify = useNotify();
  const [draft, setDraft] = useState({ ...defaultWebhookConfig(module), ...initialConfig });
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const update = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const updateHeader = (headerIndex, patch) => update({ headers: draft.headers.map((header, index) => index === headerIndex ? { ...header, ...patch } : header) });
  const testWebhook = async () => {
    if (!draft.url.trim()) { notify.error("Callback URL is required"); return; }
    setTesting(true);
    try {
      const response = await fetchApi("/api/workflows/test-webhook", {
        method: "POST",
        body: JSON.stringify({ config: draft, event: `${module}.updated`, workflowId }),
      });
      notify.success(`Webhook responded with HTTP ${response.result?.status || 200}`);
    } catch (_error) { /* fetchApi already toasted */ }
    finally { setTesting(false); }
  };
  return <div className="workflow-webhook-overlay" onMouseDown={onClose}>
    <div className="workflow-webhook-panel" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Webhook settings">
      <div className="workflow-webhook-head"><h2>WEBHOOK SETTINGS</h2><button type="button" className="workflow-icon-button" onClick={onClose} aria-label="Close webhook settings"><X size={18} /></button></div>
      <div className="workflow-webhook-body">
        <div className="workflow-webhook-help"><b>Configure how this workflow sends the matching CRM record.</b><span>Use placeholders such as <code>{"{{contactId}}"}</code> or <code>{"{{status}}"}</code> in an advanced JSON body.</span></div>
        <label>Request method<Select aria-label="Webhook request method" value={draft.method} onChange={(method) => update({ method })}><option>POST</option><option>PUT</option><option>PATCH</option></Select></label>
        <label>Callback URL<input aria-label="Webhook callback URL" value={draft.url} onChange={(event) => update({ url: event.target.value })} placeholder="https://your-domain.com/meta/lead-feedback" /></label>
        <fieldset><legend>Custom headers</legend>{draft.headers.map((header, headerIndex) => <div className="workflow-webhook-header-row" key={headerIndex}>
          <input aria-label={`Webhook header ${headerIndex + 1} name`} value={header.key || ""} onChange={(event) => updateHeader(headerIndex, { key: event.target.value })} placeholder="X-Webhook-Secret" />
          <input aria-label={`Webhook header ${headerIndex + 1} value`} type={header.secret ? "password" : "text"} value={header.value || ""} onChange={(event) => updateHeader(headerIndex, { value: event.target.value })} placeholder="Header value" />
          <label className="workflow-webhook-secret"><input type="checkbox" checked={!!header.secret} onChange={(event) => updateHeader(headerIndex, { secret: event.target.checked })} /> Secret</label>
          <button type="button" className="workflow-icon-button" onClick={() => update({ headers: draft.headers.filter((_, index) => index !== headerIndex) })} aria-label={`Remove webhook header ${headerIndex + 1}`}><Trash2 size={15} /></button>
        </div>)}<button type="button" className="workflow-link-button" onClick={() => update({ headers: [...draft.headers, { key: "", value: "", secret: true }] })}><Plus size={15} /> Add custom header</button></fieldset>
        <fieldset><legend>Encoding format</legend><div className="workflow-webhook-options">{[["json", "JSON"], ["xml", "XML"], ["form", "Form URL encoded"]].map(([value, label]) => <label key={value}><input type="radio" checked={draft.encoding === value} onChange={() => update({ encoding: value })} /> {label}</label>)}</div></fieldset>
        <fieldset><legend>Request body</legend><div className="workflow-webhook-options"><label><input type="radio" checked={draft.bodyMode === "simple"} onChange={() => update({ bodyMode: "simple" })} /> Simple</label><label><input type="radio" checked={draft.bodyMode === "advanced"} onChange={() => update({ bodyMode: "advanced" })} /> Advanced JSON</label></div>
          {draft.bodyMode === "simple" ? <div className="workflow-webhook-fields">{(catalogue.fields[module] || []).map((field) => <label key={field}><input type="checkbox" checked={(draft.selectedFields || []).includes(field)} onChange={(event) => update({ selectedFields: event.target.checked ? [...(draft.selectedFields || []), field] : (draft.selectedFields || []).filter((item) => item !== field) })} /> {field}</label>)}</div> : <textarea aria-label="Advanced webhook JSON body" value={draft.bodyTemplate || ""} onChange={(event) => update({ bodyTemplate: event.target.value })} rows={10} spellCheck="false" />}
        </fieldset>
      </div>
      <div className="workflow-webhook-footer"><button type="button" className="workflow-secondary" onClick={testWebhook} disabled={testing}>{testing ? "Testing..." : "Test this webhook"}</button><span /><button type="button" className="workflow-secondary" onClick={onClose}>Cancel</button><button type="button" className="workflow-primary" onClick={() => { onSave(draft); onClose(); }}>Save settings</button></div>
    </div>
  </div>;
}

/**
 * ScheduleBuilder — the UI for time-based workflows.
 *
 * Time-based triggers are the half of the Freshsales workflow feature the CRM
 * never had: every trigger was record-event driven, so "3 days before a deal's
 * expected close" or "every Monday at 9am" could not be expressed at all.
 */
function ScheduleBuilder({ schedule, module, onChange }) {
  const config = schedule || defaultScheduleConfig(module);
  const patch = (next) => onChange({ ...config, ...next });
  const entity = catalogue.scheduleDateFields[config.entity] ? config.entity : "contact";
  const fields = catalogue.scheduleDateFields[entity] || [];
  const offset = Number(config.offsetDays) || 0;

  return (
    <div className="workflow-schedule-builder">
      <div className="workflow-trigger-line">
        <span>Run over</span>
        <Select aria-label="Schedule record type" value={entity} onChange={(value) => {
          const first = (catalogue.scheduleDateFields[value] || [])[0];
          patch({ entity: value, field: first?.value, annual: !!first?.annual });
        }}>
          {scheduleEntityValues().map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <span>records</span>
      </div>

      {config.mode === "date_field" ? (
        <>
          <div className="workflow-trigger-line">
            <span>Relative to</span>
            <Select aria-label="Schedule date field" value={config.field || ""} onChange={(value) => {
              const chosen = fields.find((f) => f.value === value);
              patch({ field: value, annual: !!chosen?.annual });
            }}>
              {fields.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
            </Select>
            <input
              aria-label="Schedule offset days"
              type="number"
              value={Math.abs(offset)}
              onChange={(event) => {
                const magnitude = Math.abs(Number(event.target.value) || 0);
                patch({ offsetDays: offset < 0 ? -magnitude : magnitude });
              }}
            />
            <Select aria-label="Schedule offset direction" value={offset < 0 ? "before" : "after"} onChange={(direction) => {
              patch({ offsetDays: direction === "before" ? -Math.abs(offset) : Math.abs(offset) });
            }}>
              <option value="before">day(s) before</option>
              <option value="after">day(s) on / after</option>
            </Select>
          </div>
          <label className="workflow-inline-check">
            <input
              type="checkbox"
              aria-label="Repeat every year"
              checked={!!config.annual}
              onChange={(event) => patch({ annual: event.target.checked })}
            />
            {" "}Repeat every year (match the day and month only &mdash; use this for birthdays and anniversaries)
          </label>
        </>
      ) : (
        <div className="workflow-trigger-line">
          <span>Repeat</span>
          <Select aria-label="Schedule frequency" value={config.frequency || "daily"} onChange={(frequency) => patch({ frequency })}>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
          {config.frequency === "weekly" && <Select aria-label="Schedule day of week" value={String(config.dayOfWeek ?? 1)} onChange={(dayOfWeek) => patch({ dayOfWeek: Number(dayOfWeek) })}>
            {WEEKDAYS.map((day, dayIndex) => <option key={day} value={dayIndex}>{day}</option>)}
          </Select>}
          {config.frequency === "monthly" && <Select aria-label="Schedule day of month" value={String(config.dayOfMonth ?? 1)} onChange={(dayOfMonth) => patch({ dayOfMonth: Number(dayOfMonth) })}>
            {Array.from({ length: 28 }, (_, dayIndex) => dayIndex + 1).map((day) => <option key={day} value={day}>Day {day}</option>)}
          </Select>}
        </div>
      )}

      <div className="workflow-trigger-line">
        <span>at</span>
        <input aria-label="Schedule time of day" value={config.timeOfDay || "09:00"} onChange={(event) => patch({ timeOfDay: event.target.value })} placeholder="HH:MM" />
        <span>and touch at most</span>
        <input aria-label="Schedule max records" type="number" min="1" max="5000" value={config.maxRecords ?? 500} onChange={(event) => patch({ maxRecords: Number(event.target.value) || 500 })} />
        <span>records per run</span>
      </div>
      {config.frequency === "monthly" && <p className="workflow-action-hint">Days are capped at 28 so a month-end rule never skips February.</p>}
    </div>
  );
}

function ActionCard({ action, index, module, workflowId, updateAction, removeAction, pickers }) {
  const [showWebhookSettings, setShowWebhookSettings] = useState(false);
  const selected = catalogue.actions.find((item) => item.value === action.type) || catalogue.actions[0];
  const ActionIcon = selected.icon;
  const config = action.config || {};
  const updateConfig = (key, value) => updateAction(index, { config: { ...config, [key]: value } });
  return (
    <div className="workflow-action-card">
      <div className="workflow-action-row">
        <span className="workflow-group-number">{index + 1}</span>
        <div className="workflow-action-content">
          <div className="workflow-action-title">Action for: {MODULES.find((item) => item.value === module)?.label || "Contacts"} <ChevronDown size={14} /></div>
          <Select aria-label={`Action ${index + 1}`} value={action.type} onChange={(type) => updateAction(index, { type, config: type === "update_field" ? { entity: module } : {} })}>
            {actionsForModule(module).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </Select>
          {(action.type === "send_email" || action.type === "send_sms") && <input aria-label={`Action ${index + 1} recipient`} value={config.to || ""} onChange={(event) => updateConfig("to", event.target.value)} placeholder={action.type === "send_email" ? "Recipient email or record field" : "Recipient phone or record field"} />}
          {action.type === "send_notification" && <input aria-label={`Action ${index + 1} recipient user`} value={config.userId || ""} onChange={(event) => updateConfig("userId", event.target.value)} placeholder="Recipient user ID (optional)" inputMode="numeric" />}
          {/* Email template picker. The action previously accepted only a raw
              subject/body, so every rule duplicated its copy inline and edits
              to a stored template never reached the workflows using it. */}
          {action.type === "send_email" && <Select aria-label={`Action ${index + 1} email template`} value={config.templateId || ""} onChange={(templateId) => updateConfig("templateId", templateId === "" ? "" : Number(templateId))}>
            <option value="">No template &mdash; write it below</option>
            {(pickers?.emailTemplates || []).map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </Select>}
          {action.type === "send_email" && <input aria-label={`Action ${index + 1} subject`} value={config.subject || ""} onChange={(event) => updateConfig("subject", event.target.value)} placeholder={config.templateId ? "Subject (blank uses the template's)" : "Subject"} />}
          {action.type === "send_email" && <input aria-label={`Action ${index + 1} cc`} value={config.cc || ""} onChange={(event) => updateConfig("cc", event.target.value)} placeholder="Cc (comma-separated, optional)" />}
          {action.type === "send_email" && <input aria-label={`Action ${index + 1} bcc`} value={config.bcc || ""} onChange={(event) => updateConfig("bcc", event.target.value)} placeholder="Bcc (comma-separated, optional)" />}
          {action.type === "send_email" && <input aria-label={`Action ${index + 1} from name`} value={config.fromName || ""} onChange={(event) => updateConfig("fromName", event.target.value)} placeholder="From name (optional)" />}
          {(action.type === "send_email" || action.type === "send_sms" || action.type === "send_notification") && <textarea aria-label={`Action ${index + 1} message`} value={config.message || config.body || ""} onChange={(event) => updateConfig(action.type === "send_email" ? "body" : "message", event.target.value)} placeholder="Message or body" rows={2} />}
          {action.type === "create_task" && <input aria-label={`Action ${index + 1} task title`} value={config.title || ""} onChange={(event) => updateConfig("title", event.target.value)} placeholder="Task title" />}
          {action.type === "create_task" && <input aria-label={`Action ${index + 1} task due days`} type="number" min="0" value={config.dueInDays || ""} onChange={(event) => updateConfig("dueInDays", event.target.value === "" ? "" : Number(event.target.value))} placeholder="Due in days (default: 3)" />}
          {action.type === "create_task" && <Select aria-label={`Action ${index + 1} task assignee`} value={config.assignToId || ""} onChange={(assignToId) => updateConfig("assignToId", assignToId === "" ? "" : Number(assignToId))}>
            <option value="">Assignee &mdash; the acting user</option>
            {(pickers?.assignees || []).map((user) => <option key={user.id} value={user.id}>{user.name || user.email}</option>)}
          </Select>}
          {action.type === "create_task" && <Select aria-label={`Action ${index + 1} task priority`} value={config.priority || "Medium"} onChange={(priority) => updateConfig("priority", priority)}>
            {["Low", "Medium", "High", "Critical"].map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>}
          {action.type === "create_task" && <Select aria-label={`Action ${index + 1} task type`} value={config.taskType || "Task"} onChange={(taskType) => updateConfig("taskType", taskType)}>
            {["Task", "Call", "Meeting", "Site Visit", "Follow Up"].map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>}

          {/* Create appointment */}
          {action.type === "create_appointment" && <input aria-label={`Action ${index + 1} appointment title`} value={config.title || ""} onChange={(event) => updateConfig("title", event.target.value)} placeholder="Appointment title" />}
          {action.type === "create_appointment" && <input aria-label={`Action ${index + 1} appointment in days`} type="number" min="0" value={config.inDays ?? ""} onChange={(event) => updateConfig("inDays", event.target.value === "" ? "" : Number(event.target.value))} placeholder="Days from now (default: 1)" />}
          {action.type === "create_appointment" && <input aria-label={`Action ${index + 1} appointment time`} value={config.timeOfDay || ""} onChange={(event) => updateConfig("timeOfDay", event.target.value)} placeholder="Start time HH:MM (e.g. 10:30)" />}
          {action.type === "create_appointment" && <input aria-label={`Action ${index + 1} appointment duration`} type="number" min="5" value={config.durationMinutes ?? ""} onChange={(event) => updateConfig("durationMinutes", event.target.value === "" ? "" : Number(event.target.value))} placeholder="Duration in minutes (default: 30)" />}
          {action.type === "create_appointment" && <input aria-label={`Action ${index + 1} appointment location`} value={config.location || ""} onChange={(event) => updateConfig("location", event.target.value)} placeholder="Location or meeting link (optional)" />}
          {action.type === "create_appointment" && <Select aria-label={`Action ${index + 1} appointment owner`} value={config.assignToId || ""} onChange={(assignToId) => updateConfig("assignToId", assignToId === "" ? "" : Number(assignToId))}>
            <option value="">Owner &mdash; the acting user</option>
            {(pickers?.assignees || []).map((user) => <option key={user.id} value={user.id}>{user.name || user.email}</option>)}
          </Select>}

          {/* Create deal */}
          {action.type === "create_deal" && <input aria-label={`Action ${index + 1} deal title`} value={config.title || ""} onChange={(event) => updateConfig("title", event.target.value)} placeholder="Deal title (supports {{name}})" />}
          {action.type === "create_deal" && <input aria-label={`Action ${index + 1} deal amount`} value={config.amount || ""} onChange={(event) => updateConfig("amount", event.target.value)} placeholder="Amount (default: 0)" />}
          {action.type === "create_deal" && <Select aria-label={`Action ${index + 1} deal stage`} value={config.stage || "lead"} onChange={(stage) => updateConfig("stage", stage)}>
            {["lead", "contacted", "proposal", "won", "lost"].map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>}
          {action.type === "create_deal" && <input aria-label={`Action ${index + 1} deal close in days`} type="number" min="0" value={config.expectedCloseInDays ?? ""} onChange={(event) => updateConfig("expectedCloseInDays", event.target.value === "" ? "" : Number(event.target.value))} placeholder="Expected close in N days (optional)" />}

          {/* Tags */}
          {(action.type === "add_tag" || action.type === "remove_tag") && <input aria-label={`Action ${index + 1} tags`} value={Array.isArray(config.tags) ? config.tags.join(", ") : (config.tags || "")} onChange={(event) => updateConfig("tags", event.target.value)} placeholder="Comma-separated tags, e.g. vip, onboarding" />}

          {/* Sequences */}
          {(action.type === "add_to_sequence" || action.type === "remove_from_sequence") && <Select aria-label={`Action ${index + 1} sequence`} value={config.sequenceId || ""} onChange={(sequenceId) => updateConfig("sequenceId", sequenceId === "" ? "" : Number(sequenceId))}>
            <option value="">{action.type === "remove_from_sequence" ? "Every sequence" : "Select a sequence"}</option>
            {(pickers?.sequences || []).map((sequence) => <option key={sequence.id} value={sequence.id}>{sequence.name}{sequence.isActive ? "" : " (inactive)"}</option>)}
          </Select>}

          {/* Wait */}
          {action.type === "wait" && <input aria-label={`Action ${index + 1} delay minutes`} type="number" min="1" value={config.delayMinutes ?? ""} onChange={(event) => updateConfig("delayMinutes", event.target.value === "" ? "" : Number(event.target.value))} placeholder="Delay in minutes (1440 = 1 day)" />}
          {action.type === "wait" && <p className="workflow-action-hint">Everything below this step runs after the delay. A test run executes the whole chain immediately.</p>}

          {/* Delete record */}
          {action.type === "delete_record" && <label className="workflow-confirm-label">
            <input type="checkbox" aria-label={`Action ${index + 1} delete confirmation`} checked={config.confirm === true} onChange={(event) => updateConfig("confirm", event.target.checked)} />
            {" "}Yes, remove the matching {module} record
          </label>}
          {action.type === "delete_record" && <p className="workflow-action-hint">This cannot be undone from the workflow. Records that support it are soft-deleted.</p>}
          {action.type === "update_field" && <Select aria-label={`Action ${index + 1} field name`} value={config.field || ""} onChange={(field) => updateConfig("field", field)}><option value="">Select field</option>{(MUTABLE_FIELD_OPTIONS[module] || []).map((field) => <option key={field} value={field}>{field}</option>)}</Select>}
          {action.type === "update_field" && <input aria-label={`Action ${index + 1} field value`} value={config.value || ""} onChange={(event) => updateConfig("value", event.target.value)} placeholder="Field value" />}
          {/* Ownership used to be a single hardcoded user ID. Rotation,
              least-busy and inherit-from-account are the Freshsales modes. */}
          {action.type === "assign_agent" && <Select aria-label={`Action ${index + 1} assignment mode`} value={config.mode || "specific"} onChange={(mode) => updateConfig("mode", mode)}>
            <option value="specific">A specific user</option>
            <option value="round_robin">Round-robin across a pool</option>
            <option value="least_busy">The least busy user</option>
            <option value="record_owner">The related contact&apos;s owner</option>
          </Select>}
          {action.type === "assign_agent" && (config.mode || "specific") === "specific" && <Select aria-label={`Action ${index + 1} assignee`} value={config.userId || ""} onChange={(userId) => updateConfig("userId", userId === "" ? "" : Number(userId))}>
            <option value="">Select a user</option>
            {(pickers?.assignees || []).map((user) => <option key={user.id} value={user.id}>{user.name || user.email}</option>)}
          </Select>}
          {action.type === "assign_agent" && ["round_robin", "least_busy"].includes(config.mode) && <label className="workflow-pool-picker">
            <span>Pool (leave empty for the whole team)</span>
            <select multiple aria-label={`Action ${index + 1} assignee pool`} className="workflow-select" value={(config.userIds || []).map(String)} onChange={(event) => updateConfig("userIds", Array.from(event.target.selectedOptions).map((option) => Number(option.value)))}>
              {(pickers?.assignees || []).map((user) => <option key={user.id} value={user.id}>{user.name || user.email}</option>)}
            </select>
          </label>}
          {action.type === "create_approval" && <Select aria-label={`Action ${index + 1} approval entity`} value={config.entity || "Deal"} onChange={(entity) => updateConfig("entity", entity)}><option>Deal</option><option>Contact</option><option>Invoice</option><option>Ticket</option></Select>}
          {action.type === "create_approval" && <input aria-label={`Action ${index + 1} approval reason`} value={config.reasonTemplate || ""} onChange={(event) => updateConfig("reasonTemplate", event.target.value)} placeholder="Reason, e.g. Discount review for {{title}}" />}
          {action.type === "send_webhook" && <input aria-label={`Action ${index + 1} webhook URL`} value={config.url || ""} onChange={(event) => updateConfig("url", event.target.value)} placeholder="https://example.com/webhook" />}
          {action.type === "send_webhook" && <button type="button" className="workflow-link-button" onClick={() => setShowWebhookSettings(true)}><Pencil size={14} /> Edit webhook settings</button>}
        </div>
        <ActionIcon size={18} className="workflow-action-icon" />
        <button type="button" className="workflow-icon-button" onClick={() => removeAction(index)} aria-label={`Remove action ${index + 1}`}><Trash2 size={15} /></button>
      </div>
      {showWebhookSettings && <WebhookSettingsModal initialConfig={config} module={module} workflowId={workflowId} onSave={(nextConfig) => updateAction(index, { config: nextConfig })} onClose={() => setShowWebhookSettings(false)} />}
    </div>
  );
}

export default function Workflows() {
  const notify = useNotify();
  const [view, setView] = useState("all");
  const [templateCategory, setTemplateCategory] = useState("all");
  const [templateSearch, setTemplateSearch] = useState("");
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState(null);
  const [history, setHistory] = useState(null);
  const [openMenu, setOpenMenu] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionStats, setActionStats] = useState({});
  // Email templates, sequences and assignable users for the action config
  // dropdowns. These used to be free-text ID boxes, so configuring an action
  // meant knowing a numeric primary key by heart.
  const [pickers, setPickers] = useState({ emailTemplates: [], sequences: [], assignees: [] });
  // Bumped once the server catalogue lands. `catalogue` is a module-level
  // object (see applyServerSchema), so mutating it does not itself re-render —
  // this counter is what tells React the trigger/action/operator/field lists
  // have been replaced.
  const [, setSchemaVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      // Authoritative trigger/action/operator/field catalogue. A failure here
      // is survivable: the FALLBACK_* constants keep the builder usable, so
      // this resolves to null rather than blocking the whole picker load.
      fetchApi("/api/workflows/schema").catch(() => null),
      fetchApi("/api/workflows/email-templates").catch(() => []),
      fetchApi("/api/workflows/sequences").catch(() => []),
      fetchApi("/api/workflows/assignees").catch(() => []),
    ]).then(([schema, emailTemplates, sequences, assignees]) => {
      if (cancelled) return;
      if (applyServerSchema(schema)) setSchemaVersion((version) => version + 1);
      // Coerce rather than default: `|| []` still lets a non-array response
      // (an error envelope, an unexpected object) through to a `.map` in the
      // action config and take the whole builder down with it. A picker that
      // cannot be populated should render empty, not crash the page.
      const asList = (value) => (Array.isArray(value) ? value : []);
      setPickers({
        emailTemplates: asList(emailTemplates),
        sequences: asList(sequences),
        assignees: asList(assignees),
      });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (openMenu === null) return undefined;
    const closeMenu = (event) => {
      if (!event.target.closest(".workflow-menu-wrap")) setOpenMenu(null);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  const loadWorkflows = async () => {
    setLoading(true);
    try {
      const [itemsResult, statsResult] = await Promise.all([
        fetchApi("/api/workflows"),
        fetchApi("/api/workflows/stats/actions").catch(() => ({})),
      ]);
      const items = itemsResult || [];
      setActionStats(statsResult || {});
      // sortOrder is a real column now; workflowOrder() still reads the legacy
      // targetState.order for rules saved before the parity migration.
      setWorkflows([...items].sort((a, b) => workflowOrder(a) - workflowOrder(b) || a.id - b.id));
    }
    catch (_error) { /* fetchApi already toasted */ }
    finally { setLoading(false); }
  };
  // The loader is intentionally stable for this page lifetime. It no longer
  // closes over `notify`, so exhaustive-deps is satisfied without a suppression.
  useEffect(() => { loadWorkflows(); }, []);

  const filteredWorkflows = useMemo(() => workflows.filter((workflow) => view === "all" || (view === "active" ? workflow.isActive : !workflow.isActive)), [workflows, view]);
  const filteredTemplates = TEMPLATES
    .filter((template) => (templateCategory === "all" || template.category === templateCategory) && template.name.toLowerCase().includes(templateSearch.toLowerCase()))
    .sort((a, b) => Number(a.name === "Junk Lead Suppression to Meta") - Number(b.name === "Junk Lead Suppression to Meta"));

  const save = async (activate, options = {}) => {
    if (!editor.name.trim()) { notify.error("Workflow name is required"); return null; }
    setSaving(true);
    const conditionGroups = editor.groups.map((group) => ({
      ...group,
      clauses: group.clauses
        .filter((clause) => clause.field)
        .map((clause) => (["in", "nin"].includes(clause.op) && typeof clause.value === "string"
          ? { ...clause, value: clause.value.split(",").map((value) => value.trim()).filter(Boolean) }
          : clause)),
    }));
    const actions = editor.actions.map((action) => ["update_field", "assign_agent"].includes(action.type) ? { ...action, config: { ...action.config, entity: action.config.entity || editor.module } } : action);
    const targetState = { module: editor.module, execution: editor.execution, description: editor.description, actions, ...(editor.order !== null ? { order: editor.order } : {}) };
    const payload = {
      name: editor.name.trim(),
      triggerType: editor.triggerType,
      actionType: editor.actions[0]?.type || "send_notification",
      targetState,
      condition: JSON.stringify({ groups: conditionGroups }),
      // null clears a schedule when a rule is converted back to event-driven.
      scheduleConfig: isScheduleTrigger(editor.triggerType) ? (editor.scheduleConfig || defaultScheduleConfig(editor.module)) : null,
    };
    try {
      const saved = editor.id
        ? await fetchApi(`/api/workflows/${editor.id}`, { method: "PUT", body: JSON.stringify({ ...payload, isActive: activate }) })
        : await fetchApi("/api/workflows", { method: "POST", body: JSON.stringify({ ...payload, isActive: activate }) });
      if (!options.silent) notify.success(activate ? "Workflow enabled" : "Workflow saved as draft");
      if (options.keepOpen) setEditor(fromRule(saved));
      else setEditor(null);
      await loadWorkflows();
      return saved;
    } catch (_error) { /* fetchApi already toasted; falls through to return null */ }
    finally { setSaving(false); }
    return null;
  };

  const toggleWorkflow = async (workflow) => {
    try { const updated = await fetchApi(`/api/workflows/${workflow.id}/toggle`, { method: "PUT" }); setWorkflows((items) => items.map((item) => item.id === workflow.id ? updated : item)); }
    catch (_error) { /* fetchApi already toasted */ }
  };
  const deleteWorkflow = async (workflow) => {
    if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return;
    try { await fetchApi(`/api/workflows/${workflow.id}`, { method: "DELETE" }); setWorkflows((items) => items.filter((item) => item.id !== workflow.id)); notify.success("Workflow deleted"); }
    catch (_error) { /* fetchApi already toasted */ }
  };
  const testWorkflow = async (workflow) => {
    try { const response = await fetchApi(`/api/workflows/${workflow.id}/test`, { method: "POST", body: JSON.stringify({}) }); if (response.success) notify.success(response.message || "Workflow test completed"); else notify.error(response.result?.error || response.message || "Workflow test failed"); await loadWorkflows(); }
    catch (_error) { /* fetchApi already toasted */ }
  };
  const testEditor = async () => {
    let workflow = editor;
    if (!workflow.id) {
      const saved = await save(false, { keepOpen: true, silent: true });
      if (!saved) return;
      workflow = saved;
    }
    await testWorkflow(workflow);
  };

  /**
   * Apply a saved workflow to records that already exist.
   *
   * Always previews first: the dry run reports how many records WOULD be
   * affected, and only an explicit confirm actually fires the actions. Nobody
   * should discover the blast radius by emailing four thousand contacts.
   */
  const runNow = async (workflow) => {
    try {
      const preview = await fetchApi(`/api/workflows/${workflow.id}/run-now`, {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      });
      if (!preview?.matched) {
        notify.info(preview?.message || "No existing records match this workflow's conditions.");
        return;
      }
      if (!window.confirm(`${preview.message}\n\nApply it now?`)) return;
      const applied = await fetchApi(`/api/workflows/${workflow.id}/run-now`, {
        method: "POST",
        body: JSON.stringify({ dryRun: false }),
      });
      notify.success(applied?.message || "Workflow applied to existing records");
      await loadWorkflows();
    } catch (_error) { /* fetchApi already toasted */ }
  };

  const reorderWorkflows = async (fromIndex, toIndex) => {
    if (view !== "all" || fromIndex === toIndex) return;
    const next = [...workflows];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setWorkflows(next);
    try {
      await fetchApi("/api/workflows/order", {
        method: "PUT",
        body: JSON.stringify({ workflowIds: next.map((workflow) => workflow.id) }),
      });
    } catch (_error) {
      // fetchApi already toasted — just roll the optimistic reorder back.
      await loadWorkflows();
    }
  };

  if (editor) {
    return <WorkflowEditor editor={editor} setEditor={setEditor} saving={saving} save={save} onTest={testEditor} onCancel={() => setEditor(null)} pickers={pickers} onRunNow={runNow} />;
  }

  if (history) return <HistoryPanel workflow={history} onClose={() => setHistory(null)} />;

  return (
    <div className="workflow-page">
      <div className="workflow-topbar"><div className="workflow-breadcrumb"><b>Workflows</b></div><button className="workflow-primary" onClick={() => setEditor(emptyRule())}><Plus size={17} /> Create workflow</button></div>
      <div className="workflow-layout">
        <aside className="workflow-sidebar">
          <h2>Workflow templates</h2>
          <nav>{TEMPLATE_CATEGORIES.map((category) => <button key={category.value} className={templateCategory === category.value ? "is-selected" : ""} onClick={() => { setTemplateCategory(category.value); setView("templates"); }}><span>{category.label}</span><small>{category.value === "all" ? TEMPLATES.length : TEMPLATES.filter((template) => template.category === category.value).length}</small></button>)}</nav>
          <div className="workflow-status-nav"><h2>Workflows by status</h2>{[["all", "All workflows"], ["active", "Active"], ["inactive", "Inactive"]].map(([value, label]) => <button key={value} className={view === value ? "is-selected" : ""} onClick={() => setView(value)}><span><i className={`workflow-status-dot ${value}`} />{label}</span><small>{value === "all" ? workflows.length : workflows.filter((workflow) => value === "active" ? workflow.isActive : !workflow.isActive).length}</small></button>)}</div>
          <div className="workflow-help"><b>What are workflows?</b><p>Automate repetitive CRM work when records change.</p></div>
        </aside>
        <main className="workflow-main">
          {view === "templates" ? <TemplateGallery search={templateSearch} setSearch={setTemplateSearch} category={templateCategory} templates={filteredTemplates} onUse={(template) => setEditor(emptyRule(template))} onCreate={() => setEditor(emptyRule())} /> : <WorkflowList workflows={filteredWorkflows} actionStats={actionStats} loading={loading} onEdit={(workflow) => setEditor(fromRule(workflow))} onToggle={toggleWorkflow} onDelete={deleteWorkflow} onTest={testWorkflow} onHistory={setHistory} openMenu={openMenu} setOpenMenu={setOpenMenu} view={view} onCreate={() => setEditor(emptyRule())} onReorder={reorderWorkflows} onRunNow={runNow} />}
        </main>
      </div>
    </div>
  );
}

function WorkflowList({ workflows, actionStats, loading, onEdit, onToggle, onDelete, onTest, onHistory, openMenu, setOpenMenu, view, onCreate, onReorder, onRunNow }) {
  const [dragIndex, setDragIndex] = useState(null);
  const canReorder = view === "all";
  const drop = (toIndex) => {
    if (dragIndex === null || dragIndex === toIndex) { setDragIndex(null); return; }
    onReorder(dragIndex, toIndex);
    setDragIndex(null);
  };
  return <>
    <div className="workflow-usage"><Activity size={16} /> <b>{workflows.filter((workflow) => workflow.isActive).length}</b> active workflows.</div>
    <div className="workflow-heading"><div><h1>{view === "active" ? "Active workflows" : view === "inactive" ? "Inactive workflows" : "All workflows"}</h1><p>{view === "inactive" ? "Use the toggle to enable a workflow." : "All your workflows are executed in the order below. Feel free to reorder them."}</p></div></div>
    {loading ? <div className="workflow-empty">Loading workflows...</div> : workflows.length === 0 ? <div className="workflow-empty"><Activity size={42} /><h3>No workflows found</h3><button className="workflow-primary" onClick={onCreate}>Create workflow</button></div> : <div className="workflow-list"><div className="workflow-list-header"><span>ORDER OF EXECUTION</span><span>NAME</span><span>TYPE</span><span>ACTIONS EXECUTED</span></div>{workflows.map((workflow, index) => <div className={`workflow-list-row ${dragIndex === index ? "is-dragging" : ""}`} key={workflow.id} draggable={canReorder} onDragStart={() => canReorder && setDragIndex(index)} onDragOver={(event) => canReorder && event.preventDefault()} onDrop={() => canReorder && drop(index)} onDragEnd={() => setDragIndex(null)}><div className="workflow-order"><GripVertical size={16} /><b>{index + 1}</b><button type="button" className={`workflow-toggle ${workflow.isActive ? "on" : ""}`} onClick={() => onToggle(workflow)} aria-label={`${workflow.isActive ? "Disable" : "Enable"} ${workflow.name}`}><span /></button></div><div className="workflow-name"><button onClick={() => onEdit(workflow)}>{workflow.name}</button><p>{workflow.autoDisabledAt ? "Paused automatically after repeated failures" : workflow.isActive ? (workflow.nextScheduledAt ? `Next run ${formatDateTime(workflow.nextScheduledAt)}` : "Runs when its trigger conditions are met") : "Inactive workflow"}</p><small>Last updated {formatDate(workflow.updatedAt || workflow.createdAt, "\u2014")} \u00b7 Last run {formatDateTime(workflow.lastRunAt, "never")}</small>{workflow.lastError && <small className="workflow-row-error"><AlertTriangle size={12} /> {workflow.lastError}</small>}</div><div className="workflow-type">{workflow.triggerType?.split(".")[0] || "CRM"}</div><div className="workflow-actions-summary"><b>{actionStats[String(workflow.id)] || 0} successful actions</b><span>in the last 7 days.</span><button onClick={() => onHistory(workflow)}>View history <ArrowLeft size={13} /></button></div><div className="workflow-menu-wrap"><button className="workflow-icon-button" onClick={() => setOpenMenu(openMenu === workflow.id ? null : workflow.id)} aria-label={`Actions for ${workflow.name}`}><MoreVertical size={18} /></button>{openMenu === workflow.id && <div className={`workflow-menu ${index >= workflows.length - 2 ? "menu-up" : ""}`}><button onClick={() => onEdit(workflow)}><Pencil size={14} /> Edit</button><button onClick={() => onTest(workflow)}><Play size={14} /> Test workflow</button><button onClick={() => onEdit({ ...workflow, id: null, name: `${workflow.name} copy` })}><Copy size={14} /> Clone</button><button onClick={() => onRunNow(workflow)}><RefreshCw size={14} /> Apply to existing records</button><button onClick={() => onDelete(workflow)}><Trash2 size={14} /> Delete</button></div>}</div></div>)}</div>}
  </>;
}

function TemplateGallery({ search, setSearch, category, templates, onUse, onCreate }) {
  return <div className="workflow-template-main"><div className="workflow-heading"><div><h1>Start by selecting a workflow template</h1><p>Choose a ready-made workflow or create your own.</p></div></div><label className="workflow-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search for a template" /></label><h2>{TEMPLATE_CATEGORIES.find((item) => item.value === category)?.label || "All templates"}</h2><div className="workflow-template-grid">{templates.map((template, index) => <article className="workflow-template-card" key={`${template.name}-${index}`}><div className="workflow-template-icon"><Activity size={21} /></div><h3>{template.name}</h3><button className="workflow-dark-button" onClick={() => onUse(template)}>Use template</button></article>)}</div>{templates.length === 0 && <div className="workflow-empty">No templates match your search.</div>}<div className="workflow-create-footer">Could not find a template which works for you?<button className="workflow-dark-button" onClick={onCreate}>Create your own workflow</button></div></div>;
}

function WorkflowEditor({ editor, setEditor, saving, save, onTest, onCancel, pickers, onRunNow }) {
  const update = (patch) => setEditor((current) => ({ ...current, ...patch }));
  const updateGroup = (index, patch) => update({ groups: editor.groups.map((group, currentIndex) => currentIndex === index ? { ...group, ...patch } : group) });
  const updateAction = (index, patch) => update({ actions: editor.actions.map((action, currentIndex) => currentIndex === index ? { ...action, ...patch } : action) });
  const selectModule = (module) => update({
    module,
    triggerType: defaultTriggerForModule(module),
    scheduleConfig: null,
    groups: editor.groups.map((group) => ({ ...group, clauses: group.clauses.map((clause) => ({ ...clause, entity: module, field: "" })) })),
  });
  // Switching to (or away from) a time-based trigger has to create or clear the
  // schedule, otherwise the rule saves as scheduled with nothing to schedule on
  // and the API rejects it.
  const selectTrigger = (triggerType) => update({
    triggerType,
    scheduleConfig: isScheduleTrigger(triggerType)
      ? (editor.scheduleConfig && editor.scheduleConfig.mode === (triggerType === "schedule.recurring" ? "recurring" : "date_field")
        ? editor.scheduleConfig
        : { ...defaultScheduleConfig(editor.module), mode: triggerType === "schedule.recurring" ? "recurring" : "date_field", ...(triggerType === "schedule.recurring" ? { frequency: "daily" } : {}) })
      : null,
  });
  const scheduled = isScheduleTrigger(editor.triggerType);
  return (
    <div className="workflow-page workflow-editor-page">
      <div className="workflow-editor-topbar">
        <button className="workflow-back" onClick={onCancel}><ArrowLeft size={16} /> Workflows</button>
        <div>
          <button className="workflow-secondary" onClick={onCancel}>Cancel</button>
          <button className="workflow-secondary" onClick={() => save(false)} disabled={saving}>Save as draft</button>
          <button className="workflow-secondary" onClick={onTest} disabled={saving}><Play size={14} /> Test workflow</button>
          {/* Freshsales lets an author backfill a workflow over records that
              already exist; without it a rule only ever affects records touched
              after it was created. Defaults to a dry run. */}
          {editor.id && <button className="workflow-secondary" onClick={() => onRunNow(editor)} disabled={saving}><RefreshCw size={14} /> Apply to existing records</button>}
          <button className="workflow-primary" onClick={() => save(true)} disabled={saving}><Check size={16} /> {saving ? "Saving..." : "Enable"}</button>
        </div>
      </div>
      <div className="workflow-editor-content">
        {/* The auto-disable guard pauses a workflow after repeated failures.
            Saying so here is the difference between "someone turned this off"
            and "this is broken". */}
        {editor.health?.autoDisabledAt && <div className="workflow-alert" role="alert">
          <AlertTriangle size={16} />
          <span>This workflow was paused automatically after {editor.health.consecutiveFailures} consecutive failures. Last error: {editor.health.lastError || "unknown"}. Fix the problem and press Enable to resume it.</span>
        </div>}
        {!editor.health?.autoDisabledAt && editor.health?.lastError && <div className="workflow-alert workflow-alert-warn" role="alert">
          <AlertTriangle size={16} />
          <span>Last run failed: {editor.health.lastError}</span>
        </div>}
        <input className="workflow-title-input" value={editor.name} onChange={(event) => update({ name: event.target.value })} aria-label="Workflow name" />
        <textarea className="workflow-description" value={editor.description} onChange={(event) => update({ description: event.target.value })} placeholder="Add description" aria-label="Workflow description" rows={1} />
        <section>
          <h2>Run this workflow for</h2>
          <div className="workflow-module-buttons">{MODULES.map((module) => <button key={module.value} className={editor.module === module.value ? "is-selected" : ""} onClick={() => selectModule(module.value)}><module.icon size={18} /> {module.label}</button>)}</div>
        </section>
        <section>
          <h2>When to trigger this workflow?</h2>
          <div className="workflow-trigger-line">
            <span>Trigger</span>
            <Select aria-label="Workflow trigger" value={editor.triggerType} onChange={selectTrigger}>{triggersForModule(editor.module).map((trigger) => <option key={trigger.value} value={trigger.value}>{trigger.label}</option>)}</Select>
            <span>and run this workflow</span>
            <Select aria-label="Workflow execution frequency" value={editor.execution} onChange={(execution) => update({ execution })}><option value="once">once for each {editor.module}</option><option value="every">every time conditions match</option></Select>
          </div>
          {scheduled && <ScheduleBuilder schedule={editor.scheduleConfig} module={editor.module} onChange={(scheduleConfig) => update({ scheduleConfig })} />}
        </section>
        <section>
          <h2>What conditions should be met?</h2>
          {editor.groups.map((group, index) => <ConditionGroup key={index} group={group} index={index} module={editor.module} updateGroup={updateGroup} removeGroup={(groupIndex) => update({ groups: editor.groups.filter((_, currentIndex) => currentIndex !== groupIndex) })} />)}
          <button className="workflow-add-group" onClick={() => update({ groups: [...editor.groups, defaultGroup(editor.module)] })}><Plus size={15} /> Add group</button>
        </section>
        <section>
          <h2>What actions should be executed?</h2>
          {editor.actions.map((action, index) => <ActionCard key={index} action={action} index={index} module={editor.module} workflowId={editor.id} pickers={pickers} updateAction={updateAction} removeAction={(actionIndex) => update({ actions: editor.actions.filter((_, currentIndex) => currentIndex !== actionIndex) })} />)}
          <button className="workflow-link-button" onClick={() => update({ actions: [...editor.actions, { type: "send_notification", config: {} }] })}><Plus size={15} /> Add action</button>
        </section>
      </div>
    </div>
  );
}

/**
 * HistoryPanel — per-workflow execution log.
 *
 * Rewritten against GET /api/workflows/history, which now filters server-side.
 * The previous version fetched the last 50 rows for the WHOLE tenant and then
 * filtered them client-side by workflow id, so on any busy tenant clicking
 * "View history" on a real workflow showed "No actions found" — its rows had
 * already been pushed out of the window by other workflows. It also inferred
 * success by regex-testing the raw details JSON for the substring "fail" (so a
 * deal whose lost reason mentioned failure read as a failed execution), and
 * rendered the CONTACT column from `log.contactName`, a field the underlying
 * model has never had. Previous/Next were hardcoded `disabled` and the period
 * dropdown had an empty onChange.
 */
function HistoryPanel({ workflow, onClose }) {
  const PAGE_SIZE = 25;
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("all");
  const [days, setDays] = useState("7");
  const [contactFilter, setContactFilter] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), status, days });
    if (workflow?.id) params.set("workflowId", String(workflow.id));
    if (contactFilter) params.set("contactId", contactFilter);
    fetchApi(`/api/workflows/history?${params.toString()}`)
      .then((data) => {
        if (cancelled) return;
        setLogs(data?.logs || []);
        setTotal(data?.total || 0);
      })
      .catch(() => { if (!cancelled) { setLogs([]); setTotal(0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workflow?.id, offset, status, days, contactFilter]);

  // Reset to the first page whenever a filter changes, or page 3 of the old
  // filter would render as an empty page of the new one.
  const changeFilter = (setter) => (value) => { setOffset(0); setter(value); };

  const contacts = [...new Map(
    logs.filter((log) => log.contactId).map((log) => [log.contactId, log.contactLabel || `Contact #${log.contactId}`]),
  ).entries()];

  const statusLabel = (value) => (value === "SUCCESS" ? "Successful" : value === "FAILED" ? "Failed" : "Skipped");

  return <div className="workflow-history-overlay"><div className="workflow-history-panel">
    <div className="workflow-history-head"><h2>ACTION HISTORY</h2><button className="workflow-icon-button" onClick={onClose} aria-label="Close history"><X size={18} /></button></div>
    <div className="workflow-history-meta">
      <div className="workflow-history-name">Workflow name<br /><b>{workflow.name}</b></div>
      <div className="workflow-history-filters">
        <div>Showing: {[["all", "All actions"], ["failed", "Failed actions"], ["success", "Successful actions"]].map(([value, label]) => (
          <label key={value}><input type="radio" name="workflow-history-status" checked={status === value} onChange={() => changeFilter(setStatus)(value)} /> {label}</label>
        ))}</div>
        <Select aria-label="History period" value={days} onChange={changeFilter(setDays)}>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Select>
      </div>
      <label className="workflow-contact-filter">Filter by contact
        <Select aria-label="Filter by contact" value={contactFilter} onChange={changeFilter(setContactFilter)}>
          <option value="">All contacts</option>
          {contacts.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Select>
      </label>
    </div>
    <div className="workflow-history-table">
      <div className="workflow-list-header"><span>ACTION</span><span>TRIGGERED ON</span><span>STATUS</span><span>RECORD</span></div>
      {loading ? <div className="workflow-empty">Loading history...</div>
        : logs.length === 0 ? <div className="workflow-empty">No actions found.</div>
          : logs.map((log) => <div className="workflow-history-row" key={log.id}>
            <div><b>{log.actionType}</b><small>{log.triggerType}{log.durationMs != null ? ` \u00b7 ${log.durationMs}ms` : ""}{log.isTest ? " \u00b7 test run" : ""}</small>{log.error && <small className="workflow-row-error">{log.error}</small>}</div>
            <span>{formatDateTime(log.createdAt)}</span>
            <span className={`workflow-history-status is-${String(log.status || "").toLowerCase()}`}>{statusLabel(log.status)}</span>
            <span>{log.contactLabel || log.recordKey || "\u2014"}</span>
          </div>)}
    </div>
    <div className="workflow-history-footer">
      <button className="workflow-history-page-button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
      <span>{total === 0 ? "0 actions" : `${offset + 1}\u2013${Math.min(offset + logs.length, total)} of ${total}`}</span>
      <button className="workflow-history-page-button" disabled={offset + logs.length >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
      <button className="workflow-secondary workflow-history-close" onClick={onClose}>Close</button>
    </div>
  </div></div>;
}
