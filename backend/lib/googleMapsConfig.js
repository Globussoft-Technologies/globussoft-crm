const prisma = require("./prisma");
const {
  decryptCredential,
  encryptCredential,
  maskCredential,
} = require("./credentialMasking");

const GOOGLE_MAPS_PROVIDER = "google_maps";

function configFromRow(row) {
  const tenantKey = row?.token ? decryptCredential(row.token) : "";
  const enabled = row?.isActive === true;
  const effectiveKey = enabled ? tenantKey : "";

  return {
    row,
    enabled,
    configured: Boolean(tenantKey),
    source: tenantKey ? "tenant" : "none",
    last4: tenantKey ? maskCredential(row.token) : null,
    updatedAt: row?.updatedAt || null,
    effectiveKey,
  };
}

async function getGoogleMapsConfig(tenantId, db = prisma) {
  const row = await db.integration.findUnique({
    where: { tenantId_provider: { tenantId, provider: GOOGLE_MAPS_PROVIDER } },
  });
  return configFromRow(row);
}

async function saveGoogleMapsConfig(tenantId, input, db = prisma) {
  const current = await getGoogleMapsConfig(tenantId, db);
  const suppliedKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  const enabled = input?.enabled === true;

  if (suppliedKey && (suppliedKey.length < 20 || suppliedKey.length > 500)) {
    const error = new Error("Enter a valid Google Maps API key.");
    error.code = "INVALID_API_KEY";
    error.status = 400;
    throw error;
  }
  if (!suppliedKey && !current.configured) {
    const error = new Error("Add a Google Maps API key before saving these settings.");
    error.code = "API_KEY_REQUIRED";
    error.status = 400;
    throw error;
  }

  const token = suppliedKey
    ? encryptCredential(suppliedKey)
    : (current.row?.token || null);
  const row = await db.integration.upsert({
    where: { tenantId_provider: { tenantId, provider: GOOGLE_MAPS_PROVIDER } },
    create: {
      tenantId,
      provider: GOOGLE_MAPS_PROVIDER,
      token,
      isActive: enabled,
      settings: JSON.stringify({ api: "places-new" }),
    },
    update: {
      token,
      isActive: enabled,
      settings: JSON.stringify({ api: "places-new" }),
    },
  });

  return configFromRow(row);
}

async function resolveGoogleMapsApiKey(tenantId, db = prisma) {
  const config = await getGoogleMapsConfig(tenantId, db);
  return config.effectiveKey || null;
}

function toPublicGoogleMapsConfig(config) {
  return {
    enabled: config.enabled,
    configured: config.configured,
    source: config.source,
    last4: config.last4,
    updatedAt: config.updatedAt,
  };
}

module.exports = {
  GOOGLE_MAPS_PROVIDER,
  getGoogleMapsConfig,
  saveGoogleMapsConfig,
  resolveGoogleMapsApiKey,
  toPublicGoogleMapsConfig,
};
