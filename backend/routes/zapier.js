const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// ---------------------------------------------------------------------------
// Zapier-friendly metadata
// ---------------------------------------------------------------------------

const TRIGGERS = [
  {
    key: "contact_created",
    name: "New Contact",
    description: "Triggers when a new contact is added to the CRM",
    sample: {
      id: 1,
      name: "John Doe",
      email: "john@example.com",
      phone: "+1-555-0100",
      company: "Acme Corp",
      status: "Lead",
      createdAt: "2026-04-16T10:00:00.000Z",
    },
  },
  {
    key: "deal_won",
    name: "Deal Won",
    description: "Triggers when a deal is moved to the won stage",
    sample: {
      id: 42,
      title: "Enterprise SaaS Plan",
      amount: 25000,
      currency: "USD",
      stage: "won",
      contactId: 1,
      createdAt: "2026-04-16T10:00:00.000Z",
    },
  },
  {
    key: "deal_stage_changed",
    name: "Deal Stage Changed",
    description: "Triggers whenever a deal moves to a new pipeline stage",
    sample: {
      id: 42,
      title: "Enterprise SaaS Plan",
      amount: 25000,
      previousStage: "proposal",
      stage: "won",
      contactId: 1,
    },
  },
  {
    key: "task_completed",
    name: "Task Completed",
    description: "Triggers when a task is marked complete",
    sample: {
      id: 7,
      title: "Follow up with John",
      status: "Completed",
      priority: "High",
      completedAt: "2026-04-16T10:00:00.000Z",
    },
  },
  {
    key: "form_submitted",
    name: "Form Submitted",
    description: "Triggers when a landing-page form is submitted",
    sample: {
      id: 11,
      formId: "lead-magnet-1",
      data: { name: "Jane Smith", email: "jane@example.com", interest: "Demo" },
      submittedAt: "2026-04-16T10:00:00.000Z",
    },
  },
];

const ACTIONS = [
  {
    key: "create_contact",
    name: "Create Contact",
    description: "Create a new contact in the CRM",
    fields: [
      { key: "name", label: "Full Name", type: "string", required: true },
      { key: "email", label: "Email", type: "string", required: true },
      { key: "phone", label: "Phone", type: "string", required: false },
      { key: "company", label: "Company", type: "string", required: false },
      { key: "title", label: "Job Title", type: "string", required: false },
      { key: "status", label: "Status", type: "string", required: false },
      { key: "source", label: "Source", type: "string", required: false },
    ],
  },
  {
    key: "create_deal",
    name: "Create Deal",
    description: "Create a new deal/opportunity in the CRM pipeline",
    fields: [
      { key: "title", label: "Deal Title", type: "string", required: true },
      { key: "amount", label: "Amount", type: "number", required: false },
      { key: "currency", label: "Currency", type: "string", required: false },
      { key: "stage", label: "Stage", type: "string", required: false },
      { key: "contactId", label: "Linked Contact ID", type: "integer", required: false },
    ],
  },
  {
    key: "add_note",
    name: "Add Note",
    description: "Add a note/activity to an existing contact",
    fields: [
      { key: "contactId", label: "Contact ID", type: "integer", required: true },
      { key: "description", label: "Note Text", type: "string", required: true },
    ],
  },
  {
    key: "send_email",
    name: "Send Email",
    description: "Queue an outbound email to a contact",
    fields: [
      { key: "to", label: "To Address", type: "string", required: true },
      { key: "from", label: "From Address", type: "string", required: false },
      { key: "subject", label: "Subject", type: "string", required: true },
      { key: "body", label: "Body", type: "string", required: true },
      { key: "contactId", label: "Linked Contact ID", type: "integer", required: false },
    ],
  },
];

// ---------------------------------------------------------------------------
// Metadata endpoints
// ---------------------------------------------------------------------------

router.get("/triggers", (req, res) => {
  res.json(TRIGGERS);
});

router.get("/actions", (req, res) => {
  res.json(ACTIONS);
});

router.get("/test/:trigger", (req, res) => {
  const trig = TRIGGERS.find((t) => t.key === req.params.trigger);
  if (!trig) return res.status(404).json({ error: "Unknown trigger" });
  // Return as array — Zapier expects polling triggers to return a list
  res.json([trig.sample]);
});

// ---------------------------------------------------------------------------
// API key resolver — extracts ApiKey + userId/tenantId from Bearer header
// ---------------------------------------------------------------------------

async function resolveApiKey(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!token) return null;
  const apiKey = await prisma.apiKey.findUnique({ where: { keySecret: token } });
  if (!apiKey) return null;
  // Touch lastUsed (best-effort, fire and forget)
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsed: new Date() } }).catch(() => {});
  return apiKey;
}

function validateRequiredFields(action, body) {
  const missing = action.fields
    .filter((f) => f.required)
    .filter((f) => body[f.key] === undefined || body[f.key] === null || body[f.key] === "")
    .map((f) => f.key);
  return missing;
}

async function executeAction(actionKey, body, ctx) {
  const { userId, tenantId } = ctx;
  switch (actionKey) {
    case "create_contact":
      return prisma.contact.create({
        data: {
          name: body.name,
          email: body.email,
          phone: body.phone || null,
          company: body.company || null,
          title: body.title || null,
          status: body.status || "Lead",
          source: body.source || "Zapier",
          tenantId,
          assignedToId: userId || null,
        },
      });
    case "create_deal":
      return prisma.deal.create({
        data: {
          title: body.title,
          amount: body.amount ? parseFloat(body.amount) : 0,
          currency: body.currency || "USD",
          stage: body.stage || "lead",
          contactId: body.contactId ? parseInt(body.contactId) : null,
          ownerId: userId || null,
          tenantId,
        },
      });
    case "add_note":
      return prisma.activity.create({
        data: {
          type: "Note",
          description: body.description,
          contactId: parseInt(body.contactId),
          userId: userId || null,
          tenantId,
        },
      });
    case "send_email":
      return prisma.emailMessage.create({
        data: {
          subject: body.subject,
          body: body.body,
          from: body.from || "noreply@globussoft.com",
          to: body.to,
          direction: "OUTBOUND",
          contactId: body.contactId ? parseInt(body.contactId) : null,
          userId: userId || null,
          tenantId,
        },
      });
    default:
      throw Object.assign(new Error("Unknown action"), { statusCode: 404 });
  }
}

// ---------------------------------------------------------------------------
// Action execution (Bearer ApiKey auth)
// ---------------------------------------------------------------------------

router.post("/actions/:key/execute", async (req, res) => {
  try {
    const action = ACTIONS.find((a) => a.key === req.params.key);
    if (!action) return res.status(404).json({ error: "Unknown action" });

    const apiKey = await resolveApiKey(req);
    if (!apiKey) return res.status(401).json({ error: "Invalid or missing API key" });

    const missing = validateRequiredFields(action, req.body || {});
    if (missing.length) {
      return res.status(400).json({ error: "Missing required fields", missing });
    }

    const record = await executeAction(action.key, req.body || {}, {
      userId: apiKey.userId,
      tenantId: apiKey.tenantId,
    });

    res.status(201).json({ success: true, action: action.key, record });
  } catch (err) {
    console.error("[zapier] action execute failed:", err);
    res.status(err.statusCode || 500).json({ error: err.message || "Failed to execute action" });
  }
});

// ---------------------------------------------------------------------------
// Public webhook ingress — Zapier or any service can push events
// ---------------------------------------------------------------------------

router.post("/webhook", async (req, res) => {
  try {
    const { triggerKey, apiKey: rawKey, payload } = req.body || {};
    if (!triggerKey || !rawKey) {
      return res.status(400).json({ error: "triggerKey and apiKey are required" });
    }

    const apiKey = await prisma.apiKey.findUnique({ where: { keySecret: rawKey } });
    if (!apiKey) return res.status(401).json({ error: "Invalid API key" });

    prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsed: new Date() } })
      .catch(() => {});

    const ctx = { userId: apiKey.userId, tenantId: apiKey.tenantId };
    const data = payload || {};
    let record = null;

    switch (triggerKey) {
      case "contact_created":
        if (!data.email || !data.name) {
          return res.status(400).json({ error: "Payload requires name and email" });
        }
        record = await executeAction("create_contact", data, ctx);
        break;
      case "deal_won":
      case "deal_stage_changed":
        if (!data.title) {
          return res.status(400).json({ error: "Payload requires title" });
        }
        record = await executeAction(
          "create_deal",
          { ...data, stage: data.stage || (triggerKey === "deal_won" ? "won" : "lead") },
          ctx
        );
        break;
      case "task_completed":
      case "form_submitted":
        // Generic ingress — record as a note on a contact when contactId provided,
        // otherwise create an activity-less audit log via Note on contact 0 fallback.
        if (data.contactId) {
          record = await executeAction(
            "add_note",
            {
              contactId: data.contactId,
              description: `[${triggerKey}] ${JSON.stringify(data)}`,
            },
            ctx
          );
        } else {
          // Without a contact context, simply echo back acceptance
          record = { acknowledged: true, triggerKey, payload: data };
        }
        break;
      default:
        return res.status(400).json({ error: "Unknown triggerKey" });
    }

    res.status(201).json({ success: true, recordId: record && record.id ? record.id : null });
  } catch (err) {
    console.error("[zapier] webhook ingress failed:", err);
    res.status(500).json({ error: err.message || "Webhook ingress failed" });
  }
});

// ---------------------------------------------------------------------------
// Subscriptions — Zapier creates a Webhook record per active Zap
// ---------------------------------------------------------------------------

router.get("/subscriptions", verifyToken, async (req, res) => {
  try {
    const subs = await prisma.webhook.findMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(subs);
  } catch (err) {
    console.error("[zapier] list subscriptions failed:", err);
    res.status(500).json({ error: "Failed to load subscriptions" });
  }
});

router.post("/subscribe", verifyToken, async (req, res) => {
  try {
    const { event, targetUrl } = req.body || {};
    if (!event || !targetUrl) {
      return res.status(400).json({ error: "event and targetUrl are required" });
    }
    const sub = await prisma.webhook.create({
      data: {
        event,
        targetUrl,
        isActive: true,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(sub);
  } catch (err) {
    console.error("[zapier] subscribe failed:", err);
    res.status(500).json({ error: "Failed to create subscription" });
  }
});

router.delete("/subscribe/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.webhook.findFirst({
      where: { id, userId: req.user.userId, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Subscription not found" });
    await prisma.webhook.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[zapier] unsubscribe failed:", err);
    res.status(500).json({ error: "Failed to remove subscription" });
  }
});

module.exports = router;
