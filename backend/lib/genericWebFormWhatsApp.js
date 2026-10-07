const prisma = require("./prisma");

const TEMPLATE_SETTING_KEY = "generic.webForm.whatsappTemplate";
const DEFAULT_TEMPLATE = "Hi {{lead.firstName}}, thank you for contacting {{organization.name}}. We have received your enquiry through {{form.name}} and our team will contact you shortly.";

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function render(template, { contact, tenant, form }) {
  const values = {
    "lead.name": contact.name || "",
    "lead.firstName": firstName(contact.name),
    "lead.lastName": String(contact.name || "").trim().split(/\s+/).slice(1).join(" "),
    "lead.phone": contact.phone || "",
    "lead.email": contact.email || "",
    "organization.name": tenant.name || "",
    "form.name": form.name || "",
  };
  return String(template || DEFAULT_TEMPLATE).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => values[key] ?? "");
}

function templateParameters(contact, tenant, form, body) {
  const values = [
    firstName(contact.name),
    contact.company || "",
    contact.email || "",
    contact.phone || "",
    tenant.name || "",
    form.name || "",
  ];
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

function renderApprovedTemplate(body, parameters) {
  const values = new Map((parameters || []).map((item, index) => [index + 1, item.text || ""]));
  return String(body || "").replace(/\{\{(\d+)\}\}/g, (match, index) => values.get(Number(index)) ?? match);
}

function leadStatusKey(contact, isNewContact) {
  if (isNewContact) return "newLead";
  const status = String(contact?.status || "Lead").toLowerCase().replace(/[^a-z]/g, "");
  if (status === "prospect") return "prospect";
  if (["customer", "converted", "convertedlead", "won"].includes(status)) return "converted";
  return "existingLead";
}

async function sendGenericWebFormWhatsApp({
  form,
  contact,
  submissionId,
  isNewContact = false,
  source = "web_form",
}) {
  const rawRecipientPhone = contact?.whatsappPhone || contact?.phone;
  // The Create Lead form stores a display-formatted value such as
  // "+1 1234567890". Meta Cloud API requires the international number as
  // digits, so normalize it before using it for the thread and outbound job.
  const recipientPhone = String(rawRecipientPhone || "").replace(/\D/g, "");
  if (!form || form.scope !== "generic" || !recipientPhone) {
    return { sent: false, code: rawRecipientPhone ? "NOT_GENERIC" : "LEAD_PHONE_MISSING" };
  }

  const [tenant, config, selectedTemplateSetting] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: form.tenantId }, select: { name: true, vertical: true } }),
    prisma.whatsAppConfig.findFirst({ where: { tenantId: form.tenantId, isActive: true }, select: { phoneNumberId: true } }),
    prisma.tenantSetting.findUnique({ where: { tenantId_key: { tenantId: form.tenantId, key: TEMPLATE_SETTING_KEY } }, select: { value: true } }),
  ]);
  if (tenant?.vertical !== "generic") return { sent: false, code: "NOT_GENERIC" };
  if (!config?.phoneNumberId) return { sent: false, code: "WHATSAPP_NOT_CONFIGURED" };

  let approvedTemplate = null;
  if (selectedTemplateSetting?.value && prisma.whatsAppTemplate?.findFirst) {
    let selectedId = null;
    try {
      const parsed = JSON.parse(selectedTemplateSetting.value);
      selectedId = Number(parsed?.statusTemplates?.[leadStatusKey(contact, isNewContact)] || parsed?.templateId) || null;
    } catch {
      selectedId = Number(selectedTemplateSetting.value) || null;
    }
    if (selectedId) {
      approvedTemplate = await prisma.whatsAppTemplate.findFirst({
        where: { id: selectedId, tenantId: form.tenantId, status: "APPROVED" },
        select: { id: true, name: true, body: true },
      });
    }
  }

  const parameters = approvedTemplate ? templateParameters(contact, tenant, form, approvedTemplate.body) : [];
  const body = approvedTemplate
    ? renderApprovedTemplate(approvedTemplate.body, parameters)
    : render(DEFAULT_TEMPLATE, { contact, tenant, form });
  const messageMetadata = JSON.stringify({
    submissionId,
    source,
    ...(approvedTemplate ? { parameters } : {}),
  });
  const duplicate = await prisma.whatsAppMessage.findFirst({
    // Acknowledgements are idempotent per submission, not forever per
    // contact/body. A returning lead who submits again must receive the new
    // acknowledgement while retries of the same submission stay safe.
    where: { tenantId: form.tenantId, contactId: contact.id, interactiveJson: messageMetadata },
    select: { id: true },
  });
  if (duplicate) return { sent: false, code: "DUPLICATE" };

  const thread = await prisma.whatsAppThread.upsert({
    where: { tenantId_contactPhone: { tenantId: form.tenantId, contactPhone: recipientPhone } },
    create: { tenantId: form.tenantId, contactPhone: recipientPhone, contactName: contact.name, contactId: contact.id, lastMessageAt: new Date() },
    update: { contactName: contact.name, contactId: contact.id, lastMessageAt: new Date() },
  });
  const message = await prisma.whatsAppMessage.create({
    // Only approved Meta templates must be sent through the template API.
    // When no status template is selected, keep the fallback as plain text;
    // using a synthetic template name makes the outbound worker call Meta with
    // a template that does not exist.
    data: { to: recipientPhone, from: config.phoneNumberId, body, direction: "OUTBOUND", status: "QUEUED", templateName: approvedTemplate?.name || null, contactId: contact.id, tenantId: form.tenantId, threadId: thread.id, interactiveJson: messageMetadata },
  });
  await require("./whatsappQueue").getQueue().enqueueSend({ messageId: message.id, tenantId: form.tenantId });
  return { sent: true, messageId: message.id };
}

module.exports = {
  sendGenericWebFormWhatsApp,
  TEMPLATE_SETTING_KEY,
  DEFAULT_TEMPLATE,
  templateParameters,
  leadStatusKey,
};
