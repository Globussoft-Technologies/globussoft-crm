const crypto = require("crypto");
const prisma = require("./prisma");
const { notify } = require("./notificationService");

function leadDisplayName(contact) {
  if (!contact) return "A new lead";
  return contact.name || contact.email || contact.phone || `Lead #${contact.id}`;
}

async function notifyAdminsOfNewLead({ tenantId, contact, io }) {
  if (!tenantId || !contact?.id || contact.status !== "Lead") return [];

  try {
    const admins = await prisma.user.findMany({
      where: {
        tenantId,
        role: "ADMIN",
        deactivatedAt: null,
      },
      select: { id: true },
    });

    const leadName = leadDisplayName(contact);
    const results = [];
    for (const admin of admins) {
      results.push(await notify({
        userId: admin.id,
        tenantId,
        title: "New lead added",
        message: `${leadName} has been added to Leads.`,
        type: "info",
        category: "lead",
        priority: "normal",
        link: "/leads",
        entityType: "lead",
        entityId: contact.id,
        channels: ["db", "socket"],
        io,
      }));
    }
    return results;
  } catch (err) {
    console.error("[leadNotifications] admin lead notification failed:", err && err.message);
    return [];
  }
}

function normalizeEmbedOrigin(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch (_err) {
    return null;
  }
}

function allowlistEntryMatchesOrigin(origin, entry) {
  if (!origin || !entry || typeof entry !== "string") return false;
  const trimmed = entry.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;

  const match = trimmed.match(/^https:\/\/(\*\.)?([^\s/*:]+)(?::(\d+))?(?:\/.*)?$/i);
  if (!match) return false;

  const wildcard = !!match[1];
  const host = match[2].toLowerCase();
  const port = match[3] || "";

  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_err) {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if ((parsed.port || "") !== port) return false;

  const hostName = parsed.hostname.toLowerCase();
  if (wildcard) {
    return hostName === host || hostName.endsWith(`.${host}`);
  }

  return hostName === host;
}

function isEmbedOriginAllowed(origin, allowlistJson) {
  const normalizedOrigin = normalizeEmbedOrigin(origin);
  if (!allowlistJson) return true;

  let allowlist = allowlistJson;
  if (typeof allowlistJson === "string") {
    try {
      allowlist = JSON.parse(allowlistJson);
    } catch (_err) {
      return true;
    }
  }

  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  if (!normalizedOrigin) return false;
  return allowlist.some((entry) => allowlistEntryMatchesOrigin(normalizedOrigin, entry));
}

function blockedOriginEntityId(origin) {
  const hash = crypto.createHash("sha1").update(String(origin)).digest("hex").slice(0, 8);
  return parseInt(hash, 16);
}

async function notifyAdminsOfBlockedLeadOrigin({ tenantId, origin, io }) {
  const normalizedOrigin = normalizeEmbedOrigin(origin);
  if (!tenantId || !normalizedOrigin) return [];

  try {
    const admins = await prisma.user.findMany({
      where: {
        tenantId,
        role: "ADMIN",
        deactivatedAt: null,
      },
      select: { id: true },
    });

    const results = [];
    for (const admin of admins) {
      results.push(await notify({
        userId: admin.id,
        tenantId,
        title: "External lead origin blocked",
        message: `${normalizedOrigin} is not in the external lead allowlist. Open Settings to allow or deny it.`,
        type: "warning",
        category: "lead",
        priority: "high",
        link: "/settings",
        entityType: "lead_domain",
        entityId: blockedOriginEntityId(normalizedOrigin),
        channels: ["db", "socket"],
        io,
      }));
    }
    return results;
  } catch (err) {
    console.error("[leadNotifications] blocked origin notification failed:", err && err.message);
    return [];
  }
}

module.exports = {
  allowlistEntryMatchesOrigin,
  isEmbedOriginAllowed,
  normalizeEmbedOrigin,
  notifyAdminsOfBlockedLeadOrigin,
  notifyAdminsOfNewLead,
};
