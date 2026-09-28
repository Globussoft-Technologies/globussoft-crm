const prisma = require("./prisma");

const SETTING_KEY = "generic.webForm.whatsappLeadMessage";
const MESSAGE_TAG = "generic_web_form_lead";
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

async function sendGenericWebFormWhatsApp({ form, contact, submissionId }) {
  if (!form || form.scope !== "generic" || !contact?.phone) {
    return { sent: false, code: contact?.phone ? "NOT_GENERIC" : "LEAD_PHONE_MISSING" };
  }

  const [tenant, config, setting] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: form.tenantId }, select: { name: true, vertical: true } }),
    prisma.whatsAppConfig.findFirst({ where: { tenantId: form.tenantId, isActive: true }, select: { phoneNumberId: true } }),
    prisma.tenantSetting.findUnique({ where: { tenantId_key: { tenantId: form.tenantId, key: SETTING_KEY } }, select: { value: true } }),
  ]);
  if (tenant?.vertical !== "generic") return { sent: false, code: "NOT_GENERIC" };
  if (!config?.phoneNumberId) return { sent: false, code: "WHATSAPP_NOT_CONFIGURED" };

  const body = render(setting?.value || DEFAULT_TEMPLATE, { contact, tenant, form });
  const messageMetadata = JSON.stringify({ submissionId, source: "web_form" });
  const duplicate = await prisma.whatsAppMessage.findFirst({
    // Acknowledgements are idempotent per submission, not forever per
    // contact/body. A returning lead who submits again must receive the new
    // acknowledgement while retries of the same submission stay safe.
    where: { tenantId: form.tenantId, contactId: contact.id, templateName: MESSAGE_TAG, interactiveJson: messageMetadata },
    select: { id: true },
  });
  if (duplicate) return { sent: false, code: "DUPLICATE" };

  const thread = await prisma.whatsAppThread.upsert({
    where: { tenantId_contactPhone: { tenantId: form.tenantId, contactPhone: contact.phone } },
    create: { tenantId: form.tenantId, contactPhone: contact.phone, contactName: contact.name, contactId: contact.id, lastMessageAt: new Date() },
    update: { contactName: contact.name, contactId: contact.id, lastMessageAt: new Date() },
  });
  const message = await prisma.whatsAppMessage.create({
    data: { to: contact.phone, from: config.phoneNumberId, body, direction: "OUTBOUND", status: "QUEUED", templateName: MESSAGE_TAG, contactId: contact.id, tenantId: form.tenantId, threadId: thread.id, interactiveJson: messageMetadata },
  });
  await require("./whatsappQueue").getQueue().enqueueSend({ messageId: message.id, tenantId: form.tenantId });
  return { sent: true, messageId: message.id };
}

module.exports = { sendGenericWebFormWhatsApp, SETTING_KEY, DEFAULT_TEMPLATE };
