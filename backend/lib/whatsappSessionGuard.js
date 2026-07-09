/**
 * whatsappSessionGuard.js — device-session governance for the WhatsApp Web
 * (QR-scan) transport used by the Travel vertical.
 *
 * WHY THIS EXISTS — the actual WhatsApp connection is a single tenant-scoped
 * in-memory session + LocalAuth store owned by services/whatsappWebClient.js
 * (one number per tenant). This module does NOT touch that engine; it only
 * records WHICH CRM user, on WHICH device, currently controls the connect/QR
 * action, and gates the /connect route accordingly. Two independent protections:
 *
 *   1. Per-user device lock — a given user may hold the control claim on only
 *      ONE device at a time. A 2nd device for the SAME user is refused (the UI
 *      shows a "controlled from another device" warning). DIFFERENT users are
 *      never blocked by each other — they share the one inbox as before.
 *
 *   2. Per-tenant relink cooldown — because the number is shared, generating a
 *      fresh QR / relink on it is throttled for a cooldown window after a
 *      disconnect, regardless of who clicks. This is the Meta-suspension safety
 *      layer (frequent relinks on one account are what trip Meta). It is skipped
 *      when the shared session is already CONNECTED (an idempotent connect
 *      generates no QR, so there is no relink to throttle).
 *
 * Stale claims (a browser tab that stopped heart-beating) are expired LAZILY on
 * every claim()/heartbeat() call — no cron needed — so a closed tab frees the
 * lock after WA_DEVICE_HEARTBEAT_TTL_MS.
 *
 * Login/logout/reconnect/blocked attempts are written to the audit log via the
 * shared writeAudit() helper (entity "WhatsAppWebSession").
 *
 * CJS self-mocking seam (CLAUDE.md standing pattern): inter-function calls go
 * through module.exports.fn(...) so vitest vi.spyOn interception works.
 *
 * Config (env, read at call-time so tests can override):
 *   WA_DEVICE_LOCK               "off" disables the whole layer (default: on)
 *   WA_DEVICE_HEARTBEAT_TTL_MS   claim goes stale after this (default 120000 = 2m)
 *   WA_RELINK_COOLDOWN_MS        relink cooldown after a disconnect (default 900000 = 15m)
 */

const prisma = require("./prisma");
const { writeAudit } = require("./audit");

const ACTIVE = "ACTIVE";
const LOGGED_OUT = "LOGGED_OUT";
const EXPIRED = "EXPIRED";

// Read env at call-time (not module-load) so tests can flip config per-case.
function cfg() {
  const raw = process.env.WA_DEVICE_LOCK;
  const enabled = String(raw == null ? "on" : raw).toLowerCase() !== "off";
  return {
    enabled,
    heartbeatTtlMs: Number(process.env.WA_DEVICE_HEARTBEAT_TTL_MS) || 120000,
    cooldownMs: Number(process.env.WA_RELINK_COOLDOWN_MS) || 900000,
  };
}

// writeAudit is already fail-soft (never throws), but wrap defensively so a
// governance-audit hiccup can never break a connect/disconnect request.
async function audit(action, entityId, userId, tenantId, details) {
  try {
    await writeAudit("WhatsAppWebSession", action, entityId, userId, tenantId, details);
  } catch (e) {
    console.warn(`[waGuard] audit ${action} failed (non-fatal): ${e.message}`);
  }
}

// Expire ACTIVE claims whose heartbeat lapsed — frees a lock left by a closed
// tab. Best-effort; returns the count expired.
async function expireStale(tenantId) {
  const { heartbeatTtlMs } = cfg();
  const cutoff = new Date(Date.now() - heartbeatTtlMs);
  try {
    const r = await prisma.whatsAppWebSession.updateMany({
      where: { tenantId: Number(tenantId), status: ACTIVE, lastHeartbeat: { lt: cutoff } },
      data: { status: EXPIRED },
    });
    return r.count || 0;
  } catch (e) {
    console.warn(`[waGuard] expireStale failed (non-fatal): ${e.message}`);
    return 0;
  }
}

/**
 * Decide whether (userId, deviceId) may drive a connect on this tenant, and —
 * if so — record/refresh the control claim.
 *
 * opts: { deviceLabel, ip, reset, isConnected }
 * Returns { allowed:true, session, reconnect } OR
 *         { allowed:false, code, message, activeDevice?, cooldownRemainingMs? }.
 */
async function claim(tenantId, userId, deviceId, opts = {}) {
  tenantId = Number(tenantId);
  userId = Number(userId);
  const { deviceLabel = null, ip = null, reset = false, isConnected = false } = opts;
  const { enabled, cooldownMs } = cfg();

  // Layer disabled, or a legacy/other caller with no device identity — we
  // cannot enforce a per-device lock without a deviceId, so allow (backward
  // compatible) and audit it as a bypass so the trail stays complete.
  if (!enabled || !deviceId) {
    await audit("LOGIN", null, userId, tenantId, {
      deviceId: deviceId || null,
      ip,
      bypass: true,
      reason: !enabled ? "lock-disabled" : "no-device-id",
    });
    return { allowed: true, bypass: true };
  }

  const dev = String(deviceId);
  await module.exports.expireStale(tenantId);

  // (1) Per-user device lock — is THIS user already ACTIVE on a different device?
  const others = await prisma.whatsAppWebSession.findMany({
    where: { tenantId, userId, status: ACTIVE, deviceId: { not: dev } },
    orderBy: { lastHeartbeat: "desc" },
  });
  if (others.length) {
    const a = others[0];
    await audit("DEVICE_LOCKED", a.id, userId, tenantId, {
      attemptedDeviceId: dev,
      heldDeviceId: a.deviceId,
      heldDeviceLabel: a.deviceLabel,
    });
    const since = a.loginAt ? new Date(a.loginAt).toISOString() : null;
    return {
      allowed: false,
      code: "WA_DEVICE_LOCKED",
      message:
        `WhatsApp is already being controlled from another device` +
        (a.deviceLabel ? ` (${a.deviceLabel})` : "") +
        (since ? `, connected ${since}` : "") +
        `. Disconnect there — or wait for it to go idle — before connecting from this device.`,
      activeDevice: { deviceLabel: a.deviceLabel, ip: a.ip, loginAt: a.loginAt },
    };
  }

  // (2) Per-tenant relink cooldown — only bites when a fresh QR would actually
  // be generated (session not already CONNECTED, or an explicit reset which
  // wipes + relinks). A resume of a still-live link generates no QR → no relink.
  if (!isConnected || reset) {
    const lastLogout = await prisma.whatsAppWebSession.findFirst({
      where: { tenantId, logoutAt: { not: null } },
      orderBy: { logoutAt: "desc" },
      select: { logoutAt: true },
    });
    if (lastLogout && lastLogout.logoutAt) {
      const remaining = cooldownMs - (Date.now() - new Date(lastLogout.logoutAt).getTime());
      if (remaining > 0) {
        await audit("RELINK_COOLDOWN", null, userId, tenantId, { deviceId: dev, cooldownRemainingMs: remaining, reset });
        return {
          allowed: false,
          code: "WA_RELINK_COOLDOWN",
          message:
            `WhatsApp was recently disconnected. To protect the number from suspension, ` +
            `please wait ${Math.ceil(remaining / 60000)} more minute(s) before reconnecting.`,
          cooldownRemainingMs: remaining,
        };
      }
    }
  }

  // (3) Allowed — upsert this device's claim (reused on reconnect, no dupes).
  const now = new Date();
  const existing = await prisma.whatsAppWebSession.findUnique({
    where: { tenantId_userId_deviceId: { tenantId, userId, deviceId: dev } },
  });
  const reconnect = !!(existing && existing.status === ACTIVE);
  const base = { status: ACTIVE, ip, deviceLabel, lastHeartbeat: now, logoutAt: null };
  let row;
  if (existing) {
    // Reactivating a LOGGED_OUT/EXPIRED row resets loginAt; a live reconnect keeps it.
    row = await prisma.whatsAppWebSession.update({
      where: { id: existing.id },
      data: reconnect ? base : { ...base, loginAt: now },
    });
  } else {
    row = await prisma.whatsAppWebSession.create({
      data: { tenantId, userId, deviceId: dev, loginAt: now, ...base },
    });
  }
  await audit(reconnect ? "RECONNECT" : "LOGIN", row.id, userId, tenantId, { deviceId: dev, deviceLabel, ip, reset });
  return { allowed: true, session: row, reconnect };
}

/**
 * Refresh a device's heartbeat. Returns { ok, lost } — lost:true when the claim
 * no longer exists / is no longer ACTIVE (expired or taken), so the UI can tell
 * the operator it lost control of the session.
 */
async function heartbeat(tenantId, userId, deviceId) {
  tenantId = Number(tenantId);
  userId = Number(userId);
  if (!deviceId) return { ok: false, lost: false };
  const dev = String(deviceId);
  await module.exports.expireStale(tenantId);
  try {
    const row = await prisma.whatsAppWebSession.findUnique({
      where: { tenantId_userId_deviceId: { tenantId, userId, deviceId: dev } },
    });
    if (!row || row.status !== ACTIVE) return { ok: false, lost: true };
    await prisma.whatsAppWebSession.update({ where: { id: row.id }, data: { lastHeartbeat: new Date() } });
    return { ok: true, lost: false };
  } catch (e) {
    console.warn(`[waGuard] heartbeat failed (non-fatal): ${e.message}`);
    return { ok: false, lost: false };
  }
}

/**
 * Release a user's control claim on disconnect/logout. Sets logoutAt (which
 * starts the tenant relink cooldown) + marks the row LOGGED_OUT. When deviceId
 * is omitted, releases all of this user's active claims for the tenant.
 */
async function release(tenantId, userId, deviceId, opts = {}) {
  tenantId = Number(tenantId);
  userId = Number(userId);
  const { logout = false } = opts;
  const now = new Date();
  try {
    const where = deviceId
      ? { tenantId, userId, deviceId: String(deviceId) }
      : { tenantId, userId, status: ACTIVE };
    const r = await prisma.whatsAppWebSession.updateMany({
      where,
      data: { status: LOGGED_OUT, logoutAt: now },
    });
    await audit("LOGOUT", null, userId, tenantId, { deviceId: deviceId || null, logout, released: r.count || 0 });
    return { released: r.count || 0 };
  } catch (e) {
    console.warn(`[waGuard] release failed (non-fatal): ${e.message}`);
    return { released: 0 };
  }
}

module.exports = {
  claim,
  heartbeat,
  release,
  expireStale,
  cfg,
  STATUS: { ACTIVE, LOGGED_OUT, EXPIRED },
};
