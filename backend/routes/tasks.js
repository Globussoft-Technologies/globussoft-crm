const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { requirePermission, userHasPermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { ensureEnum, ensureDateInRange } = require("../lib/validators");
const { writeAudit, diffFields } = require("../lib/audit");
const { parseDateTimeLocalInTZ } = require("../lib/datetime");
const { summarizeMessages } = require("../lib/leadConversationSummary");
const { notify, notifyMany } = require("../lib/notificationService");
const { sendEmail } = require("../lib/emailSender");
const { toE164 } = require("../utils/deduplication");

const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

// #313 datetime callsite-sweep: HTML <input type="datetime-local"> emits
// strings shaped 'YYYY-MM-DDTHH:mm' with NO TZ marker. Naive `new Date(input)`
// parses such strings using the *server* timezone — on the production demo
// box (UTC) a 10:30 IST appointment landed at 10:30 UTC = 16:00 IST after
// re-render, drifting the wall-clock by 5h30. We pin parsing to Asia/Kolkata
// (the product-anchored TZ, identical to routes/wellness.js's WELLNESS_TZ
// — same rationale: India-based deployments, cron schedules at IST hours)
// so the user's typed wall-clock survives the round-trip regardless of
// where the backend runs. Full ISO timestamps (with 'Z' or '±HH:mm' suffix)
// carry their TZ in-band; the native Date constructor is correct for those
// and we pass them through unchanged.
const TASKS_TZ = "Asia/Kolkata";
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
function parseTenantDateInput(input) {
  if (input == null) return null;
  if (input instanceof Date) return input;
  if (typeof input !== "string") return new Date(input);
  if (DATETIME_LOCAL_RE.test(input)) {
    return parseDateTimeLocalInTZ(input, TASKS_TZ);
  }
  return new Date(input);
}
// #163: enums used elsewhere in the app — surfaced as strict checks instead of
// silent coercion to "Pending".
const ALLOWED_TASK_STATUSES = new Set(["Pending", "In Progress", "In Process", "Completed", "Cancelled"]);
const TRAVEL_TASK_STATUSES = new Set(["Pending", "In Process", "Completed"]);
const ALLOWED_TASK_PRIORITIES = new Set(["Low", "Medium", "High", "Critical"]);
// Lead Reports cluster: activity kind + visit result. Both columns are
// nullable, so omitting them keeps the pre-existing task shape verbatim.
// "Meeting" / "Site Visit" are what routes/lead_reports.js reads to build the
// daily meetings-and-site-visits and visit-done-not-booked reports.
const ALLOWED_TASK_TYPES = new Set(["Task", "Call", "Meeting", "Site Visit", "Follow Up"]);
const ALLOWED_TASK_OUTCOMES = new Set([
  "pending",
  "booked",
  "interested",
  "not_interested",
  "reschedule",
  "no_show",
]);
const VALID_EXTENSION_SOURCES = new Set(["gmail", "whatsapp"]);
function canViewAllTasks(req) {
  return ["ADMIN", "MANAGER", "OWNER"].includes(String(req.user?.role || "").toUpperCase());
}

async function isTravelTenant(req) {
  if (req.user?.vertical) return req.user.vertical === "travel";
  if (!req.user?.tenantId) return false;
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    select: { vertical: true },
  });
  req.user.vertical = tenant?.vertical || "generic";
  return req.user.vertical === "travel";
}

function normalizeTaskStatusForTenant(status, travelTenant) {
  if (!travelTenant) return status;
  if (status === "In Progress") return "In Process";
  return status;
}

function emailConfigured() {
  return Boolean(process.env.SENDGRID_API_KEY);
}

async function getWhatsappReadiness(tenantId) {
  const config = await prisma.whatsAppConfig.findFirst({
    where: { tenantId, isActive: true, disconnectedAt: null },
    select: { id: true, phoneNumberId: true, businessRestricted: true },
  });
  if (!config) return { configured: false, reason: "No active WhatsApp provider configured" };
  if (!config.phoneNumberId) return { configured: false, reason: "WhatsApp phone number ID is missing" };
  if (config.businessRestricted) return { configured: false, reason: "WhatsApp business account is restricted" };
  return { configured: true, reason: null, config };
}

function taskAssignmentText(task, assignee) {
  const due = task.dueDate ? new Date(task.dueDate).toLocaleString("en-IN", { timeZone: TASKS_TZ }) : "No due date set";
  const assigneeName = assignee?.name || assignee?.email || "there";
  return {
    subject: `New Travel CRM task: ${task.title}`,
    text: [
      `Hi ${assigneeName},`,
      "",
      `A Travel CRM task has been assigned to you: ${task.title}`,
      `Status: ${task.status || "Pending"}`,
      `Priority: ${task.priority || "Medium"}`,
      `Due: ${due}`,
      "",
      "Open your CRM task queue to update it as Pending, In Process, or Completed.",
    ].join("\n"),
    whatsapp: `New Travel CRM task assigned: ${task.title}\nPriority: ${task.priority || "Medium"}\nDue: ${due}\nUpdate it in CRM: Pending, In Process, or Completed.`,
  };
}

async function queueTravelTaskWhatsapp({ task, assignee, actorId, tenantId }) {
  const phone = toE164(assignee?.phone);
  if (!phone) {
    return { channel: "whatsapp", status: "skipped", configured: null, reason: "Assignee has no valid phone number", recipient: null };
  }

  const readiness = await getWhatsappReadiness(tenantId);
  if (!readiness.configured) {
    return { channel: "whatsapp", status: "skipped", configured: false, reason: readiness.reason, recipient: phone };
  }

  const optOut = await prisma.whatsAppOptOut.findUnique({
    where: { tenantId_contactPhone: { tenantId, contactPhone: phone } },
    select: { capturedAt: true, reason: true },
  });
  if (optOut) {
    return { channel: "whatsapp", status: "skipped", configured: true, reason: "Assignee has opted out of WhatsApp messages", recipient: phone };
  }

  const content = taskAssignmentText(task, assignee);
  let thread = await prisma.whatsAppThread.upsert({
    where: { tenantId_contactPhone: { tenantId, contactPhone: phone } },
    create: {
      tenantId,
      contactPhone: phone,
      contactName: assignee?.name || assignee?.email || null,
      status: "OPEN",
      lastMessageAt: new Date(),
    },
    update: { lastMessageAt: new Date() },
  });
  if (thread.status === "CLOSED") {
    thread = await prisma.whatsAppThread.update({
      where: { id: thread.id },
      data: { status: "OPEN" },
    });
  }

  const message = await prisma.whatsAppMessage.create({
    data: {
      to: phone,
      from: readiness.config.phoneNumberId || "",
      body: content.whatsapp,
      direction: "OUTBOUND",
      status: "QUEUED",
      userId: actorId || null,
      tenantId,
      threadId: thread.id,
    },
  });

  try {
    const { getQueue } = require("../lib/whatsappQueue");
    await getQueue().enqueueSend({ messageId: message.id, tenantId });
    return { channel: "whatsapp", status: "queued", configured: true, reason: null, recipient: phone, messageId: message.id };
  } catch (err) {
    await prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: { status: "FAILED", errorMessage: `enqueue failed: ${err.message}` },
    }).catch(() => {});
    return { channel: "whatsapp", status: "failed", configured: true, reason: "WhatsApp queue failed", recipient: phone, messageId: message.id };
  }
}

async function notifyTravelTaskAssignment({ task, actorId, tenantId }) {
  if (!task?.userId) {
    return {
      required: true,
      attempted: false,
      reason: "Task is not assigned to a member",
      channels: [],
    };
  }
  if (!task.dueDate) {
    return {
      required: true,
      attempted: false,
      reason: "Set a due date/time to trigger assignment notifications",
      channels: [],
    };
  }

  const assignee = task.user || await prisma.user.findFirst({
    where: { id: task.userId, tenantId },
    select: { id: true, name: true, email: true, phone: true },
  });
  if (!assignee) {
    return { required: true, attempted: false, reason: "Assignee was not found", channels: [] };
  }

  const content = taskAssignmentText(task, assignee);
  const channels = [];
  if (!assignee.email) {
    channels.push({ channel: "email", status: "skipped", configured: emailConfigured(), reason: "Assignee has no email address", recipient: null });
  } else if (!emailConfigured()) {
    channels.push({ channel: "email", status: "skipped", configured: false, reason: "SendGrid is not configured", recipient: assignee.email });
  } else {
    const result = await sendEmail({
      to: assignee.email,
      subject: content.subject,
      text: content.text,
      html: content.text.replace(/\n/g, "<br>"),
    });
    channels.push({
      channel: "email",
      status: result.sent ? "sent" : "failed",
      configured: true,
      reason: result.sent ? null : (result.reason || "Email provider rejected the message"),
      recipient: assignee.email,
    });
  }

  channels.push(await queueTravelTaskWhatsapp({ task, assignee, actorId, tenantId }));
  return { required: true, attempted: true, reason: null, channels };
}

async function notifyTaskAssignee({ task, actorId, tenantId, io, reassigned = false }) {
  if (!task.userId || task.userId === actorId) return;
  await notify({
    userId: task.userId,
    tenantId,
    title: reassigned ? "Task reassigned to you" : "New task assigned",
    message: (reassigned ? "A task was reassigned to you" : "A new task was assigned to you") + ": \"" + task.title + "\".",
    type: "task",
    priority: task.priority === "Critical" ? "high" : "normal",
    link: "/tasks",
    entityType: "Task",
    entityId: task.id,
    category: "task",
    dedupWindowHours: 0,
    io,
  });
}


function compactTaskText(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 15).trimEnd()}...`;
}

function normalizeExtensionTaskMessages(body) {
  const capturedAt = body.capturedAt ? new Date(body.capturedAt) : new Date();
  const validCapturedAt = Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt;

  if (body.source === "gmail") {
    return [
      {
        direction: "INBOUND",
        body: [body.subject ? `Subject: ${body.subject}` : null, body.body || ""]
          .filter(Boolean)
          .join("\n\n"),
        createdAt: validCapturedAt,
      },
    ].filter((m) => m.body.trim());
  }

  return (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && String(m.text || "").trim())
    .map((m) => ({
      direction: m.direction === "out" ? "OUTBOUND" : "INBOUND",
      body: m.text,
      createdAt: validCapturedAt,
    }));
}

function extensionTaskCustomerName(body) {
  if (body.source === "gmail") {
    const senderRaw = String(body.sender || "").trim();
    const m = senderRaw.match(/^(.*?)\s*<([^<>]+)>\s*$/);
    return (m && m[1] && m[1].trim()) || senderRaw || "Email sender";
  }
  return body.chatName || "WhatsApp chat";
}

function extensionTaskTitle(body) {
  if (body.source === "gmail") return body.subject || "Follow up on captured email";
  return body.chatName ? `Follow up: ${body.chatName}` : "Follow up on WhatsApp chat";
}

function taskNotesFromSummary(summary) {
  const highlights = Array.isArray(summary.highlights) ? summary.highlights : [];
  return [
    summary.purpose,
    highlights.length ? `Key: ${highlights.join("; ")}` : "",
    summary.leadStage ? `Stage: ${summary.leadStage}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}
function taskResolutionNote(notes) {
  const text = String(notes || "");
  if (!text.startsWith("__task_meta__")) return "";
  try {
    const meta = JSON.parse(text.slice("__task_meta__".length));
    return String(meta.r || "").trim();
  } catch (_e) {
    return "";
  }
}

async function notifyTaskCompletionAdmins({ task, actorId, tenantId, io }) {
  if (!prisma.user || typeof prisma.user.findMany !== "function") return;
  const admins = await prisma.user.findMany({
    where: {
      tenantId,
      OR: [
        { role: { in: ["ADMIN", "MANAGER", "OWNER"] } },
        { userType: "OWNER" },
      ],
    },
    select: { id: true },
  });
  const userIds = admins.map((u) => u.id).filter((id) => id && id !== actorId);
  if (!userIds.length) return;

  const note = taskResolutionNote(task.notes);
  await notifyMany({
    userIds,
    tenantId,
    title: "Task resolved",
    message: `Task "${task.title}" was resolved.${note ? ` Resolution note: ${note}` : ""}`,
    type: "success",
    priority: "normal",
    link: "/tasks",
    entityType: "Task",
    entityId: task.id,
    category: "task",
    dedupWindowHours: 0,
    io,
  });
}

function validateTaskInput(body, opts = {}) {
  if (body.priority !== undefined && body.priority !== null && body.priority !== "") {
    const e = ensureEnum(body.priority, ALLOWED_TASK_PRIORITIES, { field: "priority", code: "INVALID_PRIORITY" });
    if (e) return e;
  }
  if (body.status !== undefined && body.status !== null && body.status !== "") {
    const allowed = opts.travelTenant ? TRAVEL_TASK_STATUSES : ALLOWED_TASK_STATUSES;
    const e = ensureEnum(body.status, allowed, { field: "status", code: "INVALID_STATUS" });
    if (e) return e;
  }
  if (body.dueDate !== undefined && body.dueDate !== null && body.dueDate !== "") {
    // Reject obviously bogus dates (year < 2000 or > 2100). We allow past
    // dueDates because users do legitimately log overdue work, but a 1900 or
    // 2999 timestamp is always wrong and was silently accepted pre-fix.
    const e = ensureDateInRange(body.dueDate, { minYear: 2000, maxYear: 2100, field: "dueDate", code: "INVALID_DUEDATE" });
    if (e) return e;
  }
  if (body.type !== undefined && body.type !== null && body.type !== "") {
    const e = ensureEnum(body.type, ALLOWED_TASK_TYPES, { field: "type", code: "INVALID_TASK_TYPE" });
    if (e) return e;
  }
  if (body.outcome !== undefined && body.outcome !== null && body.outcome !== "") {
    const e = ensureEnum(body.outcome, ALLOWED_TASK_OUTCOMES, { field: "outcome", code: "INVALID_TASK_OUTCOME" });
    if (e) return e;
  }
  return null;
}

// GET /api/tasks — with optional filters
// #167: soft-deleted tasks hidden by default. ?includeDeleted=true opts in.
// #436: status filter is now case-insensitive AND tolerant of the legacy
// "OPEN"/"PENDING" enum values. The Sidebar badge query is hard-coded to
// `?status=PENDING` (uppercase) and the orchestrator-engine fan-out writes
// new tasks with `status: "OPEN"` (also uppercase). Both fall outside the
// canonical Title-case enum the schema/UI expects (`Pending`/`Completed`),
// so an exact-match `where.status = status` returned zero rows — the
// Owner's "Task Queue" badge counter sat at 0 even when the orchestrator
// had created tasks. Treat OPEN/PENDING (and their casing variants) as
// `Pending` for query purposes; everything else still hits exact match.
function normalizeStatusFilter(raw) {
  if (!raw) return null;
  const upper = String(raw).toUpperCase();
  if (upper === "PENDING" || upper === "OPEN") return "Pending";
  if (upper === "COMPLETED" || upper === "DONE" || upper === "CLOSED") return "Completed";
  if (upper === "IN PROGRESS" || upper === "INPROGRESS") return "In Progress";
  if (upper === "CANCELLED" || upper === "CANCELED") return "Cancelled";
  return raw; // unrecognized — pass through, will exact-match (or return [])
}

router.get("/", verifyToken, async (req, res) => {
  try {
    const { status, priority, contactId, overdue, mine } = req.query;
    const travelTenant = await isTravelTenant(req);

    const where = { tenantId: req.user.tenantId };
    if (status) where.status = normalizeStatusFilter(status);
    if (priority) where.priority = priority;
    if (contactId) where.contactId = parseInt(contactId);
    if (travelTenant || !canViewAllTasks(req)) where.userId = req.user.userId;
    if (overdue === "true") {
      where.dueDate = { lt: new Date() };
      where.status = "Pending";
    }
    // #436: ?mine=true → show tasks assigned to the caller. Owner persona
    // hits this via the upcoming "My Tasks" tab; we keep the existing
    // tenant-wide list for ?mine!=true so admin/manager oversight is
    // unchanged. ADMIN/MANAGER also see tasks they CREATED but never
    // assigned to a specific user (userId=null) so the Owner's recent
    // self-created queue items are visible — orchestrator-fan-out tasks
    // historically wrote userId=null because `stripDangerous` deleted the
    // assignee field on the create path (see POST handler comment).
    if (!travelTenant && mine === "true") {
      const me = req.user.userId;
      const isOrgRole = req.user.role === "ADMIN" || req.user.role === "MANAGER";
      where.OR = isOrgRole
        ? [{ userId: me }, { userId: null }]
        : [{ userId: me }];
    }
    if (req.query.includeDeleted !== "true") where.deletedAt = null;
    // ?count=1 — sidebar badge polls: return { total } only, skip full fetch.
    if (req.query.count === '1') {
      const total = await prisma.task.count({ where });
      return res.json({ total });
    }

    // #172: pagination
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    // #920 slice 4: ?fields=summary slim-shape opt-in. Mirrors slice 1
    // (contacts f7790241), slice 2 (deals 6786c2da), slice 3 (tickets
    // badc9cca). When the caller passes ?fields=summary we drop the
    // nested contact + user includes (which fan out PII — email, phone,
    // company, etc.) and return only the columns needed for list-page
    // rendering. Opt-in additive — existing callers (no ?fields, or any
    // non-exact value) get the full include shape unchanged.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where, take: limit, skip: offset,
      orderBy: { createdAt: "desc" },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        contactId: true,
        userId: true,
        tenantId: true,
        createdAt: true,
        // NOTE: `type` / `outcome` are deliberately NOT in the slim shape.
        // The #920 slice-4 contract pins this column set exactly
        // (test/routes/tasks.test.js), and nothing needs them here — the
        // Lead Reports route runs its own explicit selects and the Tasks page
        // reads the full include.
      };
    } else {
      findManyArgs.include = { contact: true, user: true };
    }
    const tasks = await prisma.task.findMany(findManyArgs);

    // Sort by priority in-memory (Critical first)
    tasks.sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99)
    );

    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Tasks" });
  }
});

// GET /api/tasks/assignment-readiness - Travel CRM assignment notification setup.
router.get("/assignment-readiness", verifyToken, async (req, res) => {
  try {
    const travelTenant = await isTravelTenant(req);
    if (!travelTenant) {
      return res.json({
        travel: false,
        email: { configured: emailConfigured(), reason: emailConfigured() ? null : "SendGrid is not configured" },
        whatsapp: { configured: false, reason: "Travel assignment WhatsApp notifications only run for Travel CRM tenants" },
      });
    }
    const whatsapp = await getWhatsappReadiness(req.user.tenantId);
    return res.json({
      travel: true,
      requiresAssigneeAndDueDate: true,
      statuses: Array.from(TRAVEL_TASK_STATUSES),
      email: { configured: emailConfigured(), reason: emailConfigured() ? null : "SendGrid is not configured" },
      whatsapp: { configured: whatsapp.configured, reason: whatsapp.reason },
    });
  } catch (err) {
    console.error("[tasks] assignment-readiness failed:", err);
    return res.status(500).json({ error: "Failed to check task notification readiness", code: "TASK_NOTIFICATION_READINESS_FAILED" });
  }
});


// POST /api/tasks/extension-summary - summarize a browser-extension capture for task notes.
router.post("/extension-summary", verifyToken, requirePermission("tasks", "write"), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.source || !VALID_EXTENSION_SOURCES.has(body.source)) {
      return res.status(400).json({
        error: `source must be one of: ${Array.from(VALID_EXTENSION_SOURCES).join(", ")}`,
        code: "INVALID_SOURCE",
      });
    }

    const messages = normalizeExtensionTaskMessages(body);
    if (!messages.length) {
      return res.status(400).json({ error: "Capture had no usable text content", code: "EMPTY_CAPTURE" });
    }

    const summary = await summarizeMessages({
      tenantId: req.user.tenantId,
      customerName: extensionTaskCustomerName(body),
      messages,
    });

    return res.json({
      title: compactTaskText(extensionTaskTitle(body), 120),
      notes: taskNotesFromSummary(summary),
      summary,
    });
  } catch (err) {
    console.error("[tasks] extension-summary error:", err && err.message);
    return res.status(500).json({ error: "Failed to summarize task", code: "TASK_SUMMARY_FAILED" });
  }
});
// POST /api/tasks
router.post("/", verifyToken, requirePermission("tasks", "write"), async (req, res) => {
  try {
    // #436: the global `stripDangerous` middleware (server.js:299, applied to
    // every route) deletes `userId` from req.body — that's the right thing
    // for entities where `userId` is the row owner / cross-tenant pivot, but
    // on Task `userId` is the assignee. Stripping it meant POST /api/tasks
    // could never assign a task to a user; every row landed with userId=null,
    // so the Owner's "my tasks" queue read empty and the Sidebar pending-task
    // badge sat at 0. Accept `targetUserId` (renamed surface, never stripped)
    // and fall through to req.strippedFields.userId for back-compat with old
    // clients that still POST `userId`.
    const travelTenant = await isTravelTenant(req);
    const { title, dueDate, contactId, targetUserId, notes, priority, type, outcome } = req.body;
    const assigneeRaw = (targetUserId !== undefined && targetUserId !== null && targetUserId !== "")
      ? targetUserId
      : (req.strippedFields && req.strippedFields.userId);
    if (!title) return res.status(400).json({ error: "title is required" });
    // #163: reject invalid status / priority instead of silently coercing.
    const normalizedStatus = normalizeTaskStatusForTenant(req.body.status, travelTenant);
    const inputErr = validateTaskInput({ ...req.body, status: normalizedStatus }, { travelTenant });
    if (inputErr) return res.status(inputErr.status).json(inputErr);

    const task = await prisma.task.create({
      data: {
        title,
        status: normalizedStatus || "Pending",
        priority: priority || "Medium",
        // #313: route datetime-local form input ("2026-05-15T10:30") through
        // the IST parser so the wall-clock the user typed survives storage.
        // Full ISO timestamps stay on the native ctor.
        dueDate: dueDate ? parseTenantDateInput(dueDate) : null,
        contactId: contactId ? parseInt(contactId) : null,
        userId: assigneeRaw !== undefined && assigneeRaw !== null && assigneeRaw !== ""
          ? parseInt(assigneeRaw)
          : null,
        notes: notes || null,
        // Lead Reports cluster — nullable when omitted, so the pre-existing
        // create shape is byte-for-byte unchanged for callers that don't send
        // these (extension capture, orchestrator fan-out, workflow engine).
        type: type || null,
        outcome: outcome || null,
        tenantId: req.user.tenantId,
      },
      include: { contact: true, user: true },
    });
    try { require("../lib/eventBus").emitEvent("task.created", { taskId: task.id, title: task.title, userId: req.user.userId }, req.user.tenantId, req.io); } catch(_e) {}
    // #179: audit task creation.
    await writeAudit('Task', 'CREATE', task.id, req.user.userId, req.user.tenantId, {
      title: task.title,
      priority: task.priority,
      assignedTo: task.userId,
      contactId: task.contactId,
    });
    try {
      await notifyTaskAssignee({ task, actorId: req.user.userId, tenantId: req.user.tenantId, io: req.io });
    } catch (notifyErr) {
      console.warn("[tasks] assignee notification skipped:", notifyErr && notifyErr.message);
    }
    let notificationResults = null;
    if (travelTenant) {
      try {
        notificationResults = await notifyTravelTaskAssignment({ task, actorId: req.user.userId, tenantId: req.user.tenantId });
      } catch (deliveryErr) {
        console.warn("[tasks] travel assignment delivery failed:", deliveryErr && deliveryErr.message);
        notificationResults = { required: true, attempted: false, reason: "Assignment notification check failed", channels: [] };
      }
    }
    res.status(201).json(notificationResults ? { ...task, notificationResults } : task);
  } catch (err) {
    console.error("[tasks] create failed:", err);
    res.status(500).json({
      error: "Failed to create Task",
      detail: process.env.NODE_ENV === "production" ? undefined : (err && err.message),
    });
  }
});

// PUT /api/tasks/:id — general update
router.put("/:id", verifyToken, requirePermission("tasks", "update"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID" });

    const travelTenant = await isTravelTenant(req);
    const existing = await prisma.task.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Task not found" });

    // #168: same validation on update path.
    const normalizedStatus = normalizeTaskStatusForTenant(req.body.status, travelTenant);
    const inputErr = validateTaskInput({ ...req.body, status: normalizedStatus }, { travelTenant });
    if (inputErr) return res.status(inputErr.status).json(inputErr);

    const { title, notes, dueDate, priority, status, targetUserId, type, outcome } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (notes !== undefined) data.notes = notes;
    // #313: same datetime-local-vs-ISO sniffing as POST.
    if (dueDate !== undefined) data.dueDate = dueDate ? parseTenantDateInput(dueDate) : null;
    if (priority !== undefined) data.priority = priority;
    if (status !== undefined) data.status = normalizedStatus;
    // Lead Reports cluster — only written when the caller sends the key, so an
    // update that omits them leaves the stored values untouched.
    if (type !== undefined) data.type = type || null;
    if (outcome !== undefined) data.outcome = outcome || null;
    if (targetUserId !== undefined) {
      data.userId = targetUserId !== null && targetUserId !== "" ? parseInt(targetUserId) : null;
    }

    // gap #17: capture prior status BEFORE the update so task.completed can be
    // gated idempotently — re-saving an already-Completed task must not re-fire.
    const wasCompleted = existing.status === "Completed";

    const task = await prisma.task.update({
      where: { id: existing.id },
      data,
      include: { contact: true, user: true },
    });

    // gap #17: emit task.completed only on the Pending → Completed transition.
    try {
      if (!wasCompleted && task.status === "Completed") {
        require("../lib/eventBus").emitEvent(
          "task.completed",
          {
            taskId: task.id,
            contactId: task.contactId,
            dealId: task.dealId || null,
            assignedToId: task.userId,
            completedAt: new Date(),
          },
          req.user.tenantId,
          req.io
        );
      }
    } catch (_e) {}

    // #179: audit only the keys that actually changed.
    if (existing.userId !== task.userId) {
      try {
        await notifyTaskAssignee({ task, actorId: req.user.userId, tenantId: req.user.tenantId, io: req.io, reassigned: true });
      } catch (notifyErr) {
        console.warn("[tasks] reassignment notification skipped:", notifyErr && notifyErr.message);
      }
    }

    const changes = diffFields(existing, task, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      await writeAudit('Task', 'UPDATE', task.id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }

    let notificationResults = null;
    if (travelTenant && (existing.userId !== task.userId || existing.dueDate?.getTime?.() !== task.dueDate?.getTime?.())) {
      try {
        notificationResults = await notifyTravelTaskAssignment({ task, actorId: req.user.userId, tenantId: req.user.tenantId });
      } catch (deliveryErr) {
        console.warn("[tasks] travel reassignment delivery failed:", deliveryErr && deliveryErr.message);
        notificationResults = { required: true, attempted: false, reason: "Assignment notification check failed", channels: [] };
      }
    }

    res.json(notificationResults ? { ...task, notificationResults } : task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update Task" });
  }
});

// PUT /api/tasks/:id/complete
router.put("/:id/complete", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID" });

    const existing = await prisma.task.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Task not found" });

    const isAssignedUser = existing.userId === req.user.userId;
    const canCompleteAny = canViewAllTasks(req) || await userHasPermission(req.user, "tasks", "update");
    if (!isAssignedUser && !canCompleteAny) {
      return res.status(403).json({ error: "Only the assignee or a task manager can resolve this task" });
    }

    // gap #17: same idempotency gate as PUT /:id - don't re-fire if already complete.
    const wasCompleted = existing.status === "Completed";
    const data = { status: "Completed" };
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "notes")) {
      data.notes = req.body.notes || null;
    }
    // Lead Reports cluster — resolving a Meeting / Site Visit can carry its
    // outcome ("booked", "no_show", …) in the same call, which is what feeds
    // the visit-done-not-booked follow-up queue.
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "outcome")) {
      const outcomeErr = validateTaskInput({ outcome: req.body.outcome });
      if (outcomeErr) return res.status(outcomeErr.status).json(outcomeErr);
      data.outcome = req.body.outcome || null;
    }

    const task = await prisma.task.update({
      where: { id: existing.id },
      data,
    });

    try {
      if (!wasCompleted) {
        require("../lib/eventBus").emitEvent(
          "task.completed",
          {
            taskId: task.id,
            contactId: task.contactId,
            dealId: task.dealId || null,
            assignedToId: task.userId,
            completedAt: new Date(),
          },
          req.user.tenantId,
          req.io
        );
      }
    } catch (_e) {}

    // #179: audit completion (only on the actual transition — re-saving
    // an already-Completed task is a no-op and should not generate a row).
    if (!wasCompleted) {
      await writeAudit('Task', 'COMPLETE', task.id, req.user.userId, req.user.tenantId, {
        title: existing.title,
      });
      try {
        await notifyTaskCompletionAdmins({ task, actorId: req.user.userId, tenantId: req.user.tenantId, io: req.io });
      } catch (notifyErr) {
        console.warn("[tasks] admin completion notification skipped:", notifyErr && notifyErr.message);
      }
    }

    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to complete Task" });
  }
});

// DELETE /api/tasks/:id — soft-delete (#167). ADMIN only. Idempotent.
router.delete("/:id", verifyToken, requirePermission("tasks", "delete"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID" });
    const existing = await prisma.task.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Task not found" });
    if (existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, softDeleted: true });
    }
    try {
      await prisma.auditLog.create({
        data: { action: "SOFT_DELETE", entity: "Task", entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ title: existing.title }) }
      });
    } catch (_) { /* audit failures must not block */ }
    const task = await prisma.task.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    res.json({ ...task, message: "Task soft-deleted", softDeleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete Task" });
  }
});

// POST /api/tasks/:id/restore — undo soft-delete (#167)
router.post("/:id/restore", verifyToken, requirePermission("tasks", "delete"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID" });
    const existing = await prisma.task.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Task not found" });
    if (!existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, restored: false });
    }
    try {
      await prisma.auditLog.create({
        data: { action: "RESTORE", entity: "Task", entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ title: existing.title }) }
      });
    } catch (_) { /* non-critical */ }
    const task = await prisma.task.update({
      where: { id: existing.id },
      data: { deletedAt: null },
    });
    res.json({ ...task, restored: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to restore Task" });
  }
});

module.exports = router;


