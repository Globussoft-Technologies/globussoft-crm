const EventEmitter = require("events");
const path = require("path");
// Mirror server.js — try root .env then backend/.env with override.
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: false });
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });
const prisma = require("./prisma");

const bus = new EventEmitter();
bus.setMaxListeners(100);

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
        select: { invoiceNumber: true },
      });
      const invNum = inv?.invoiceNumber || `#${travelInvoiceId}`;
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
 * @param {object} [io]       Socket.io server instance (optional, uses global if not provided)
 */
async function emitEvent(eventName, payload, tenantId, io) {
  // Use provided io or fall back to global io reference
  const ioInstance = io || getIO();
  bus.emit(eventName, { payload, tenantId, io: ioInstance });

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
        await sendSendGrid(to, subject, body);
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
      // Sign with the tenant's per-tenant secret (same as deliverWebhooks) so
      // every outbound webhook from this tenant carries one consistent
      // signature a partner can verify. Not subscription-gated here — this is
      // a user-authored automation action, distinct from the Webhook-model
      // lead-sync stream which IS gated in deliverWebhooks().
      const { resolveTenantWebhookSecret } = require("./webhookEntitlement");
      const { secret } = await resolveTenantWebhookSecret(tenantId);
      await deliverSingle(config.url, rule.triggerType, payload, tenantId, secret);
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
  try {
    // Invoke through `module.exports.emitEvent` so test-time spies that
    // monkey-patch the exports surface (per wave-6a-event-emissions.test.js
    // pattern) continue to intercept calls. Calling the local `emitEvent`
    // closure-binding directly would bypass the spy.
    module.exports.emitEvent(eventName, payload, tenantId).catch((err) =>
      console.warn(`[${contextLabel}] ${eventName} emit failed:`, err.message)
    );
  } catch (emitErr) {
    console.warn(`[${contextLabel}] ${eventName} setup failed:`, emitErr.message);
  }
}

module.exports = {
  emitEvent,
  safeEmitEvent,
  bus,
  executeAction,
  evaluateCondition,
  renderTemplate,
  lookupField,
  setIO,
  getIO,
};
