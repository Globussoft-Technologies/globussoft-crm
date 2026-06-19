/**
 * whatsappWebClient.js — TRAVEL vertical WhatsApp transport via WhatsApp Web
 * (QR-scan multi-device, powered by whatsapp-web.js + puppeteer).
 *
 * WHY THIS EXISTS — the travel vertical previously dispatched through Wati's
 * hosted REST platform (services/watiClient.js). That file is KEPT ON DISK
 * (nothing removed) but is no longer wired into the routes/crons — its
 * `require(...)` lines are commented out at every call site. This module is
 * the active replacement: instead of a paid Wati account + Meta-approved
 * templates + a 24h session window, an operator simply scans a QR code from
 * their phone (WhatsApp → Linked devices) and the CRM can then send/receive
 * freely on that number — exactly like WhatsApp Web in a browser.
 *
 * DROP-IN COMPATIBILITY — this module exposes the SAME method surface as
 * watiClient (isEnabled / getConfig / normalizePhone / persistMessageRow /
 * sendTemplateMessage / sendSessionMessage / sendSessionFile / sendBestEffort
 * / getMessageTemplates / getContacts / getMessages / getMediaResponse) so the
 * 7 travel crons + the chat route swap to it by changing one `require` line.
 * Semantic differences that fall out of WhatsApp Web (vs Wati/Meta):
 *   - No template-approval flow + no 24h window → free-form text always
 *     delivers. `sendTemplateMessage` therefore just sends the rendered
 *     bodyPreview/params as a normal text message; getMessageTemplates() is
 *     an empty list. The crons keep working because they always pass
 *     `fallbackText` (the human-readable body) to sendBestEffort.
 *   - Inbound is REAL-TIME via the puppeteer session's `message` event — no
 *     webhook, no public URL, no tunnel needed (the big localhost-dev win).
 *     Inbound persistence + thread upsert + socket emit mirror the old Wati
 *     webhook exactly, so the existing chat UI is unchanged.
 *
 * SESSION MODEL — one WhatsApp Web session PER TENANT (the travel tenant
 * hosts all 4 sub-brands on one number, Q25). Sessions are keyed by tenantId
 * and persisted to disk via whatsapp-web.js LocalAuth (clientId
 * `travel-<tenantId>`, dataPath backend/.wwebjs_auth) so a server restart
 * resumes the link without re-scanning.
 *
 * STUB / CI SAFETY — like watiClient, this module NEVER launches a browser in
 * NODE_ENV=test, and any send to a tenant whose session isn't CONNECTED
 * degrades to a STUB: it logs the would-send line and persists a QUEUED
 * WhatsAppMessage row. CI + dev-without-a-scan stay offline + deterministic.
 * whatsapp-web.js + puppeteer are lazy-`require`d only inside connect()/send
 * real paths so merely importing this module (as every cron does) stays cheap.
 *
 * CJS self-mocking seam (CLAUDE.md standing pattern): inter-function calls go
 * through module.exports.fn(...) so vitest vi.spyOn interception works.
 */

const path = require("path");

// ---------------------------------------------------------------------------
// Session registry + socket handle
// ---------------------------------------------------------------------------

// tenantId(number) → {
//   state, qr, qrDataUrl, phone, wid, client, startedAt, lastError
// }
const sessions = new Map();
let _io = null;

const STATE = Object.freeze({
  DISCONNECTED: "DISCONNECTED", // no live client
  INITIALIZING: "INITIALIZING", // puppeteer booting
  QR: "QR", // QR generated, waiting for the phone to scan
  AUTHENTICATED: "AUTHENTICATED", // scanned, syncing
  CONNECTED: "CONNECTED", // ready — can send/receive
  AUTH_FAILURE: "AUTH_FAILURE", // bad/expired session
});

const AUTH_DIR = path.join(__dirname, "..", ".wwebjs_auth");

function init(io) {
  _io = io;
  console.log("[whatsappWeb] init — socket handle attached; restoring previously-linked sessions…");
  // Auto-restore on boot: re-initialize every tenant that was linked before the
  // restart. LocalAuth persisted their creds to .wwebjs_auth/session-travel-<id>,
  // so connect() resumes WITHOUT a new QR. Fire-and-forget so server startup is
  // never blocked on puppeteer. (Previously sessions were lazy → a restart
  // silently dropped every live WhatsApp until an operator re-opened the page.)
  module.exports
    .restoreSessions()
    .catch((e) => console.error("[whatsappWeb] restoreSessions failed (non-fatal):", e.message));
}

// Reconnect every previously-linked tenant from its saved LocalAuth session on
// boot. Reads the .wwebjs_auth dir for `session-travel-<tenantId>` folders and
// connect()s each (no reset → resumes from disk, no QR). Launches are staggered
// so N tenants don't spawn N headless Chromes at once. No-op under the
// test/kill-switch guard. Best-effort per tenant — a stale session surfaces via
// the existing restore watchdog as an actionable "Reset & reconnect".
async function restoreSessions() {
  if (!canLaunch()) return { restored: 0, reason: "disabled" };
  const fs = require("fs"); // required locally — this module loads fs lazily per-function
  let entries = [];
  try {
    entries = fs.readdirSync(AUTH_DIR, { withFileTypes: true });
  } catch {
    return { restored: 0, reason: "no-auth-dir" }; // nothing linked yet
  }
  const tenantIds = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = /^session-travel-(\d+)$/.exec(e.name);
    if (m) tenantIds.push(Number(m[1]));
  }
  if (!tenantIds.length) return { restored: 0 };
  console.log(`[whatsappWeb] boot-restore: re-initializing ${tenantIds.length} saved session(s): ${tenantIds.join(", ")}`);
  let i = 0;
  for (const tenantId of tenantIds) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500)); // stagger Chrome launches
    i += 1;
    module.exports
      .connect(tenantId)
      .then(() => console.log(`[whatsappWeb] boot-restore: tenant ${tenantId} resuming from saved session`))
      .catch((err) => console.warn(`[whatsappWeb] boot-restore tenant ${tenantId} failed: ${err.message}`));
  }
  return { restored: tenantIds.length };
}

function getSession(tenantId) {
  return sessions.get(Number(tenantId)) || null;
}

// Public, JSON-safe connection state for the UI status strip + QR modal.
function getState(tenantId) {
  const s = getSession(tenantId);
  if (!s) return { state: STATE.DISCONNECTED, connected: false, phone: null, qr: null };
  return {
    state: s.state,
    connected: s.state === STATE.CONNECTED,
    phone: s.phone || null,
    // The data-URL QR is only meaningful while waiting for a scan.
    qr: s.state === STATE.QR ? s.qrDataUrl || null : null,
    lastError: s.lastError || null,
  };
}

function isConnected(tenantId) {
  const s = getSession(tenantId);
  return Boolean(s && s.state === STATE.CONNECTED && s.client);
}

function emitState(tenantId) {
  if (!_io) return;
  try {
    _io.to(`tenant:${tenantId}`).emit("whatsapp:wa-state", {
      tenantId: Number(tenantId),
      ...module.exports.getState(tenantId),
    });
  } catch (e) {
    console.error(`[whatsappWeb] state emit failed (non-fatal): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Phone helpers (mirror watiClient + utils/deduplication conventions)
// ---------------------------------------------------------------------------

function normalizePhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

// whatsapp-web.js addresses chats as "<digits>@c.us" (individual) or
// "<id>@g.us" (group). A value that already carries an @-suffix (a group id, or
// a full chatId we stored as the thread key) is passed through unchanged;
// otherwise it's treated as a phone and gets the @c.us suffix.
function toChatId(phone) {
  const s = String(phone || "");
  if (s.includes("@")) return s; // already a chatId (group / lid / c.us)
  const digits = module.exports.normalizePhone(phone);
  return digits ? `${digits}@c.us` : null;
}

// Inverse: a wweb id ("919812345678@c.us") → bare digits for our thread keys.
function fromChatId(chatId) {
  return String(chatId || "").split("@")[0].replace(/\D/g, "") || null;
}

// ---------------------------------------------------------------------------
// Persistence (copied from watiClient — identical WhatsAppMessage contract so
// the /channels log + chat surface render travel traffic the same way). NEVER
// throws.
// ---------------------------------------------------------------------------
async function persistMessageRow({ tenantId, contactId, to, body, templateName, status, providerMsgId, errorMessage, threadId, userId, from, mediaUrl, mediaType, metaType }) {
  try {
    const prisma = require("../lib/prisma");
    if (!prisma.whatsAppMessage || typeof prisma.whatsAppMessage.create !== "function") return null;
    return await prisma.whatsAppMessage.create({
      data: {
        to: String(to),
        from: from || null,
        direction: "OUTBOUND",
        status,
        body: body || null,
        templateName: templateName || null,
        providerMsgId: providerMsgId || null,
        errorMessage: errorMessage ? String(errorMessage).slice(0, 1000) : null,
        tenantId: tenantId || 1,
        contactId: contactId || null,
        threadId: threadId || null,
        userId: userId || null,
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        metaType: metaType || null,
      },
    });
  } catch (e) {
    console.error(`[whatsappWeb] WhatsAppMessage persist failed (non-fatal): ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

// Whether real puppeteer sessions are permitted in this process. Disabled
// under test (no Chromium in CI) and via an explicit kill-switch.
function canLaunch() {
  if (process.env.NODE_ENV === "test") return false;
  if (/^(1|true|yes)$/i.test(process.env.WHATSAPP_WEB_DISABLED || "")) return false;
  return true;
}

// How long a fresh session may sit before emitting a QR (or going ready)
// before we declare the restore stuck. A stale LocalAuth dir can make
// whatsapp-web.js hang here forever with no qr/ready — the watchdog turns that
// into an actionable AUTH_FAILURE the UI can offer a "Reset & reconnect" for.
const QR_WATCHDOG_MS = (() => {
  const v = parseInt(process.env.WHATSAPP_WEB_QR_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 15_000 ? v : 60_000;
})();

// Resolve a Chromium executable: explicit override, else fall back to the
// top-level puppeteer's downloaded Chromium (whatsapp-web.js's own nested
// puppeteer may not have one). Best-effort — null lets wweb use its default.
async function resolveChromePath() {
  if (process.env.WHATSAPP_WEB_CHROME_PATH) return process.env.WHATSAPP_WEB_CHROME_PATH;
  try {
    const pp = require("puppeteer");
    let p = pp.executablePath();
    if (p && typeof p.then === "function") p = await p;
    return p || null;
  } catch {
    return null;
  }
}

// Kill any orphaned Chromium still holding a tenant's userDataDir. This is the
// self-heal for the "browser is already running for …session-travel-N" lock
// that a crashed/restarted server leaves behind (the new process has no handle
// to the old Chromium). Targets ONLY chromiums whose command line contains the
// exact wweb session path — never the operator's own browser. Best-effort.
function killBrowsersForDir(tenantId) {
  if (process.env.NODE_ENV === "test") return; // never spawn shells under test
  tenantId = Number(tenantId);
  const marker = `session-travel-${tenantId}`;
  try {
    const { execSync } = require("child_process");
    if (process.platform === "win32") {
      // PowerShell: match chrome.exe whose CommandLine references the session dir.
      const ps =
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "ignore", timeout: 15000 });
    } else {
      // pkill -f matches the full command line; the marker is unique to wweb.
      execSync(`pkill -f "${marker}" || true`, { stdio: "ignore", timeout: 15000, shell: "/bin/sh" });
    }
    console.log(`[whatsappWeb] tenant ${tenantId} killed any orphan chromium holding ${marker}`);
  } catch (e) {
    console.warn(`[whatsappWeb] tenant ${tenantId} orphan-kill best-effort failed: ${e.message}`);
  }
}

// Destroy a tenant's client + (optionally) wipe its on-disk LocalAuth so the
// next connect gets a fresh QR. Used by reset + logout. Destroy is raced
// against a timeout so a stuck client can't block the wipe; a leftover
// Chromium (locked dir) is then force-killed before the wipe.
async function clearSession(tenantId, { wipe = true } = {}) {
  tenantId = Number(tenantId);
  const s = getSession(tenantId);
  if (s) {
    if (s.watchdog) { clearTimeout(s.watchdog); s.watchdog = null; }
    if (s.client) {
      try {
        await Promise.race([
          s.client.destroy(),
          new Promise((r) => setTimeout(r, 8000)),
        ]);
      } catch (e) { console.warn(`[whatsappWeb] tenant ${tenantId} destroy warn: ${e.message}`); }
    }
  }
  sessions.delete(tenantId);
  // Free any orphan Chromium still holding the dir (cross-process lock).
  module.exports.killBrowsersForDir(tenantId);
  if (wipe) {
    try {
      const fs = require("fs");
      const dir = path.join(AUTH_DIR, `session-travel-${tenantId}`);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      console.log(`[whatsappWeb] tenant ${tenantId} session wiped (${dir})`);
    } catch (e) {
      console.warn(`[whatsappWeb] tenant ${tenantId} session wipe failed: ${e.message}`);
    }
  }
}

/**
 * Start (or return the in-flight) WhatsApp Web session for a tenant. Returns
 * the current public state immediately — the QR arrives asynchronously over
 * the `whatsapp:qr` socket event AND is fetchable via getState()/GET /qr.
 * Idempotent: calling while INITIALIZING/QR/CONNECTED is a no-op.
 *
 * { reset:true } first wipes any saved session (escape hatch for a stale
 * LocalAuth that's stuck restoring) so a fresh QR is guaranteed.
 */
async function connect(tenantId, { reset = false } = {}) {
  tenantId = Number(tenantId);
  if (!canLaunch()) {
    // Test / disabled: record a DISCONNECTED stub session so the UI can show
    // "WhatsApp Web is disabled in this environment" without a crash.
    const stub = { state: STATE.DISCONNECTED, qr: null, qrDataUrl: null, phone: null, client: null, lastError: "disabled (test/kill-switch)" };
    sessions.set(tenantId, stub);
    return module.exports.getState(tenantId);
  }

  if (reset) {
    await module.exports.clearSession(tenantId, { wipe: true });
  } else {
    const existing = getSession(tenantId);
    if (existing && existing.client && existing.state !== STATE.AUTH_FAILURE && existing.state !== STATE.DISCONNECTED) {
      return module.exports.getState(tenantId);
    }
    // A dead in-memory session (AUTH_FAILURE/DISCONNECTED) — tear its client
    // down first (keep the dir so a valid saved link can still resume).
    if (existing) await module.exports.clearSession(tenantId, { wipe: false });
  }

  // Lazy-require the heavy deps only on the real path.
  const { Client, LocalAuth } = require("whatsapp-web.js");
  const executablePath = await module.exports.resolveChromePath();

  const session = {
    state: STATE.INITIALIZING,
    qr: null,
    qrDataUrl: null,
    phone: null,
    wid: null,
    client: null,
    startedAt: Date.now(),
    lastError: null,
    watchdog: null,
  };
  sessions.set(tenantId, session);
  module.exports.emitState(tenantId);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `travel-${tenantId}`, dataPath: AUTH_DIR }),
    puppeteer: {
      headless: true,
      // --no-sandbox is required to run Chromium as root in most server
      // containers; the extra flags trim memory on low-RAM boxes.
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
      ...(executablePath ? { executablePath } : {}),
    },
  });
  session.client = client;
  module.exports.wireEvents(client, tenantId);

  // Watchdog: if neither a QR nor a ready state arrives in time, the restore
  // is stuck (almost always a stale session dir) — surface an actionable error.
  session.watchdog = setTimeout(() => {
    const s = getSession(tenantId);
    if (s && (s.state === STATE.INITIALIZING || s.state === STATE.AUTHENTICATED)) {
      s.state = STATE.AUTH_FAILURE;
      s.lastError = "Timed out starting WhatsApp (the saved session may be stale). Click “Reset & reconnect” to get a fresh QR.";
      console.error(`[whatsappWeb] tenant ${tenantId} QR watchdog fired — stuck in ${s.state}`);
      module.exports.emitState(tenantId);
    }
  }, QR_WATCHDOG_MS);

  // initialize() resolves once the browser is up; errors here flip to
  // AUTH_FAILURE so the UI can offer a retry instead of hanging on a spinner.
  client.initialize().catch((e) => {
    console.error(`[whatsappWeb] tenant ${tenantId} initialize failed: ${e.message}`);
    const s = getSession(tenantId);
    if (s) {
      if (s.watchdog) { clearTimeout(s.watchdog); s.watchdog = null; }
      s.state = STATE.AUTH_FAILURE;
      s.lastError = e.message;
    }
    module.exports.emitState(tenantId);
  });

  return module.exports.getState(tenantId);
}

/**
 * Tear down a tenant's session. `logout:true` also clears the persisted
 * LocalAuth credentials (forces a fresh QR next connect); otherwise the
 * link is kept on disk and the next connect() resumes without scanning.
 */
async function disconnect(tenantId, { logout = false } = {}) {
  tenantId = Number(tenantId);
  // logout → also wipe the saved link (fresh QR next time); otherwise keep the
  // LocalAuth dir so a reconnect resumes without re-scanning.
  await module.exports.clearSession(tenantId, { wipe: logout });
  module.exports.emitState(tenantId);
  return { state: STATE.DISCONNECTED, connected: false, phone: null, qr: null };
}

/**
 * Wire the puppeteer client's events to session state + persistence + sockets.
 * Pulled out as an exported function so it's individually testable.
 */
function wireEvents(client, tenantId) {
  tenantId = Number(tenantId);

  client.on("qr", async (qr) => {
    const s = getSession(tenantId);
    if (!s) return;
    s.state = STATE.QR;
    s.qr = qr;
    try {
      const QRCode = require("qrcode");
      s.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 1 });
    } catch (e) {
      console.error(`[whatsappWeb] QR render failed: ${e.message}`);
      s.qrDataUrl = null;
    }
    console.log(`[whatsappWeb] tenant ${tenantId} QR ready — scan from WhatsApp → Linked devices`);
    if (_io) {
      _io.to(`tenant:${tenantId}`).emit("whatsapp:qr", {
        tenantId,
        qr: s.qrDataUrl,
        state: STATE.QR,
      });
    }
    module.exports.emitState(tenantId);
  });

  client.on("authenticated", () => {
    const s = getSession(tenantId);
    if (!s) return;
    s.state = STATE.AUTHENTICATED;
    s.qr = null;
    s.qrDataUrl = null;
    console.log(`[whatsappWeb] tenant ${tenantId} authenticated — syncing…`);
    module.exports.emitState(tenantId);
  });

  client.on("auth_failure", (msg) => {
    const s = getSession(tenantId);
    if (!s) return;
    s.state = STATE.AUTH_FAILURE;
    s.lastError = String(msg || "authentication failed");
    console.error(`[whatsappWeb] tenant ${tenantId} auth_failure: ${s.lastError}`);
    module.exports.emitState(tenantId);
  });

  client.on("ready", () => {
    const s = getSession(tenantId);
    if (!s) return;
    s.state = STATE.CONNECTED;
    s.qr = null;
    s.qrDataUrl = null;
    try {
      const wid = client.info && client.info.wid;
      s.wid = wid ? wid._serialized || String(wid) : null;
      s.phone = wid ? (wid.user || module.exports.fromChatId(s.wid)) : null;
    } catch { /* info not always populated immediately */ }
    console.log(`[whatsappWeb] tenant ${tenantId} CONNECTED as ${s.phone || "(unknown number)"}`);
    module.exports.emitState(tenantId);
    // Backfill the operator's EXISTING conversations into the CRM inbox — this
    // is what WhatsApp Web does the moment you scan (it shows your whole chat
    // list + history, not just new messages). Delayed a few seconds so the
    // WhatsApp chat store finishes its initial sync before we read it.
    // Fire-and-forget; progress streams via the whatsapp:imported event.
    setTimeout(() => {
      module.exports.importAllChats(tenantId).catch((e) =>
        console.error(`[whatsappWeb] tenant ${tenantId} initial chat import failed: ${e.message}`));
    }, 4000);
  });

  client.on("disconnected", (reason) => {
    const s = getSession(tenantId);
    console.warn(`[whatsappWeb] tenant ${tenantId} disconnected: ${reason}`);
    if (s) {
      s.state = STATE.DISCONNECTED;
      s.lastError = String(reason || "disconnected");
      s.client = null;
    }
    module.exports.emitState(tenantId);
    // The inbox is a live mirror — when the link drops (logged out from phone,
    // network loss, etc.) clear the imported chats so the next connect starts
    // clean. Fire-and-forget; deleteMany on an empty set is a harmless no-op.
    module.exports.purgeChats(tenantId).catch(() => {});
  });

  // Inbound customer message → persist + thread upsert + socket emit.
  client.on("message", async (msg) => {
    try {
      await module.exports.ingestInbound(tenantId, msg);
    } catch (e) {
      console.error(`[whatsappWeb] tenant ${tenantId} ingest error (non-fatal): ${e.message}`);
    }
  });

  // Delivery / read receipts on OUTBOUND messages.
  client.on("message_ack", async (msg, ack) => {
    try {
      await module.exports.applyAck(tenantId, msg, ack);
    } catch (e) {
      console.error(`[whatsappWeb] tenant ${tenantId} ack error (non-fatal): ${e.message}`);
    }
  });
}

// ack int → our WhatsAppMessage.status enum. -1 ERROR, 1 SERVER(sent),
// 2 DEVICE(delivered), 3 READ, 4 PLAYED(read). 0 PENDING is ignored.
function mapAck(ack) {
  switch (Number(ack)) {
    case -1: return "FAILED";
    case 1: return "SENT";
    case 2: return "DELIVERED";
    case 3:
    case 4: return "READ";
    default: return null;
  }
}

const ACK_RANK = { QUEUED: 0, SENT: 1, FAILED: 2, DELIVERED: 2, READ: 3 };

async function applyAck(tenantId, msg, ack) {
  const next = module.exports.mapAck(ack);
  if (!next) return;
  const providerMsgId = msg && msg.id ? msg.id._serialized : null;
  if (!providerMsgId) return;
  const prisma = require("../lib/prisma");
  const row = await prisma.whatsAppMessage.findFirst({
    where: { tenantId: Number(tenantId), providerMsgId: String(providerMsgId), direction: "OUTBOUND" },
    select: { id: true, status: true, threadId: true },
  });
  if (!row) return;
  const currentRank = ACK_RANK[row.status] !== undefined ? ACK_RANK[row.status] : 0;
  if (ACK_RANK[next] <= currentRank) return; // rank-guard: never downgrade
  await prisma.whatsAppMessage.update({ where: { id: row.id }, data: { status: next } });
  if (_io) {
    _io.to(`tenant:${tenantId}`).emit("whatsapp:status", {
      tenantId: Number(tenantId),
      threadId: row.threadId,
      providerMsgId: String(providerMsgId),
      status: next,
    });
  }
}

// Best-effort Contact match for thread linking (mirrors travel_whatsapp.js).
async function matchContact(tenantId, phoneE164) {
  try {
    const prisma = require("../lib/prisma");
    const digits = String(phoneE164).replace(/\D/g, "");
    return await prisma.contact.findFirst({
      where: {
        tenantId: Number(tenantId),
        OR: [{ phone: phoneE164 }, { phone: digits }, { phone: `+${digits}` }],
      },
      select: { id: true, name: true },
    });
  } catch {
    return null;
  }
}

// Download + persist inbound media (S3 when configured, /uploads fallback) so
// the chat bubble renders it. Returns a URL or null.
async function persistInboundMedia(tenantId, msg) {
  try {
    if (!msg.hasMedia) return null;
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;
    const buffer = Buffer.from(media.data, "base64");
    const mime = media.mimetype || "application/octet-stream";
    const ext = (mime.split("/")[1] || "bin").split(";")[0];
    const baseName = media.filename || `wa-${Date.now()}.${ext}`;
    let s3 = null;
    try { s3 = require("./s3Service"); } catch { /* optional */ }
    if (s3 && process.env.AWS_S3_BUCKET_NAME) {
      try {
        return { url: await s3.uploadFile(buffer, baseName, mime, `whatsapp/${tenantId}/wa-web`), mime, kind: mime.split("/")[0] };
      } catch (e) {
        console.error(`[whatsappWeb] inbound media S3 persist failed (local fallback): ${e.message}`);
      }
    }
    const fs = require("fs");
    const crypto = require("crypto");
    const dir = path.join(__dirname, "..", "uploads", "wa-web");
    fs.mkdirSync(dir, { recursive: true });
    const safe = `${crypto.randomUUID()}-${baseName.replace(/[^\w.-]/g, "_")}`;
    fs.writeFileSync(path.join(dir, safe), buffer);
    return { url: `/uploads/wa-web/${safe}`, mime, kind: mime.split("/")[0] };
  } catch (e) {
    console.error(`[whatsappWeb] inbound media download failed (non-fatal): ${e.message}`);
    return null;
  }
}

/**
 * Persist an inbound customer message + upsert its thread + emit the SAME
 * "whatsapp:received" socket event the chat UI already subscribes to. Mirrors
 * the old Wati webhook handler's unread/contact semantics exactly.
 */
// WhatsApp addresses real 1:1 chats with EITHER @c.us (classic, number-based)
// OR @lid (newer privacy-id form — most modern chats land here). BOTH are real
// customer conversations and must be imported. Only groups (@g.us), channels/
// newsletters (@newsletter — the long 120363… ids) and status/broadcast are
// excluded. (Live-confirmed 2026-06-18: an account showed 503 chats of which
// only 1 was @c.us — the rest were @lid; an @c.us-only filter dropped them all.)
function chatAddressKind(id) {
  if (typeof id !== "string") return null;
  if (id.endsWith("@c.us")) return "c.us";
  if (id.endsWith("@lid")) return "lid";
  if (id.endsWith("@g.us")) return "group";
  if (id.endsWith("@newsletter")) return "newsletter";
  if (id === "status@broadcast" || id.endsWith("@broadcast")) return "broadcast";
  return null;
}
function isIndividualChatId(id) {
  const k = chatAddressKind(id);
  return k === "c.us" || k === "lid";
}
// Back-compat alias (older callers/tests) — @c.us only.
function isCustomerChatId(id) {
  return typeof id === "string" && /^\d{6,15}@c\.us$/.test(id);
}

// A WhatsApp display title is only a real NAME if it contains a letter —
// otherwise it's just the number echoed back (e.g. "+91 98…"), which we'd
// rather not store as a "name". Returns the trimmed name or null.
function cleanName(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  return /[a-z]/i.test(s) ? s : null;
}

// Resolve a real phone (E.164 "+digits" or null) + display name + a STABLE
// thread key for an individual chat. @c.us → the number is in the id. @lid →
// the id digits are a privacy id, NOT a phone; look up the real number via
// getContactLidAndPhone (preferred) then the contact record. The key is always
// non-null: the real number when known, else "lid:<digits>" so the chat still
// shows (labelled by name). Best-effort — never throws.
async function resolveIndividual(client, serializedId) {
  const kind = module.exports.chatAddressKind(serializedId);
  const idDigits = module.exports.fromChatId(serializedId);
  if (kind === "c.us") {
    const phone = idDigits ? `+${idDigits}` : null;
    return { phone, name: null, key: phone || serializedId };
  }
  // @lid — resolve to the real phone + name.
  let phone = null;
  let name = null;
  try {
    if (typeof client.getContactLidAndPhone === "function") {
      const pairs = await client.getContactLidAndPhone([serializedId]);
      const hit = Array.isArray(pairs) ? pairs[0] : null;
      const rawPhone = hit && (hit.phone || hit.pn);
      const digits = String(rawPhone || "").replace(/\D/g, "");
      if (digits) phone = `+${digits}`;
    }
  } catch { /* fall through to contact lookup */ }
  try {
    const contact = await client.getContactById(serializedId);
    if (contact) {
      if (!phone) {
        const num = String(contact.number || "").replace(/\D/g, "");
        // Only trust contact.number if it differs from the lid digits (a lid
        // contact often echoes the lid back as .number).
        if (num && num !== idDigits) phone = `+${num}`;
      }
      name = contact.name || contact.pushname || contact.shortName || null;
    }
  } catch { /* best-effort */ }
  return { phone, name, key: phone || `lid:${idDigits}` };
}

// Content message types worth persisting. WhatsApp also emits a stream of
// system events (e2e_notification, call_log, gp2 group-events, protocol
// messages, notification_template, …) that carry no chat content — those would
// render as "(empty)" bubbles, so they're dropped.
const CONTENT_TYPES = new Set(["chat", "text", "image", "video", "audio", "ptt", "voice", "document", "sticker", "location"]);
// Friendly placeholder shown when a media message's bytes couldn't be
// downloaded (so the bubble reads "📷 Photo" instead of "(empty)").
const MEDIA_LABEL = {
  image: "📷 Photo", video: "🎥 Video", audio: "🎵 Audio",
  ptt: "🎤 Voice message", voice: "🎤 Voice message",
  document: "📄 Document", sticker: "🌟 Sticker", location: "📍 Location",
};
function isContentMessage(msg) {
  if (!msg) return false;
  const type = String(msg.type || "chat").toLowerCase();
  if (!CONTENT_TYPES.has(type)) return false;
  // A 'chat' with no body and no media is a no-op system echo — skip it.
  if ((type === "chat" || type === "text") && !msg.hasMedia && !(msg.body && msg.body.trim())) return false;
  return true;
}

async function ingestInbound(tenantId, msg) {
  tenantId = Number(tenantId);
  // Skip our own echoes; accept real 1:1 chats (@c.us/@lid) AND groups (@g.us).
  if (!msg || msg.fromMe) return;
  const fromRaw = msg.from || "";
  const kind = module.exports.chatAddressKind(fromRaw);
  const isGroup = kind === "group";
  if (!module.exports.isIndividualChatId(fromRaw) && !isGroup) return;
  if (!module.exports.isContentMessage(msg)) return;

  // Resolve the stable thread key + display name.
  const session = getSession(tenantId);
  let phone = null;
  let waName = module.exports.cleanName(msg._data && msg._data.notifyName);
  if (isGroup) {
    // Group: key = the group id; name = group subject (best-effort via getChat).
    phone = fromRaw;
    waName = null;
    try {
      if (typeof msg.getChat === "function") {
        const chat = await msg.getChat();
        if (chat && chat.name) waName = chat.name.trim() || null;
      }
    } catch { /* keep null → falls back to id */ }
  } else if (session && session.client) {
    const r = await module.exports.resolveIndividual(session.client, fromRaw);
    phone = r.key;
    if (!waName) waName = module.exports.cleanName(r.name);
  } else {
    const digits = module.exports.fromChatId(fromRaw);
    phone = digits ? `+${digits}` : null;
  }
  if (!phone) return;

  const prisma = require("../lib/prisma");
  const providerMsgId = msg.id ? msg.id._serialized : null;

  // Dedup — the same id can arrive twice across reconnects.
  if (providerMsgId) {
    const dupe = await prisma.whatsAppMessage.findFirst({
      where: { tenantId, providerMsgId: String(providerMsgId) },
      select: { id: true },
    });
    if (dupe) return;
  }

  const contact = isGroup ? null : await matchContact(tenantId, phone);
  const media = await persistInboundMedia(tenantId, msg);
  let body = typeof msg.body === "string" && msg.body !== "" ? msg.body : null;
  // In groups, prefix the sender name so you can tell who sent each message.
  if (isGroup && body) {
    const sender = module.exports.cleanName(msg._data && msg._data.notifyName);
    if (sender) body = `${sender}: ${body}`;
  }

  // Thread upsert with Meta-webhook-parity unread semantics.
  const existing = await prisma.whatsAppThread.findUnique({
    where: { tenantId_contactPhone: { tenantId, contactPhone: phone } },
  });
  let thread;
  if (existing) {
    const updates = { lastMessageAt: new Date(), lastInboundAt: new Date(), status: "OPEN", snoozedUntil: null };
    if (!existing.assignedToId) updates.unreadCount = (existing.unreadCount || 0) + 1;
    if (!existing.contactId && contact) updates.contactId = contact.id;
    if (waName && !existing.contactName) updates.contactName = waName;
    thread = await updateThreadSafe(prisma, { id: existing.id }, updates);
  } else {
    thread = await createThreadSafe(prisma, {
      tenantId,
      contactPhone: phone,
      contactName: waName,
      status: "OPEN",
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
      unreadCount: 1,
      contactId: contact ? contact.id : null,
    });
  }

  const s = getSession(tenantId);
  const message = await prisma.whatsAppMessage.create({
    data: {
      to: (s && s.phone) || "wa-web",
      from: phone,
      body,
      mediaUrl: media ? media.url : null,
      mediaType: media ? media.mime : null,
      direction: "INBOUND",
      status: "DELIVERED",
      providerMsgId,
      metaType: media ? media.kind : (msg.type ? String(msg.type) : "text"),
      tenantId,
      threadId: thread.id,
      contactId: contact ? contact.id : null,
    },
  });

  if (_io) {
    _io.to(`tenant:${tenantId}`).emit("whatsapp:received", {
      tenantId,
      threadId: thread.id,
      messageId: message.id,
      contactPhone: phone,
      from: phone,
      body: body || "(media)",
    });
  }

  // Travel auto-lead capture (2026-06-19) — for travel tenants, once a 1:1 chat
  // has a few messages, analyze it and auto-create a Travel lead if it reads as
  // a business enquiry. Best-effort + fire-and-forget: it must never delay or
  // break message ingestion (the message is already persisted + emitted above).
  if (!isGroup) {
    require("../lib/travelWhatsappLeadCapture")
      .safeMaybeCaptureLead({ tenantId, phone, name: waName, threadId: thread.id, isGroup })
      .catch(() => {});
  }

  return { threadId: thread.id, messageId: message.id };
}

// ---------------------------------------------------------------------------
// Chat backfill — import EXISTING conversations on connect
// ---------------------------------------------------------------------------

// Persist one history message (inbound OR outbound) during a backfill. Deduped
// by providerMsgId; direction derives from fromMe. Media bytes ARE downloaded
// (so imported images/docs/audio actually render) — but budgeted via
// `mediaBudget` so a huge account can't trigger thousands of downloads; once
// the budget is spent, media rows get a friendly text label instead of "(empty)".
// Returns true if a NEW row was written.
async function persistHistoryMessage(tenantId, msg, { phone, contactId, threadId, channelPhone, mediaBudget, isGroup }) {
  if (!module.exports.isContentMessage(msg)) return false;
  const prisma = require("../lib/prisma");
  const providerMsgId = msg.id ? msg.id._serialized : null;
  if (providerMsgId) {
    const dupe = await prisma.whatsAppMessage.findFirst({
      where: { tenantId: Number(tenantId), providerMsgId: String(providerMsgId) },
      select: { id: true },
    });
    if (dupe) return false;
  }
  const outbound = Boolean(msg.fromMe);
  let body = typeof msg.body === "string" && msg.body.trim() !== "" ? msg.body : null;
  // In group chats, prefix the sender's name to inbound messages so you can
  // tell who said what (WhatsApp shows the participant name above each bubble).
  if (isGroup && !outbound && body) {
    const sender = module.exports.cleanName(msg._data && msg._data.notifyName);
    if (sender) body = `${sender}: ${body}`;
  }
  const type = String(msg.type || "chat").toLowerCase();
  const isMedia = msg.hasMedia || ["image", "video", "audio", "ptt", "voice", "document", "sticker"].includes(type);
  const created = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();

  let mediaUrl = null;
  let mediaType = null;
  if (isMedia) {
    if (mediaBudget && mediaBudget.remaining > 0) {
      const m = await module.exports.persistInboundMedia(tenantId, msg);
      if (m) { mediaUrl = m.url; mediaType = m.mime; mediaBudget.remaining -= 1; }
    }
    // Couldn't (or chose not to) download → label the bubble so it isn't "(empty)".
    if (!mediaUrl && !body) body = MEDIA_LABEL[type] || "📎 Attachment";
  }

  await prisma.whatsAppMessage.create({
    data: {
      to: outbound ? phone : (channelPhone || "wa-web"),
      from: outbound ? (channelPhone || "wa-web") : phone,
      body,
      mediaUrl,
      mediaType,
      direction: outbound ? "OUTBOUND" : "INBOUND",
      status: outbound ? (module.exports.mapAck(msg.ack) || "SENT") : "DELIVERED",
      providerMsgId,
      metaType: isMedia ? type : "text",
      tenantId: Number(tenantId),
      threadId,
      contactId: contactId || null,
      createdAt: Number.isNaN(created.getTime()) ? new Date() : created,
    },
  });
  return true;
}

// Delete ALL WhatsApp threads + messages for a tenant — the linked account is
// a live mirror, so disconnecting clears it and a fresh connect re-imports.
// Messages deleted first (FK to thread). Returns the row counts.
async function purgeChats(tenantId) {
  tenantId = Number(tenantId);
  const prisma = require("../lib/prisma");
  let messages = 0;
  let threads = 0;
  try {
    const m = await prisma.whatsAppMessage.deleteMany({ where: { tenantId } });
    messages = m.count || 0;
    const t = await prisma.whatsAppThread.deleteMany({ where: { tenantId } });
    threads = t.count || 0;
    console.log(`[whatsappWeb] tenant ${tenantId} purged ${threads} threads / ${messages} messages`);
  } catch (e) {
    console.error(`[whatsappWeb] purgeChats failed: ${e.message}`);
  }
  return { threads, messages };
}

// contactName / contactAvatar landed as new columns; on a dev box whose Prisma
// client hasn't been regenerated yet, including them throws "Unknown argument
// `X`". These wrappers strip the offending field and retry so chat import NEVER
// breaks — names + DPs simply start populating once `prisma generate` has run.
function stripUnknownArg(data, errMessage) {
  const m = /Unknown argument [`'"]?(\w+)[`'"]?/.exec(String(errMessage || ""));
  if (m && m[1] && Object.prototype.hasOwnProperty.call(data, m[1])) {
    const rest = { ...data };
    delete rest[m[1]];
    return rest;
  }
  return null;
}
async function createThreadSafe(prisma, data) {
  let d = data;
  for (let i = 0; i < 4; i += 1) {
    try {
      return await prisma.whatsAppThread.create({ data: d });
    } catch (e) {
      const stripped = stripUnknownArg(d, e.message);
      if (!stripped) throw e;
      d = stripped;
    }
  }
  return await prisma.whatsAppThread.create({ data: d });
}
async function updateThreadSafe(prisma, where, data) {
  let d = data;
  for (let i = 0; i < 4; i += 1) {
    try {
      return await prisma.whatsAppThread.update({ where, data: d });
    } catch (e) {
      const stripped = stripUnknownArg(d, e.message);
      if (!stripped) throw e;
      d = stripped;
    }
  }
  return await prisma.whatsAppThread.update({ where, data: d });
}

// Fetch a chat's WhatsApp profile picture (DP) URL — best-effort + time-boxed
// so a slow/privacy-locked lookup can't stall the import. Returns the CDN URL
// (loads directly in an <img>; refreshed on each re-import) or null.
async function getProfilePicSafe(client, chatId) {
  try {
    const url = await Promise.race([
      client.getProfilePicUrl(chatId),
      new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    return url || null;
  } catch {
    return null; // no DP / privacy / not reachable
  }
}

// ---------------------------------------------------------------------------
// Own WhatsApp profile (the linked account) — view + edit
// ---------------------------------------------------------------------------

// The connected account's own profile: number, display name, "about", and DP.
async function getOwnProfile(tenantId) {
  if (!module.exports.isConnected(tenantId)) return { connected: false, phone: null, name: null, about: null, avatar: null };
  const session = getSession(tenantId);
  const client = session.client;
  const wid = client.info && client.info.wid ? client.info.wid._serialized : null;
  const name = (client.info && client.info.pushname) || session.phone || null;
  let about = null;
  let avatar = null;
  try { avatar = wid ? await module.exports.getProfilePicSafe(client, wid) : null; } catch { /* none */ }
  try {
    if (wid) {
      const contact = await client.getContactById(wid);
      if (contact && typeof contact.getAbout === "function") about = await contact.getAbout();
    }
  } catch { /* about not always available */ }
  return { connected: true, phone: session.phone, name, about, avatar };
}

// Change the linked account's own profile picture from an uploaded image.
async function setOwnProfilePicture(tenantId, buffer, mimeType) {
  if (!module.exports.isConnected(tenantId)) throw new Error("WhatsApp not connected");
  if (!buffer || !buffer.length) throw new Error("image required");
  const { MessageMedia } = require("whatsapp-web.js");
  const media = new MessageMedia(mimeType || "image/jpeg", buffer.toString("base64"), "profile.jpg");
  const ok = await getSession(tenantId).client.setProfilePicture(media);
  return { ok: ok !== false };
}

// Remove the linked account's own profile picture.
async function deleteOwnProfilePicture(tenantId) {
  if (!module.exports.isConnected(tenantId)) throw new Error("WhatsApp not connected");
  const ok = await getSession(tenantId).client.deleteProfilePicture();
  return { ok: ok !== false };
}

// Update the linked account's display name and/or "about" status text.
async function setOwnProfile(tenantId, { name, about } = {}) {
  if (!module.exports.isConnected(tenantId)) throw new Error("WhatsApp not connected");
  const client = getSession(tenantId).client;
  const result = {};
  if (typeof name === "string" && name.trim()) {
    result.nameSet = (await client.setDisplayName(name.trim())) !== false;
  }
  if (typeof about === "string") {
    await client.setStatus(about);
    result.aboutSet = true;
  }
  return { ok: true, ...result };
}

/**
 * Pull the linked account's existing 1:1 conversations into the CRM inbox —
 * exactly what WhatsApp Web shows the moment you scan. Only real @c.us chats
 * (skips groups / channels / @lid / broadcasts). Best-effort + capped so a
 * busy account can't stall the event loop. Emits "whatsapp:imported" when done
 * so the chat UI refreshes its thread list.
 *
 *   perChatLimit — recent messages pulled per chat (default 25)
 *   maxChats     — safety cap on number of chats imported (default 300)
 */
async function importAllChats(tenantId, { perChatLimit = 25, maxChats = 300 } = {}) {
  tenantId = Number(tenantId);
  if (!module.exports.isConnected(tenantId)) return { imported: false, reason: "not-connected" };
  const session = getSession(tenantId);
  const channelPhone = session && session.phone;
  const prisma = require("../lib/prisma");

  let chats = [];
  try {
    chats = await session.client.getChats();
  } catch (e) {
    console.error(`[whatsappWeb] tenant ${tenantId} getChats failed: ${e.message}`);
    return { imported: false, reason: e.message };
  }

  // Import 1:1 chats (@c.us / @lid) AND groups (@g.us). Skip channels
  // (@newsletter) + status/broadcast.
  const candidates = chats.filter((c) => {
    const id = c && c.id && c.id._serialized;
    if (!id) return false;
    const kind = module.exports.chatAddressKind(id);
    return module.exports.isIndividualChatId(id) || kind === "group" || c.isGroup;
  });
  const byKind = chats.reduce((acc, c) => {
    const k = module.exports.chatAddressKind(c && c.id && c.id._serialized) || "other";
    acc[k] = (acc[k] || 0) + 1; return acc;
  }, {});
  console.log(`[whatsappWeb] tenant ${tenantId} import: ${chats.length} chats total, ${candidates.length} importable (1:1 + groups). breakdown=${JSON.stringify(byKind)}`);

  let threadsTouched = 0;
  let messages = 0;
  // Bounded media-download budget across the whole import so a large account
  // can't trigger thousands of downloads; recent chats (top of the list) get
  // their images first.
  const mediaBudget = { remaining: 250 };
  for (const chat of candidates) {
    if (threadsTouched >= maxChats) break;
    const id = chat.id._serialized;
    const isGroup = Boolean(chat.isGroup) || module.exports.chatAddressKind(id) === "group";
    // Groups: the thread key IS the group id (no single phone); name = subject.
    // Individuals: resolve real phone (+ name) — @lid ids aren't numbers.
    let phone;
    let contact = null;
    let waName;
    if (isGroup) {
      phone = id; // e.g. "<id>@g.us"
      waName = (chat.name && chat.name.trim()) || "Group";
    } else {
      const resolved = await module.exports.resolveIndividual(session.client, id);
      phone = resolved.key; // +number or lid:<digits>
      contact = resolved.phone ? await matchContact(tenantId, resolved.phone) : null;
      waName = module.exports.cleanName(chat.name) || module.exports.cleanName(resolved.name) || null;
    }
    // Profile picture (DP / group icon) — best-effort CDN URL (null if none).
    const avatar = await module.exports.getProfilePicSafe(session.client, id);

    let msgs = [];
    try {
      msgs = await chat.fetchMessages({ limit: perChatLimit });
    } catch (e) {
      console.warn(`[whatsappWeb] fetchMessages(${phone}) failed: ${e.message}`);
    }
    // Keep real content messages; the THREAD is created regardless so the
    // conversation shows up even if history isn't fetchable yet (parity with
    // WhatsApp Web, which lists every chat).
    const content = (msgs || []).filter((m) => module.exports.isContentMessage(m));
    const latestTs = content.length ? content[content.length - 1].timestamp : (chat.timestamp || null);
    const lastMessageAt = latestTs ? new Date(latestTs * 1000) : new Date();

    // Upsert the thread (unread mirrors WhatsApp's own per-chat unread count).
    const existing = await prisma.whatsAppThread.findUnique({
      where: { tenantId_contactPhone: { tenantId, contactPhone: phone } },
    });
    let thread;
    if (existing) {
      thread = await updateThreadSafe(prisma, { id: existing.id }, {
        lastMessageAt,
        status: existing.status === "CLOSED" ? "CLOSED" : "OPEN",
        ...(!existing.contactId && contact ? { contactId: contact.id } : {}),
        ...(waName && !existing.contactName ? { contactName: waName } : {}),
        ...(avatar ? { contactAvatar: avatar } : {}),
      });
    } else {
      thread = await createThreadSafe(prisma, {
        tenantId,
        contactPhone: phone,
        contactName: waName,
        contactAvatar: avatar,
        status: "OPEN",
        lastMessageAt,
        unreadCount: Number(chat.unreadCount) > 0 ? Number(chat.unreadCount) : 0,
        contactId: contact ? contact.id : null,
      });
    }
    threadsTouched += 1;

    // Oldest-first so createdAt ordering lands naturally.
    for (const m of content.slice().reverse()) {
      try {
        const wrote = await module.exports.persistHistoryMessage(tenantId, m, {
          phone, contactId: contact ? contact.id : null, threadId: thread.id, channelPhone, mediaBudget, isGroup,
        });
        if (wrote) messages += 1;
      } catch (e) {
        console.warn(`[whatsappWeb] history persist failed (${phone}): ${e.message}`);
      }
    }
  }

  console.log(`[whatsappWeb] tenant ${tenantId} chat import done — ${threadsTouched} chats, ${messages} messages`);
  if (_io) {
    _io.to(`tenant:${tenantId}`).emit("whatsapp:imported", { tenantId, threads: threadsTouched, messages });
  }
  return { imported: true, threads: threadsTouched, messages };
}

// ---------------------------------------------------------------------------
// watiClient-compatible send surface
// ---------------------------------------------------------------------------

// In the compat contract, "enabled" means "this tenant has a live, scanned
// session that can actually deliver". Without a tenantId (rare) it's false so
// callers stub. NEVER launches anything.
function isEnabled(tenantId) {
  if (process.env.NODE_ENV === "test") return false;
  if (tenantId == null) return false;
  return module.exports.isConnected(tenantId);
}

// Shape-compatible with watiClient.getConfig(). WhatsApp Web has no static
// endpoint/token; channelNumber is the connected number when available.
function getConfig() {
  return { endpoint: null, token: null, channelNumber: null };
}

/**
 * Core text send. Real path when the tenant's session is CONNECTED; otherwise
 * a STUB (QUEUED row + log) — identical envelope shape to watiClient so the
 * chat route + crons branch the same way.
 */
async function sendSessionMessage({ tenantId, subBrand, toPhone, text, contactId, threadId, userId, persistTo, templateName }) {
  if (!toPhone) throw new Error("toPhone required");
  if (!text) throw new Error("text required");
  // A group/chat id (contains "@") is used directly; a phone is normalised.
  const to = String(toPhone).includes("@") ? String(toPhone) : module.exports.normalizePhone(toPhone);
  if (!to) throw new Error("toPhone could not be normalised");
  const rowTo = persistTo || to;
  const session = getSession(tenantId);
  const from = (session && session.phone) || null;
  // templateName is carried onto the persisted row for analytics parity with
  // Wati even though WhatsApp Web sends it as plain text.
  const tpl = templateName || null;

  if (!module.exports.isEnabled(tenantId)) {
    console.log(
      `[whatsappWeb STUB] sendText tenant=${tenantId} subBrand=${subBrand || "(none)"} to=${to} ` +
      `textLen=${String(text).length} — operator must scan the WhatsApp QR to go live`,
    );
    const row = await module.exports.persistMessageRow({ tenantId, contactId, to: rowTo, body: text, templateName: tpl, status: "QUEUED", threadId, userId, from });
    return { stub: true, sent: false, status: "QUEUED", to, channel: from, messageRowId: row ? row.id : null };
  }

  try {
    const chatId = module.exports.toChatId(to);
    const sent = await session.client.sendMessage(chatId, text);
    const providerMsgId = sent && sent.id ? sent.id._serialized : null;
    console.log(`[whatsappWeb] text sent tenant=${tenantId} to=${to}`);
    const row = await module.exports.persistMessageRow({ tenantId, contactId, to: rowTo, body: text, templateName: tpl, status: "SENT", providerMsgId, threadId, userId, from });
    return { stub: false, sent: true, status: "SENT", to, channel: from, providerMsgId, messageRowId: row ? row.id : null };
  } catch (e) {
    console.error(`[whatsappWeb] text send FAILED tenant=${tenantId} to=${to}: ${e.message}`);
    const row = await module.exports.persistMessageRow({ tenantId, contactId, to: rowTo, body: text, templateName: tpl, status: "FAILED", errorMessage: e.message, threadId, userId, from });
    return { stub: false, sent: false, status: "FAILED", to, channel: from, error: e.message, messageRowId: row ? row.id : null };
  }
}

/**
 * Template-shaped send. WhatsApp Web has no template/HSM concept, so we just
 * send the rendered text. Prefer the caller's bodyPreview (the chat route
 * renders the substituted body); else stitch the parameter values onto the
 * templateName as a readable line so nothing is lost.
 */
async function sendTemplateMessage({ tenantId, subBrand, toPhone, templateName, parameters, contactId, bodyPreview, threadId, userId, persistTo }) {
  if (!toPhone) throw new Error("toPhone required");
  const values = Array.isArray(parameters)
    ? parameters.map((p) => (p && typeof p === "object" ? p.value : p)).filter((v) => v != null && v !== "")
    : [];
  const text = (bodyPreview && String(bodyPreview).trim())
    || (templateName ? `${templateName}${values.length ? `: ${values.join(" · ")}` : ""}` : "")
    || "";
  if (!text) throw new Error("no renderable body for template send");
  // templateName is preserved on the row for analytics parity with Wati.
  const out = await module.exports.sendSessionMessage({ tenantId, subBrand, toPhone, text, contactId, threadId, userId, persistTo, templateName: templateName || null });
  return { ...out, templateName: templateName || null };
}

/**
 * Media send. Real path uploads the buffer via the live session; stub mode
 * persists a QUEUED row with the media metadata (so the bubble still renders
 * from the locally-persisted mediaUrl the route passes in).
 */
async function sendSessionFile({ tenantId, toPhone, buffer, filename, mimeType, caption, contactId, threadId, userId, persistTo, mediaUrl }) {
  if (!toPhone) throw new Error("toPhone required");
  if (!buffer || !buffer.length) throw new Error("file buffer required");
  const to = String(toPhone).includes("@") ? String(toPhone) : module.exports.normalizePhone(toPhone);
  if (!to) throw new Error("toPhone could not be normalised");
  const rowTo = persistTo || to;
  const session = getSession(tenantId);
  const from = (session && session.phone) || null;
  const kind = String(mimeType || "").split("/")[0] || "document";
  const persistCommon = {
    tenantId, contactId, to: rowTo, body: caption || null, threadId, userId, from,
    mediaUrl: mediaUrl || null,
    mediaType: mimeType || null,
    metaType: kind === "application" ? "document" : kind,
  };

  if (!module.exports.isEnabled(tenantId)) {
    console.log(`[whatsappWeb STUB] sendFile tenant=${tenantId} to=${to} file=${filename} (${mimeType}, ${buffer.length}b) — scan the QR to go live`);
    const row = await module.exports.persistMessageRow({ ...persistCommon, status: "QUEUED" });
    return { stub: true, sent: false, status: "QUEUED", to, channel: from, messageRowId: row ? row.id : null, mediaUrl: mediaUrl || null };
  }

  try {
    const { MessageMedia } = require("whatsapp-web.js");
    const media = new MessageMedia(mimeType || "application/octet-stream", buffer.toString("base64"), filename || "file");
    const chatId = module.exports.toChatId(to);
    const sent = await session.client.sendMessage(chatId, media, caption ? { caption } : {});
    const providerMsgId = sent && sent.id ? sent.id._serialized : null;
    console.log(`[whatsappWeb] file sent tenant=${tenantId} to=${to} file=${filename}`);
    const row = await module.exports.persistMessageRow({ ...persistCommon, status: "SENT", providerMsgId });
    return { stub: false, sent: true, status: "SENT", to, channel: from, providerMsgId, messageRowId: row ? row.id : null, mediaUrl: mediaUrl || null };
  } catch (e) {
    console.error(`[whatsappWeb] file send FAILED tenant=${tenantId} to=${to}: ${e.message}`);
    const row = await module.exports.persistMessageRow({ ...persistCommon, status: "FAILED", errorMessage: e.message });
    return { stub: false, sent: false, status: "FAILED", to, channel: from, error: e.message, messageRowId: row ? row.id : null, mediaUrl: mediaUrl || null };
  }
}

/**
 * Best-effort dispatch — the ONE call every travel cron uses. With WhatsApp
 * Web there's no template gate, so we just send the human-readable text
 * (fallbackText, or the rendered template). Never throws.
 */
async function sendBestEffort({ tenantId, subBrand, toPhone, templateName, parameters, fallbackText, contactId }) {
  try {
    if (fallbackText) {
      return await module.exports.sendSessionMessage({ tenantId, subBrand, toPhone, text: fallbackText, contactId });
    }
    if (templateName) {
      return await module.exports.sendTemplateMessage({ tenantId, subBrand, toPhone, templateName, parameters, contactId });
    }
    return { stub: !module.exports.isEnabled(tenantId), sent: false, status: "SKIPPED", error: "neither fallbackText nor templateName supplied" };
  } catch (e) {
    console.error(`[whatsappWeb] sendBestEffort error (non-fatal): ${e.message}`);
    return { stub: !module.exports.isEnabled(tenantId), sent: false, status: "FAILED", error: e.message };
  }
}

// WhatsApp Web has no approved-template catalogue — the chat template picker
// just stays empty (free-form text always delivers).
async function getMessageTemplates() {
  return { stub: true, templates: [] };
}

/**
 * Recent chats for the manual pull-sync. Real-time inbound already arrives via
 * the `message` event, so this is a secondary path; returns [] when the
 * tenant isn't connected.
 */
async function getContacts({ tenantId, pageSize = 20 } = {}) {
  if (!module.exports.isConnected(tenantId)) return { stub: true, contacts: [] };
  try {
    const session = getSession(tenantId);
    const chats = await session.client.getChats();
    const contacts = chats
      .filter((c) => !c.isGroup && c.id && c.id._serialized && c.id._serialized.endsWith("@c.us"))
      .slice(0, pageSize)
      .map((c) => ({ wAid: c.id._serialized, phone: module.exports.fromChatId(c.id._serialized) }));
    return { stub: false, contacts };
  } catch (e) {
    console.error(`[whatsappWeb] getContacts failed: ${e.message}`);
    return { stub: false, contacts: [] };
  }
}

/** Recent messages of one conversation — used by the manual pull-sync. */
async function getMessages({ tenantId, whatsappNumber, pageSize = 30 }) {
  if (!whatsappNumber) throw new Error("whatsappNumber required");
  if (!module.exports.isConnected(tenantId)) return { stub: true, items: [] };
  try {
    const session = getSession(tenantId);
    const chatId = module.exports.toChatId(whatsappNumber);
    const chat = await session.client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: pageSize });
    const items = msgs.map((m) => ({
      id: m.id ? m.id._serialized : null,
      eventType: "message",
      text: m.body || "",
      owner: Boolean(m.fromMe),
      created: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
      type: m.type || "text",
    }));
    return { stub: false, items };
  } catch (e) {
    console.error(`[whatsappWeb] getMessages failed: ${e.message}`);
    return { stub: false, items: [] };
  }
}

// Inbound media is persisted (S3/uploads) at ingest, so there's no on-demand
// fetch-by-fileName step like Wati's. Kept for interface compatibility — the
// media proxy route simply 404s in stub mode.
async function getMediaResponse() {
  return null;
}

module.exports = {
  STATE,
  init,
  restoreSessions,
  // lifecycle
  connect,
  disconnect,
  clearSession,
  killBrowsersForDir,
  resolveChromePath,
  getState,
  getSession,
  isConnected,
  emitState,
  wireEvents,
  ingestInbound,
  importAllChats,
  purgeChats,
  persistHistoryMessage,
  isCustomerChatId,
  chatAddressKind,
  isIndividualChatId,
  resolveIndividual,
  cleanName,
  getProfilePicSafe,
  getOwnProfile,
  setOwnProfilePicture,
  deleteOwnProfilePicture,
  setOwnProfile,
  isContentMessage,
  applyAck,
  mapAck,
  persistInboundMedia,
  // helpers
  normalizePhone,
  toChatId,
  fromChatId,
  persistMessageRow,
  // watiClient-compatible surface
  isEnabled,
  getConfig,
  sendTemplateMessage,
  sendSessionMessage,
  sendSessionFile,
  sendBestEffort,
  getMessageTemplates,
  getContacts,
  getMessages,
  getMediaResponse,
};
