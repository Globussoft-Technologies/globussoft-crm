const express = require("express");

const router = express.Router();
const prisma = require("../lib/prisma");
const { renderTemplate } = require("../lib/microTemplate");
const { normalizeGenericTemplatePlaceholders } = require("../lib/genericCampaignAutomation");
const { routeRequest } = require("../lib/llmRouter");

async function requireGenericTenant(req, res) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    select: { id: true, name: true, vertical: true },
  });
  if ((tenant?.vertical || "generic") !== "generic") {
    res.status(404).json({ error: "Generic CRM template metadata is not available for this vertical", code: "GENERIC_ONLY" });
    return null;
  }
  return tenant;
}

// Generic CRM-only source of truth for the variables the existing sequence
// email renderer can resolve without changing any other vertical or send path.
router.get("/personalization-fields", async (req, res) => {
  try {
    const tenant = await requireGenericTenant(req, res);
    if (!tenant) return;
    const customDefinitions = await prisma.leadCustomFieldDefinition.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
      select: { fieldKey: true, label: true },
    });
    const relatedFields = [
      ['Deal', [['id', 'Deal ID'], ['title', 'Deal Title'], ['amount', 'Deal Amount'], ['currency', 'Deal Currency'], ['probability', 'Deal Probability'], ['stage', 'Deal Stage'], ['expectedClose', 'Expected Close'], ['lostReason', 'Lost Reason']]],
      ['Invoice', [['id', 'Invoice ID'], ['number', 'Invoice Number'], ['invoiceNum', 'Invoice Number (raw field)'], ['amount', 'Invoice Amount'], ['status', 'Invoice Status'], ['dueDate', 'Due Date'], ['issuedDate', 'Issued Date'], ['paidAt', 'Paid At'], ['paymentMode', 'Payment Mode']]],
      ['Payment', [['id', 'Payment ID'], ['invoiceId', 'Invoice ID'], ['description', 'Payment Description'], ['amount', 'Payment Amount'], ['currency', 'Payment Currency'], ['gateway', 'Payment Gateway'], ['status', 'Payment Status'], ['paidAt', 'Paid At']]],
      ['Pickup', [['id', 'Pickup Point ID'], ['contactId', 'Contact ID'], ['address', 'Pickup Address'], ['location', 'Pickup Location'], ['pickupAddress', 'Pickup Address (raw field)'], ['sourceTranscriptId', 'Source Transcript ID'], ['sourceExcerpt', 'Source Excerpt'], ['createdAt', 'Pickup Created Date'], ['updatedAt', 'Pickup Updated Date']]],
      ['Visit', [['id', 'Visit Task ID'], ['title', 'Visit Title'], ['notes', 'Visit Notes'], ['type', 'Visit Type'], ['outcome', 'Visit Outcome'], ['dueDate', 'Visit Date'], ['completedAt', 'Visit Completed Date']]],
      ['Task', [['id', 'Task ID'], ['title', 'Task Title'], ['dueDate', 'Due Date'], ['status', 'Task Status'], ['priority', 'Task Priority'], ['type', 'Task Type'], ['outcome', 'Task Outcome']]],
      ['Activity', [['type', 'Activity Type'], ['description', 'Activity Description'], ['createdAt', 'Activity Date']]],
      ['Expense', [['id', 'Expense ID'], ['title', 'Expense Title'], ['amount', 'Expense Amount'], ['currency', 'Expense Currency'], ['category', 'Expense Category'], ['status', 'Expense Status'], ['expenseDate', 'Expense Date']]],
      ['Contract', [['id', 'Contract ID'], ['title', 'Contract Title'], ['status', 'Contract Status'], ['startDate', 'Contract Start Date'], ['endDate', 'Contract End Date'], ['value', 'Contract Value']]],
      ['Estimate', [['id', 'Estimate ID'], ['estimateNum', 'Estimate Number'], ['title', 'Estimate Title'], ['status', 'Estimate Status'], ['totalAmount', 'Estimate Total'], ['validUntil', 'Estimate Valid Until']]],
      ['Project', [['id', 'Project ID'], ['name', 'Project Name'], ['status', 'Project Status'], ['priority', 'Project Priority'], ['startDate', 'Project Start Date'], ['endDate', 'Project End Date'], ['budget', 'Project Budget']]],
    ].flatMap(([group, entries]) => entries.map(([key, label]) => ({ key: `${group.toLowerCase()}.${key}`, label, group })));
    const fields = [
      { key: "contact.name", label: "Contact Name", group: "Contact" },
      { key: "contact.first_name", label: "First Name", group: "Contact" },
      { key: "contact.last_name", label: "Last Name", group: "Contact" },
      { key: "contact.email", label: "Contact Email", group: "Contact" },
      { key: "contact.phone", label: "Contact Phone", group: "Contact" },
      { key: "contact.whatsappPhone", label: "WhatsApp Phone", group: "Contact" },
      { key: "contact.company", label: "Contact Company", group: "Contact" },
      { key: "contact.title", label: "Job Title", group: "Contact" },
      { key: "contact.status", label: "Contact Status", group: "Contact" },
      { key: "contact.source", label: "Lead Source", group: "Contact" },
      { key: "contact.medium", label: "Lead Medium", group: "Contact" },
      { key: "contact.industry", label: "Industry", group: "Contact" },
      { key: "contact.companySize", label: "Company Size", group: "Contact" },
      { key: "contact.linkedin", label: "LinkedIn", group: "Contact" },
      { key: "contact.website", label: "Website", group: "Contact" },
      { key: "contact.facebookUrl", label: "Facebook", group: "Contact" },
      { key: "contact.githubUrl", label: "GitHub", group: "Contact" },
      { key: "contact.twitterUrl", label: "Twitter", group: "Contact" },
      { key: "contact.firstTouchSource", label: "First Touch Source", group: "Contact" },
      { key: "contact.lastTouchSource", label: "Last Touch Source", group: "Contact" },
      { key: "contact.birthDate", label: "Birth Date", group: "Contact" },
      { key: "contact.anniversary", label: "Anniversary", group: "Contact" },
      { key: "contact.gst", label: "GST Number", group: "Contact" },
      { key: "contact.stateCode", label: "State Code", group: "Contact" },
      { key: "contact.billingStateCode", label: "Billing State Code", group: "Contact" },
      { key: "contact.externalId", label: "External ID", group: "Contact" },
      { key: "contact.aiScore", label: "AI Score", group: "Contact" },
      { key: "contact.tags", label: "Tags", group: "Contact" },
      { key: "enrollmentId", label: "Enrollment ID", group: "Campaign" },
      { key: "sequenceId", label: "Sequence ID", group: "Campaign" },
      ...relatedFields,
      ...customDefinitions.map(field => ({ key: `contact.custom.${field.fieldKey}`, label: field.label, group: "Custom Contact Fields" })),
    ];
    const seenKeys = new Set();
    const seenLabels = new Set();
    const uniqueFields = fields.filter((field) => {
      const key = `${field.group || ""}:${field.key || ""}`.toLowerCase();
      // Raw-field entries are aliases for the same customer-facing field and
      // remain renderable in existing templates; they do not need a second
      // picker entry.
      const label = String(field.label || "").replace(/\s+\(raw field\)$/i, "").toLowerCase();
      const labelKey = `${field.group || ""}:${label}`;
      if (seenKeys.has(key) || seenLabels.has(labelKey)) return false;
      seenKeys.add(key);
      seenLabels.add(labelKey);
      return true;
    });
    res.json({ fields: uniqueFields });
  } catch (err) {
    console.error("[EmailTemplates] Generic personalization metadata error:", err.message);
    res.status(500).json({ error: "Failed to fetch personalization fields", code: "PERSONALIZATION_FIELDS_FAILED" });
  }
});

// Generic CRM-only, read-only preview. Values are resolved from the selected
// contact at preview time and are never written back to the CRM or template.
router.post("/preview", async (req, res) => {
  try {
    const tenant = await requireGenericTenant(req, res);
    if (!tenant) return;
    const contactId = Number(req.body.contactId);
    const contact = Number.isInteger(contactId) && contactId > 0
      ? await prisma.contact.findFirst({
        where: { id: contactId, tenantId: req.user.tenantId },
        select: {
          id: true, name: true, email: true, phone: true, whatsappPhone: true, company: true, title: true,
          status: true, source: true, medium: true, tagsJson: true, industry: true, companySize: true,
          linkedin: true, website: true, facebookUrl: true, githubUrl: true, twitterUrl: true,
          firstTouchSource: true, lastTouchSource: true, birthDate: true, anniversary: true, gst: true,
          stateCode: true, billingStateCode: true, externalId: true, aiScore: true,
          leadCustomFieldValues: {
            include: { field: { select: { fieldKey: true } } },
          },
          deals: { orderBy: { createdAt: "desc" }, take: 1 },
          invoices: { orderBy: { issuedDate: "desc" }, take: 1 },
          tasks: { orderBy: { createdAt: "desc" }, take: 1 },
          activities: { orderBy: { createdAt: "desc" }, take: 1 },
          expenses: { orderBy: { createdAt: "desc" }, take: 1 },
          contracts: { orderBy: { createdAt: "desc" }, take: 1 },
          estimates: { orderBy: { createdAt: "desc" }, take: 1 },
          projects: { orderBy: { createdAt: "desc" }, take: 1 },
          customerPickups: { orderBy: { updatedAt: "desc" }, take: 1 },
        },
      })
      : null;
    const sample = contact || {
      id: null,
      name: "Rahul Sharma",
      email: "rahul@example.com",
      phone: "+1 555 0100",
      company: "Example Company",
      status: "Lead",
    };
    const custom = Object.fromEntries((sample.leadCustomFieldValues || []).map(value => [
      value.field.fieldKey,
      value.valueText ?? value.valueNumber ?? value.valueDate ?? value.valueBool ?? "",
    ]));
    const names = String(sample.name || '').trim().split(/\s+/).filter(Boolean);
    let tags = [];
    try { tags = sample.tagsJson ? JSON.parse(sample.tagsJson) : []; } catch (_error) { tags = []; }
    const contactContext = {
      ...sample,
      first_name: names[0] || '',
      last_name: names.slice(1).join(' '),
      tags,
      custom,
    };
    const context = {
      contact: contactContext,
      name: sample.name,
      email: sample.email,
      phone: sample.phone,
      company: sample.company,
      enrollmentId: null,
      sequenceId: null,
    };
    if (contact) {
      const payment = await prisma.payment.findFirst({
        where: { tenantId: req.user.tenantId, contactId: contact.id },
        orderBy: { createdAt: "desc" },
      });
      Object.assign(context, {
        deal: contact.deals?.[0] || {},
        invoice: contact.invoices?.[0] ? { ...contact.invoices[0], number: contact.invoices[0].invoiceNum } : {},
        payment: payment || {},
        task: contact.tasks?.[0] || {},
        activity: contact.activities?.[0] || {},
        expense: contact.expenses?.[0] || {},
        contract: contact.contracts?.[0] || {},
        estimate: contact.estimates?.[0] || {},
        project: contact.projects?.[0] || {},
        pickup: contact.customerPickups?.[0]
          ? { ...contact.customerPickups[0], address: contact.customerPickups[0].pickupAddress, location: contact.customerPickups[0].pickupAddress }
          : {},
      });
    }
    res.json({
      subject: renderTemplate(normalizeGenericTemplatePlaceholders(req.body.subject || ""), context),
      body: renderTemplate(normalizeGenericTemplatePlaceholders(req.body.body || ""), context),
      contact: { id: sample.id, name: sample.name, email: sample.email },
      isSample: !contact,
    });
  } catch (err) {
    console.error("[EmailTemplates] Generic preview error:", err.message);
    res.status(500).json({ error: "Failed to preview email template", code: "EMAIL_TEMPLATE_PREVIEW_FAILED" });
  }
});

// Generic CRM-only AI drafting. This creates no template row: the marketer
// remains in control of the generated body and saves it through the existing
// template CRUD flow only after reviewing it.
router.post("/ai-draft", async (req, res) => {
  try {
    const tenant = await requireGenericTenant(req, res);
    if (!tenant) return;
    const subject = String(req.body?.subject || "").trim();
    if (!subject) {
      return res.status(400).json({ error: "A subject is required to write a template", code: "SUBJECT_REQUIRED" });
    }
    if (subject.length > 300) {
      return res.status(400).json({ error: "Subject must be 300 characters or fewer", code: "SUBJECT_TOO_LONG" });
    }

    const result = await routeRequest({
      task: "email-template-draft",
      payload: {
        subject,
        __userId: req.user.userId,
        __surface: "generic-email-template",
      },
      tenantId: req.user.tenantId,
    });
    if (result.stub || !String(result.text || "").trim()) {
      return res.status(503).json({ error: "AI email drafting is not configured for this tenant", code: "AI_NOT_CONFIGURED" });
    }
    return res.json({ body: result.text.trim(), model: result.model });
  } catch (err) {
    console.error("[EmailTemplates] Generic AI draft failed:", err.message);
    return res.status(err.code === "AI_NOT_CONFIGURED" ? 503 : err.code === "LLM_BUDGET_EXCEEDED" ? 429 : 502).json({
      // `friendly` is a boolean marker on gateway errors, not display text.
      // Return the configured human message so the template editor can show
      // the same setup guidance as the organization AI settings screen.
      error: err.message || "Failed to write email template",
      code: err.code || "AI_DRAFT_FAILED",
    });
  }
});

// List all email templates
router.get("/", async (req, res) => {
  try {
    // #920 slice 9: ?fields=summary slim-shape opt-in. Mirrors slice 1
    // (contacts f7790241), slice 2 (deals 6786c2da), slice 3 (tickets
    // badc9cca), slice 4 (tasks), slice 5 (projects), slice 6 (expenses),
    // slice 7 (notifications). When the caller passes ?fields=summary we
    // drop the heaviest column (`body` is @db.Text and frequently holds
    // multi-KB HTML email payloads) and return only the columns the
    // SequenceBuilder / EmailTemplates list picker actually renders.
    // Opt-in additive — existing callers (no ?fields, or any non-exact
    // value) get the full row shape unchanged.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where: { tenantId: req.user.tenantId },
      orderBy: { updatedAt: "desc" },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        name: true,
        subject: true,
        category: true,
        tenantId: true,
        createdAt: true,
        updatedAt: true,
      };
    }
    const templates = await prisma.emailTemplate.findMany(findManyArgs);
    res.json(templates);
  } catch (err) {
    console.error("[EmailTemplates] List error:", err);
    res.status(500).json({ error: "Failed to fetch email templates" });
  }
});

// Get single template
router.get("/:id", async (req, res) => {
  try {
    const template = await prisma.emailTemplate.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!template) return res.status(404).json({ error: "Template not found" });
    res.json(template);
  } catch (err) {
    console.error("[EmailTemplates] Get error:", err);
    res.status(500).json({ error: "Failed to fetch email template" });
  }
});

// Create template
router.post("/", async (req, res) => {
  try {
    const { name, subject, body, category } = req.body;
    if (!name || !subject || !body) {
      return res.status(400).json({ error: "name, subject, and body are required" });
    }
    const template = await prisma.emailTemplate.create({
      data: { name, subject, body, category: category || "General", tenantId: req.user.tenantId },
    });
    res.status(201).json(template);
  } catch (err) {
    console.error("[EmailTemplates] Create error:", err);
    res.status(500).json({ error: "Failed to create email template" });
  }
});

// Update template
router.put("/:id", async (req, res) => {
  try {
    const { name, subject, body, category } = req.body;
    const existing = await prisma.emailTemplate.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    const template = await prisma.emailTemplate.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name }),
        ...(subject !== undefined && { subject }),
        ...(body !== undefined && { body }),
        ...(category !== undefined && { category }),
      },
    });
    res.json(template);
  } catch (err) {
    console.error("[EmailTemplates] Update error:", err);
    res.status(500).json({ error: "Failed to update email template" });
  }
});

// Delete template
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.emailTemplate.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    await prisma.emailTemplate.delete({
      where: { id: existing.id },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[EmailTemplates] Delete error:", err);
    res.status(500).json({ error: "Failed to delete email template" });
  }
});

module.exports = router;
