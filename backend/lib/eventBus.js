const EventEmitter = require("events");
const path = require("path");
// Mirror server.js — try root .env then backend/.env with override.
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });
const prisma = require("./prisma");
const { sendSms, resolveProviderConfig } = require("../services/smsProvider");
// Shared vocabulary (triggers / actions / operators / mutable entities) and the
// implementations for the actions added in the parity wave. Neither module
// requires eventBus, so there is no cycle.
const workflowSchema = require("./workflowSchema");
const workflowActions = require("./workflowActions");

const bus = new EventEmitter();
bus.setMaxListeners(100);

// Defensive guard rails for misconfigured automation rules that would otherwise
// emit events in a tight cascade and exhaust memory / CPU. Both are opt-out via
// env (set to 0 to disable).
const MAX_EVENT_CHAIN_DEPTH = (() => {
  const v = parseInt(process.env.WORKFLOW_MAX_EVENT_CHAIN_DEPTH, 10);
  return Number.isFinite(v) && v >= 0 ? v : 10;
})();

// Global io reference for routes to emit events with socket.io support
let globalIo = null;

// ── Travel payment admin notification listener ─────────────────────
// Fires on every payment.collected event that carries a travel reference
// (quote advance, milestone, or full travel-invoice payment) and notifies
// all ADMIN/MANAGER users in the tenant.
const { notifyMany } = require("./notificationService");

bus.on("payment.collected", async ({ payload, tenantId }) => {
  try {
    const quoteId = payload.quoteId ? Number(payload.quoteId) : null;
    const travelInvoiceId = payload.travelInvoiceId ? Number(payload.travelInvoiceId) : null;
    if (!quoteId && !travelInvoiceId) return; // not a travel payment

    const staff = await prisma.user.findMany({
      where: { tenantId, role: { in: ["ADMIN", "MANAGER"] } },
      select: { id: true },
    });
    const userIds = staff.map((u) => u.id);
    if (!userIds.length) return;

    const amount = Number(payload.amount || 0);
    const currency = payload.currency || "INR";
    const paidText = amount > 0 ? `${currency} ${amount.toLocaleString("en-IN")}` : `${currency} (amount unknown)`;

    let title, message, link;
    if (travelInvoiceId) {
      const inv = await prisma.travelInvoice.findFirst({
        where: { id: travelInvoiceId, tenantId },
        select: { invoiceNum: true },
      });
      const invNum = inv?.invoiceNum || `#${travelInvoiceId}`;
      title = `Payment received for invoice ${invNum}`;
      message = `A Razorpay payment of ${paidText} was received against invoice ${invNum}.`;
      link = `/travel/invoices/${travelInvoiceId}`;
    } else {
      title = `Advance payment received for quote #${quoteId}`;
      message = `A Razorpay payment of ${paidText} was received as advance for quote #${quoteId}.`;
      link = `/travel/quotes/${quoteId}`;
    }

    await notifyMany({
      userIds,
      tenantId,
      title,
      message,
      type: "success",
      link,
      entityType: "Payment",
      entityId:
        payload.paymentId && !Number.isNaN(Number(payload.paymentId))
          ? Number(payload.paymentId)
          : null,
      category: "payment",
    });
  } catch (e) {
    console.error("[eventBus] travel payment notification listener failed:", e.message);
  }
});

function setIO(io) {
  globalIo = io;
}

function getIO() {
  return globalIo;
}

// SendGrid email sending (same pattern as communications.js)
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";

/**
 * Split "a@x.com, b@y.com" into SendGrid's [{email}] shape.
 * Returns undefined for empty input so the key is omitted from the payload —
 * SendGrid rejects an empty cc/bcc array outright.
 */
function toRecipientList(raw) {
  if (!raw) return undefined;
  const list = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((email) => ({ email }));
  return list.length ? list : undefined;
}

async function sendSendGrid(to, subject, body, options = {}) {
  if (!SENDGRID_API_KEY) {
    console.log(`[WorkflowEngine] SendGrid not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }

  const htmlBody = body.replace(/\n/g, "<br>");
  // cc / bcc / fromName were not expressible before: the action only ever
  // accepted to/subject/body, so a rule could not copy a manager on a
  // notification or send under a human-looking sender name.
  const personalization = { to: [{ email: to }] };
  const cc = toRecipientList(options.cc);
  const bcc = toRecipientList(options.bcc);
  if (cc) personalization.cc = cc;
  if (bcc) personalization.bcc = bcc;

  const payload = {
    personalizations: [personalization],
    from: options.fromName ? { email: FROM_EMAIL, name: options.fromName } : { email: FROM_EMAIL },
    subject: subject,
    content: [
      { type: "text/plain", value: body },
      { type: "text/html", value: htmlBody }
    ]
  };

  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const messageId = response.headers.get("x-message-id") || "sent";
      console.log(`[WorkflowEngine] Email sent to ${to}: ${messageId}`);
      return { sent: true, id: messageId };
    } else {
      const err = await response.text();
      console.error(`[WorkflowEngine] SendGrid error (${response.status}):`, err);
      return { sent: false, reason: err };
    }
  } catch (err) {
    console.error("[WorkflowEngine] Email send error:", err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * #20 — Resolve a dot-path field name against an event payload.
 * Most existing emitEvent callers FLATTEN the payload (e.g. {dealId, amount, …}),
 * but new callers may nest ({deal: {amount}}). We try the nested path first,
 * then fall back to the trailing segment on a flat payload.
 *
 * Example: lookupField("deal.amount", {deal:{amount:1000}}) → 1000
 *          lookupField("deal.amount", {dealId: 42, amount: 1000}) → 1000
 */
function lookupField(path, payload) {
  if (payload == null || typeof payload !== "object") return undefined;
  const parts = String(path).split(".");
  // 1. Nested walk.
  let cur = payload;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") {
      cur = undefined;
      break;
    }
    cur = cur[p];
  }
  if (cur !== undefined) return cur;
  // 2. Flat fallback — the last segment of the dot-path.
  const last = parts[parts.length - 1];
  if (last in payload) return payload[last];
  return undefined;
}

/**
 * #20 — Evaluate a JSON-encoded condition array against an event payload.
 * Returns true (fire the action) when:
 *   - condition is empty/null  → backwards-compat with pre-#20 rules
 *   - every clause matches     → AND semantics
 * Returns false on:
 *   - malformed JSON  → log and refuse to fire (fail-closed)
 *   - any clause that fails or has an unknown operator
 *
 * Operators: eq, neq, gt, gte, lt, lte, in, nin, contains, startsWith.
 */
function evaluateCondition(conditionJson, payload) {
  if (conditionJson == null || conditionJson === "") return true;

  let clauses;
  try {
    clauses = JSON.parse(conditionJson);
  } catch (e) {
    console.warn(`[WorkflowEngine] Bad condition JSON, skipping rule: ${e.message}`);
    return false;
  }
  const groups = Array.isArray(clauses)
    ? [{ match: "all", clauses }]
    : clauses && Array.isArray(clauses.groups)
      ? clauses.groups
      : null;
  if (!groups) {
    console.warn("[WorkflowEngine] Condition must be a JSON array or grouped conditions");
    return false;
  }
  if (groups.length === 0) return true;

  const evaluateClause = (clause) => {
    if (!clause || typeof clause !== "object") return false;
    const { field, op, value } = clause;
    if (!field || !op) return false;

    const actual = lookupField(field, payload);

    switch (op) {
      case "eq":
        if (actual != value) return false; // loose equality on purpose (string vs number from JSON)
        break;
      case "neq":
        if (actual == value) return false;
        break;
      case "gt":
        if (!(Number(actual) > Number(value))) return false;
        break;
      case "gte":
        if (!(Number(actual) >= Number(value))) return false;
        break;
      case "lt":
        if (!(Number(actual) < Number(value))) return false;
        break;
      case "lte":
        if (!(Number(actual) <= Number(value))) return false;
        break;
      case "in":
        if (!Array.isArray(value) || !value.includes(actual)) return false;
        break;
      case "nin":
        if (!Array.isArray(value) || value.includes(actual)) return false;
        break;
      case "contains":
        if (actual == null || !String(actual).includes(String(value))) return false;
        break;
      case "exists":
        if (actual == null || actual === "") return false;
        break;
      case "icontains":
        if (actual == null || !String(actual).toLowerCase().includes(String(value).toLowerCase())) return false;
        break;
      case "startsWith":
        if (actual == null || !String(actual).startsWith(String(value))) return false;
        break;
      case "endsWith":
        if (actual == null || !String(actual).endsWith(String(value))) return false;
        break;
      // `exists` shipped in the engine but was missing from the builder's
      // operator list, so it was unreachable from the UI. `not_exists` is its
      // inverse and had no implementation at all — "is empty" was simply not
      // expressible.
      case "not_exists":
        if (!(actual == null || actual === "")) return false;
        break;

      // ── Relative-date operators ───────────────────────────────────────
      // `value` is a whole number of days. A field that is absent or
      // unparseable as a date fails the clause rather than throwing, so one
      // bad row never aborts a whole event's rule evaluation.
      case "date_within_next":
      case "date_within_past":
      case "date_before":
      case "date_after": {
        const when = actual == null ? null : new Date(actual);
        if (!when || Number.isNaN(when.getTime())) return false;
        const days = Number(value);
        if (!Number.isFinite(days)) return false;
        const now = Date.now();
        const boundary = now + days * 24 * 60 * 60 * 1000;
        if (op === "date_within_next" && !(when.getTime() >= now && when.getTime() <= boundary)) return false;
        if (op === "date_within_past" && !(when.getTime() <= now && when.getTime() >= now - days * 24 * 60 * 60 * 1000)) return false;
        if (op === "date_before" && !(when.getTime() < boundary)) return false;
        if (op === "date_after" && !(when.getTime() > boundary)) return false;
        break;
      }

      // ── Change-tracking operators ─────────────────────────────────────
      // "stage changed from Proposal to Won" was impossible to express: the
      // payload carried the prior value on some events but no operator could
      // read it. These consult, in order of preference:
      //   1. payload.previous.<field> — the explicit prior-value snapshot that
      //      contact.updated / deal.updated / ticket.updated now attach;
      //   2. the from*/to* pair on deal.stage_changed (fromStage / toStage);
      //   3. payload.changedFields — a list of keys that were written, which
      //      is enough for a bare `changed` test but not for from/to.
      case "changed":
      case "changed_to":
      case "changed_from": {
        const previous = lookupField(`previous.${field}`, payload);
        const capitalised = String(field).charAt(0).toUpperCase() + String(field).slice(1);
        const pairedFrom = lookupField(`from${capitalised}`, payload);
        const pairedTo = lookupField(`to${capitalised}`, payload);

        const before = previous !== undefined ? previous : pairedFrom;
        const after = pairedTo !== undefined ? pairedTo : actual;

        if (op === "changed") {
          if (before !== undefined) {
            if (String(before) === String(after)) return false;
          } else {
            // No snapshot available — fall back to the changed-key list.
            const changedFields = lookupField("changedFields", payload);
            const list = Array.isArray(changedFields)
              ? changedFields
              : String(changedFields || "").split(",").map((k) => k.trim());
            if (!list.includes(field)) return false;
          }
          break;
        }
        // from/to comparisons genuinely need the prior value; without it the
        // honest answer is "cannot tell", which is a non-match.
        if (before === undefined) return false;
        if (op === "changed_to" && !(String(after) == String(value) && String(before) !== String(after))) return false;
        if (op === "changed_from" && !(String(before) == String(value) && String(before) !== String(after))) return false;
        break;
      }

      default:
        console.warn(`[WorkflowEngine] Unknown condition op: ${op}`);
        return false;
    }
    return true;
  };

  return groups.every((group) => {
    if (!group || !Array.isArray(group.clauses)) return false;
    if (group.clauses.length === 0) return true;
    return group.match === "any"
      ? group.clauses.some(evaluateClause)
      : group.clauses.every(evaluateClause);
  });
}

/**
 * #1 — Render a mustache-style template against an event payload.
 * `{{path.to.field}}` → resolved via lookupField; if a placeholder doesn't
 * resolve, we leave the raw `{{path}}` in place so the rule author sees the
 * bug (rather than silently producing "Discount > 10% on undefined").
 */
function renderTemplate(template, payload) {
  if (template == null) return "";
  return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, path) => {
    const v = lookupField(path.trim(), payload);
    return v === undefined || v === null ? match : String(v);
  });
}

function workflowRecordKey(payload) {
  const idFields = ["contactId", "dealId", "ticketId", "taskId", "meetingId", "callId", "invoiceId", "paymentId", "approvalId", "membershipId", "shiftId"];
  const field = idFields.find((key) => payload[key] !== undefined && payload[key] !== null);
  // A scheduled firing already carries a date-bucketed key (see
  // lib/workflowSchedule.js). Respect it — recomputing from the payload here
  // would strip the date and collapse every occurrence into one dedupe slot.
  if (payload.__recordKey) return String(payload.__recordKey);
  return field ? `${field}:${payload[field]}` : null;
}

function runsOncePerRecord(rule) {
  try {
    const targetState = rule.targetState ? JSON.parse(rule.targetState) : {};
    return targetState.execution === "once";
  } catch (_error) {
    return false;
  }
}

/**
 * Execution order for a rule.
 *
 * `sortOrder` is a real column as of the parity migration. Rules written
 * before it lived with their order smuggled inside the targetState JSON, so
 * that remains the fallback — the migration backfills what it can parse, and
 * this covers the rest without a second pass over the table.
 */
function ruleExecutionOrder(rule) {
  if (Number.isFinite(Number(rule?.sortOrder)) && Number(rule.sortOrder) !== 0) {
    return Number(rule.sortOrder);
  }
  try {
    const targetState = rule.targetState ? JSON.parse(rule.targetState) : {};
    const order = Number(targetState.order);
    return Number.isFinite(order) ? order : Number(rule?.sortOrder) || Number.MAX_SAFE_INTEGER;
  } catch (_error) {
    return Number(rule?.sortOrder) || Number.MAX_SAFE_INTEGER;
  }
}

// Entity metadata now lives in lib/workflowSchema.js so the route validator,
// the builder UI and this engine cannot drift apart again. Re-exported below
// for the existing importers that reach for eventBus.WORKFLOW_ENTITIES.
const { WORKFLOW_ENTITIES } = workflowSchema;

function resolveActionValue(value, payload) {
  if (value == null || value === "") return value;
  if (typeof value === "string" && payload[value] != null) return payload[value];
  return renderTemplate(value, payload);
}

function coerceEntityValue(entity, field, value) {
  const numericFields = new Set(["assignedToId", "ownerId", "userId", "assigneeId", "amount", "probability", "aiScore"]);
  const dateFields = new Set(["expectedClose", "dueDate"]);
  if (numericFields.has(field)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`${field} must be a number`);
    return numeric;
  }
  if (dateFields.has(field)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date`);
    return date;
  }
  return value;
}

/**
 * A short human label for the history table's record column.
 *
 * Denormalised onto WorkflowExecution at write time. The old history panel
 * tried to read `log.contactName` off an AuditLog row — a field that has never
 * existed on that model — so the column silently rendered the rule's own id
 * for every row.
 */
function payloadLabel(payload) {
  return (
    payload.name
    || payload.title
    || payload.subject
    || payload.invoiceNum
    || payload.email
    || (payload.contactId ? `Contact #${payload.contactId}` : null)
    || null
  );
}

/**
 * Record one action execution.
 *
 * Two rows are written on purpose, and they are not redundant:
 *
 *   • WorkflowExecution — the OPERATIONAL record. Indexed on
 *     (tenantId, ruleId, recordKey) so "run once per record" is a cheap
 *     lookup, and on (tenantId, ruleId, createdAt) so the history panel can
 *     filter and paginate server-side. Status is a real column.
 *   • AuditLog — the COMPLIANCE record, unchanged, so the tenant-wide audit
 *     trail and anything already reading `entity="AutomationRule"` keeps
 *     working exactly as before.
 *
 * Neither write is allowed to break the action that just succeeded, hence the
 * try/catch: losing a log line is bad, rolling back a sent email is worse.
 */
async function recordWorkflowExecution(rule, payload, tenantId, options = {}) {
  const {
    status = "SUCCESS",
    actionType = rule.actionType,
    error,
    details,
    durationMs,
    isTest = !!payload._test,
  } = options;

  const recordKey = workflowRecordKey(payload);
  const errorText = error ? String(error.message || error) : null;

  try {
    await prisma.workflowExecution.create({
      data: {
        ruleId: rule.id,
        triggerType: rule.triggerType,
        actionType: actionType || "unknown",
        status,
        recordKey,
        contactId: Number(payload.contactId) || null,
        entityLabel: payloadLabel(payload),
        error: errorText,
        details: details ? JSON.stringify(details).slice(0, 60000) : null,
        durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
        isTest,
        tenantId,
      },
    });
  } catch (e) {
    console.error("[WorkflowEngine] execution log write failed:", e.message);
  }

  try {
    await prisma.auditLog.create({
      data: {
        action: status === "SUCCESS" ? "WORKFLOW" : "WORKFLOW_FAILED",
        entity: "AutomationRule",
        entityId: rule.id,
        details: JSON.stringify({
          trigger: rule.triggerType,
          action: actionType,
          recordKey,
          error: errorText || undefined,
          webhook: details?.webhook || error?.webhookResult || undefined,
          payload: { ...payload, body: undefined },
        }),
        tenantId,
      },
    });
  } catch (e) {
    console.error("[WorkflowEngine] audit log write failed:", e.message);
  }
}

// Back-compat alias. The old name is referenced by existing unit tests.
async function writeWorkflowLog(rule, payload, tenantId, action, error, executionDetails) {
  return recordWorkflowExecution(rule, payload, tenantId, {
    status: action === "WORKFLOW_FAILED" ? "FAILED" : "SUCCESS",
    error,
    details: executionDetails,
  });
}

/**
 * How many consecutive failures before a rule is paused automatically.
 *
 * Freshsales pauses a failing workflow and tells the admin. Without this a
 * rule pointed at a dead webhook retries on every single matching event
 * forever, burning quota and filling the log with identical errors. Opt out
 * with WORKFLOW_AUTO_DISABLE_THRESHOLD=0.
 */
const AUTO_DISABLE_THRESHOLD = (() => {
  const v = parseInt(process.env.WORKFLOW_AUTO_DISABLE_THRESHOLD, 10);
  return Number.isFinite(v) && v >= 0 ? v : 10;
})();

/**
 * Update the rule's health counters after an execution, and pause it when it
 * has failed too many times in a row.
 *
 * Best-effort: a counter update must never turn a successful action into a
 * failed one, so everything is inside a try/catch.
 */
async function updateRuleHealth(rule, tenantId, { failed, error, isTest }) {
  // A manual test must not be able to trip the auto-disable guard, or
  // debugging a broken rule would switch it off underneath you.
  if (isTest) return null;

  try {
    const data = failed
      ? {
        lastRunAt: new Date(),
        runCount: { increment: 1 },
        failureCount: { increment: 1 },
        consecutiveFailures: { increment: 1 },
        lastError: String(error?.message || error || "").slice(0, 2000) || null,
      }
      : {
        lastRunAt: new Date(),
        runCount: { increment: 1 },
        consecutiveFailures: 0,
        lastError: null,
      };

    const updated = await prisma.automationRule.update({
      where: { id: rule.id },
      data,
      select: { id: true, name: true, isActive: true, consecutiveFailures: true, createdById: true },
    });

    if (
      failed
      && AUTO_DISABLE_THRESHOLD > 0
      && updated.isActive
      && updated.consecutiveFailures >= AUTO_DISABLE_THRESHOLD
    ) {
      await prisma.automationRule.update({
        where: { id: rule.id },
        data: { isActive: false, autoDisabledAt: new Date() },
      });
      console.warn(
        `[WorkflowEngine] Rule ${rule.id} ("${updated.name}") auto-disabled after ${updated.consecutiveFailures} consecutive failures`,
      );
      await notifyRuleOwners(updated, tenantId, error);
    }
    return updated;
  } catch (e) {
    console.error("[WorkflowEngine] rule health update failed:", e.message);
    return null;
  }
}

/** Tell someone a workflow was switched off. Author first, admins otherwise. */
async function notifyRuleOwners(rule, tenantId, error) {
  try {
    let userIds = [];
    if (rule.createdById) {
      const author = await prisma.user.findFirst({
        where: { id: rule.createdById, tenantId },
        select: { id: true },
      });
      if (author) userIds = [author.id];
    }
    if (!userIds.length) {
      const admins = await prisma.user.findMany({
        where: { tenantId, role: { in: ["ADMIN", "MANAGER"] } },
        select: { id: true },
      });
      userIds = admins.map((u) => u.id);
    }
    if (!userIds.length) return;

    await notifyMany({
      userIds,
      tenantId,
      title: `Workflow paused: ${rule.name}`,
      message: `"${rule.name}" was switched off automatically after ${AUTO_DISABLE_THRESHOLD} consecutive failures. Last error: ${String(error?.message || error || "unknown")}`,
      type: "error",
      link: "/workflows",
      entityType: "AutomationRule",
      entityId: rule.id,
      category: "workflow",
    });
  } catch (e) {
    console.error("[WorkflowEngine] auto-disable notification failed:", e.message);
  }
}

/**
 * Has this rule already run for this record?
 *
 * Previously this loaded the 500 most recent AuditLog rows for the rule and
 * JSON.parsed each one looking for a matching recordKey — an O(n) scan on
 * every single event, which also meant a rule silently started re-firing once
 * it had more than 500 executions behind it. Now it is one indexed lookup
 * against WorkflowExecution's (tenantId, ruleId, recordKey) index.
 */
async function hasWorkflowRun(rule, tenantId, recordKey) {
  if (!recordKey) return false;
  const existing = await prisma.workflowExecution.findFirst({
    where: { tenantId, ruleId: rule.id, recordKey, status: "SUCCESS", isTest: false },
    select: { id: true },
  });
  return !!existing;
}

/**
 * Emit a CRM event, triggering matching AutomationRules and outbound Webhooks.
 *
 * @param {string} eventName  e.g. "contact.created", "deal.stage_changed"
 * @param {object} payload    event-specific data (contactId, dealId, userId, etc.)
 * @param {number} tenantId   tenant scope
 * @param {object} [io]       Socket.io server instance (optional, uses global if not provided)
 */
async function emitEvent(eventName, payload, tenantId, io, depth = 0) {
  if (depth > MAX_EVENT_CHAIN_DEPTH) {
    console.warn(`[WorkflowEngine] Event chain depth exceeded for ${eventName}; breaking potential cascade.`);
    return;
  }

  // Use provided io or fall back to global io reference
  const ioInstance = io || getIO();
  bus.emit(eventName, { payload, tenantId, io: ioInstance });

  // 1. Find matching automation rules
  const triggerTypes = [eventName];
  if (eventName === "contact.created" || eventName === "contact.updated") {
    triggerTypes.push("contact.created_or_updated");
  }
  const rules = await prisma.automationRule.findMany({
    where: {
      tenantId,
      isActive: true,
      triggerType: triggerTypes.length === 1 ? eventName : { in: triggerTypes },
    },
  });

  const orderedRules = [...rules].sort((a, b) => ruleExecutionOrder(a) - ruleExecutionOrder(b) || a.id - b.id);
  for (const rule of orderedRules) {
    try {
      // #20 — gate on the rule's condition before firing the action.
      if (!evaluateCondition(rule.condition, payload)) {
        continue;
      }
      if (runsOncePerRecord(rule) && await hasWorkflowRun(rule, tenantId, workflowRecordKey(payload))) {
        continue;
      }
      await executeAction(rule, payload, tenantId, io, depth);
    } catch (e) {
      console.error(`[WorkflowEngine] Rule ${rule.id} failed:`, e.message);
      await recordWorkflowExecution(rule, payload, tenantId, { status: "FAILED", error: e });
      await updateRuleHealth(rule, tenantId, { failed: true, error: e, isTest: !!payload._test });
    }
  }

  // 2. Fire matching webhooks
  const { deliverWebhooks } = require("./webhookDelivery");
  await deliverWebhooks(eventName, payload, tenantId);
}

/**
 * Execute a single automation rule action.
 *
 * Two shapes are supported:
 *   • `targetState.actions` — an ordered array, written by the builder UI.
 *   • a bare `targetState` object with `rule.actionType` — the legacy shape
 *     from before the multi-action builder. Still executed unchanged.
 */
async function executeAction(rule, payload, tenantId, io, depth = 0) {
  let config = {};
  if (rule.targetState) {
    try {
      config = JSON.parse(rule.targetState);
    } catch (e) {
      console.warn(`[WorkflowEngine] Rule ${rule.id} targetState is not valid JSON, treating as empty: ${e.message}`);
      config = {};
    }
  }

  if (Array.isArray(config.actions)) {
    return runActionList(rule, config.actions, payload, tenantId, io, depth);
  }

  return runActionWithRetry(rule, rule.actionType, config, payload, tenantId, io, depth);
}

/**
 * Walk an ordered action list.
 *
 * A `wait` action parks everything after it in WorkflowScheduledAction and
 * stops the walk — the scheduler cron resumes the tail when the delay
 * elapses. Actually sleeping here would pin an HTTP request (and a pooled DB
 * connection) open for hours or days.
 */
async function runActionList(rule, actions, payload, tenantId, io, depth = 0) {
  const result = { attempted: 0, succeeded: 0, failed: 0, deferred: false };

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (!action || !action.type) continue;

    if (action.type === "wait") {
      const remaining = actions.slice(index + 1).filter((item) => item && item.type);
      try {
        const outcome = await workflowActions.scheduleRemainingActions(
          action.config || {},
          remaining,
          payload,
          tenantId,
          rule,
          workflowRecordKey(payload),
        );
        result.attempted += 1;
        result.succeeded += 1;
        result.deferred = !!outcome.deferred;
        await recordWorkflowExecution(rule, payload, tenantId, {
          status: "SUCCESS",
          actionType: "wait",
          details: outcome,
        });
      } catch (error) {
        result.attempted += 1;
        result.failed += 1;
        console.error(`[WorkflowEngine] Rule ${rule.id} wait failed:`, error.message);
        await recordWorkflowExecution(rule, payload, tenantId, {
          status: "FAILED",
          actionType: "wait",
          error,
        });
      }
      // Everything after the wait is now the scheduler's problem.
      break;
    }

    result.attempted += 1;
    try {
      await runActionWithRetry(rule, action.type, action.config || {}, payload, tenantId, io, depth);
      result.succeeded += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`[WorkflowEngine] Rule ${rule.id} action ${action.type} failed:`, error.message);
      await recordWorkflowExecution(rule, payload, tenantId, {
        status: "FAILED",
        actionType: action.type,
        error,
      });
    }
  }

  await updateRuleHealth(rule, tenantId, {
    failed: result.failed > 0,
    error: result.failed > 0 ? new Error(`${result.failed} action(s) failed`) : null,
    isTest: !!payload._test,
  });

  return result;
}

/**
 * Which actions are worth retrying, and how hard.
 *
 * Only the three that cross a network boundary. Retrying a prisma.update that
 * failed validation ("stage must be a number") just burns time and writes the
 * same error three times; retrying a webhook that got a 503 is the difference
 * between a lost automation and a delivered one.
 *
 * Freshsales retries failed webhook deliveries rather than dropping them on the
 * first blip, and without this a single transient 502 permanently lost the
 * action AND pushed the rule one step closer to the auto-disable threshold.
 */
const RETRYABLE_ACTIONS = new Set(["send_webhook", "send_email", "send_sms"]);

const DEFAULT_RETRY_ATTEMPTS = (() => {
  const v = parseInt(process.env.WORKFLOW_RETRY_ATTEMPTS, 10);
  return Number.isFinite(v) && v >= 1 ? Math.min(v, 5) : 3;
})();

const RETRY_BASE_DELAY_MS = (() => {
  const v = parseInt(process.env.WORKFLOW_RETRY_BASE_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 500;
})();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one action, retrying transient failures with exponential backoff.
 *
 * Retries wrap runSingleAction from the OUTSIDE, which matters: that function
 * writes its SUCCESS execution row as its last statement, so a failed attempt
 * throws before logging anything and a retry cannot produce duplicate SUCCESS
 * rows. The caller still owns the FAILED row, written once, after the last
 * attempt gives up.
 *
 * A test fire never retries — an author debugging a broken webhook wants the
 * error now, not in four seconds.
 */
async function runActionWithRetry(rule, actionType, config, payload, tenantId, io, depth = 0) {
  const configured = Number(config?.retryAttempts);
  const maxAttempts = payload?._test || !RETRYABLE_ACTIONS.has(actionType)
    ? 1
    : Math.max(1, Math.min(5, Number.isFinite(configured) && configured >= 1 ? configured : DEFAULT_RETRY_ATTEMPTS));

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runSingleAction(rule, actionType, config, payload, tenantId, io, depth);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[WorkflowEngine] Rule ${rule.id} action ${actionType} attempt ${attempt}/${maxAttempts} failed (${error.message}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Run exactly one action and log it.
 *
 * Throws on failure so the caller decides whether that aborts the list. Every
 * branch either completes its side effect or throws — an action must never
 * `break` out of the switch having done nothing while the caller records
 * SUCCESS, which is exactly how the old `create_approval` path could log a
 * green execution for a request it never created.
 */
async function runSingleAction(rule, actionType, config, payload, tenantId, io, depth = 0) {
  const startedAt = Date.now();
  let executionDetails;

  switch (actionType) {
    case "send_email": {
      const content = await workflowActions.resolveEmailContent(config, tenantId);
      const to = config.to || payload.email;
      if (!to) throw new Error("No email recipient was resolved");
      const subject = renderTemplate(content.subject || `Notification: ${rule.name}`, payload);
      const body = renderTemplate(content.body || `Workflow "${rule.name}" was triggered.`, payload);
      const sent = await sendSendGrid(resolveActionValue(to, payload), subject, body, {
        cc: config.cc ? resolveActionValue(config.cc, payload) : null,
        bcc: config.bcc ? resolveActionValue(config.bcc, payload) : null,
        fromName: config.fromName ? renderTemplate(config.fromName, payload) : null,
      });
      if (!sent.sent) throw new Error(`Email was not sent: ${sent.reason || "provider error"}`);
      executionDetails = { email: { to, templateId: content.templateId, messageId: sent.id } };
      break;
    }

    case "send_notification": {
      const configuredUserId = Number(config.userId);
      const userId = Number.isInteger(configuredUserId) && configuredUserId > 0
        ? configuredUserId
        : payload.userId;
      // Previously a missing userId silently fell through and still logged a
      // successful execution.
      if (!userId) throw new Error("No notification recipient was resolved");
      await prisma.notification.create({
        data: {
          title: renderTemplate(config.title || rule.name, payload),
          message: renderTemplate(config.message || `Workflow triggered: ${rule.name}`, payload),
          userId,
          tenantId,
          type: "info",
        },
      });
      if (io) io.emit("notification_new", { userId });
      executionDetails = { notification: { userId } };
      break;
    }

    case "create_task": {
      const dueDate = new Date();
      const configuredDueDays = Number(config.dueInDays);
      const dueInDays = Number.isFinite(configuredDueDays) && configuredDueDays >= 0 ? configuredDueDays : 3;
      const configuredAssigneeId = Number(config.assignToId);
      const userId = Number.isInteger(configuredAssigneeId) && configuredAssigneeId > 0
        ? configuredAssigneeId
        : payload.userId || null;
      dueDate.setDate(dueDate.getDate() + dueInDays);
      const task = await prisma.task.create({
        data: {
          title: renderTemplate(config.title || `Follow up: ${rule.name}`, payload),
          dueDate,
          priority: config.priority || undefined,
          type: config.taskType || undefined,
          notes: config.notes ? renderTemplate(config.notes, payload) : undefined,
          userId,
          contactId: payload.contactId || null,
          tenantId,
        },
      });
      executionDetails = { taskId: task.id };
      break;
    }

    case "create_appointment": {
      executionDetails = await workflowActions.createAppointment(config, payload, tenantId, rule, renderTemplate);
      break;
    }

    case "create_deal": {
      executionDetails = await workflowActions.createDeal(config, payload, tenantId, rule, renderTemplate);
      break;
    }

    case "add_tag": {
      executionDetails = await workflowActions.applyTags(config, payload, tenantId, { remove: false });
      break;
    }

    case "remove_tag": {
      executionDetails = await workflowActions.applyTags(config, payload, tenantId, { remove: true });
      break;
    }

    case "add_to_sequence": {
      executionDetails = await workflowActions.addToSequence(config, payload, tenantId);
      break;
    }

    case "remove_from_sequence": {
      executionDetails = await workflowActions.removeFromSequence(config, payload, tenantId);
      break;
    }

    case "delete_record": {
      executionDetails = await workflowActions.deleteRecord(config, payload, tenantId);
      break;
    }

    case "update_field": {
      const entity = String(config.entity || "").toLowerCase();
      const entityConfig = WORKFLOW_ENTITIES[entity];
      if (!entityConfig) throw new Error(`Unsupported workflow entity: ${entity || "missing"}`);
      const entityId = Number(config.entityId || payload[entityConfig.idKey]);
      const field = config.field;
      if (!Number.isInteger(entityId) || entityId < 1) throw new Error(`Missing ${entityConfig.idKey} for update_field`);
      if (!entityConfig.mutableFields.has(field)) throw new Error(`Field ${field || "missing"} cannot be updated on ${entity}`);
      const model = prisma[entityConfig.model];
      const record = await model.findFirst({ where: { id: entityId, tenantId }, select: { id: true } });
      if (!record) throw new Error(`${entity} record not found in this tenant`);
      const resolvedValue = resolveActionValue(config.value, payload);
      await model.update({ where: { id: record.id }, data: { [field]: coerceEntityValue(entity, field, resolvedValue) } });
      executionDetails = { entity, entityId: record.id, field, value: resolvedValue };
      break;
    }

    case "assign_agent": {
      const entity = String(
        config.entity
        || Object.keys(WORKFLOW_ENTITIES).find((key) => payload[WORKFLOW_ENTITIES[key].idKey])
        || "",
      ).toLowerCase();
      const entityConfig = WORKFLOW_ENTITIES[entity];
      if (!entityConfig) throw new Error(`Unsupported workflow entity: ${entity || "missing"}`);
      const entityId = Number(config.entityId || payload[entityConfig.idKey]);
      if (!Number.isInteger(entityId) || entityId < 1) throw new Error(`Missing ${entityConfig.idKey} for assign_agent`);
      // Rotation / least-busy / inherit-owner all resolve here; `specific`
      // preserves the original fixed-userId behaviour byte for byte.
      const assigneeId = await workflowActions.resolveAssignee(config, payload, tenantId, rule, entityConfig);
      const model = prisma[entityConfig.model];
      const record = await model.findFirst({ where: { id: entityId, tenantId }, select: { id: true } });
      if (!record) throw new Error(`${entity} record not found in this tenant`);
      await model.update({ where: { id: record.id }, data: { [entityConfig.assigneeField]: assigneeId } });
      executionDetails = { entity, entityId: record.id, assigneeId, mode: config.mode || "specific" };
      break;
    }

    case "send_sms": {
      const to = resolveActionValue(config.to, payload) || payload.phone;
      if (!to) throw new Error("No SMS recipient was resolved");
      // Dry-run from POST /:id/test should not require a live SMS provider.
      if (payload._test) {
        console.log(`[WorkflowEngine] SMS test dry-run: to=${to}`);
        executionDetails = { sms: { to, dryRun: true } };
        break;
      }
      const provider = await resolveProviderConfig(prisma, tenantId);
      if (!provider) throw new Error("No active SMS provider is configured for this tenant");
      const body = renderTemplate(config.message || rule.name, payload);
      const message = await prisma.smsMessage.create({
        data: {
          to: String(to), from: provider.senderId || null, body,
          direction: "OUTBOUND", status: "QUEUED", provider: provider.provider,
          contactId: payload.contactId || null, userId: payload.userId || null, tenantId,
        },
      });
      const sent = await sendSms({ ...provider, to, body });
      await prisma.smsMessage.update({
        where: { id: message.id },
        data: sent.success
          ? { status: "SENT", providerMsgId: sent.providerMsgId || null }
          : { status: "FAILED", errorMessage: sent.error || "SMS provider rejected the message" },
      });
      if (!sent.success) throw new Error(sent.error || "SMS provider rejected the message");
      executionDetails = { sms: { to, messageId: message.id } };
      break;
    }

    case "send_webhook": {
      const { deliverConfiguredWebhook } = require("./webhookDelivery");
      // Sign with the tenant's per-tenant secret (same as deliverWebhooks) so
      // every outbound webhook from this tenant carries one consistent
      // signature a partner can verify. Not subscription-gated here — this is
      // a user-authored automation action, distinct from the Webhook-model
      // lead-sync stream which IS gated in deliverWebhooks().
      const { resolveTenantWebhookSecret } = require("./webhookEntitlement");
      const { secret } = await resolveTenantWebhookSecret(tenantId);
      const result = await deliverConfiguredWebhook(config, rule.triggerType, payload, tenantId, secret);
      executionDetails = {
        webhook: {
          status: result.status,
          statusText: result.statusText,
          response: result.response,
        },
      };
      break;
    }

    case "create_approval": {
      // Config shape: { entity: "Deal", reasonTemplate: "Discount > 10% on {{deal.title}}" }
      // entityId is resolved from the event payload via `<entity-lowercase>Id`.
      //
      // Every branch below now THROWS instead of `break`-ing. Previously a
      // missing entity / entityId / requesterId logged a console warning, fell
      // out of the switch, and still wrote a successful WORKFLOW audit row —
      // so a rule that never created a single approval looked perfectly
      // healthy in the history panel.
      const entity = config.entity;
      if (!entity || typeof entity !== "string") {
        throw new Error("create_approval requires an entity");
      }
      const idKey = entity.toLowerCase() + "Id";
      const entityId = payload[idKey] != null ? Number(payload[idKey]) : null;
      if (!entityId || Number.isNaN(entityId)) {
        throw new Error(`create_approval: payload.${idKey} not found`);
      }
      const reason = renderTemplate(config.reasonTemplate || "", payload) || null;

      // `rule.createdById` is a real column as of the parity migration; it
      // used to be read off a model that did not have it, so this fallback
      // was always undefined.
      const requesterId = payload.userId || payload.actorId || rule.createdById || null;
      if (!requesterId) {
        throw new Error("create_approval: no requester could be resolved from the payload or the rule's author");
      }

      const created = await prisma.approvalRequest.create({
        data: {
          entity,
          entityId,
          reason,
          status: "PENDING",
          requestedBy: requesterId,
          tenantId,
        },
      });
      executionDetails = { approvalId: created.id };

      // Chain trigger so other rules can subscribe to approval.created.
      // depth+1 keeps MAX_EVENT_CHAIN_DEPTH honest against a rule that
      // creates an approval in response to approval.created.
      try {
        await emitEvent(
          "approval.created",
          {
            approvalId: created.id,
            entity: created.entity,
            entityId: created.entityId,
            requesterId,
            reason: created.reason,
          },
          tenantId,
          io,
          depth + 1,
        );
      } catch (e) {
        console.error("[WorkflowEngine] approval.created emit failed:", e.message);
      }
      break;
    }

    case "wait": {
      // Only reachable for a legacy single-action rule whose sole action is a
      // wait. There is nothing after it to defer, so this is a no-op rather
      // than an error — the multi-action path in runActionList handles the
      // real case.
      executionDetails = { deferred: false, reason: "wait is the only action on this rule" };
      break;
    }

    default:
      throw new Error(`Unknown actionType: ${actionType}`);
  }

  await recordWorkflowExecution(rule, payload, tenantId, {
    status: "SUCCESS",
    actionType,
    details: executionDetails,
    durationMs: Date.now() - startedAt,
  });
  return { attempted: 1, succeeded: 1, failed: 0 };
}

async function testRule(rule, payload, tenantId, io) {
  if (!evaluateCondition(rule.condition, payload)) {
    return { conditionsMatched: false, attempted: 0, succeeded: 0, failed: 0 };
  }
  const testPayload = { ...payload, _test: true };
  try {
    const result = await executeAction(rule, testPayload, tenantId, io);
    return { conditionsMatched: true, ...(result || { attempted: 1, succeeded: 1, failed: 0 }) };
  } catch (error) {
    await recordWorkflowExecution(rule, testPayload, tenantId, { status: "FAILED", error });
    return { conditionsMatched: true, attempted: 1, succeeded: 0, failed: 1, error: error.message };
  }
}

/**
 * Fire-and-forget wrapper around `emitEvent` for route handlers that
 * emit lifecycle webhooks (visa.status_changed, quote.sent,
 * itinerary.accepted, etc.). Logs subscriber failures via console.warn
 * — never throws back into the route handler's response path.
 *
 * Use this from any route that wants to fire a webhook AFTER a
 * primary action succeeds (status update, accept, send, etc.). The
 * outer try/catch protects against unlikely require() / module-init
 * failures; the inner .catch handles the Promise-level emit failure.
 *
 * @param {string} eventName     Canonical event name (see
 *                               webhookDelivery.js JSDoc catalogue).
 * @param {object} payload       Flat event payload — subscribers see
 *                               this as the body's `payload` field.
 * @param {number} tenantId      Per-tenant scoping (cannot cross
 *                               tenant boundaries).
 * @param {string} contextLabel  Identifier for the calling site, used
 *                               in console.warn on failure
 *                               (e.g. "travel-visa/patch").
 */
function safeEmitEvent(eventName, payload, tenantId, contextLabel) {
  // Invoke through `module.exports.emitEvent` so test-time spies that
  // monkey-patch the exports surface (per wave-6a-event-emissions.test.js
  // pattern) continue to intercept calls. Calling the local `emitEvent`
  // closure-binding directly would bypass the spy.
  (async () => {
    try {
      await module.exports.emitEvent(eventName, payload, tenantId);
    } catch (err) {
      console.warn(`[${contextLabel}] ${eventName} emit failed:`, err.message);
    }
  })();
}

module.exports = {
  emitEvent,
  safeEmitEvent,
  bus,
  executeAction,
  evaluateCondition,
  renderTemplate,
  workflowRecordKey,
  runsOncePerRecord,
  lookupField,
  ruleExecutionOrder,
  testRule,
  setIO,
  getIO,
  // Parity wave additions.
  runSingleAction,
  runActionWithRetry,
  runActionList,
  recordWorkflowExecution,
  writeWorkflowLog,
  hasWorkflowRun,
  updateRuleHealth,
  payloadLabel,
  WORKFLOW_ENTITIES,
  AUTO_DISABLE_THRESHOLD,
};
