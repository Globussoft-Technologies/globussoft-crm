const express = require("express");

const router = express.Router();
const prisma = require("../lib/prisma");
const { renderGenericTemplate } = require("../lib/genericEmailTemplateRenderer");
const { normalizeGenericTemplatePlaceholders } = require("../lib/genericCampaignAutomation");
const { routeRequest } = require("../lib/llmRouter");
const { ensureGenericLeadNotificationTemplates, SYSTEM_CATEGORY_PREFIX } = require("../lib/genericLeadEmailTemplates");

const TEMPLATE_ORDER_SETTING_PREFIX = "generic.marketing.templateOrder";

function parseSavedOrder(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isSafeInteger) : [];
  } catch {
    return [];
  }
}

function applySavedOrder(rows, orderedIds, { unrankedFirst = false } = {}) {
  const rank = new Map(orderedIds.map((id, index) => [Number(id), index]));
  return [...rows].sort((left, right) => {
    const leftIsRanked = rank.has(left.id);
    const rightIsRanked = rank.has(right.id);
    if (leftIsRanked !== rightIsRanked) {
      if (unrankedFirst) return leftIsRanked ? 1 : -1;
      return leftIsRanked ? -1 : 1;
    }
    const leftRank = leftIsRanked ? rank.get(left.id) : Number.MAX_SAFE_INTEGER;
    const rightRank = rightIsRanked ? rank.get(right.id) : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}

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
      { key: "sender.name", label: "Sender Name", group: "Sender Details" },
      { key: "sender.email", label: "Sender Email", group: "Sender Details" },
      { key: "sender.company", label: "Sender Company", group: "Sender Details" },
      { key: "enrollmentId", label: "Enrollment ID", group: "Campaign" },
      { key: "sequenceId", label: "Sequence ID", group: "Campaign" },
      { key: "system.pickupPlotLink", label: "Pickup / Plot Selection Link", group: "System" },
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
            include: { field: { select: { fieldKey: true, label: true } } },
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
      organization: { name: tenant.name || '' },
      tenant: { name: tenant.name || '' },
      customFields: (sample.leadCustomFieldValues || []).map(value => ({
        key: value.field?.fieldKey, label: value.field?.label,
        value: value.valueText ?? value.valueNumber ?? value.valueDate ?? value.valueBool ?? '',
      })),
      sender: { name: tenant.name || '', email: '', company: tenant.name || '' },
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
      subject: renderGenericTemplate(normalizeGenericTemplatePlaceholders(req.body.subject || ""), context),
      body: renderGenericTemplate(normalizeGenericTemplatePlaceholders(req.body.body || ""), context, { html: true }),
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
    const channel = String(req.body?.channel || "EMAIL").trim().toUpperCase();
    if (!["EMAIL", "WHATSAPP"].includes(channel)) {
      return res.status(400).json({ error: "AI drafting supports EMAIL or WHATSAPP templates", code: "CHANNEL_INVALID" });
    }
    const templateName = String(req.body?.templateName || "").trim();
    const subject = String(req.body?.subject || (channel === "WHATSAPP" ? templateName.replace(/_/g, " ") : "")).trim();
    if (!subject) {
      return res.status(400).json({
        error: channel === "WHATSAPP" ? "A template name is required to write a WhatsApp message" : "A subject is required to write a template",
        code: channel === "WHATSAPP" ? "TEMPLATE_NAME_REQUIRED" : "SUBJECT_REQUIRED",
      });
    }
    if (subject.length > 300) {
      return res.status(400).json({ error: "Subject must be 300 characters or fewer", code: "SUBJECT_TOO_LONG" });
    }

    const result = await routeRequest({
      task: "email-template-draft",
      payload: {
        subject,
        channel,
        templateName: templateName || undefined,
        category: String(req.body?.category || "").trim() || undefined,
        includePickupPlotLink: channel === "WHATSAPP" && req.body?.includePickupPlotLink === true,
        __userId: req.user.userId,
        __surface: channel === "WHATSAPP" ? "generic-whatsapp-template" : "generic-email-template",
      },
      tenantId: req.user.tenantId,
    });
    if (result.stub || !String(result.text || "").trim()) {
      return res.status(503).json({ error: `AI ${channel === "WHATSAPP" ? "WhatsApp" : "email"} drafting is not configured for this tenant`, code: "AI_NOT_CONFIGURED" });
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
    const paginate = req.query.paginate === "1";
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
    const requestedChannel = String(req.query.channel || "").trim().toUpperCase();
    const channel = ["EMAIL", "SMS", "WHATSAPP"].includes(requestedChannel) ? requestedChannel : null;
    if (paginate || channel) {
      const tenant = await requireGenericTenant(req, res);
      if (!tenant) return;
      await ensureGenericLeadNotificationTemplates(prisma, req.user.tenantId);
    }
    const findManyArgs = {
      where: { tenantId: req.user.tenantId, ...(channel ? { channel } : {}) },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        name: true,
        subject: true,
        category: true,
        channel: true,
        tenantId: true,
        createdAt: true,
        updatedAt: true,
      };
    }
    if (!paginate) {
      const templates = await prisma.emailTemplate.findMany(findManyArgs);
      return res.json(templates);
    }
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : 10;
    const orderSettingKey = `${TEMPLATE_ORDER_SETTING_PREFIX}.${channel || "ALL"}`;
    const [allTemplates, total, orderSetting] = await Promise.all([
      prisma.emailTemplate.findMany(findManyArgs),
      prisma.emailTemplate.count({ where: findManyArgs.where }),
      prisma.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId: req.user.tenantId, key: orderSettingKey } },
        select: { value: true },
      }),
    ]);
    const templates = applySavedOrder(
      allTemplates,
      parseSavedOrder(orderSetting?.value),
      { unrankedFirst: channel === "EMAIL" },
    ).slice((page - 1) * limit, page * limit);
    return res.json({
      items: templates,
      pagination: { page, pageSize: limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error("[EmailTemplates] List error:", err);
    res.status(500).json({ error: "Failed to fetch email templates", code: "EMAIL_TEMPLATES_LIST_FAILED" });
  }
});

// Generic CRM template-card ordering. Only the rows included in orderedIds
// move; their existing slots in the full tenant/channel order are reused so
// dragging on a paginated page cannot pull page-two cards onto page one.
router.put("/reorder", async (req, res) => {
  try {
    const tenant = await requireGenericTenant(req, res);
    if (!tenant) return;
    const requestedChannel = String(req.body?.channel || "").trim().toUpperCase();
    if (!["ALL", "EMAIL", "SMS", "WHATSAPP"].includes(requestedChannel)) {
      return res.status(400).json({ error: "channel must be ALL, EMAIL, SMS, or WHATSAPP", code: "INVALID_CHANNEL" });
    }
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map(Number) : [];
    if (orderedIds.length < 2 || orderedIds.length > 50 || orderedIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(orderedIds).size !== orderedIds.length) {
      return res.status(400).json({ error: "orderedIds must contain 2 to 50 unique template IDs", code: "INVALID_ORDER" });
    }
    const where = {
      tenantId: req.user.tenantId,
      ...(requestedChannel === "ALL" ? {} : { channel: requestedChannel }),
    };
    const settingKey = `${TEMPLATE_ORDER_SETTING_PREFIX}.${requestedChannel}`;
    const [rows, currentSetting] = await Promise.all([prisma.emailTemplate.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }), prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: req.user.tenantId, key: settingKey } },
      select: { value: true },
    })]);
    const rowIds = applySavedOrder(
      rows,
      parseSavedOrder(currentSetting?.value),
      { unrankedFirst: requestedChannel === "EMAIL" },
    ).map(row => row.id);
    if (orderedIds.some(id => !rowIds.includes(id))) {
      return res.status(409).json({ error: "Template order is out of date. Refresh and try again.", code: "ORDER_STALE" });
    }
    const moving = new Set(orderedIds);
    const slots = rowIds.map((id, index) => moving.has(id) ? index : -1).filter(index => index >= 0);
    const nextIds = [...rowIds];
    slots.forEach((slot, index) => { nextIds[slot] = orderedIds[index]; });
    await prisma.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: req.user.tenantId, key: settingKey } },
      update: { value: JSON.stringify(nextIds), category: "ui" },
      create: { tenantId: req.user.tenantId, key: settingKey, value: JSON.stringify(nextIds), category: "ui" },
    });
    return res.json({ success: true, orderedIds });
  } catch (err) {
    console.error("[EmailTemplates] Reorder error:", err);
    return res.status(500).json({ error: "Failed to reorder templates", code: "EMAIL_TEMPLATE_REORDER_FAILED" });
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
    const { name, subject, body, category, channel } = req.body;
    const trimmedName = String(name || "").trim();
    if (!trimmedName || !subject || !body) {
      return res.status(400).json({ error: "name, subject, and body are required" });
    }
    if (channel !== undefined) {
      const tenant = await requireGenericTenant(req, res);
      if (!tenant) return;
    }
    const normalizedChannel = String(channel || "EMAIL").trim().toUpperCase();
    if (!["EMAIL", "SMS", "WHATSAPP"].includes(normalizedChannel)) return res.status(400).json({ error: "channel must be EMAIL, SMS, or WHATSAPP" });
    if (channel !== undefined) {
      const duplicate = await prisma.emailTemplate.findFirst({
        where: { tenantId: req.user.tenantId, channel: normalizedChannel, name: trimmedName },
        select: { id: true },
      });
      if (duplicate) {
        return res.status(409).json({
          error: `This name is already used by another ${normalizedChannel} template`,
          code: "TEMPLATE_NAME_EXISTS",
        });
      }
    }
    const template = await prisma.emailTemplate.create({
      data: { name: trimmedName, subject, body, channel: normalizedChannel, category: category || "General", tenantId: req.user.tenantId },
    });
    res.status(201).json(template);
  } catch (err) {
    console.error("[EmailTemplates] Create error:", err);
    res.status(500).json({ error: "Failed to create email template", code: "EMAIL_TEMPLATE_CREATE_FAILED" });
  }
});

// Update template
router.put("/:id", async (req, res) => {
  try {
    const { name, subject, body, category, channel } = req.body;
    const existing = await prisma.emailTemplate.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    if (channel !== undefined) {
      const tenant = await requireGenericTenant(req, res);
      if (!tenant) return;
    }
    const normalizedChannel = channel === undefined ? undefined : String(channel || "").trim().toUpperCase();
    if (normalizedChannel !== undefined && !["EMAIL", "SMS", "WHATSAPP"].includes(normalizedChannel)) return res.status(400).json({ error: "channel must be EMAIL, SMS, or WHATSAPP" });
    const trimmedName = name === undefined ? existing.name : String(name || "").trim();
    if (channel !== undefined) {
      const duplicate = await prisma.emailTemplate.findFirst({
        where: {
          tenantId: req.user.tenantId,
          channel: normalizedChannel,
          name: trimmedName,
          id: { not: existing.id },
        },
        select: { id: true },
      });
      if (duplicate) {
        return res.status(409).json({
          error: `This name is already used by another ${normalizedChannel} template`,
          code: "TEMPLATE_NAME_EXISTS",
        });
      }
    }
    const template = await prisma.emailTemplate.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name: trimmedName }),
        ...(subject !== undefined && { subject }),
        ...(body !== undefined && { body }),
        ...(category !== undefined && !String(existing.category || "").startsWith(SYSTEM_CATEGORY_PREFIX) && { category }),
        ...(normalizedChannel !== undefined && { channel: normalizedChannel }),
      },
    });
    res.json(template);
  } catch (err) {
    console.error("[EmailTemplates] Update error:", err);
    res.status(500).json({ error: "Failed to update email template", code: "EMAIL_TEMPLATE_UPDATE_FAILED" });
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
