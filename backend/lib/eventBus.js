const EventEmitter = require("events");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const prisma = require("./prisma");

const bus = new EventEmitter();
bus.setMaxListeners(100);

// Mailgun email sending (same pattern as communications.js)
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "crm.globusdemos.com";
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;

async function sendMailgun(to, subject, body) {
  if (!MAILGUN_API_KEY) {
    console.log(`[WorkflowEngine] Mailgun not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }

  const formData = new URLSearchParams();
  formData.append("from", FROM_EMAIL);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", body);
  formData.append("html", body.replace(/\n/g, "<br>"));

  try {
    const response = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from("api:" + MAILGUN_API_KEY).toString("base64") },
      body: formData,
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`[WorkflowEngine] Email sent to ${to}: ${data.id}`);
      return { sent: true, id: data.id };
    } else {
      const err = await response.text();
      console.error(`[WorkflowEngine] Mailgun error (${response.status}):`, err);
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
  if (!Array.isArray(clauses)) {
    console.warn("[WorkflowEngine] Condition must be a JSON array of clauses");
    return false;
  }
  if (clauses.length === 0) return true;

  for (const clause of clauses) {
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
      case "startsWith":
        if (actual == null || !String(actual).startsWith(String(value))) return false;
        break;
      default:
        console.warn(`[WorkflowEngine] Unknown condition op: ${op}`);
        return false;
    }
  }
  return true;
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

/**
 * Emit a CRM event, triggering matching AutomationRules and outbound Webhooks.
 *
 * @param {string} eventName  e.g. "contact.created", "deal.stage_changed"
 * @param {object} payload    event-specific data (contactId, dealId, userId, etc.)
 * @param {number} tenantId   tenant scope
 * @param {object} [io]       Socket.io server instance (optional)
 */
async function emitEvent(eventName, payload, tenantId, io) {
  bus.emit(eventName, { payload, tenantId, io });

  // 1. Find matching automation rules
  const rules = await prisma.automationRule.findMany({
    where: { tenantId, triggerType: eventName, isActive: true },
  });

  for (const rule of rules) {
    try {
      // #20 — gate on the rule's condition before firing the action.
      if (!evaluateCondition(rule.condition, payload)) {
        continue;
      }
      await executeAction(rule, payload, tenantId, io);
    } catch (e) {
      console.error(`[WorkflowEngine] Rule ${rule.id} failed:`, e.message);
    }
  }

  // 2. Fire matching webhooks
  const { deliverWebhooks } = require("./webhookDelivery");
  await deliverWebhooks(eventName, payload, tenantId);
}

/**
 * Execute a single automation rule action.
 */
async function executeAction(rule, payload, tenantId, io) {
  const config = rule.targetState ? JSON.parse(rule.targetState) : {};

  switch (rule.actionType) {
    case "send_email": {
      const to = config.to || payload.email;
      const subject = config.subject || `Notification: ${rule.name}`;
      const body = config.body || `Workflow "${rule.name}" was triggered.`;
      if (to) {
        await sendMailgun(to, subject, body);
      } else {
        console.warn(`[WorkflowEngine] send_email rule ${rule.id}: no recipient address`);
      }
      break;
    }

    case "send_notification": {
      const userId = config.userId || payload.userId;
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
      dueDate.setDate(dueDate.getDate() + (config.dueInDays || 3));
      await prisma.task.create({
        data: {
          title: config.title || `Follow up: ${rule.name}`,
          dueDate,
          userId: config.assignToId || payload.userId,
          contactId: payload.contactId || null,
          tenantId,
        },
      });
      break;
    }

    case "update_field": {
      const entity = config.entity; // e.g. "contact", "deal"
      const entityId = config.entityId || payload.contactId || payload.dealId;
      const field = config.field;
      const value = config.value;
      if (entity && entityId && field) {
        const model = prisma[entity];
        if (model) {
          await model.update({
            where: { id: entityId },
            data: { [field]: value },
          });
        }
      }
      break;
    }

    case "assign_agent": {
      if (payload.contactId && config.userId) {
        await prisma.contact.update({
          where: { id: payload.contactId },
          data: { assignedToId: config.userId },
        });
      }
      break;
    }

    case "send_sms": {
      // Placeholder: would integrate with SMS provider
      console.log(`[WorkflowEngine] SMS action: to=${config.to || payload.phone}, msg=${config.message || rule.name}`);
      break;
    }

    case "send_webhook": {
      const { deliverSingle } = require("./webhookDelivery");
      await deliverSingle(config.url, rule.triggerType, payload, tenantId);
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
          io
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
  await prisma.auditLog.create({
    data: {
      action: "WORKFLOW",
      entity: "AutomationRule",
      entityId: rule.id,
      details: JSON.stringify({
        trigger: rule.triggerType,
        action: rule.actionType,
        payload: { ...payload, body: undefined },
      }),
      tenantId,
    },
  });
}

module.exports = {
  emitEvent,
  bus,
  executeAction,
  evaluateCondition,
  renderTemplate,
  lookupField,
};
