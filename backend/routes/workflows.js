const express = require("express");
const prisma = require("../lib/prisma");
const { ensureEnum } = require("../lib/validators");
const { resolveConfiguredWebhookUrl } = require("../lib/webhookDelivery");
const { encryptCredential, looksLikeMaskedSentinel, maskCredential } = require("../lib/credentialMasking");
const { requirePermission } = require("../middleware/requirePermission");
// Triggers, actions, operators and mutable-entity metadata used to be declared
// here AND in lib/eventBus.js AND again in the React builder, and had drifted:
// operators the engine implemented were unreachable from the UI, and a trigger
// with no emit site anywhere was still offered in the dropdown. One source of
// truth now.
const workflowSchema = require("../lib/workflowSchema");
const {
  SCHEDULE_ENTITIES,
  SCHEDULE_TRIGGERS,
  isScheduleTrigger,
  validateScheduleConfig,
  nextRecurringRun,
} = require("../lib/workflowSchedule");

const router = express.Router();

// RBAC. The `workflows` permission set (read/write/update/delete/manage) has
// existed in lib/permissionCatalog.js since the RBAC migration but this router
// never enforced it, so any authenticated user — including a plain agent —
// could create, edit, reorder or delete tenant-wide automation, and read back
// every rule's webhook configuration. Freshsales restricts workflows to
// admins; these guards are the equivalent.
const canRead = requirePermission("workflows", "read");
const canWrite = requirePermission("workflows", "write");
const canUpdate = requirePermission("workflows", "update");
const canDelete = requirePermission("workflows", "delete");

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

// ── Catalogue endpoints ──────────────────────────────────────────────
// TRIGGER_TYPES / ACTION_TYPES were maintained here, in lib/eventBus.js and
// again in the React builder. They had drifted: `nin` and `exists` worked in
// the engine but were missing from the UI's operator list, and
// `invoice.overdue` was advertised with no emitter anywhere. All of it now
// comes from lib/workflowSchema.js, and `publicTriggers()` filters out any
// trigger without a real emit site so the dropdown can never again offer
// something that cannot fire.
const TRIGGER_TYPES = workflowSchema.publicTriggers();
const ACTION_TYPES = workflowSchema.ACTION_TYPES;

// GET /triggers — supported trigger types (optionally scoped to a module)
router.get("/triggers", canRead, (req, res) => {
  const module = req.query.module;
  res.json(module ? workflowSchema.triggersForModule(module) : TRIGGER_TYPES);
});

// GET /actions — supported action types (optionally scoped to a module)
router.get("/actions", canRead, (req, res) => {
  const module = req.query.module;
  res.json(module ? workflowSchema.actionsForModule(module) : ACTION_TYPES);
});

// GET /schema — everything the builder needs in one round trip: modules,
// triggers, actions, condition operators, condition fields, and the schedule
// entity/date-field catalogue for time-based rules.
router.get("/schema", canRead, (req, res) => {
  res.json({
    modules: workflowSchema.MODULES,
    triggers: TRIGGER_TYPES,
    actions: ACTION_TYPES,
    operators: workflowSchema.CONDITION_OPS,
    fields: workflowSchema.FIELD_OPTIONS,
    scheduleTriggers: SCHEDULE_TRIGGERS,
    scheduleEntities: Object.fromEntries(
      Object.entries(SCHEDULE_ENTITIES).map(([key, value]) => [key, { dateFields: value.dateFields }]),
    ),
  });
});

// GET /email-templates — picker source for the send_email action's template
// field. Kept here (rather than making the builder call the templates API) so
// one `workflows.read` grant is enough to configure a workflow end to end.
router.get("/email-templates", canRead, async (req, res) => {
  try {
    const templates = await prisma.emailTemplate.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, name: true, subject: true, category: true },
      orderBy: { name: "asc" },
    });
    res.json(templates);
  } catch (error) {
    console.error("[Workflows] Email template list error:", error.message);
    res.status(500).json({ error: "Failed to fetch email templates", code: "WORKFLOW_TEMPLATES_FAILED" });
  }
});

// GET /sequences — picker source for add_to_sequence / remove_from_sequence.
router.get("/sequences", canRead, async (req, res) => {
  try {
    const sequences = await prisma.sequence.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    });
    res.json(sequences);
  } catch (error) {
    console.error("[Workflows] Sequence list error:", error.message);
    res.status(500).json({ error: "Failed to fetch sequences", code: "WORKFLOW_SEQUENCES_FAILED" });
  }
});

// GET /assignees — picker source for assign_agent / create_task / appointments.
router.get("/assignees", canRead, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { id: "asc" },
    });
    res.json(users);
  } catch (error) {
    console.error("[Workflows] Assignee list error:", error.message);
    res.status(500).json({ error: "Failed to fetch assignees", code: "WORKFLOW_ASSIGNEES_FAILED" });
  }
});

/**
 * GET /history — workflow execution log.
 *
 * Reads WorkflowExecution rather than scanning AuditLog. The old endpoint
 * returned the last 50 rows for the WHOLE tenant and left the client to filter
 * by workflow id, so on a busy tenant clicking "View history" on a real
 * workflow showed "No actions found" — its rows had already been pushed out of
 * the window by other workflows. Filtering and pagination are server-side now.
 *
 * Query: workflowId, status (success|failed|skipped|all), days, contactId,
 *        limit, offset.
 */
router.get("/history", canRead, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const where = { tenantId: req.user.tenantId };

    const workflowId = parseInt(req.query.workflowId, 10);
    if (Number.isInteger(workflowId) && workflowId > 0) where.ruleId = workflowId;

    const status = String(req.query.status || "all").toLowerCase();
    if (status === "failed") where.status = "FAILED";
    else if (status === "success") where.status = "SUCCESS";
    else if (status === "skipped") where.status = "SKIPPED";

    const days = parseInt(req.query.days, 10);
    if (Number.isInteger(days) && days > 0) {
      where.createdAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
    }

    const contactId = parseInt(req.query.contactId, 10);
    if (Number.isInteger(contactId) && contactId > 0) where.contactId = contactId;

    const [logs, total] = await Promise.all([
      prisma.workflowExecution.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: { rule: { select: { id: true, name: true } } },
      }),
      prisma.workflowExecution.count({ where }),
    ]);

    res.json({
      logs: logs.map((log) => ({
        id: log.id,
        workflowId: log.ruleId,
        workflowName: log.rule?.name || null,
        triggerType: log.triggerType,
        actionType: log.actionType,
        // A real column. Previously the client inferred failure by regex-testing
        // the raw details JSON for the substring "fail", so a deal whose lost
        // reason mentioned failure was reported as a failed execution.
        status: log.status,
        error: log.error,
        recordKey: log.recordKey,
        contactId: log.contactId,
        // Denormalised at write time. The old panel read `log.contactName` off
        // an AuditLog row, a field that model has never had, so this column
        // rendered the rule's own id for every single row.
        contactLabel: log.entityLabel,
        durationMs: log.durationMs,
        isTest: log.isTest,
        details: log.details,
        createdAt: log.createdAt,
      })),
      total,
      limit,
      offset,
      hasMore: offset + logs.length < total,
    });
  } catch (error) {
    console.error("[Workflows] History error:", error.message);
    res.status(500).json({ error: "Failed to fetch workflow history", code: "WORKFLOW_HISTORY_FAILED" });
  }
});

// GET / — list all automation rules for tenant
router.get("/", canRead, async (req, res) => {
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
      // Parity additions. The list row renders "Last updated <date>" and the
      // failure banner, and before these columns existed it fell back to
      // `workflow.updatedAt || workflow.createdAt` on a model that had
      // neither — so every row permanently read "Not run yet".
      sortOrder: true,
      createdAt: true,
      updatedAt: true,
      lastRunAt: true,
      lastError: true,
      runCount: true,
      failureCount: true,
      consecutiveFailures: true,
      autoDisabledAt: true,
      nextScheduledAt: true,
    };
    const findArgs = { where: { tenantId: req.user.tenantId } };
    if (isSummary) findArgs.select = slimSelect;
    const rules = await prisma.automationRule.findMany(findArgs);
    res.json(isSummary ? rules : rules.map(maskWorkflowSecrets));
  } catch (error) {
    console.error("[Workflows] List error:", error.message);
    res.status(500).json({ error: "Failed to fetch workflows", code: "WORKFLOW_LIST_FAILED" });
  }
});

// GET /:id — fetch a single automation rule by id (tenant-scoped).
// #418: brings workflows in line with sequences/contacts/deals/etc., where
// every resource exposes a direct GET /:id rather than forcing a list-scan.
// PUT /order - persist the execution order for the current tenant.
// The order is stored inside targetState to avoid changing the existing schema.
router.put("/order", canUpdate, async (req, res) => {
  try {
    const workflowIds = req.body?.workflowIds;
    if (!Array.isArray(workflowIds) || workflowIds.length === 0 || workflowIds.some((id) => !Number.isInteger(Number(id)) || Number(id) < 1)) {
      return res.status(400).json({ error: "workflowIds must be a non-empty array of positive integers" });
    }
    const ids = workflowIds.map((id) => Number(id));
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: "workflowIds must not contain duplicates" });
    const rules = await prisma.automationRule.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true },
    });
    if (rules.length !== ids.length || rules.some((rule) => !ids.includes(rule.id))) {
      return res.status(400).json({ error: "workflowIds must include every workflow in the tenant" });
    }
    // Writes the real `sortOrder` column. Previously the position was smuggled
    // into the targetState JSON blob, so reordering rewrote every rule's entire
    // configuration — a parse failure on one rule silently reset that rule's
    // whole config to `{order:n}` — and the engine had to JSON.parse every rule
    // just to sort them.
    await prisma.$transaction(ids.map((id, order) => prisma.automationRule.update({
      where: { id },
      data: { sortOrder: order, updatedById: req.user.userId },
    })));
    res.json({ success: true, workflowIds: ids });
  } catch (error) {
    console.error("[Workflows] Order update error:", error.message);
    res.status(500).json({ error: "Failed to save workflow order", code: "WORKFLOW_ORDER_FAILED" });
  }
});

// GET /stats/actions - successful action counts per workflow for the last seven days.
router.get("/stats/actions", canRead, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Reads the execution log, not AuditLog, and excludes manual test fires so
    // the "N successful actions" counter reflects real traffic.
    const grouped = await prisma.workflowExecution.groupBy({
      by: ["ruleId"],
      where: {
        tenantId: req.user.tenantId,
        status: "SUCCESS",
        isTest: false,
        createdAt: { gte: since },
      },
      _count: { _all: true },
    });
    res.json(Object.fromEntries(grouped.map((item) => [String(item.ruleId), item._count._all])));
  } catch (error) {
    console.error("[Workflows] Stats error:", error.message);
    res.status(500).json({ error: "Failed to fetch workflow statistics", code: "WORKFLOW_STATS_FAILED" });
  }
});

// POST /test-webhook - test settings before saving a workflow.
router.post("/test-webhook", canWrite, async (req, res) => {
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

router.get("/:id", canRead, async (req, res) => {
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
  } catch (error) {
    console.error("[Workflows] Fetch error:", error.message);
    res.status(500).json({ error: "Failed to fetch workflow", code: "WORKFLOW_FETCH_FAILED" });
  }
});

// Prisma P2000 = "value too long for the column". This used to reach the caller
// as a bare HTTP 500: AutomationRule.targetState was varchar(191) while the
// builder writes the whole workflow JSON into it, so every non-trivial save
// failed with an untraceable "something went wrong" toast. targetState is now
// @db.Text, but `name` is still varchar(191) — surface that class of failure as
// a 400 the user can actually act on instead of a generic server error.
function writeFailure(res, error, fallbackMessage, fallbackCode) {
  if (error?.code === "P2000") {
    const column = error?.meta?.column_name || error?.meta?.target || "a field";
    return res.status(400).json({ error: `Value too long for ${column} — please shorten it.`, code: "VALUE_TOO_LONG" });
  }
  return res.status(500).json({ error: fallbackMessage, code: fallbackCode });
}

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
// Was a hand-maintained list that had to be kept in step with the engine's
// switch and the builder's dropdown by hand — and wasn't: `exists` and `nin`
// passed validation here and worked in the engine but never reached the UI.
const VALID_CONDITION_OPS = new Set(workflowSchema.CONDITION_OP_VALUES);

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
router.post("/", canWrite, async (req, res) => {
  try {
    const { name, triggerType, actionType, targetState, condition, isActive, scheduleConfig } = req.body;

    if (!name || !triggerType || !actionType) {
      return res.status(400).json({ error: "name, triggerType, and actionType are required" });
    }

    const enumErr = validateTriggerAction({ triggerType, actionType });
    if (enumErr) return res.status(enumErr.status).json(enumErr);

    const condCheck = validateCondition(condition);
    if (!condCheck.ok) {
      return res.status(condCheck.status).json({ error: condCheck.error, code: condCheck.code });
    }

    // Time-based rules carry their cadence in scheduleConfig; the validator
    // also rejects a schedule attached to an event-driven trigger, which would
    // otherwise look scheduled in the builder and never run.
    const schedCheck = validateScheduleConfig(scheduleConfig, triggerType);
    if (!schedCheck.ok) {
      return res.status(400).json({ error: schedCheck.error, code: schedCheck.code });
    }
    if (isScheduleTrigger(triggerType) && !schedCheck.value) {
      return res.status(400).json({ error: "A scheduled workflow needs a scheduleConfig", code: "INVALID_SCHEDULE" });
    }

    let preparedTarget;
    try { preparedTarget = prepareTargetState(targetState || {}, actionType); }
    catch (error) { return res.status(400).json({ error: error.message, code: "INVALID_WEBHOOK_CONFIG" }); }

    // New rules go to the end of the execution order rather than colliding on
    // 0 with everything else in the tenant.
    const maxOrder = await prisma.automationRule.aggregate({
      where: { tenantId: req.user.tenantId },
      _max: { sortOrder: true },
    });

    const newRule = await prisma.automationRule.create({
      data: {
        name,
        triggerType,
        actionType,
        targetState: JSON.stringify(preparedTarget),
        condition: condCheck.value,
        isActive: isActive === undefined ? true : !!isActive,
        scheduleConfig: schedCheck.value ? JSON.stringify(schedCheck.value) : null,
        nextScheduledAt: schedCheck.value?.mode === "recurring"
          ? nextRecurringRun(schedCheck.value, new Date())
          : null,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
        // `createdById` is a real column as of the parity migration. The engine
        // has referenced `rule.createdById` (as the fallback requester for the
        // create_approval action) since long before the column existed.
        createdById: req.user.userId,
        updatedById: req.user.userId,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(maskWorkflowSecrets(newRule));
  } catch (error) {
    console.error("[Workflows] Create error:", error.message);
    writeFailure(res, error, "Failed to save workflow", "WORKFLOW_CREATE_FAILED");
  }
});

// PUT /:id — update an existing rule
router.put("/:id", canUpdate, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    const { name, triggerType, actionType, targetState, isActive, condition, scheduleConfig } = req.body;

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
    if (isActive !== undefined) {
      data.isActive = !!isActive;
      // Re-enabling clears the auto-disable state, so a rule the failure guard
      // paused starts from a clean slate instead of tripping again on the next
      // single failure.
      if (isActive) {
        data.autoDisabledAt = null;
        data.consecutiveFailures = 0;
        data.lastError = null;
      }
    }

    // Schedule validated against the EFFECTIVE trigger (the incoming one when
    // supplied, otherwise the stored one) so switching a rule from event-driven
    // to scheduled — or back — is checked correctly.
    const effectiveTrigger = triggerType !== undefined ? triggerType : existing.triggerType;
    if (scheduleConfig !== undefined) {
      const schedCheck = validateScheduleConfig(scheduleConfig, effectiveTrigger);
      if (!schedCheck.ok) {
        return res.status(400).json({ error: schedCheck.error, code: schedCheck.code });
      }
      data.scheduleConfig = schedCheck.value ? JSON.stringify(schedCheck.value) : null;
      data.nextScheduledAt = schedCheck.value?.mode === "recurring"
        ? nextRecurringRun(schedCheck.value, new Date())
        : null;
    } else if (triggerType !== undefined && !isScheduleTrigger(triggerType) && existing.scheduleConfig) {
      // Converted away from a scheduled trigger — drop the now-meaningless
      // schedule instead of leaving the cron a rule it can never fire.
      data.scheduleConfig = null;
      data.nextScheduledAt = null;
    }

    if (isScheduleTrigger(effectiveTrigger)
      && !(data.scheduleConfig ?? existing.scheduleConfig)) {
      return res.status(400).json({ error: "A scheduled workflow needs a scheduleConfig", code: "INVALID_SCHEDULE" });
    }

    data.updatedById = req.user.userId;

    const updated = await prisma.automationRule.update({
      where: { id: existing.id },
      data,
    });
    res.json(maskWorkflowSecrets(updated));
  } catch (error) {
    console.error("[Workflows] Update error:", error.message);
    writeFailure(res, error, "Failed to update workflow", "WORKFLOW_UPDATE_FAILED");
  }
});

// DELETE /:id — delete an automation rule
router.delete("/:id", canDelete, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    await prisma.automationRule.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (error) {
    console.error("[Workflows] Delete error:", error.message);
    res.status(500).json({ error: "Failed to delete workflow", code: "WORKFLOW_DELETE_FAILED" });
  }
});

// PUT /:id/toggle — toggle isActive
router.put("/:id/toggle", canUpdate, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    const enabling = !existing.isActive;
    const rule = await prisma.automationRule.update({
      where: { id: existing.id },
      data: {
        isActive: enabling,
        updatedById: req.user.userId,
        // Turning a rule back on clears whatever the failure guard recorded,
        // otherwise a rule it paused would trip again on its very next failure
        // instead of getting a fresh run of attempts.
        ...(enabling ? { autoDisabledAt: null, consecutiveFailures: 0, lastError: null } : {}),
      },
    });
    res.json(maskWorkflowSecrets(rule));
  } catch (error) {
    console.error("[Workflows] Toggle error:", error.message);
    res.status(500).json({ error: "Failed to toggle workflow", code: "WORKFLOW_TOGGLE_FAILED" });
  }
});

// POST /:id/test — manually fire a rule with a mock payload
router.post("/:id/test", canWrite, async (req, res) => {
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
    res.status(500).json({ error: "Failed to test workflow", code: "WORKFLOW_TEST_FAILED" });
  }
});

/**
 * POST /:id/run-now — apply a workflow to records that already exist.
 *
 * Freshsales lets an author backfill a workflow over the records that matched
 * before it was switched on; without it, a rule only ever affects records
 * touched after creation, and there was no way to catch up.
 *
 * Two modes:
 *   • A scheduled rule runs its normal scheduler pass immediately.
 *   • An event-driven rule is replayed over its module's existing records, with
 *     its own conditions applied to each.
 *
 * `dryRun` (the default) evaluates conditions and reports how many records
 * WOULD be affected without executing a single action — so nobody discovers
 * the blast radius by emailing 4,000 contacts.
 */
router.post("/:id/run-now", canWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "id must be a positive integer", code: "INVALID_ID" });
    }
    const rule = await prisma.automationRule.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!rule) return res.status(404).json({ error: "Workflow not found" });

    const dryRun = req.body?.dryRun !== false;
    const limit = Math.min(Math.max(parseInt(req.body?.limit, 10) || 100, 1), 1000);

    if (isScheduleTrigger(rule.triggerType)) {
      const { runScheduledRule } = require("../cron/workflowScheduler");
      if (dryRun) {
        return res.json({
          success: true,
          dryRun: true,
          message: "This is a scheduled workflow. Running it now performs one scheduler pass over its matching records.",
        });
      }
      const result = await runScheduledRule(rule, new Date(), req.app.get("io"));
      return res.json({ success: true, dryRun: false, ...result });
    }

    // Which record set to replay over: the builder stores the module on
    // targetState, and the trigger prefix is the fallback for older rules.
    let target = {};
    try { target = rule.targetState ? JSON.parse(rule.targetState) : {}; } catch (_error) { target = {}; }
    const moduleName = target.module || rule.triggerType.split(".")[0];
    const entityConfig = workflowSchema.WORKFLOW_ENTITIES[moduleName];
    if (!entityConfig) {
      return res.status(400).json({
        error: `Run-now supports ${Object.keys(workflowSchema.WORKFLOW_ENTITIES).join(", ")} workflows only`,
        code: "RUN_NOW_UNSUPPORTED",
      });
    }

    const eventBus = require("../lib/eventBus");
    const where = { tenantId: req.user.tenantId };
    if (entityConfig.softDelete) where.deletedAt = null;

    const records = await prisma[entityConfig.model].findMany({
      where,
      take: limit + 1,
      orderBy: { id: "desc" },
    });
    const truncated = records.length > limit;
    const batch = truncated ? records.slice(0, limit) : records;

    let matched = 0;
    let fired = 0;
    let failed = 0;

    for (const record of batch) {
      const payload = {
        ...record,
        [entityConfig.idKey]: record.id,
        userId: req.user.userId,
        contactId: record.contactId ?? (moduleName === "contact" ? record.id : null),
      };
      if (!eventBus.evaluateCondition(rule.condition, payload)) continue;
      matched += 1;
      if (dryRun) continue;
      try {
        await eventBus.executeAction(rule, payload, req.user.tenantId, req.app.get("io"), 0);
        fired += 1;
      } catch (error) {
        failed += 1;
        await eventBus.recordWorkflowExecution(rule, payload, req.user.tenantId, { status: "FAILED", error });
      }
    }

    res.json({
      success: true,
      dryRun,
      module: moduleName,
      examined: batch.length,
      matched,
      fired,
      failed,
      truncated,
      message: dryRun
        ? `${matched} of ${batch.length} existing ${moduleName} records match this workflow's conditions. Re-run with dryRun:false to apply it.`
        : `Applied to ${fired} ${moduleName} record(s)${failed ? `, ${failed} failed` : ""}.`,
    });
  } catch (error) {
    console.error("[Workflows] Run-now error:", error.message);
    res.status(500).json({ error: "Failed to run workflow", code: "WORKFLOW_RUN_NOW_FAILED" });
  }
});

/**
 * GET /:id/health — execution health for one workflow.
 * Backs the builder's failure banner and the "why did this switch itself off?"
 * question that auto-disable would otherwise answer only in the server log.
 */
router.get("/:id/health", canRead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "id must be a positive integer", code: "INVALID_ID" });
    }
    const rule = await prisma.automationRule.findFirst({
      where: { id, tenantId: req.user.tenantId },
      select: {
        id: true, name: true, isActive: true, lastRunAt: true, lastError: true,
        runCount: true, failureCount: true, consecutiveFailures: true,
        autoDisabledAt: true, nextScheduledAt: true, createdAt: true, updatedAt: true,
      },
    });
    if (!rule) return res.status(404).json({ error: "Workflow not found" });

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [recent, pending] = await Promise.all([
      prisma.workflowExecution.groupBy({
        by: ["status"],
        where: { tenantId: req.user.tenantId, ruleId: id, isTest: false, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.workflowScheduledAction.count({
        where: { tenantId: req.user.tenantId, ruleId: id, status: "PENDING" },
      }),
    ]);

    res.json({
      ...rule,
      autoDisabled: !!rule.autoDisabledAt,
      pendingDelayedActions: pending,
      last7Days: Object.fromEntries(recent.map((row) => [row.status, row._count._all])),
    });
  } catch (error) {
    console.error("[Workflows] Health error:", error.message);
    res.status(500).json({ error: "Failed to fetch workflow health", code: "WORKFLOW_HEALTH_FAILED" });
  }
});

module.exports = router;
