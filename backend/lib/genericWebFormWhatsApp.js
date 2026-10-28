const prisma = require("./prisma");
const { normalizeGenericWhatsAppThreadPhone } = require("./phoneFormatting");

const TEMPLATE_SETTING_KEY = "generic.webForm.whatsappTemplate";
const DEFAULT_TEMPLATE = "Hi {{lead.firstName}}, thank you for contacting {{organization.name}}. We have received your enquiry through {{form.name}} and our team will contact you shortly.";

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function render(template, { contact, tenant, form, selectionLink }) {
  const values = {
    "lead.name": contact.name || "",
    "lead.firstName": firstName(contact.name),
    "lead.lastName": String(contact.name || "").trim().split(/\s+/).slice(1).join(" "),
    "lead.phone": contact.phone || "",
    "lead.email": contact.email || "",
    "organization.name": tenant.name || "",
    "form.name": form.name || "",
  };
  const rendered = String(template || DEFAULT_TEMPLATE).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => values[key] ?? "");
  return selectionLink ? `${rendered}\n\nChoose your pickup location and interested plot: ${selectionLink}` : rendered;
}

function templateValues(contact, tenant, form, selectionLink = null) {
  const values = [
    firstName(contact.name),
    contact.company || "",
    contact.email || "",
    contact.phone || "",
    tenant.name || "",
    form.name || "",
    selectionLink || "",
  ];
  return values.map(value => String(value ?? ""));
}

function templateParameters(contact, tenant, form, body, selectionLink = null) {
  const values = templateValues(contact, tenant, form, selectionLink);
  const parameters = [];
  const seen = new Set();
  const regex = /\{\{(\d+)\}\}/g;
  let match;
  while ((match = regex.exec(String(body || "")))) {
    const index = Number(match[1]);
    if (seen.has(index)) continue;
    seen.add(index);
    parameters.push({ type: "text", text: String(values[index - 1] ?? "") });
  }
  return parameters;
}

function renderApprovedTemplate(body, contact, tenant, form, selectionLink = null) {
  const values = templateValues(contact, tenant, form, selectionLink);
  return String(body || "").replace(/\{\{(\d+)\}\}/g, (match, index) => values[Number(index) - 1] ?? match);
}

function leadStatusKey(contact, isNewContact) {
  if (isNewContact) return "newLead";
  const status = String(contact?.status || "Lead").toLowerCase().replace(/[^a-z]/g, "");
  if (status === "prospect") return "prospect";
  if (["customer", "converted", "convertedlead", "won"].includes(status)) return "converted";
  return "existingLead";
}

async function upsertGenericWhatsAppThread({ db = prisma, tenantId, phone, data = {} }) {
  const contactPhone = normalizeGenericWhatsAppThreadPhone(phone);
  if (!contactPhone) return null;

  const now = data.lastMessageAt || new Date();
  let thread = await db.whatsAppThread.upsert({
    where: { tenantId_contactPhone: { tenantId, contactPhone } },
    create: { tenantId, contactPhone, status: "OPEN", ...data, lastMessageAt: now },
    update: { ...data, lastMessageAt: now },
  });

  // Releases before v3.9.4 stored automatic-send keys without the leading
  // plus. Merge those legacy rows lazily when this contact is next messaged,
  // preserving the complete history while avoiding a risky global migration.
  const legacyPhone = contactPhone.slice(1);
  const legacyThreads = await db.whatsAppThread.findMany({
    where: { tenantId, contactPhone: legacyPhone, id: { not: thread.id } },
  });
  if (legacyThreads.length > 0) {
    const legacyIds = legacyThreads.map((item) => item.id);
    await db.whatsAppMessage.updateMany({
      where: { tenantId, threadId: { in: legacyIds } },
      data: { threadId: thread.id },
    });
    await db.whatsAppThread.deleteMany({
      where: { tenantId, id: { in: legacyIds } },
    });

    const legacy = legacyThreads[0];
    thread = await db.whatsAppThread.update({
      where: { id: thread.id },
      data: {
        contactName: data.contactName || thread.contactName || legacy.contactName || undefined,
        contactId: data.contactId || thread.contactId || legacy.contactId || undefined,
        lastInboundAt: thread.lastInboundAt || legacy.lastInboundAt || undefined,
        unreadCount: (thread.unreadCount || 0) + legacyThreads.reduce((sum, item) => sum + (item.unreadCount || 0), 0),
      },
    });
  }

  return thread;
}

async function sendGenericWebFormWhatsApp({
  form,
  contact,
  submissionId,
  isNewContact = false,
  source = "web_form",
  db = prisma,
  bulkTemplateId = null,
  selectionLink = null,
}) {
  const rawRecipientPhone = contact?.whatsappPhone || contact?.phone;
  // The Create Lead form stores a display-formatted value such as
  // "+1 1234567890". Keep one E.164 key for the thread, while retaining the
  // digits-only recipient shape expected by the Meta outbound worker.
  const recipientPhone = normalizeGenericWhatsAppThreadPhone(rawRecipientPhone);
  const providerPhone = recipientPhone.replace(/\D/g, "");
  if (!form || form.scope !== "generic" || !recipientPhone) {
    return { sent: false, code: rawRecipientPhone ? "NOT_GENERIC" : "LEAD_PHONE_MISSING" };
  }

  const [tenant, config, selectedTemplateSetting] = await Promise.all([
    db.tenant.findUnique({ where: { id: form.tenantId }, select: { name: true, vertical: true } }),
    db.whatsAppConfig.findFirst({ where: { tenantId: form.tenantId, isActive: true }, select: { phoneNumberId: true } }),
    db.tenantSetting.findUnique({ where: { tenantId_key: { tenantId: form.tenantId, key: TEMPLATE_SETTING_KEY } }, select: { value: true } }),
  ]);
  if (tenant?.vertical !== "generic") return { sent: false, code: "NOT_GENERIC" };
  if (!config?.phoneNumberId) return { sent: false, code: "WHATSAPP_NOT_CONFIGURED" };

  let approvedTemplate = null;
  if ((bulkTemplateId || selectedTemplateSetting?.value) && db.whatsAppTemplate?.findFirst) {
    let selectedId = null;
    try {
      const parsed = JSON.parse(selectedTemplateSetting?.value || "{}");
      selectedId = bulkTemplateId || Number(parsed?.statusTemplates?.[leadStatusKey(contact, isNewContact)] || parsed?.templateId) || null;
    } catch {
      selectedId = bulkTemplateId || Number(selectedTemplateSetting.value) || null;
    }
    if (selectedId) {
      approvedTemplate = await db.whatsAppTemplate.findFirst({
        where: { id: selectedId, tenantId: form.tenantId, status: "APPROVED" },
        select: { id: true, name: true, body: true },
      });
    }
  }
  if (bulkTemplateId && !approvedTemplate) return { sent: false, code: "TEMPLATE_UNAVAILABLE" };

  const isPickupPlotDefault = approvedTemplate
    && ["generic_new_lead_pickup_plot", "generic_lead_pickup_plot"].includes(approvedTemplate.name)
    && /\{\{7\}\}/.test(approvedTemplate.body || "");
  const templateSelectionLink = isPickupPlotDefault ? selectionLink : null;
  const parameters = approvedTemplate ? templateParameters(contact, tenant, form, approvedTemplate.body, templateSelectionLink) : [];
  const body = approvedTemplate
    ? renderApprovedTemplate(approvedTemplate.body, contact, tenant, form, templateSelectionLink)
    : render(DEFAULT_TEMPLATE, { contact, tenant, form });
  const messageMetadata = JSON.stringify({
    submissionId,
    source,
    ...(approvedTemplate ? { parameters } : {}),
  });
  const duplicate = await db.whatsAppMessage.findFirst({
    // Acknowledgements are idempotent per submission, not forever per
    // contact/body. A returning lead who submits again must receive the new
    // acknowledgement while retries of the same submission stay safe.
    where: { tenantId: form.tenantId, contactId: contact.id,
      interactiveJson: bulkTemplateId ? { contains: JSON.stringify({ submissionId }).slice(0, -1) } : messageMetadata },
    select: { id: true },
  });
  if (duplicate) return { sent: false, code: "DUPLICATE" };

  const thread = await upsertGenericWhatsAppThread({
    db,
    tenantId: form.tenantId,
    phone: recipientPhone,
    data: { contactName: contact.name, contactId: contact.id },
  });
  const message = await db.whatsAppMessage.create({
    // Only approved Meta templates must be sent through the template API.
    // When no status template is selected, keep the fallback as plain text;
    // using a synthetic template name makes the outbound worker call Meta with
    // a template that does not exist.
    data: { to: providerPhone, from: config.phoneNumberId, body, direction: "OUTBOUND", status: "QUEUED", templateName: approvedTemplate?.name || null, contactId: contact.id, tenantId: form.tenantId, threadId: thread.id, interactiveJson: messageMetadata },
  });
  await require("./whatsappQueue").getQueue().enqueueSend({ messageId: message.id, tenantId: form.tenantId, ...(db !== prisma ? { db } : {}) });
  return { sent: true, messageId: message.id };
}

async function queueGenericBulkContact(args) {
  return prisma.$transaction(async (db) => {
    // Serializes retries for this recipient, and commits the message and
    // outbound job together. No provider/network calls occur here.
    await db.$queryRawUnsafe("SELECT id FROM `Contact` WHERE id = ? AND tenantId = ? FOR UPDATE", args.contact.id, args.form.tenantId);
    return sendGenericWebFormWhatsApp({ ...args, db });
  });
}

module.exports = {
  sendGenericWebFormWhatsApp,
  TEMPLATE_SETTING_KEY,
  DEFAULT_TEMPLATE,
  templateParameters,
  leadStatusKey,
  queueGenericBulkContact,
  upsertGenericWhatsAppThread,
};
