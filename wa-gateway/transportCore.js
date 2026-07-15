/**
 * WhatsApp Gateway Transport Core — the standalone transport service for
 * whatsapp-web.js + Puppeteer/Chromium. Owns sessions, QR, connect/disconnect,
 * send, inbound dispatch, and the Puppeteer crash guard.
 *
 * This is extracted from backend/services/whatsappWebClient.js (transport half).
 * All persistence, Socket.IO, lead capture, and business logic remain in the
 * CRM backend — the gateway is strictly stateless transport (except for the
 * live Chromium sessions which are per-tenant and transient).
 *
 * Deployment: runs as a standalone Node process (wa-gateway), reachable from the
 * backend via REST at WA_GATEWAY_URL with X-Internal-Key auth. Posts normalized
 * event DTOs (qr, state, inbound, ack, imported) to the backend's
 * /internal/whatsapp/events webhook.
 *
 * SESSION MODEL — one Chromium session per tenant, keyed by tenantId. Persisted
 * to disk via LocalAuth (clientId `travel-<tenantId>`, dataPath
 * `.wwebjs_auth/session-travel-<tenantId>`) so a service restart resumes without
 * re-scanning. QR re-scan only during production cutover (Phase 3).
 *
 * CI/TEST SAFETY — honors NODE_ENV=test and WHATSAPP_WEB_DISABLED env flags;
 * never launches a browser in those modes. Lazy-requires whatsapp-web.js +
 * puppeteer only inside live connect() paths.
 */

const path = require("path");
const fs = require("fs");

// ─────────────────────────────────────────────────────────────────────────────
// Session registry + Puppeteer crash guard
// ─────────────────────────────────────────────────────────────────────────────

// tenantId(number) → { state, qr, qrDataUrl, phone, wid, client, startedAt, lastError }
const sessions = new Map();

const STATE = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  INITIALIZING: "INITIALIZING",
  QR: "QR",
  AUTHENTICATED: "AUTHENTICATED",
  CONNECTED: "CONNECTED",
  AUTH_FAILURE: "AUTH_FAILURE",
});

const AUTH_DIR = path.join(__dirname, ".wwebjs_auth");

// Benign puppeteer/wweb teardown errors that should NOT crash the gateway.
const _PUPPETEER_TEARDOWN_RE = /detached Frame|Target closed|Session closed|Protocol error|Execution context was destroyed|page has been closed|Cannot read properties of (?:null|undefined).*(?:frame|page)/i;
function isPuppeteerTeardownError(err) {
  const m = String((err && err.stack) || (err && err.message) || err || "");
  if (!_PUPPETEER_TEARDOWN_RE.test(m)) return false;
  return /whatsapp-web\.js|puppeteer/i.test(m) || /detached Frame|Target closed|Session closed/i.test(m);
}

let _crashGuardInstalled = false;
function installPuppeteerCrashGuard() {
  if (_crashGuardInstalled) return;
  _crashGuardInstalled = true;
  process.on("unhandledRejection", (reason) => {
    if (isPuppeteerTeardownError(reason)) {
      console.warn(`[transportCore] swallowed puppeteer teardown rejection (non-fatal): ${(reason && reason.message) || reason}`);
      return;
    }
    throw reason;
  });
  process.on("uncaughtException", (err) => {
    if (isPuppeteerTeardownError(err)) {
      console.warn(`[transportCore] swallowed puppeteer teardown exception (non-fatal): ${(err && err.message) || err}`);
      return;
    }
    throw err;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Event forwarder — posts DTOs to the backend webhook
// ─────────────────────────────────────────────────────────────────────────────

let _eventHandler = null; // (type, tenantId, payload) → Promise<void>

function setEventHandler(fn) {
  _eventHandler = fn;
}

async function emitStateChange(tenantId, state) {
  if (_eventHandler) await _eventHandler("state", tenantId, state);
}
async function emitQR(tenantId, qr) {
  if (_eventHandler) await _eventHandler("qr", tenantId, { qr });
}
async function emitInbound(tenantId, msg) {
  if (_eventHandler) await _eventHandler("inbound", tenantId, msg);
}
async function emitAck(tenantId, payload) {
  if (_eventHandler) await _eventHandler("ack", tenantId, payload);
}
async function emitImportProgress(tenantId, chats) {
  if (_eventHandler) await _eventHandler("imported", tenantId, { chats });
}

// ─────────────────────────────────────────────────────────────────────────────
// DTO Builders (pure, no side effects) — mirror backend/services/waTransportDTO.js
// ─────────────────────────────────────────────────────────────────────────────

function messageIdOf(msg) {
  return msg && msg.id && msg.id._serialized ? String(msg.id._serialized) : null;
}

function buildAckDTO(msg, ack) {
  return {
    providerMsgId: messageIdOf(msg),
    ack: ack || null,
  };
}

function buildInboundMessageDTO(tenantId, msg) {
  if (!msg || msg.fromMe) return null;
  const fromRaw = msg.from || "";
  // Minimal chat kind check (exact logic in backend)
  if (!/^[0-9]+@c\.us|@lid|@g\.us/.test(fromRaw)) return null;
  // Minimal content check
  if (msg.type === "e2e_notification" || !msg.body) return null;

  const isGroup = fromRaw.includes("@g.us");
  return {
    providerMsgId: messageIdOf(msg),
    phone: fromRaw,
    isGroup,
    waName: (msg._data && msg._data.notifyName) || null,
    body: typeof msg.body === "string" && msg.body.trim() ? msg.body : null,
    notifyName: (msg._data && msg._data.notifyName) || null,
    type: (msg.type || "chat").toLowerCase(),
    hasMedia: Boolean(msg.hasMedia),
    timestamp: msg.timestamp || 0,
  };
}

function buildHistoryMessageDTO(msg) {
  if (!msg) return null;
  return {
    providerMsgId: messageIdOf(msg),
    outbound: Boolean(msg.fromMe),
    body: typeof msg.body === "string" && msg.body.trim() ? msg.body : null,
    type: (msg.type || "chat").toLowerCase(),
    hasMedia: Boolean(msg.hasMedia),
    timestamp: msg.timestamp || 0,
    ack: msg.ack || null,
    notifyName: (msg._data && msg._data.notifyName) || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle — connect / disconnect / restore / shutdown
// ─────────────────────────────────────────────────────────────────────────────

function getSession(tenantId) {
  return sessions.get(Number(tenantId));
}

async function connect(tenantId, { reset = false } = {}) {
  tenantId = Number(tenantId);
  if (process.env.NODE_ENV === "test" || process.env.WHATSAPP_WEB_DISABLED) {
    return getState(tenantId);
  }

  const existing = getSession(tenantId);
  if (existing && existing.state === STATE.CONNECTED && !reset) {
    return getState(tenantId);
  }

  if (existing && reset) {
    await module.exports.disconnect(tenantId, { logout: true });
  }

  const s = { tenantId, state: STATE.INITIALIZING, qr: null, qrDataUrl: null, phone: null, wid: null, client: null, startedAt: new Date(), lastError: null };
  sessions.set(tenantId, s);
  await emitStateChange(tenantId, getState(tenantId));

  // Declared outside the try so the catch can reap a half-initialized client.
  let client = null;
  try {
    const { Client, LocalAuth } = require("whatsapp-web.js");
    const chromium = require("puppeteer");
    installPuppeteerCrashGuard();

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", process.env.WHATSAPP_WEB_CHROME_PATH ? "--executable-path=" + process.env.WHATSAPP_WEB_CHROME_PATH : ""].filter(Boolean),
    });

    client = new Client({
      authStrategy: new LocalAuth({ clientId: `travel-${tenantId}`, dataPath: AUTH_DIR }),
      puppeteer: { browser },
      webVersionCache: { type: "remote", remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html" },
    });

    client.on("qr", async (qr) => {
      s.state = STATE.QR;
      s.qr = qr;
      s.qrDataUrl = `data:image/png;base64,${(await require("qrcode").toDataURL(qr))}`;
      await emitStateChange(tenantId, getState(tenantId));
      await emitQR(tenantId, s.qrDataUrl);
    });

    client.on("authenticated", () => {
      s.state = STATE.AUTHENTICATED;
      emitStateChange(tenantId, getState(tenantId)).catch(() => {});
    });

    client.on("auth_failure", async (msg) => {
      s.state = STATE.AUTH_FAILURE;
      s.lastError = msg || "auth failed";
      // The browser behind a failed auth can never recover — reap it or it
      // sits as a ~1 GB orphan (whatsapp-web.js does not close it for us).
      const dead = s.client || client;
      s.client = null;
      if (dead && !dead.__tcDestroyed) {
        dead.__tcDestroyed = true;
        try { await dead.destroy(); } catch (e) { console.error(`[transportCore] tenant ${tenantId} auth_failure destroy warn: ${e.message}`); }
      }
      await emitStateChange(tenantId, getState(tenantId));
    });

    client.on("ready", async () => {
      s.state = STATE.CONNECTED;
      const info = client.info;
      s.phone = (info && info.me && info.me.user) || null;
      s.wid = (info && info.me && info.me.user) ? `${info.me.user}@c.us` : null;
      s.client = client;
      await emitStateChange(tenantId, getState(tenantId));
    });

    client.on("disconnected", async (reason) => {
      // Destroy the browser on EVERY disconnect — logout, transient drop, or
      // force-unlink. whatsapp-web.js leaves the Chromium process alive after
      // the session dies; without this each drop orphans ~1 GB of RAM.
      const dead = s.client || client;
      s.state = STATE.DISCONNECTED;
      s.phone = null;
      s.wid = null;
      s.client = null;
      s.qr = null;
      s.qrDataUrl = null;
      s.lastError = reason || "disconnected";
      if (dead && !dead.__tcDestroyed) {
        dead.__tcDestroyed = true;
        try { await dead.destroy(); } catch (e) { console.error(`[transportCore] tenant ${tenantId} disconnect destroy warn: ${e.message}`); }
      }
      await emitStateChange(tenantId, getState(tenantId));
    });

    client.on("message", async (msg) => {
      if (msg && msg.fromMe) return;
      const dto = buildInboundMessageDTO(tenantId, msg);
      if (dto) await emitInbound(tenantId, dto);
    });

    client.on("message_ack", async (msg, ack) => {
      const dto = buildAckDTO(msg, ack);
      await emitAck(tenantId, dto);
    });

    await client.initialize();
    return getState(tenantId);
  } catch (e) {
    s.state = STATE.AUTH_FAILURE;
    s.lastError = e.message || "initialization failed";
    // Reap a half-initialized client so its browser doesn't linger.
    if (client && !client.__tcDestroyed) {
      client.__tcDestroyed = true;
      try { await client.destroy(); } catch { /* best-effort */ }
    }
    await emitStateChange(tenantId, getState(tenantId));
    return getState(tenantId);
  }
}

async function disconnect(tenantId, { logout = false } = {}) {
  tenantId = Number(tenantId);
  const s = getSession(tenantId);
  if (!s) return getState(tenantId); // unknown / already-gone tenant — no-op (was a TypeError)
  const live = s.client;
  s.client = null;
  if (live && !live.__tcDestroyed) {
    live.__tcDestroyed = true;
    try {
      if (logout) await live.logout();
      await live.destroy();
    } catch (e) {
      console.error(`[transportCore] disconnect error (non-fatal): ${e.message}`);
    }
  }
  s.state = STATE.DISCONNECTED;
  s.phone = null;
  s.wid = null;
  s.client = null;
  s.qr = null;
  s.qrDataUrl = null;
  await emitStateChange(tenantId, getState(tenantId));
  return getState(tenantId);
}

async function restoreSessions() {
  if (process.env.NODE_ENV === "test" || process.env.WHATSAPP_WEB_DISABLED) return;
  try {
    const dirs = fs.readdirSync(AUTH_DIR).filter((d) => d.startsWith("session-travel-"));
    for (const dir of dirs) {
      const tenantId = parseInt(dir.replace("session-travel-", ""), 10);
      if (Number.isNaN(tenantId)) continue;
      console.log(`[transportCore] auto-restoring tenant ${tenantId}…`);
      module.exports.connect(tenantId).catch((e) => console.error(`restore tenant ${tenantId} failed:`, e.message));
    }
  } catch (e) {
    console.error("[transportCore] restoreSessions failed (non-fatal):", e.message);
  }
}

async function shutdownAll() {
  console.log("[transportCore] shutting down all sessions…");
  const promises = [];
  for (const [tenantId] of sessions) {
    promises.push(module.exports.disconnect(tenantId, { logout: false }));
  }
  await Promise.all(promises);
  sessions.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// State queries (synchronous)
// ─────────────────────────────────────────────────────────────────────────────

function getState(tenantId) {
  const s = getSession(tenantId);
  if (!s) return { state: STATE.DISCONNECTED, connected: false, phone: null, qr: null };
  return {
    state: s.state,
    connected: s.state === STATE.CONNECTED,
    phone: s.phone || null,
    qr: s.qrDataUrl || null,
    lastError: s.lastError || null,
  };
}

function isConnected(tenantId) {
  const s = getSession(tenantId);
  return Boolean(s && s.state === STATE.CONNECTED && s.client);
}

// ─────────────────────────────────────────────────────────────────────────────
// Send methods (via the live session, if connected)
// ─────────────────────────────────────────────────────────────────────────────

async function sendMessage(tenantId, chatId, text) {
  const s = getSession(tenantId);
  if (!s || !s.client || s.state !== STATE.CONNECTED) {
    return { ok: false, error: "not-connected" };
  }
  try {
    const msg = await s.client.sendMessage(chatId, text);
    return { ok: true, providerMsgId: msg.id._serialized };
  } catch (e) {
    return { ok: false, error: e.message || "send failed" };
  }
}

async function sendFile(tenantId, chatId, media, filename, caption) {
  const s = getSession(tenantId);
  if (!s || !s.client || s.state !== STATE.CONNECTED) {
    return { ok: false, error: "not-connected" };
  }
  try {
    const msg = await s.client.sendMessage(chatId, media, { caption, sendAudioAsVoice: false, sendMediaAsDocument: true, filename });
    return { ok: true, providerMsgId: msg.id._serialized };
  } catch (e) {
    return { ok: false, error: e.message || "send failed" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Import methods (backfill chats + history)
// ─────────────────────────────────────────────────────────────────────────────

async function importAllChats(tenantId) {
  const s = getSession(tenantId);
  if (!s || !s.client || s.state !== STATE.CONNECTED) {
    return { ok: false, error: "not-connected", imported: 0 };
  }
  try {
    const chats = await s.client.getChats();
    const imported = [];
    for (const chat of chats) {
      imported.push({
        id: chat.id._serialized,
        isGroup: chat.isGroup,
        phone: chat.id.user ? chat.id.user : null,
        waName: chat.name || null,
        avatar: null, // placeholder
        unreadCount: chat.unreadCount || 0,
        lastMessageAt: chat.timestamp ? new Date(chat.timestamp * 1000) : null,
      });
    }
    await emitImportProgress(tenantId, imported);
    return { ok: true, imported: imported.length };
  } catch (e) {
    return { ok: false, error: e.message || "import failed", imported: 0 };
  }
}

async function backfillThreadHistory(tenantId, chatId) {
  const s = getSession(tenantId);
  if (!s || !s.client || s.state !== STATE.CONNECTED) {
    return { ok: false, error: "not-connected", backfilled: 0 };
  }
  try {
    const chat = await s.client.getChatById(chatId);
    if (!chat) return { ok: false, error: "chat-not-found", backfilled: 0 };
    const messages = await chat.fetchMessages({ limit: 100 });
    const imported = [];
    for (const msg of messages) {
      const dto = buildHistoryMessageDTO(msg);
      if (dto) imported.push(dto);
    }
    await emitImportProgress(tenantId, imported);
    return { ok: true, backfilled: imported.length };
  } catch (e) {
    return { ok: false, error: e.message || "backfill failed", backfilled: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile methods
// ─────────────────────────────────────────────────────────────────────────────

async function getProfile(tenantId) {
  const s = getSession(tenantId);
  if (!s || !s.client || s.state !== STATE.CONNECTED) {
    return { ok: false, connected: false };
  }
  try {
    const info = s.client.info;
    return {
      ok: true,
      connected: true,
      phone: (info && info.me && info.me.user) || null,
      name: (info && info.pushname) || null,
      about: null, // whatsapp-web.js doesn't expose "about"
      avatar: null, // placeholder
    };
  } catch (e) {
    return { ok: false, error: e.message, connected: false };
  }
}

async function setProfile(tenantId, patch) {
  const s = getSession(tenantId);
  if (!s || !s.client || s.state !== STATE.CONNECTED) {
    return { ok: false, error: "not-connected" };
  }
  try {
    if (patch.name) await s.client.setDisplayName(patch.name);
    if (patch.about) await s.client.setStatus(patch.about);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || "profile update failed" };
  }
}

async function setAvatar(tenantId, mediaUrl) {
  const s = getSession(tenantId);
  if (!s || !s.client || s.state !== STATE.CONNECTED) {
    return { ok: false, error: "not-connected" };
  }
  try {
    // whatsapp-web.js doesn't natively support setting avatar; stubbed
    return { ok: false, error: "avatar-not-supported" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deleteAvatar(tenantId) {
  const s = getSession(tenantId);
  if (!s || !s.client || s.state !== STATE.CONNECTED) {
    return { ok: false, error: "not-connected" };
  }
  try {
    // stubbed — whatsapp-web.js doesn't expose this
    return { ok: false, error: "delete-avatar-not-supported" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // session
  getSession,
  sessions,
  getState,
  isConnected,
  // lifecycle
  connect,
  disconnect,
  restoreSessions,
  shutdownAll,
  // events
  setEventHandler,
  emitStateChange,
  emitQR,
  emitInbound,
  emitAck,
  emitImportProgress,
  // send
  sendMessage,
  sendFile,
  // import
  importAllChats,
  backfillThreadHistory,
  // profile
  getProfile,
  setProfile,
  setAvatar,
  deleteAvatar,
  // crash guard
  installPuppeteerCrashGuard,
  isPuppeteerTeardownError,
};
