//
// WhatsApp embedded-signup onboarding orchestration (P2).
//
// Called from routes/whatsapp_onboard.js — the route stays thin and this
// module owns the multi-step flow:
//
//   1. exchangeCode      Meta OAuth code → access token
//   2. debugToken        capture expiry + scope verification
//   3. extendToken       (optional) bump short-lived → 60d token
//   4. subscribeApp      wire Meta webhook delivery for this WABA → us
//   5. registerPhone     register the phone-number-id for Cloud API messaging
//   6. persist           AES-256-GCM-encrypt token, upsert WhatsAppConfig
//   7. initial template sync (best-effort)
//
// Failure shapes — every step that fails returns an object with `code`:
//   META_AUTH_FAILED         OAuth code exchange failed
//   TOKEN_DEBUG_FAILED       /debug_token call failed
//   TOKEN_INVALID            token is not valid / wrong app
//   SCOPE_MISSING            required scopes absent
//   WEBHOOK_SUBSCRIBE_FAILED subscribed_apps call failed
//   PHONE_REGISTER_FAILED    /register call failed
//   PERSIST_FAILED           DB upsert failed
//
// Meta config (META_APP_ID / META_APP_SECRET / WHATSAPP_EMBEDDED_SIGNUP_ENABLED)
// is read per-call so an operator can flip the feature flag without restart.

const prisma = require("./prisma");
const { encryptCredential } = require("./credentialMasking");
const provider = require("../services/whatsappProvider");
const { writeAudit } = require("./audit");

const REQUIRED_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
];

function envAppId()     { return process.env.META_APP_ID || ""; }
function envAppSecret() { return process.env.META_APP_SECRET || ""; }
function isEnabled() {
  return String(process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED || "").toLowerCase() === "true";
}

/**
 * Exchange phase — converts the embedded-signup code into an access token.
 * Returns { ok, token, expiresAt, scopes } or { ok:false, code, error }.
 */
async function exchangeAndDebug({ code, redirectUri }) {
  const appId = envAppId();
  const appSecret = envAppSecret();
  if (!appId || !appSecret) {
    return { ok: false, code: "META_CREDS_MISSING", error: "META_APP_ID / META_APP_SECRET unset on backend" };
  }

  const exch = await provider.exchangeCode({ code, appId, appSecret, redirectUri });
  if (!exch.ok || !exch.data?.access_token) {
    return { ok: false, code: "META_AUTH_FAILED", error: exch.error || "no access_token in response" };
  }
  let token = exch.data.access_token;

  // Try to extend short-lived → long-lived. fb_exchange_token is idempotent on
  // already-long-lived tokens (returns the same shape), so we always call.
  const ext = await provider.extendToken({ token, appId, appSecret });
  if (ext.ok && ext.data?.access_token) {
    token = ext.data.access_token;
  }
  // If extend failed we proceed with the original token — debugToken will
  // tell us the real expiry below.

  const dbg = await provider.debugToken({ token, appId, appSecret });
  if (!dbg.ok || !dbg.data?.data) {
    return { ok: false, code: "TOKEN_DEBUG_FAILED", error: dbg.error || "debug_token returned no data" };
  }
  const info = dbg.data.data;
  if (info.is_valid === false) {
    return { ok: false, code: "TOKEN_INVALID", error: "Meta marked the token as not valid" };
  }
  const scopes = Array.isArray(info.scopes) ? info.scopes : [];
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "SCOPE_MISSING",
      error: `Missing required scope(s): ${missing.join(", ")}. The tenant may need to redo the embedded-signup flow with the correct permissions selected.`,
    };
  }
  // expires_at of 0 = "never expires" (system-user-tied token).
  const expiresAt = info.expires_at && info.expires_at > 0 ? new Date(info.expires_at * 1000) : null;
  return {
    ok: true,
    token,
    expiresAt,
    scopes,
    appUserId: info.user_id || null,
  };
}

/**
 * Finalize phase — given a validated token + the tenant's WABA + phone-number-id,
 * subscribes our app to the WABA, registers the phone, encrypts + stores config.
 *
 * @param {Object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.token
 * @param {Date|null} opts.expiresAt
 * @param {string|null} opts.appUserId
 * @param {string} opts.wabaId
 * @param {string} opts.phoneNumberId
 * @param {string} [opts.registerPin]   6-digit 2-step verification PIN
 * @param {number} [opts.userId]        actor for audit
 */
async function finalize({
  tenantId,
  token,
  expiresAt,
  appUserId,
  wabaId,
  phoneNumberId,
  registerPin,
  userId,
}) {
  // 1. Subscribe app to WABA. Tolerate the "already subscribed" success path —
  //    Meta returns ok=true if we re-subscribe an existing subscription.
  const sub = await provider.subscribeApp({ wabaId, accessToken: token });
  if (!sub.ok && !/already/i.test(sub.error || "")) {
    return { ok: false, code: "WEBHOOK_SUBSCRIBE_FAILED", error: sub.error };
  }

  // 2. Register phone for Cloud API. Optional — Meta sometimes auto-registers
  //    during embedded signup. Skip if registerPin is not provided AND the
  //    phone is already registered (which we can't cheaply detect without a
  //    Graph call; we just tolerate the failure path).
  if (registerPin) {
    const reg = await provider.registerPhone({
      phoneNumberId,
      accessToken: token,
      pin: registerPin,
    });
    if (!reg.ok && !/already.*registered/i.test(reg.error || "")) {
      return { ok: false, code: "PHONE_REGISTER_FAILED", error: reg.error };
    }
  }

  // 3. Persist. Encrypt the token. Upsert on (tenantId, provider='meta_cloud').
  //    Active by default; previous configs on the same tenant get isActive=false.
  let saved;
  try {
    saved = await prisma.$transaction(async (tx) => {
      const upserted = await tx.whatsAppConfig.upsert({
        where: { tenantId_provider: { tenantId, provider: "meta_cloud" } },
        create: {
          tenantId,
          provider: "meta_cloud",
          phoneNumberId,
          businessAccountId: wabaId,
          accessToken: encryptCredential(token),
          isActive: true,
          tokenExpiresAt: expiresAt,
          appUserId: appUserId || null,
          webhookVerified: true,
          onboardedAt: new Date(),
          disconnectedAt: null,
          lastRotatedAt: new Date(),
          lastHealthCheckAt: new Date(),
        },
        update: {
          phoneNumberId,
          businessAccountId: wabaId,
          accessToken: encryptCredential(token),
          isActive: true,
          tokenExpiresAt: expiresAt,
          appUserId: appUserId || null,
          webhookVerified: true,
          onboardedAt: { set: undefined }, // preserve original onboardedAt on reconnect
          disconnectedAt: null,
          lastRotatedAt: new Date(),
          lastHealthCheckAt: new Date(),
        },
      });
      // Deactivate any sibling providers for this tenant — only one active
      // provider at a time.
      await tx.whatsAppConfig.updateMany({
        where: { tenantId, provider: { not: "meta_cloud" } },
        data: { isActive: false },
      });
      return upserted;
    });
  } catch (err) {
    return { ok: false, code: "PERSIST_FAILED", error: err.message };
  }

  await writeAudit("WhatsAppConfig", "WHATSAPP_CONNECT", saved.id, userId || null, tenantId, {
    wabaId,
    phoneNumberId,
    tokenExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    via: "embedded_signup",
  }).catch((e) => console.warn("[onboarding] audit WHATSAPP_CONNECT failed:", e.message));

  return { ok: true, configId: saved.id, phoneNumberId, wabaId, tokenExpiresAt: expiresAt };
}

/**
 * Disconnect — soft. Optionally calls /subscribed_apps DELETE so Meta stops
 * sending webhooks for this WABA. The DB row is preserved (no chat history
 * lost) with disconnectedAt set.
 */
async function disconnect({ tenantId, userId, alsoUnsubscribeFromMeta }) {
  const cfg = await prisma.whatsAppConfig.findFirst({
    where: { tenantId, provider: "meta_cloud" },
  });
  if (!cfg) return { ok: false, code: "NOT_CONNECTED" };

  if (alsoUnsubscribeFromMeta && cfg.businessAccountId && cfg.accessToken) {
    const { decryptCredential } = require("./credentialMasking");
    const tok = decryptCredential(cfg.accessToken);
    if (tok) {
      const r = await provider.unsubscribeApp({ wabaId: cfg.businessAccountId, accessToken: tok });
      if (!r.ok) {
        // Don't fail the disconnect — Meta sometimes returns 4xx if already
        // unsubscribed. Log + continue.
        console.warn("[onboarding] unsubscribeApp failed (continuing):", r.error);
      }
    }
  }

  const updated = await prisma.whatsAppConfig.update({
    where: { id: cfg.id },
    data: { isActive: false, disconnectedAt: new Date(), webhookVerified: false },
  });
  await writeAudit("WhatsAppConfig", "WHATSAPP_DISCONNECT", cfg.id, userId || null, tenantId, {
    wabaId: cfg.businessAccountId,
    phoneNumberId: cfg.phoneNumberId,
    alsoUnsubscribeFromMeta: !!alsoUnsubscribeFromMeta,
  }).catch((e) => console.warn("[onboarding] audit WHATSAPP_DISCONNECT failed:", e.message));
  return { ok: true, configId: updated.id };
}

module.exports = {
  exchangeAndDebug,
  finalize,
  disconnect,
  isEnabled,
  REQUIRED_SCOPES,
  _internals: { envAppId, envAppSecret },
};
