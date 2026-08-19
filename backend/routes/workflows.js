const express = require("express");
const prisma = require("../lib/prisma");
const { ensureEnum } = require("../lib/validators");
const { resolveConfiguredWebhookUrl } = require("../lib/webhookDelivery");
const { encryptCredential, looksLikeMaskedSentinel, maskCredential } = require("../lib/credentialMasking");

const router = express.Router();

function parseTargetState(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return structuredClone(raw);
  try { return JSON.parse(raw); } catch (_error) { throw new Error("targetState is not valid JSON"); }
}

function webhookConfigs(target, actionType) {
  if (Array.isArray(target.actions)) {
    return target.actions.flatMap((action, index) => action?.type === "send_webhook" ? [{ config: action.config || {}, index }] : []);
  }
  return actionType === "send_webhook" ? [{ config: target, index: null }] : [];
}

function validateWebhookConfig(config) {
  resolveConfiguredWebhookUrl(config?.url);
  if (!["POST", "PUT", "PATCH"].includes(String(config?.method || "POST").toUpperCase())) {
    throw new Error("Webhook method must be POST, PUT, or PATCH");
  }
  if (!["json", "form", "xml"].includes(String(config?.encoding || "json").toLowerCase())) {
    throw new Error("Webhook encoding must be JSON, form, or XML");
  }
  const headers = Array.isArray(config?.headers) ? config.headers : [];
  if (headers.length > 20) throw new Error("A webhook can have at most 20 custom headers");
  for (const header of headers) {
    const key = String(header?.key || "").trim();
    if (key && !/^[A-Za-z0-9-]+$/.test(key)) throw new Error(`Invalid webhook header name: ${key}`);
    if (["host", "content-length", "connection", "transfer-encoding"].includes(key.toLowerCase())) {
      throw new Error(`Webhook header ${key} is managed by the CRM`);
    }
  }
  if (config?.bodyMode === "advanced" && typeof config.bodyTemplate === "string" && config.bodyTemplate.trim()) {
    try { JSON.parse(config.bodyTemplate); } catch (_error) { throw new Error("Advanced webhook body must be valid JSON"); }
  }
}

function secureWebhookConfig(config, previousConfig = {}) {
  validateWebhookConfig(config);
  const previousHeaders = Array.isArray(previousConfig.headers) ? previousConfig.headers : [];
  return {
    ...config,
    method: String(config.method || "POST").toUpperCase(),
    encoding: String(config.encoding || "json").toLowerCase(),
    headers: (Array.isArray(config.headers) ? config.headers : []).map((header) => {
      if (!header?.secret) return header;
      const previous = previousHeaders.find((item) => String(item?.key || "").toLowerCase() === String(header.key || "").toLowerCase());
      const value = looksLikeMaskedSentinel(header.value) && previous ? previous.value : encryptCredential(String(header.value || ""));
      return { ...header, value };
    }),
  };
}

function prepareTargetState(raw, actionType, previousRaw) {
  const target = parseTargetState(raw);
  const previous = parseTargetState(previousRaw);
  if (Array.isArray(target.actions)) {
    target.actions = target.actions.map((action, index) => action?.type === "send_webhook"
      ? { ...action, config: secureWebhookConfig(action.config || {}, previous.actions?.[index]?.config || {}) }
      : action);
  } else if (actionType === "send_webhook") {
    return secureWebhookConfig(target, previous);
  }
  return target;
}

function maskWorkflowSecrets(rule) {
  if (!rule?.targetState) return rule;
  let target;
  try { target = parseTargetState(rule.targetState); } catch (_error) { return rule; }
  for (const { config } of webhookConfigs(target, rule.actionType)) {
    if (!Array.isArray(config.headers)) continue;
    config.headers = config.headers.map((header) => header?.secret
      ? { ...header, value: maskCredential(header.value) || "****" }
      : header);
  }
  return { ...rule, targetState: JSON.stringify(target) };
}

// Supported trigger types
const TRIGGER_TYPES = [
  { value: "contact.created", label: "Contact Created", description: "Fires when a new contact is added" },
  { value: "contact.updated", label: "Contact Updated", description: "Fires when a contact is modified" },
  { value: "contact.created_or_updated", label: "Contact Created or Updated", description: "Fires when a contact is added or modified" },
  { value: "deal.created", label: "Deal Created", description: "Fires when a new deal is created" },
  { value: "deal.updated", label: "Deal Updated", description: "Fires whenever a deal is updated via PUT /api/deals/:id" },
  { value: "deal.stage_changed", label: "Deal Stage Changed", description: "Fires when a deal moves pipeline stages" },
  { value: "deal.won", label: "Deal Won", description: "Fires when a deal is marked as won" },
  { value: "deal.lost", label: "Deal Lost", description: "Fires when a deal is marked as lost" },
  { value: "ticket.created", label: "Ticket Created", description: "Fires when a support ticket is opened" },
  { value: "ticket.updated", label: "Ticket Updated", description: "Fires when a ticket status changes" },
  { value: "invoice.created", label: "Invoice Created", description: "Fires when an invoice is generated" },
  { value: "invoice.paid", label: "Invoice Paid", description: "Fires when an invoice is marked as paid" },
  // PRD Gap §13 wave-6a — additional invoice + payment lifecycle events.
  { value: "invoice.completed", label: "Invoice Completed", description: "Fires when an invoice reaches its terminal PAID state (analytics-friendly)" },
  { value: "invoice.voided", label: "Invoice Voided", description: "Fires when an invoice is voided" },
  { value: "invoice.refunded", label: "Invoice Refunded", description: "Fires when a PAID invoice is refunded" },
  { value: "invoice.overdue", label: "Invoice Overdue", description: "Fires when an invoice passes its due date" },
  { value: "payment.collected", label: "Payment Collected", description: "Fires when payment is captured (gateway success or manual mark-paid)" },
  { value: "task.created", label: "Task Created", description: "Fires when a task is created" },
  { value: "task.completed", label: "Task Completed", description: "Fires when a task is marked complete" },
  { value: "lead.converted", label: "Lead Converted", description: "Fires when a lead becomes a customer" },
  // PRD Gap §13 wave-6a — wallet / cashback / gift-card / membership / attendance.
  { value: "wallet.topup", label: "Wallet Top-up", description: "Fires on every wallet credit (manual, refund, gift-card, cashback)" },
  { value: "wallet.spent", label: "Wallet Spent", description: "Fires on every wallet debit (redemption, reversal, manual)" },
  { value: "cashback.credited", label: "Cashback Credited", description: "Fires when cashback is credited to a patient's wallet for a completed visit" },
  { value: "giftcard.issued", label: "Gift Card Issued", description: "Fires when a gift card is issued by an admin/manager" },
  { value: "giftcard.redeemed", label: "Gift Card Redeemed", description: "Fires when a gift card is redeemed against a patient's wallet" },
  { value: "membership.plan_created", label: "Membership Plan Created", description: "Fires when an admin/manager creates a new membership plan" },
  { value: "membership.enrolled", label: "Membership Enrolled", description: "Fires on first-time patient enrollment in a membership plan" },
  { value: "membership.renewed", label: "Membership Renewed", description: "Fires when a patient purchases the same plan they previously held" },
  { value: "membership.benefit_applied", label: "Membership Benefit Applied", description: "Fires when a service is redeemed against an active membership balance" },
  { value: "membership.expired", label: "Membership Expired", description: "Fires on the active→expired transition (lazily detected on redeem)" },
  { value: "membership.cancelled", label: "Membership Cancelled", description: "Fires when an admin/manager cancels a patient's membership" },
  // v3.7.3 — proactive T-7 renewal-due event. Emitted by wellnessOpsEngine
  // when a membership's endDate falls in the next 7 days AND it has not yet
  // been notified (idempotent via expiryNotifiedAt marker). Lets workflow
  // rules send templated email / SMS / WhatsApp ahead of the in-app
  // notification that staff already see.
  { value: "membership.renewal_due", label: "Membership Renewal Due (T-7)", description: "Fires once per membership when it enters the 7-day expiry window. Payload: { membershipId, patientId, patientName, planId, planName, daysLeft, endDate }" },
  { value: "attendance.checked_in", label: "Attendance Clock-In", description: "Fires when a staff member clocks in (manual or biometric)" },
  { value: "attendance.checked_out", label: "Attendance Clock-Out", description: "Fires when a staff member clocks out (manual or biometric)" },
  // #1 — approval lifecycle events. Lets a rule auto-create an approval on a
  // threshold AND lets a separate rule react when that approval is approved
  // (e.g. advance the deal stage). Decoupled by design.
  { value: "approval.created", label: "Approval Created", description: "Fires when an approval request is created (manually or via create_approval action)" },
  { value: "approval.approved", label: "Approval Approved", description: "Fires when an approval request is approved" },
  { value: "approval.rejected", label: "Approval Rejected", description: "Fires when an approval request is rejected" },
  // #12 — SLA breach event. Fired by slaBreachEngine cron (every 5 min) when a
  // ticket has missed its first-response SLA. Lets rules react: notify manager,
  // escalate, send Slack ping, etc.
  { value: "sla.breached", label: "SLA Breached", description: "Fires when a ticket misses its first-response SLA (cron: every 5 min)" },
  // PRD Gap §13 item 4 — POS shift lifecycle. Emitted by routes/pos.js on
  // POST /shifts/open and POST /shifts/:id/close. Lets a manager subscribe
  // (e.g. Slack ping when a register opens, flag |variance| > N on close).
  { value: "shift.opened", label: "POS Shift Opened", description: "Fires when a cashier opens a register shift (POST /api/pos/shifts/open)" },
  { value: "shift.closed", label: "POS Shift Closed", description: "Fires when a register shift is closed (POST /api/pos/shifts/:id/close); payload includes variance" },
];

// Supported action types
const ACTION_TYPES = [
  { value: "send_email", label: "Send Email", config: ["to", "subject", "body"] },
  { value: "send_sms", label: "Send SMS", config: ["to", "message"] },
  { value: "send_notification", label: "Send Notification", config: ["userId", "title", "message"] },
  { value: "create_task", label: "Create Task", config: ["title", "dueInDays", "assignToId"] },
  { value: "update_field", label: "Update Field", config: ["entity", "entityId", "field", "value"] },
  { value: "assign_agent", label: "Assign Agent", config: ["userId"] },
  { value: "send_webhook", label: "Send Webhook", config: ["url"] },
  // #1 — auto-create an ApprovalRequest. targetState carries:
  //   { entity: "Deal", reasonTemplate: "Discount > 10% on {{deal.title}}" }
  { value: "create_approval", label: "Create Approval Request", config: ["entity", "reasonTemplate"] },
];

// GET /triggers — list supported trigger types
router.get("/triggers", (req, res) => {
  res.json(TRIGGER_TYPES);
});

// GET /actions — list supported action types
router.get("/actions", (req, res) => {
  res.json(ACTION_TYPES);
});

// GET /history — recent workflow execution logs
router.get("/history", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const logs = await prisma.auditLog.findMany({
      where: {
        tenantId: req.user.tenantId,
        entity: "AutomationRule",
        action: { in: ["WORKFLOW", "WORKFLOW_FAILED"] },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    const total = await prisma.auditLog.count({
      where: {
        tenantId: req.user.tenantId,
        entity: "AutomationRule",
        action: { in: ["WORKFLOW", "WORKFLOW_FAILED"] },
      },
    });

    res.json({ logs, total, limit, offset });
  } catch (error) {
    console.error("[Workflows] History error:", error.message);
    res.status(500).json({ error: "Failed to fetch workflow history" });
  }
});

// GET / — list all automation rules for tenant
router.get("/", async (req, res) => {
  try {
    // #920 slice 17 — payload reduction via opt-in slim shape. When the caller
    // passes ?fields=summary, GET /api/workflows returns only the columns
    // needed for list / picker / dashboard-counter UIs (id, name, triggerType,
    // actionType, isActive, tenantId). The slim branch drops the heavy
    // `targetState` and `condition` text fields — both are `@db.Text` JSON
    // blobs that can run tens of KB per row for complex rules (multi-clause
    // conditions, templated email bodies, webhook URLs + headers, etc.) and
    // are never needed by the directory view in Workflows.jsx (it only
    // renders name + trigger + action + active-toggle). ADDITIVE: when
    // ?fields is absent or any other value, the prior full-row shape is
    // preserved (no `select`), so the existing builder UI + the workflow
    // engine's own findMany walks keep getting the full payload.
    const isSummary = req.query.fields === "summary";
    const slimSelect = {
      id: true,
      name: true,
      triggerType: true,
      actionType: true,
      isActive: true,
      tenantId: true,
    };
    const findArgs = { where: { tenantId: req.user.tenantId } };
    if (isSummary) findArgs.select = slimSelect;
    const rules = await prisma.automationRule.findMany(findArgs);
    res.json(isSummary ? rules : rules.map(maskWorkflowSecrets));
  } catch (_error) {
    res.status(500).json({ error: "Failed to fetch workflows" });
  }
});

// GET /:id — fetch a single automation rule by id (tenant-scoped).
// #418: brings workflows in line with sequences/contacts/deals/etc., where
// every resource exposes a direct GET /:id rather than forcing a list-scan.
// PUT /order - persist the execution order for the current tenant.
// The order is stored inside targetState to avoid changing the existing schema.
router.put("/order", async (req, res) => {
  try {
    const workflowIds = req.body?.workflowIds;
    if (!Array.isArray(workflowIds) || workflowIds.length === 0 || workflowIds.some((id) => !Number.isInteger(Number(id)) || Number(id) < 1)) {
      return res.status(400).json({ error: "workflowIds must be a non-empty array of positive integers" });
    }
    const ids = workflowIds.map((id) => Number(id));
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: "workflowIds must not contain duplicates" });
    const rules = await prisma.automationRule.findMany({ where: { tenantId: req.user.tenantId } });
    if (rules.length !== ids.length || rules.some((rule) => !ids.includes(rule.id))) {
      return res.status(400).json({ error: "workflowIds must include every workflow in the tenant" });
    }
    await prisma.$transaction(ids.map((id, order) => {
      const rule = rules.find((item) => item.id === id);
      let targetState = {};
      try { targetState = rule.targetState ? JSON.parse(rule.targetState) : {}; } catch (_error) { targetState = {}; }
      return prisma.automationRule.update({ where: { id: rule.id }, data: { targetState: JSON.stringify({ ...targetState, order }) } });
    }));
    res.json({ success: true, workflowIds: ids });
  } catch (error) {
    console.error("[Workflows] Order update error:", error.message);
    res.status(500).json({ error: "Failed to save workflow order" });
  }
});

// GET /stats/actions - successful action counts per workflow for the last seven days.
router.get("/stats/actions", async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const grouped = await prisma.auditLog.groupBy({
      by: ["entityId"],
      where: {
        tenantId: req.user.tenantId,
        entity: "AutomationRule",
        action: "WORKFLOW",
        createdAt: { gte: since },
      },
      _count: { _all: true },
    });
    res.json(Object.fromEntries(grouped.map((item) => [String(item.entityId), item._count._all])));
  } catch (error) {
    console.error("[Workflows] Stats error:", error.message);
    res.status(500).json({ error: "Failed to fetch workflow statistics" });
  }
});

// POST /test-webhook - test settings before saving a workflow.
router.post("/test-webhook", async (req, res) => {
  try {
    let config = req.body?.config || {};
    const workflowId = Number(req.body?.workflowId);
    if (Number.isInteger(workflowId) && workflowId > 0) {
      const existing = await prisma.automationRule.findFirst({ where: { id: workflowId, tenantId: req.user.tenantId } });
      if (!existing) return res.status(404).json({ error: "Workflow not found" });
      const previousTarget = parseTargetState(existing.targetState);
      const previousConfig = webhookConfigs(previousTarget, existing.actionType)[0]?.config || {};
      config = secureWebhookConfig(config, previousConfig);
    } else {
      validateWebhookConfig(config);
    }
    const { deliverConfiguredWebhook } = require("../lib/webhookDelivery");
    const { resolveTenantWebhookSecret } = require("../lib/webhookEntitlement");
    const { secret } = await resolveTenantWebhookSecret(req.user.tenantId);
    const payload = req.body?.payload || {
      contactId: 0,
      name: "Workflow test lead",
      email: req.user.email || "test@example.com",
      phone: "",
      status: "Test",
      source: "Meta",
      tags: ["TEST"],
      tenantId: req.user.tenantId,
      _test: true,
    };
    const result = await deliverConfiguredWebhook(config, req.body?.event || "contact.updated", payload, req.user.tenantId, secret);
    res.json({ success: true, result });
  } catch (error) {
    const status = /invalid|must|cannot|at most|valid JSON|required/i.test(error.message) ? 400 : 502;
    res.status(status).json({ error: error.message, result: error.webhookResult });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id < 1) {
      return res.status(400).json({ error: "id must be a positive integer", code: "INVALID_ID" });
    }
    const wf = await prisma.automationRule.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!wf) return res.status(404).json({ error: "Workflow not found" });
    res.json(maskWorkflowSecrets(wf));
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch workflow" });
  }
});

// Helper: validate that a triggerType / actionType is in the supported whitelist.
// #18: previously accepted any string; engine would silently log "Unknown actionType"
// at execute time. Now we reject at create/update time with 400 + machine code.
const TRIGGER_VALUES = TRIGGER_TYPES.map((t) => t.value);
const ACTION_VALUES = ACTION_TYPES.map((a) => a.value);

function validateTriggerAction({ triggerType, actionType }) {
  if (triggerType !== undefined) {
    const err = ensureEnum(triggerType, TRIGGER_VALUES, { field: "triggerType", code: "INVALID_TRIGGER_TYPE" });
    if (err) return { ...err, allowed: TRIGGER_VALUES };
  }
  if (actionType !== undefined) {
    const err = ensureEnum(actionType, ACTION_VALUES, { field: "actionType", code: "INVALID_ACTION_TYPE" });
    if (err) return { ...err, allowed: ACTION_VALUES };
  }
  return null;
}

// #20 — validate the optional `condition` JSON before persisting. Accepts:
//   - undefined / null / "" → no condition (always-fire, returns {ok:true,value:null})
//   - JSON-encoded array string of clauses {field,op,value}
//   - JSON-encoded workflow groups {groups:[{match,clauses:[...]}]}
//   - already-an-array (frontend may send the parsed shape)
// Returns {ok:true,value:<canonical-string-or-null>} or
//         {ok:false,status,error,code:"INVALID_CONDITION"}.
const VALID_CONDITION_OPS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "contains", "icontains", "startsWith", "exists",
]);

function validateCondition(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  let parsed;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (_e) {
      return { ok: false, status: 400, error: "condition is not valid JSON", code: "INVALID_CONDITION" };
    }
  } else {
    parsed = raw;
  }
  const groups = Array.isArray(parsed)
    ? [{ match: "all", clauses: parsed }]
    : parsed && Array.isArray(parsed.groups)
      ? parsed.groups
      : null;
  if (!groups) {
    return { ok: false, status: 400, error: "condition must be an array of clauses or grouped conditions", code: "INVALID_CONDITION" };
  }
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.clauses)) {
      return { ok: false, status: 400, error: "each condition group must contain a clauses array", code: "INVALID_CONDITION" };
    }
    if (group.match !== undefined && !["all", "any"].includes(group.match)) {
      return { ok: false, status: 400, error: "condition group match must be all or any", code: "INVALID_CONDITION" };
    }
  }
  for (const clause of groups.flatMap((group) => group.clauses)) {
    if (!clause || typeof clause !== "object" || Array.isArray(clause)) {
      return { ok: false, status: 400, error: "each condition clause must be an object", code: "INVALID_CONDITION" };
    }
    if (!clause.field || typeof clause.field !== "string") {
      return { ok: false, status: 400, error: "clause.field is required", code: "INVALID_CONDITION" };
    }
    if (!clause.op || !VALID_CONDITION_OPS.has(clause.op)) {
      return {
        ok: false,
        status: 400,
        error: `clause.op must be one of: ${Array.from(VALID_CONDITION_OPS).join(", ")}`,
        code: "INVALID_CONDITION",
      };
    }
    if (!("value" in clause)) {
      return { ok: false, status: 400, error: "clause.value is required", code: "INVALID_CONDITION" };
    }
  }
  return { ok: true, value: JSON.stringify(parsed) };
}

// POST / — create a new automation rule
router.post("/", async (req, res) => {
  try {
    const { name, triggerType, actionType, targetState, condition, isActive } = req.body;

    if (!name || !triggerType || !actionType) {
      return res.status(400).json({ error: "name, triggerType, and actionType are required" });
    }

    const enumErr = validateTriggerAction({ triggerType, actionType });
    if (enumErr) return res.status(enumErr.status).json(enumErr);

    const condCheck = validateCondition(condition);
    if (!condCheck.ok) {
      return res.status(condCheck.status).json({ error: condCheck.error, code: condCheck.code });
    }

    let preparedTarget;
    try { preparedTarget = prepareTargetState(targetState || {}, actionType); }
    catch (error) { return res.status(400).json({ error: error.message, code: "INVALID_WEBHOOK_CONFIG" }); }

    const newRule = await prisma.automationRule.create({
      data: {
        name,
        triggerType,
        actionType,
        targetState: JSON.stringify(preparedTarget),
        condition: condCheck.value,
        isActive: isActive === undefined ? true : !!isActive,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(maskWorkflowSecrets(newRule));
  } catch (error) {
    console.error("[Workflows] Create error:", error.message);
    res.status(500).json({ error: "Failed to save workflow" });
  }
});

// PUT /:id — update an existing rule
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    const { name, triggerType, actionType, targetState, isActive, condition } = req.body;

    // #18: enforce trigger/action whitelist on update too.
    const enumErr = validateTriggerAction({ triggerType, actionType });
    if (enumErr) return res.status(enumErr.status).json(enumErr);

    const data = {};
    if (name !== undefined) data.name = name;
    if (triggerType !== undefined) data.triggerType = triggerType;
    if (actionType !== undefined) data.actionType = actionType;
    if (targetState !== undefined) {
      try { data.targetState = JSON.stringify(prepareTargetState(targetState, actionType || existing.actionType, existing.targetState)); }
      catch (error) { return res.status(400).json({ error: error.message, code: "INVALID_WEBHOOK_CONFIG" }); }
    }
    // #20 — validate + persist condition. Allow explicit clear via null/"".
    if (condition !== undefined) {
      const condCheck = validateCondition(condition);
      if (!condCheck.ok) {
        return res.status(condCheck.status).json({ error: condCheck.error, code: condCheck.code });
      }
      data.condition = condCheck.value;
    }
    // #19: allow toggling isActive via PUT so the frontend rule-builder can
    // PATCH {isActive:false} without using the dedicated /toggle endpoint.
    if (isActive !== undefined) data.isActive = !!isActive;

    const updated = await prisma.automationRule.update({
      where: { id: existing.id },
      data,
    });
    res.json(maskWorkflowSecrets(updated));
  } catch (error) {
    console.error("[Workflows] Update error:", error.message);
    res.status(500).json({ error: "Failed to update workflow" });
  }
});

// DELETE /:id — delete an automation rule
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    await prisma.automationRule.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (_error) {
    res.status(500).json({ error: "Failed to delete workflow" });
  }
});

// PUT /:id/toggle — toggle isActive
router.put("/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    const rule = await prisma.automationRule.update({
      where: { id: existing.id },
      data: { isActive: !existing.isActive },
    });
    res.json(maskWorkflowSecrets(rule));
  } catch (_error) {
    res.status(500).json({ error: "Failed to toggle workflow" });
  }
});

// POST /:id/test — manually fire a rule with a mock payload
router.post("/:id/test", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    const { testRule } = require("../lib/eventBus");

    let targetState = {};
    try { targetState = existing.targetState ? JSON.parse(existing.targetState) : {}; } catch (_error) { targetState = {}; }
    const module = targetState.module || existing.triggerType.split(".")[0];
    const moduleConfig = {
      contact: { model: "contact", idKey: "contactId" },
      deal: { model: "deal", idKey: "dealId" },
      task: { model: "task", idKey: "taskId" },
      ticket: { model: "ticket", idKey: "ticketId" },
    }[module];
    let recordPayload = {};
    if (!req.body.payload && moduleConfig && prisma[moduleConfig.model]) {
      const requestedId = Number(req.body[moduleConfig.idKey]);
      const where = { tenantId: req.user.tenantId };
      if (Number.isInteger(requestedId) && requestedId > 0) where.id = requestedId;
      const record = await prisma[moduleConfig.model].findFirst({
        where,
        ...(!where.id ? { orderBy: { createdAt: "desc" } } : {}),
      });
      if (record) recordPayload = { ...record, [moduleConfig.idKey]: record.id };
    }

    const mockPayload = {
      userId: req.user.userId,
      tenantId: req.user.tenantId,
      email: req.body.email || req.user.email,
      phone: req.body.phone || null,
      ...recordPayload,
      ...(req.body.payload || {}),
      _test: true,
    };

    const result = await testRule(existing, mockPayload, req.user.tenantId, req.app.get("io"));

    res.json({
      success: result.failed === 0,
      result,
      message: result.conditionsMatched
        ? `Test fired for rule "${existing.name}" with trigger ${existing.triggerType}`
        : `Test payload did not match the conditions for rule "${existing.name}" with trigger ${existing.triggerType}`,
    });
  } catch (error) {
    console.error("[Workflows] Test error:", error.message);
    res.status(500).json({ error: "Failed to test workflow" });
  }
});

module.exports = router;
