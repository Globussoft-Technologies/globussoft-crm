const EventEmitter = require("events");
const path = require("path");
// Mirror server.js — try root .env then backend/.env with override.
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });
const prisma = require("./prisma");
const { sendSms, resolveProviderConfig } = require("../services/smsProvider");

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

async function sendSendGrid(to, subject, body) {
  if (!SENDGRID_API_KEY) {
    console.log(`[WorkflowEngine] SendGrid not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }

  const htmlBody = body.replace(/\n/g, "<br>");
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM_EMAIL },
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

function ruleExecutionOrder(rule) {
  try {
    const targetState = rule.targetState ? JSON.parse(rule.targetState) : {};
    const order = Number(targetState.order);
    return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
  } catch (_error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

const WORKFLOW_ENTITIES = {
  contact: {
    model: "contact",
    idKey: "contactId",
    assigneeField: "assignedToId",
    mutableFields: new Set(["name", "email", "phone", "company", "title", "status", "source", "assignedToId"]),
  },
  deal: {
    model: "deal",
    idKey: "dealId",
    assigneeField: "ownerId",
    mutableFields: new Set(["title", "amount", "currency", "probability", "stage", "expectedClose", "lostReason", "ownerId"]),
  },
  task: {
    model: "task",
    idKey: "taskId",
    assigneeField: "userId",
    mutableFields: new Set(["title", "dueDate", "status", "priority", "notes", "userId"]),
  },
  ticket: {
    model: "ticket",
    idKey: "ticketId",
    assigneeField: "assigneeId",
    mutableFields: new Set(["subject", "description", "status", "priority", "assigneeId"]),
  },
};

function resolveActionValue(value, payload) {
  if (value == null || value === "") return value;
  if (typeof value === "string" && payload[value] != null) return payload[value];
  return renderTemplate(value, payload);
}

function coerceEntityValue(entity, field, value) {
  const numericFields = new Set(["assignedToId", "ownerId", "userId", "assigneeId", "amount", "probability"]);
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

async function writeWorkflowLog(rule, payload, tenantId, action, error, executionDetails) {
  await prisma.auditLog.create({
    data: {
      action,
      entity: "AutomationRule",
      entityId: rule.id,
      details: JSON.stringify({
        trigger: rule.triggerType,
        action: rule.actionType,
        recordKey: workflowRecordKey(payload),
        error: error ? String(error.message || error) : undefined,
        webhook: executionDetails?.webhook || error?.webhookResult || undefined,
        payload: { ...payload, body: undefined },
      }),
      tenantId,
    },
  });
}

async function hasWorkflowRun(rule, tenantId, recordKey) {
  if (!recordKey) return false;
  const logs = await prisma.auditLog.findMany({
    where: { tenantId, entity: "AutomationRule", action: "WORKFLOW", entityId: rule.id },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { details: true },
  });
  return logs.some((log) => {
    try { return JSON.parse(log.details || "{}").recordKey === recordKey; }
    catch (_error) { return false; }
  });
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
      await writeWorkflowLog(rule, payload, tenantId, "WORKFLOW_FAILED", e);
    }
  }

  // 2. Fire matching webhooks
  const { deliverWebhooks } = require("./webhookDelivery");
  await deliverWebhooks(eventName, payload, tenantId);
}

/**
 * Execute a single automation rule action.
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

  // The workflow builder stores each configured action in targetState.actions.
  // Keep the legacy single-action shape working while executing every action
  // configured through the new UI in the order the user selected.
  if (Array.isArray(config.actions)) {
    const result = { attempted: 0, succeeded: 0, failed: 0 };
    for (const action of config.actions) {
      if (!action || !action.type) continue;
      result.attempted += 1;
      try {
        await executeAction({
          ...rule,
          actionType: action.type,
          targetState: JSON.stringify(action.config || {}),
        }, payload, tenantId, io, depth);
        result.succeeded += 1;
      } catch (error) {
        result.failed += 1;
        console.error(`[WorkflowEngine] Rule ${rule.id} action ${action.type} failed:`, error.message);
        await writeWorkflowLog({ ...rule, actionType: action.type }, payload, tenantId, "WORKFLOW_FAILED", error);
      }
    }
    return result;
  }

  let executionDetails;
  switch (rule.actionType) {
    case "send_email": {
      const to = config.to || payload.email;
      const subject = config.subject || `Notification: ${rule.name}`;
      const body = renderTemplate(config.body || `Workflow "${rule.name}" was triggered.`, payload);
      if (to) {
        const sent = await sendSendGrid(resolveActionValue(to, payload), renderTemplate(subject, payload), body);
        if (!sent.sent) throw new Error(`Email was not sent: ${sent.reason || "provider error"}`);
      } else {
        throw new Error("No email recipient was resolved");
      }
      break;
    }

    case "send_notification": {
      const configuredUserId = Number(config.userId);
      const userId = Number.isInteger(configuredUserId) && configuredUserId > 0
        ? configuredUserId
        : payload.userId;
      if (userId) {
        await prisma.notification.create({
          data: {
            title: config.title || rule.name,
            message: config.message || `Workflow triggered: ${rule.name}`,
            userId,
            tenantId,
            type: "info",
          },
        });
        if (io) io.emit("notification_new", { userId });
      }
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
      await prisma.task.create({
        data: {
          title: config.title || `Follow up: ${rule.name}`,
          dueDate,
          userId,
          contactId: payload.contactId || null,
          tenantId,
        },
      });
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
      break;
    }

    case "assign_agent": {
      const userId = Number(config.userId);
      if (!Number.isInteger(userId) || userId < 1) throw new Error("A valid assignee user ID is required");
      const entity = String(config.entity || Object.keys(WORKFLOW_ENTITIES).find((key) => payload[WORKFLOW_ENTITIES[key].idKey]) || "").toLowerCase();
      const entityConfig = WORKFLOW_ENTITIES[entity];
      if (!entityConfig) throw new Error(`Unsupported workflow entity: ${entity || "missing"}`);
      const entityId = Number(config.entityId || payload[entityConfig.idKey]);
      if (!Number.isInteger(entityId) || entityId < 1) throw new Error(`Missing ${entityConfig.idKey} for assign_agent`);
      const user = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
      if (!user) throw new Error("Assignee not found in this tenant");
      const model = prisma[entityConfig.model];
      const record = await model.findFirst({ where: { id: entityId, tenantId }, select: { id: true } });
      if (!record) throw new Error(`${entity} record not found in this tenant`);
      await model.update({ where: { id: record.id }, data: { [entityConfig.assigneeField]: user.id } });
      break;
    }

    case "send_sms": {
      const to = resolveActionValue(config.to, payload) || payload.phone;
      if (!to) throw new Error("No SMS recipient was resolved");
      // Dry-run from POST /:id/test should not require a live SMS provider.
      if (payload._test) {
        console.log(`[WorkflowEngine] SMS test dry-run: to=${to}`);
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
      // #1 — auto-create an ApprovalRequest. Config shape:
      //   { entity: "Deal", reasonTemplate: "Discount > 10% on {{deal.title}}" }
      // entity is required; entityId is resolved from the event payload via
      // `<entity-lowercase>Id` (dealId, contactId, etc.). requesterId comes
      // from payload.userId / payload.actorId, or falls back to the rule's
      // createdById. Emits `approval.created` so chained rules can react.
      const entity = config.entity;
      if (!entity || typeof entity !== "string") {
        console.warn(`[WorkflowEngine] create_approval rule ${rule.id}: missing entity`);
        break;
      }
      const idKey = entity.toLowerCase() + "Id";
      const entityId = payload[idKey] != null ? Number(payload[idKey]) : null;
      if (!entityId || Number.isNaN(entityId)) {
        console.warn(
          `[WorkflowEngine] create_approval rule ${rule.id}: payload.${idKey} not found`
        );
        break;
      }
      const reason = renderTemplate(config.reasonTemplate || "", payload) || null;

      const requesterId =
        payload.userId || payload.actorId || rule.createdById || null;
      if (!requesterId) {
        console.warn(
          `[WorkflowEngine] create_approval rule ${rule.id}: no requesterId resolvable`
        );
        break;
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

      // Chain trigger so other rules can subscribe to approval.created.
      // Use bus.emit directly to avoid recursion through emitEvent (which
      // would re-load rules); a downstream rule listening on approval.created
      // will still fire because we re-enter via emitEvent below — but we
      // protect against infinite loops by NOT chaining create_approval onto
      // approval.created itself in rule authoring.
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
          depth + 1
        );
      } catch (e) {
        console.error("[WorkflowEngine] approval.created emit failed:", e.message);
      }
      break;
    }

    default:
      console.warn(`[WorkflowEngine] Unknown actionType: ${rule.actionType}`);
  }

  // Log execution in audit log
  await writeWorkflowLog(rule, payload, tenantId, "WORKFLOW", undefined, executionDetails);
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
    await writeWorkflowLog(rule, testPayload, tenantId, "WORKFLOW_FAILED", error);
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
};
