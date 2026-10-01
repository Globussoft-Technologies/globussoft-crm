"use strict";

const prisma = require("../lib/prisma");
const {
  encryptTravelMeetingCredential,
  decryptTravelMeetingCredential,
} = require("../lib/travelMeetingCredentialEncryption");

const CONFIG_KEY = "travel.email.sendgrid";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const API_KEY_RE = /^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function providerError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeConfig(input, current = null) {
  const apiKey = String(input?.apiKey || current?.apiKey || "").trim();
  const fromEmail = String(input?.fromEmail ?? current?.fromEmail ?? "").trim().toLowerCase();
  const fromName = String(input?.fromName ?? current?.fromName ?? "").trim();
  if (!API_KEY_RE.test(apiKey) || apiKey.length > 500) {
    throw providerError("Enter a valid SendGrid API key beginning with SG.", "INVALID_SENDGRID_API_KEY");
  }
  if (!EMAIL_RE.test(fromEmail) || fromEmail.length > 254) {
    throw providerError("Enter a valid verified SendGrid sender email address.", "INVALID_SENDGRID_FROM_EMAIL");
  }
  if (!fromName || fromName.length > 100 || /[\r\n]/.test(fromName)) {
    throw providerError("Sender name is required and must be 100 characters or fewer.", "INVALID_SENDGRID_FROM_NAME");
  }
  return { apiKey, fromEmail, fromName };
}

function decodeConfig(value) {
  try {
    return normalizeConfig(JSON.parse(decryptTravelMeetingCredential(value)));
  } catch (error) {
    if (error.code) throw error;
    throw providerError("Stored Travel SendGrid credentials are invalid.", "TRAVEL_SENDGRID_CONFIG_INVALID", 500);
  }
}

async function readTenantConfig(tenantId) {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: CONFIG_KEY } },
    select: { id: true, value: true, updatedAt: true },
  });
  return row ? { row, config: decodeConfig(row.value) } : null;
}

function backendConfig() {
  return {
    apiKey: String(process.env.SENDGRID_API_KEY || "").trim(),
    fromEmail: String(process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com").trim(),
    fromName: String(process.env.SENDGRID_FROM_NAME || "").trim(),
    source: "backend",
  };
}

async function resolveSendGridConfig(tenantId) {
  if (tenantId) {
    const tenantConfig = await readTenantConfig(tenantId);
    if (tenantConfig) return { ...tenantConfig.config, source: "tenant" };
  }
  return backendConfig();
}

async function isSendGridConfigured(tenantId) {
  if (tenantId) {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: CONFIG_KEY } },
      select: { id: true },
    });
    if (row) return true;
  }
  return Boolean(backendConfig().apiKey);
}

async function saveTenantConfig(tenantId, input) {
  const existing = await readTenantConfig(tenantId);
  const config = normalizeConfig(input, existing?.config || null);
  const value = encryptTravelMeetingCredential(JSON.stringify(config));
  const row = await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key: CONFIG_KEY } },
    create: { tenantId, key: CONFIG_KEY, value, category: "travel-email" },
    update: { value, category: "travel-email" },
  });
  return { row, config };
}

async function deleteTenantConfig(tenantId) {
  return prisma.tenantSetting.deleteMany({ where: { tenantId, key: CONFIG_KEY } });
}

function publicStatus(tenantConfig) {
  const fallback = backendConfig();
  return {
    configured: Boolean(tenantConfig),
    source: tenantConfig ? "tenant" : "backend",
    fromEmail: tenantConfig?.config.fromEmail || "",
    fromName: tenantConfig?.config.fromName || "",
    apiKeyLast4: tenantConfig?.config.apiKey ? `****${tenantConfig.config.apiKey.slice(-4)}` : null,
    updatedAt: tenantConfig?.row.updatedAt || null,
    fallback: {
      configured: Boolean(fallback.apiKey),
      fromEmail: fallback.fromEmail,
      fromName: fallback.fromName,
    },
  };
}

module.exports = {
  CONFIG_KEY,
  normalizeConfig,
  readTenantConfig,
  resolveSendGridConfig,
  isSendGridConfigured,
  saveTenantConfig,
  deleteTenantConfig,
  publicStatus,
};
