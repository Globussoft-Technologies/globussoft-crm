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

module.exports = { emitEvent, bus, executeAction };
