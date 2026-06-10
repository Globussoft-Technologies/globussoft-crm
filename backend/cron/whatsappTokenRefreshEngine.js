//
// WhatsApp token refresh engine (P4).
//
// Daily tick (default 04:00 IST). For every active, non-disconnected
// WhatsAppConfig with a non-null tokenExpiresAt:
//
//   • If expires_at < now           → mark disconnectedAt + audit + notify
//   • If expires_at < now + 7 days  → call fb_exchange_token to extend
//   • Else                          → no-op (just bump lastHealthCheckAt)
//
// Tokens with tokenExpiresAt = null are system-user-tied "never expires"
// tokens — we skip them entirely.
//
// Failures during extend are logged but do not flip disconnectedAt — the
// tenant still has a working token; we'll try again tomorrow. If extend
// fails repeatedly until the token actually expires, the expired-branch
// catches it.

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const { encryptCredential, decryptCredential } = require("../lib/credentialMasking");
const provider = require("../services/whatsappProvider");
const { writeAudit } = require("../lib/audit");

const TICK_CRON = "30 4 * * *"; // 04:30 daily server time
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function envAppId()     { return process.env.META_APP_ID || ""; }
function envAppSecret() { return process.env.META_APP_SECRET || ""; }

async function processOne(cfg) {
  const now = Date.now();
  if (!cfg.tokenExpiresAt) {
    // Never-expires token — system-user-tied. Just stamp the health-check.
    await prisma.whatsAppConfig.update({
      where: { id: cfg.id },
      data: { lastHealthCheckAt: new Date() },
    });
    return { id: cfg.id, action: "skip_never_expires" };
  }

  const t = new Date(cfg.tokenExpiresAt).getTime();

  if (t <= now) {
    // Already expired — soft-disconnect.
    await prisma.whatsAppConfig.update({
      where: { id: cfg.id },
      data: { disconnectedAt: new Date(), lastHealthCheckAt: new Date(), webhookVerified: false },
    });
    await writeAudit("WhatsAppConfig", "WHATSAPP_TOKEN_EXPIRED", cfg.id, null, cfg.tenantId, {
      expiredAt: cfg.tokenExpiresAt,
      action: "soft_disconnect",
    }).catch(() => {});
    // Best-effort tenant notification — Notification model already exists.
    await prisma.notification.create({
      data: {
        tenantId: cfg.tenantId,
        userId: null,
        type: "WHATSAPP_TOKEN_EXPIRED",
        title: "WhatsApp token expired",
        message: "Your WhatsApp integration token has expired. Reconnect via Settings → Channels to resume sending.",
        url: "/channels?tab=whatsapp",
      },
    }).catch((e) => console.warn("[tokenRefresh] notification insert failed:", e.message));
    return { id: cfg.id, action: "expired" };
  }

  const msUntilExpiry = t - now;
  if (msUntilExpiry > SEVEN_DAYS_MS) {
    await prisma.whatsAppConfig.update({
      where: { id: cfg.id },
      data: { lastHealthCheckAt: new Date() },
    });
    return { id: cfg.id, action: "no_op", daysLeft: Math.floor(msUntilExpiry / (24 * 3600 * 1000)) };
  }

  // <= 7 days — try to extend.
  const appId = envAppId();
  const appSecret = envAppSecret();
  if (!appId || !appSecret) {
    return { id: cfg.id, action: "skip_no_creds" };
  }
  const tokenPlain = decryptCredential(cfg.accessToken);
  if (!tokenPlain) {
    return { id: cfg.id, action: "skip_no_token" };
  }
  const ext = await provider.extendToken({ token: tokenPlain, appId, appSecret });
  if (!ext.ok || !ext.data?.access_token) {
    console.warn(`[tokenRefresh] extend failed for config ${cfg.id}: ${ext.error}`);
    // Probe expiry — maybe it's already invalidated.
    const dbg = await provider.debugToken({ token: tokenPlain, appId, appSecret });
    if (dbg.ok && dbg.data?.data?.is_valid === false) {
      await prisma.whatsAppConfig.update({
        where: { id: cfg.id },
        data: { disconnectedAt: new Date(), lastHealthCheckAt: new Date(), webhookVerified: false },
      });
      await writeAudit("WhatsAppConfig", "WHATSAPP_TOKEN_EXPIRED", cfg.id, null, cfg.tenantId, {
        reason: "extend_failed_and_is_valid_false",
      }).catch(() => {});
      return { id: cfg.id, action: "expired_via_debug" };
    }
    await prisma.whatsAppConfig.update({
      where: { id: cfg.id },
      data: { lastHealthCheckAt: new Date() },
    });
    return { id: cfg.id, action: "extend_failed", error: ext.error };
  }

  // Got a new token. Compute new expiry from /debug_token (Meta returns one
  // in the extend response but it's not always populated).
  let newExpiresAt = cfg.tokenExpiresAt; // keep current as fallback
  const dbg = await provider.debugToken({ token: ext.data.access_token, appId, appSecret });
  if (dbg.ok && dbg.data?.data?.expires_at) {
    newExpiresAt = dbg.data.data.expires_at > 0 ? new Date(dbg.data.data.expires_at * 1000) : null;
  }

  await prisma.whatsAppConfig.update({
    where: { id: cfg.id },
    data: {
      accessToken: encryptCredential(ext.data.access_token),
      tokenExpiresAt: newExpiresAt,
      lastRotatedAt: new Date(),
      lastHealthCheckAt: new Date(),
    },
  });
  await writeAudit("WhatsAppConfig", "WHATSAPP_TOKEN_EXTENDED", cfg.id, null, cfg.tenantId, {
    previousExpiresAt: cfg.tokenExpiresAt,
    newExpiresAt: newExpiresAt,
  }).catch(() => {});
  return { id: cfg.id, action: "extended", newExpiresAt };
}

async function tick() {
  // Defensive: if the prisma client doesn't have the new column yet,
  // bail with a clear warning so the operator runs `prisma generate`.
  try {
    if (!prisma.whatsAppConfig?.findMany) return;
    const candidates = await prisma.whatsAppConfig.findMany({
      where: {
        isActive: true,
        disconnectedAt: null,
        accessToken: { not: null },
      },
    });
    if (candidates.length === 0) return;
    const results = [];
    for (const c of candidates) {
      try {
        results.push(await processOne(c));
      } catch (err) {
        console.error(`[tokenRefresh] config ${c.id} threw:`, err.message);
      }
    }
    const summary = results.reduce((acc, r) => {
      acc[r.action] = (acc[r.action] || 0) + 1;
      return acc;
    }, {});
    console.log(`[whatsappTokenRefreshEngine] processed ${results.length}:`, summary);
  } catch (err) {
    console.error("[whatsappTokenRefreshEngine] tick error:", err);
  }
}

function initWhatsappTokenRefreshCron() {
  cron.schedule(TICK_CRON, () => { tick(); });
  console.log(`[whatsappTokenRefreshEngine] initialized (cron: ${TICK_CRON})`);
}

module.exports = {
  initWhatsappTokenRefreshCron,
  _internals: { tick, processOne, SEVEN_DAYS_MS },
};
