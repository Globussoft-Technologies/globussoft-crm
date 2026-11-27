const SETTING_KEY = "notifications.emailCcRecipients";
const MAX_RECIPIENTS = 25;
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const DEFAULT_SENDER_EMAIL = String(process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com").trim();

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseRecipients(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid notification email CC settings.");
  }
  return {
    staffUserIds: Array.isArray(parsed.staffUserIds) ? parsed.staffUserIds : [],
    externalEmails: Array.isArray(parsed.externalEmails) ? parsed.externalEmails : [],
    receiverEmail: parsed.receiverEmail == null || parsed.receiverEmail === ""
      ? null
      : normalizeEmail(parsed.receiverEmail),
  };
}

async function getNotificationEmailConfig(prisma, tenantId) {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: SETTING_KEY } },
    select: { value: true },
  });
  if (!row) return { ccRecipients: [], receiverEmail: null };

  const config = parseRecipients(row.value);
  const staffUserIds = [...new Set(config.staffUserIds
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))]
    .slice(0, MAX_RECIPIENTS);
  const staff = staffUserIds.length
    ? await prisma.user.findMany({
      where: {
        tenantId,
        id: { in: staffUserIds },
        userType: { in: ["STAFF", "OWNER"] },
        role: { not: "CUSTOMER" },
        deactivatedAt: null,
      },
      select: { email: true },
    })
    : [];
  const externalEmails = config.externalEmails.map(normalizeEmail);
  return {
    ccRecipients: [...new Set([
    ...staff.map((member) => normalizeEmail(member.email)),
    ...externalEmails,
    ].filter((email) => EMAIL_PATTERN.test(email)))].slice(0, MAX_RECIPIENTS),
    receiverEmail: config.receiverEmail && EMAIL_PATTERN.test(config.receiverEmail) ? config.receiverEmail : null,
  };
}

module.exports = {
  SETTING_KEY,
  MAX_RECIPIENTS,
  EMAIL_PATTERN,
  DEFAULT_SENDER_EMAIL,
  normalizeEmail,
  parseRecipients,
  getNotificationEmailConfig,
};
