"use strict";
const SYSTEM_CATEGORY_PREFIX = "System: Generic CRM:";
const SEED_MARKER_KEY = "generic.leadNotificationTemplates.v1";
function genericLeadNotificationCategory(isNewContact) { return `${SYSTEM_CATEGORY_PREFIX} ${isNewContact ? "New Lead" : "Updated Lead"}`; }
const DEFAULTS = [
  { name: "New lead - welcome & pickup/plot", channel: "EMAIL", category: genericLeadNotificationCategory(true), subject: "Thanks for contacting {{organization.name}}", body: "<p>Hi {{contact.first_name}},</p><p>Thanks for contacting us through {{form.name}}.</p><p><a href=\"{{selectionLink}}\">Choose your pickup location and interested plot</a></p>" },
  { name: "Updated lead - pickup/plot follow-up", channel: "EMAIL", category: genericLeadNotificationCategory(false), subject: "Your enquiry with {{organization.name}}", body: "<p>Hi {{contact.first_name}},</p><p>We have updated your enquiry.</p><p><a href=\"{{selectionLink}}\">Choose your pickup location and interested plot</a></p>" },
  { name: "New lead - pickup/plot SMS", channel: "SMS", category: genericLeadNotificationCategory(true), subject: "New lead acknowledgement", body: "Hi {{contact.first_name}}, thanks for contacting us. Choose your pickup location and interested plot: {{selectionLink}}" },
  { name: "Updated lead - pickup/plot SMS", channel: "SMS", category: genericLeadNotificationCategory(false), subject: "Lead update acknowledgement", body: "Hi {{contact.first_name}}, your enquiry was updated. Choose your pickup location and interested plot: {{selectionLink}}" },
];
async function ensureGenericLeadNotificationTemplates(db, tenantId) {
  if (!db?.emailTemplate?.findMany || !db?.emailTemplate?.create) return [];
  const marker = db.tenantSetting?.findUnique ? await db.tenantSetting.findUnique({ where: { tenantId_key: { tenantId, key: SEED_MARKER_KEY } }, select: { value: true } }) : null;
  if (marker?.value === "seeded") return [];
  const existing = await db.emailTemplate.findMany({ where: { tenantId, category: { in: [...new Set(DEFAULTS.map((item) => item.category))] }, channel: { in: ["EMAIL", "SMS"] } }, select: { category: true, channel: true } });
  const keys = new Set((existing || []).map((item) => `${item.channel}:${item.category}`));
  const created = [];
  for (const template of DEFAULTS) if (!keys.has(`${template.channel}:${template.category}`)) created.push(await db.emailTemplate.create({ data: { ...template, tenantId } }));
  if (db.tenantSetting?.upsert) await db.tenantSetting.upsert({ where: { tenantId_key: { tenantId, key: SEED_MARKER_KEY } }, create: { tenantId, key: SEED_MARKER_KEY, value: "seeded", category: "communication" }, update: { value: "seeded", category: "communication" } });
  return created;
}
module.exports = { SYSTEM_CATEGORY_PREFIX, genericLeadNotificationCategory, ensureGenericLeadNotificationTemplates, _internal: { DEFAULTS, SEED_MARKER_KEY } };
