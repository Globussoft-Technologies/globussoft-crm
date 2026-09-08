/**
 * Admin-configurable "who gets notified when a new diagnostic is submitted,
 * and how" for TMC/RFU/Travel Stall/Visa Sure diagnostics (2026-08-28).
 *
 * Deliberately does NOT use a dedicated Prisma table/column — reuses the
 * generic TenantSetting key-value store (same mechanism as
 * curriculumDocuments.js / diagnosticRecommendationSettings.js /
 * diagnosticChosenInterests.js), keeping this fully additive with zero
 * schema migrations.
 *
 * Row shape: TenantSetting { tenantId, key: `travel.diagnostics.notifyConfig.<subBrand>`,
 * category: "travel-diagnostic-notification-settings",
 * value: JSON.stringify({ recipients: [{ userId, channels: ["db","email","whatsapp"] }] }) }.
 */

const prisma = require("./prisma");

const CATEGORY = "travel-diagnostic-notification-settings";
const KEY_PREFIX = "travel.diagnostics.notifyConfig.";

const ALLOWED_CHANNELS = ["db", "email", "whatsapp"];
const MAX_RECIPIENTS = 25;

function keyFor(subBrand) {
  return `${KEY_PREFIX}${String(subBrand || "").toLowerCase()}`;
}

function normalizeRecipients(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const userId = Number(raw?.userId);
    if (!Number.isFinite(userId) || userId <= 0 || seen.has(userId)) continue;
    const channels = Array.isArray(raw?.channels)
      ? [...new Set(raw.channels.filter((c) => ALLOWED_CHANNELS.includes(c)))]
      : [];
    if (!channels.length) continue; // a recipient with no channel selected does nothing — drop them
    seen.add(userId);
    out.push({ userId, channels });
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

/**
 * Raw configured recipients for a tenant/subBrand — [] when never configured.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @returns {Promise<{userId:number, channels:string[]}[]>}
 */
async function getNotificationRecipients({ tenantId, subBrand }) {
  try {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: keyFor(subBrand) } },
    });
    if (!row) return [];
    const parsed = JSON.parse(row.value);
    return normalizeRecipients(parsed?.recipients);
  } catch {
    return [];
  }
}

/**
 * Persist the recipient list for a tenant/subBrand (full replace).
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {object[]} opts.recipients - [{userId, channels}]
 * @returns {Promise<{userId:number, channels:string[]}[]>} the normalized list actually saved
 */
async function setNotificationRecipients({ tenantId, subBrand, recipients }) {
  const clean = normalizeRecipients(recipients);
  const value = JSON.stringify({ recipients: clean });
  const key = keyFor(subBrand);
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, value, category: CATEGORY },
    update: { value, category: CATEGORY },
  });
  return clean;
}

module.exports = {
  getNotificationRecipients,
  setNotificationRecipients,
  ALLOWED_CHANNELS,
  MAX_RECIPIENTS,
  CATEGORY,
};
