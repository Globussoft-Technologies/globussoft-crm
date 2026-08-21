"use strict";

// Super-admin managed AI provider keys.
// These keys are stored encrypted and can be attached to AI subscription plans.
// Only keys with isEnabled=true are eligible for CRM-managed AI resolution.

const prisma = require("./prisma");
const { encrypt, decrypt } = require("./fieldEncryption");

const DEFAULT_BASE_URLS = {
  gemini: "https://generativelanguage.googleapis.com",
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  cohere: "https://api.cohere.com/compatibility/v1",
  moonshot: "https://api.moonshot.cn/v1",
  xai: "https://api.x.ai/v1",
};

const DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash-lite",
  openai: "gpt-4o-mini",
  claude: "claude-3-5-sonnet-latest",
  groq: "llama-3.3-70b-versatile",
  deepseek: "deepseek-chat",
  mistral: "mistral-small-latest",
  openrouter: "gpt-4o-mini",
  cohere: "command-r-plus",
  moonshot: "moonshot-v1-8k",
  xai: "grok-2-latest",
};

function defaultModelForProvider(providerId) {
  return DEFAULT_MODELS[providerId] || "gpt-4o-mini";
}

function maskApiKey(key) {
  if (!key || key.length < 12) return key ? "***" : "";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function formatKey(row) {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    apiKey: maskApiKey(decrypt(row.apiKey)),
    baseUrl: row.baseUrl || DEFAULT_BASE_URLS[row.providerId] || null,
    model: row.model || defaultModelForProvider(row.providerId),
    isEnabled: row.isEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function formatKeyWithSecret(row) {
  return {
    ...formatKey(row),
    apiKey: decrypt(row.apiKey),
  };
}

function validateInput(body, { partial = false } = {}) {
  const errors = [];
  const providerId = String(body.providerId || "").trim().toLowerCase();
  if (!partial && !providerId) errors.push("providerId is required");
  const label = String(body.label || "").trim();
  if (!partial && !label) errors.push("label is required");
  const apiKey = body.apiKey != null ? String(body.apiKey).trim() : "";
  if (!partial && !apiKey) errors.push("apiKey is required");
  const baseUrl = body.baseUrl !== undefined
    ? (body.baseUrl ? String(body.baseUrl).trim() : null)
    : undefined;
  const model = body.model !== undefined
    ? (body.model ? String(body.model).trim() : null)
    : undefined;
  const isEnabled = body.isEnabled !== undefined ? body.isEnabled !== false : undefined;
  return { errors, data: { providerId, label, apiKey, baseUrl, model, isEnabled } };
}

async function listKeys({ includeSecret = false } = {}) {
  const rows = await prisma.aiManagedApiKey.findMany({
    orderBy: [{ providerId: "asc" }, { createdAt: "desc" }],
  });
  return rows.map(includeSecret ? formatKeyWithSecret : formatKey);
}

async function listEnabledKeys() {
  const rows = await prisma.aiManagedApiKey.findMany({
    where: { isEnabled: true },
    orderBy: [{ providerId: "asc" }, { createdAt: "desc" }],
  });
  return rows.map(formatKeyWithSecret);
}

async function createKey(body) {
  const { errors, data } = validateInput(body);
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.code = "INVALID_KEY_INPUT";
    throw err;
  }
  const row = await prisma.aiManagedApiKey.create({
    data: {
      providerId: data.providerId,
      label: data.label,
      apiKey: encrypt(data.apiKey),
      baseUrl: data.baseUrl,
      model: data.model,
      isEnabled: data.isEnabled,
    },
  });
  return formatKey(row);
}

async function updateKey(id, body) {
  if (!Number.isFinite(Number(id))) {
    const err = new Error("Invalid key id");
    err.code = "INVALID_KEY_ID";
    throw err;
  }
  const existing = await prisma.aiManagedApiKey.findUnique({ where: { id: Number(id) } });
  if (!existing) {
    const err = new Error("API key not found");
    err.code = "P2025";
    throw err;
  }
  const { errors, data } = validateInput(body, { partial: true });
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.code = "INVALID_KEY_INPUT";
    throw err;
  }
  const row = await prisma.aiManagedApiKey.update({
    where: { id: Number(id) },
    data: {
      providerId: data.providerId || existing.providerId,
      label: data.label || existing.label,
      apiKey: data.apiKey ? encrypt(data.apiKey) : existing.apiKey,
      baseUrl: data.baseUrl !== undefined ? data.baseUrl : existing.baseUrl,
      model: data.model !== undefined ? data.model : existing.model,
      isEnabled: data.isEnabled !== undefined ? data.isEnabled : existing.isEnabled,
    },
  });
  return formatKey(row);
}

async function deleteKey(id) {
  if (!Number.isFinite(Number(id))) {
    const err = new Error("Invalid key id");
    err.code = "INVALID_KEY_ID";
    throw err;
  }
  await prisma.aiManagedApiKey.delete({ where: { id: Number(id) } });
  return { ok: true };
}

async function getKeyById(id) {
  if (!Number.isFinite(Number(id))) return null;
  const row = await prisma.aiManagedApiKey.findUnique({ where: { id: Number(id) } });
  return row ? formatKeyWithSecret(row) : null;
}

module.exports = {
  DEFAULT_BASE_URLS,
  listKeys,
  listEnabledKeys,
  createKey,
  updateKey,
  deleteKey,
  getKeyById,
};
