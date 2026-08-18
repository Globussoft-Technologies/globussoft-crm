// @ts-check
//
// whatsappTenantConnect.js — manual per-tenant WhatsApp Cloud API connect.
//
// WHY THIS EXISTS (and how it differs from lib/whatsappOnboardingService.js):
//
//   whatsappOnboardingService is the Embedded Signup path — the tenant clicks
//   "Connect WhatsApp Business", Meta's popup hands us an OAuth `code`, and we
//   exchange it. That flow is gated behind WHATSAPP_EMBEDDED_SIGNUP_ENABLED
//   because it requires Meta App Review (Tech Provider / Solution Partner
//   status) before Meta will issue the config_id. Until review clears, every
//   tenant is stuck at 503 EMBEDDED_SIGNUP_NOT_APPROVED.
//
//   This module is the manual-credential path that works TODAY: the tenant
//   creates their own Meta app + system-user token in Business Manager, pastes
//   the four identifiers into Settings, and we validate them against Graph
//   before marking the integration connected. Same destination — one encrypted,
//   tenant-scoped WhatsAppConfig row — reached without App Review.
//
// SCOPE: the generic Meta Cloud surface only (provider "meta_cloud", the
// vertical-agnostic routes/whatsapp*.js). The travel Wati transport
// (routes/travel_whatsapp.js) and the WhatsApp Web QR transport
// (services/whatsappWebClient.js) resolve their own credentials and are
// deliberately untouched.
//
// HARD RULES enforced here:
//   1. Nothing is marked active until Meta itself confirms the credentials.
//      A failed probe leaves the row inactive — never "optimistically on".
//   2. phoneNumberId is globally unique (Meta forbids one number on two
//      WABAs). If another tenant already owns it we refuse with
//      PHONE_NUMBER_CLAIMED rather than reassigning it — that would let
//      tenant B hijack tenant A's inbound webhook routing.
//   3. Credentials are AES-256-GCM encrypted at rest (lib/credentialMasking)
//      and every return value is masked. Plaintext never leaves this module.
//   4. Tokens are never logged — not in success paths, not in error paths.
//      Graph errors are surfaced by code/message only.

const prisma = require("./prisma");
const {
  encryptCredential,
  decryptCredential,
  looksLikeMaskedSentinel,
  maskConfigRow,
} = require("./credentialMasking");
const { computeStatus } = require("./whatsappHealth");
const { writeAudit } = require("./audit");
const {
  graphRequest,
  listPhoneNumbers,
  subscribeApp,
  unsubscribeApp,
  debugToken,
} = require("../services/whatsappProvider");

// The generic Meta Cloud provider key. Sibling providers on the same tenant
// ("twilio_whatsapp", "gupshup") stay supported by PUT /config/:provider but
// only meta_cloud goes through Graph validation.
const META_CLOUD_PROVIDER = "meta_cloud";

// Secret columns on WhatsAppConfig — mirrors WA_SECRET_FIELDS in
// routes/whatsapp.js. Kept local so this module has no route dependency.
const SECRET_FIELDS = ["accessToken", "webhookVerifyToken"];

/**
 * Fields the TENANT must supply, in the order the Settings form presents
 * them. Exported so the route (and its tests) can describe the contract
 * without duplicating the list.
 */
const REQUIRED_TENANT_FIELDS = ["phoneNumberId", "businessAccountId", "accessToken"];

function fail(code, message, extra) {
  return { ok: false, code, error: message, ...(extra || {}) };
}

/**
 * True when the caller echoed a masked sentinel (`****1234`) back at us
 * instead of typing a new secret — meaning "keep what's stored".
 * @param {unknown} v
 */
function isUnchangedSecret(v) {
  if (v === undefined || v === null) return true;
  if (typeof v !== "string") return true;
  if (v.trim() === "") return true;
  return looksLikeMaskedSentinel(v);
}

/**
 * Resolve the access token to validate with: a freshly-typed one, or the
 * stored ciphertext decrypted. Returns null when neither is available.
 * @param {string|undefined} provided
 * @param {{accessToken?: string|null}|null} existing
 */
function resolveAccessToken(provided, existing) {
  if (!isUnchangedSecret(provided)) return String(provided).trim();
  if (existing && existing.accessToken) {
    try {
      const plain = decryptCredential(existing.accessToken);
      return plain || null;
    } catch (_e) {
      // Ciphertext written under a rotated WHATSAPP/field-encryption key —
      // treat as absent so the admin is told to re-paste rather than getting
      // a confusing Graph auth error.
      return null;
    }
  }
  return null;
}

/**
 * Probe Meta with the tenant's own credentials.
 *
 * Three checks, cheapest-and-most-diagnostic first:
 *   1. GET /{phoneNumberId} — proves the token can read that number at all.
 *      Meta code 190 here means the token is invalid/expired; a 404/100 means
 *      the phone-number-id is wrong.
 *   2. GET /{wabaId}/phone_numbers — proves the number actually belongs to the
 *      WABA the tenant declared. Without this a tenant could pair their own
 *      number with someone else's WABA id and we'd store an inconsistent row.
 *   3. GET /debug_token — expiry + scopes. ONLY when META_APP_ID/SECRET are
 *      configured, because debug_token needs an app access token. Manual
 *      system-user tokens are commonly used without our platform app, so a
 *      missing app secret is a skip, never a failure.
 *
 * @param {{ phoneNumberId: string, businessAccountId: string, accessToken: string }} args
 */
async function probeMeta({ phoneNumberId, businessAccountId, accessToken }) {
  const numberRes = await graphRequest({
    method: "GET",
    path: `/${phoneNumberId}`,
    accessToken,
    query: { fields: "id,display_phone_number,verified_name,quality_rating,platform_type" },
  });
  if (!numberRes.ok) {
    const code = numberRes.code === 190 ? "INVALID_ACCESS_TOKEN" : "INVALID_PHONE_NUMBER_ID";
    return fail(
      code,
      code === "INVALID_ACCESS_TOKEN"
        ? `Meta rejected the access token: ${numberRes.error}`
        : `Meta could not read phone number id "${phoneNumberId}": ${numberRes.error}`,
    );
  }

  const listRes = await listPhoneNumbers({ wabaId: businessAccountId, accessToken });
  if (!listRes.ok) {
    return fail(
      "INVALID_BUSINESS_ACCOUNT_ID",
      `Meta could not read WhatsApp Business Account "${businessAccountId}": ${listRes.error}`,
    );
  }
  const owned = Array.isArray(listRes.data?.data) ? listRes.data.data : [];
  if (owned.length && !owned.some((n) => String(n.id) === String(phoneNumberId))) {
    return fail(
      "PHONE_NUMBER_WABA_MISMATCH",
      `Phone Number ID ${phoneNumberId} is not attached to WhatsApp Business Account ${businessAccountId}. ` +
        `Check both values in Meta Business Manager → WhatsApp Accounts.`,
    );
  }

  // Token expiry — best-effort enrichment.
  let tokenExpiresAt = null;
  let scopes = [];
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (appId && appSecret) {
    const dbg = await debugToken({ token: accessToken, appId, appSecret });
    const d = dbg.ok ? dbg.data?.data : null;
    if (d) {
      // expires_at === 0 means "never expires" (system-user token).
      if (d.expires_at) tokenExpiresAt = new Date(Number(d.expires_at) * 1000);
      if (Array.isArray(d.scopes)) scopes = d.scopes;
    }
  }

  const num = numberRes.data || {};
  return {
    ok: true,
    displayPhoneNumber: num.display_phone_number || null,
    verifiedName: num.verified_name || null,
    qualityRating: num.quality_rating || null,
    tokenExpiresAt,
    scopes,
  };
}

/**
 * Validate a tenant's pasted Meta credentials and, on success, persist them
 * encrypted and mark the integration connected.
 *
 * @param {{
 *   tenantId: number,
 *   userId?: number|null,
 *   phoneNumberId?: string,
 *   businessAccountId?: string,
 *   businessId?: string|null,
 *   accessToken?: string,
 *   webhookVerifyToken?: string,
 *   subscribeWebhooks?: boolean,
 * }} input
 * @returns {Promise<{ok: true, config: any, status: any, meta: any} | {ok: false, code: string, error: string, fields?: string[]}>}
 */
async function validateAndConnect(input) {
  const {
    tenantId,
    userId = null,
    phoneNumberId,
    businessAccountId,
    businessId = null,
    accessToken,
    webhookVerifyToken,
    subscribeWebhooks = true,
  } = input || {};

  if (!tenantId) return fail("TENANT_REQUIRED", "Tenant context is required.");

  const existing = await prisma.whatsAppConfig.findUnique({
    where: { tenantId_provider: { tenantId, provider: META_CLOUD_PROVIDER } },
  });

  const cleanPhoneNumberId = String(phoneNumberId || "").trim();
  const cleanBusinessAccountId = String(businessAccountId || "").trim();
  const effectivePhoneNumberId = cleanPhoneNumberId || existing?.phoneNumberId || "";
  const effectiveBusinessAccountId = cleanBusinessAccountId || existing?.businessAccountId || "";
  const effectiveToken = resolveAccessToken(accessToken, existing);

  const missing = [];
  if (!effectivePhoneNumberId) missing.push("phoneNumberId");
  if (!effectiveBusinessAccountId) missing.push("businessAccountId");
  if (!effectiveToken) missing.push("accessToken");
  if (missing.length) {
    return fail(
      "MISSING_FIELDS",
      `Missing required Meta credentials: ${missing.join(", ")}.`,
      { fields: missing },
    );
  }

  // Cross-tenant hijack guard — BEFORE we spend a Graph round-trip. Meta lets
  // exactly one WABA own a phone_number_id, and our inbound webhook routing
  // keys off it, so a duplicate claim would silently redirect another tenant's
  // conversations.
  const claimedByOther = await prisma.whatsAppConfig.findFirst({
    where: { phoneNumberId: effectivePhoneNumberId, tenantId: { not: tenantId } },
    select: { id: true },
  });
  if (claimedByOther) {
    return fail(
      "PHONE_NUMBER_CLAIMED",
      `Phone Number ID ${effectivePhoneNumberId} is already connected to another account on this platform. ` +
        `If this number belongs to you, disconnect it there first or contact support.`,
    );
  }

  const probe = await probeMeta({
    phoneNumberId: effectivePhoneNumberId,
    businessAccountId: effectiveBusinessAccountId,
    accessToken: effectiveToken,
  });
  if (!probe.ok) {
    // Validation failed → make sure we are NOT left in a connected state.
    if (existing && existing.isActive) {
      await prisma.whatsAppConfig.update({
        where: { id: existing.id },
        data: { isActive: false },
      });
    }
    return probe;
  }

  // Webhook subscription — best-effort. "Already subscribed" is success as far
  // as we're concerned, so only a hard failure downgrades webhookVerified.
  let webhookVerified = false;
  if (subscribeWebhooks) {
    const sub = await subscribeApp({
      wabaId: effectiveBusinessAccountId,
      accessToken: effectiveToken,
    });
    webhookVerified = Boolean(sub.ok) || /already/i.test(String(sub.error || ""));
  }

  const now = new Date();
  const secretWrites = {};
  if (!isUnchangedSecret(accessToken)) {
    secretWrites.accessToken = encryptCredential(String(accessToken).trim());
  }
  if (webhookVerifyToken !== undefined) {
    secretWrites.webhookVerifyToken = isUnchangedSecret(webhookVerifyToken)
      ? undefined
      : encryptCredential(String(webhookVerifyToken).trim());
    if (secretWrites.webhookVerifyToken === undefined) delete secretWrites.webhookVerifyToken;
  }
  const rotated = Object.keys(secretWrites);

  // `settings` carries the non-secret Meta metadata that has no dedicated
  // column (Business ID, the verified display name Meta echoes back). Merged
  // rather than replaced so unrelated keys written elsewhere survive.
  let mergedSettings = {};
  if (existing?.settings) {
    try {
      const parsed = JSON.parse(existing.settings);
      if (parsed && typeof parsed === "object") mergedSettings = parsed;
    } catch (_e) {
      /* legacy non-JSON settings — start clean rather than throw */
    }
  }
  mergedSettings = {
    ...mergedSettings,
    ...(businessId !== null && businessId !== undefined && { metaBusinessId: String(businessId).trim() || null }),
    displayPhoneNumber: probe.displayPhoneNumber,
    verifiedName: probe.verifiedName,
    connectedVia: "manual",
    lastValidatedAt: now.toISOString(),
    ...(probe.scopes.length && { tokenScopes: probe.scopes }),
  };

  const writeData = {
    phoneNumberId: effectivePhoneNumberId,
    businessAccountId: effectiveBusinessAccountId,
    ...secretWrites,
    isActive: true,
    webhookVerified,
    disconnectedAt: null,
    tokenExpiresAt: probe.tokenExpiresAt,
    ...(probe.qualityRating && { qualityRating: probe.qualityRating }),
    lastHealthCheckAt: now,
    settings: JSON.stringify(mergedSettings),
    ...(rotated.length && { lastRotatedAt: now }),
  };

  const config = await prisma.whatsAppConfig.upsert({
    where: { tenantId_provider: { tenantId, provider: META_CLOUD_PROVIDER } },
    create: {
      provider: META_CLOUD_PROVIDER,
      tenantId,
      accessToken: secretWrites.accessToken || "",
      webhookVerifyToken: secretWrites.webhookVerifyToken || null,
      onboardedAt: now,
      ...writeData,
    },
    update: {
      // onboardedAt is the "first ever successful validation" marker and must
      // survive reconnects — only stamp it when it was never set.
      ...(existing?.onboardedAt ? {} : { onboardedAt: now }),
      ...writeData,
    },
  });

  // One active transport per tenant: connecting Meta Cloud stands down any
  // sibling provider rows for THIS tenant only.
  await prisma.whatsAppConfig.updateMany({
    where: { tenantId, provider: { not: META_CLOUD_PROVIDER } },
    data: { isActive: false },
  });

  await writeAudit(
    "WhatsAppConfig",
    "WHATSAPP_CONNECT",
    config.id,
    userId,
    tenantId,
    {
      provider: META_CLOUD_PROVIDER,
      phoneNumberId: effectivePhoneNumberId,
      businessAccountId: effectiveBusinessAccountId,
      webhookVerified,
      connectedVia: "manual",
      rotatedFields: rotated,
    },
  );

  return {
    ok: true,
    config: maskConfigRow(config, SECRET_FIELDS),
    status: computeStatus(config),
    meta: {
      displayPhoneNumber: probe.displayPhoneNumber,
      verifiedName: probe.verifiedName,
      qualityRating: probe.qualityRating,
      tokenExpiresAt: probe.tokenExpiresAt,
      webhookVerified,
    },
  };
}

/**
 * Soft-disconnect the tenant's Meta Cloud integration. Credentials and message
 * history are preserved so a reconnect is a re-validate, not a re-setup.
 *
 * @param {{ tenantId: number, userId?: number|null, unsubscribe?: boolean }} args
 */
async function disconnect({ tenantId, userId = null, unsubscribe = true }) {
  if (!tenantId) return fail("TENANT_REQUIRED", "Tenant context is required.");

  const existing = await prisma.whatsAppConfig.findUnique({
    where: { tenantId_provider: { tenantId, provider: META_CLOUD_PROVIDER } },
  });
  if (!existing) return fail("NOT_CONFIGURED", "No WhatsApp configuration to disconnect.");

  if (unsubscribe && existing.businessAccountId && existing.accessToken) {
    try {
      const plain = decryptCredential(existing.accessToken);
      if (plain) {
        await unsubscribeApp({ wabaId: existing.businessAccountId, accessToken: plain });
      }
    } catch (_e) {
      // Best-effort: a Meta-side unsubscribe failure must not block the
      // local disconnect, otherwise an expired token would trap the tenant.
    }
  }

  const config = await prisma.whatsAppConfig.update({
    where: { id: existing.id },
    data: { isActive: false, webhookVerified: false, disconnectedAt: new Date() },
  });

  await writeAudit(
    "WhatsAppConfig",
    "WHATSAPP_DISCONNECT",
    config.id,
    userId,
    tenantId,
    { provider: META_CLOUD_PROVIDER, phoneNumberId: existing.phoneNumberId },
  );

  return { ok: true, config: maskConfigRow(config, SECRET_FIELDS), status: computeStatus(config) };
}

/**
 * Masked connection state for the Settings card. Includes the two values OUR
 * system generates (webhook callback URL + a verify token to paste into Meta)
 * so the UI can render all three provenance groups without inventing them.
 *
 * @param {{ tenantId: number }} args
 */
async function getConnectionState({ tenantId }) {
  const config = await prisma.whatsAppConfig.findUnique({
    where: { tenantId_provider: { tenantId, provider: META_CLOUD_PROVIDER } },
  });

  let settings = {};
  if (config?.settings) {
    try {
      const parsed = JSON.parse(config.settings);
      if (parsed && typeof parsed === "object") settings = parsed;
    } catch (_e) {
      /* ignore malformed legacy settings */
    }
  }

  // WEBHOOK_BASE_URL is documented as a base ORIGIN, but operators routinely
  // paste the full callback URL they registered in Meta (that is what the value
  // looks like in Meta's own UI). Naively appending the path to such a value
  // yields ".../api/whatsapp/webhook/api/whatsapp/webhook", which Express does
  // not route — Meta's verification then fails with no clear reason. Strip a
  // trailing occurrence of the path so this is idempotent either way.
  const base = String(process.env.WEBHOOK_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/whatsapp\/webhook$/i, "")
    .replace(/\/+$/, "");
  return {
    provider: META_CLOUD_PROVIDER,
    configured: Boolean(config),
    status: computeStatus(config),
    config: config ? maskConfigRow(config, SECRET_FIELDS) : null,
    meta: {
      displayPhoneNumber: settings.displayPhoneNumber || null,
      verifiedName: settings.verifiedName || null,
      metaBusinessId: settings.metaBusinessId || null,
      connectedVia: settings.connectedVia || null,
      lastValidatedAt: settings.lastValidatedAt || null,
    },
    // Values the CLIENT copies FROM us INTO Meta.
    ours: {
      callbackUrl: base ? `${base}/api/whatsapp/webhook` : "/api/whatsapp/webhook",
      callbackUrlConfigured: Boolean(base),
      verifyTokenSource: process.env.META_VERIFY_TOKEN
        ? "platform"
        : config?.webhookVerifyToken
          ? "tenant"
          : "unset",
    },
    requiredFields: REQUIRED_TENANT_FIELDS,
  };
}

module.exports = {
  META_CLOUD_PROVIDER,
  REQUIRED_TENANT_FIELDS,
  validateAndConnect,
  disconnect,
  getConnectionState,
  // exported for unit tests / introspection only
  probeMeta,
  resolveAccessToken,
};
