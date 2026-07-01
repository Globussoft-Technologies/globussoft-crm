// Gmail OAuth + read/send integration (Gmail API).
//
// Mirrors routes/calendar_google.js exactly — same googleapis OAuth2 client,
// same per-user token storage pattern (GmailIntegration ≈ CalendarIntegration),
// same auto-refresh-and-persist `tokens` listener, same reauth detection. The
// only differences are the Gmail scopes and the gmail.users.* surface.
//
// Endpoints (all under /api/gmail, all verifyToken except the OAuth callback):
//   GET    /connect          → { authUrl }  (Gmail consent URL)
//   GET    /callback         → OAuth redirect target; stores tokens (public)
//   GET    /status           → { connected, emailAddress, lastSyncAt }
//   DELETE /disconnect       → removes the GmailIntegration row
//   GET    /messages         → list recent messages (live, parsed) ?q=&maxResults=
//   GET    /messages/:id     → one message (live, parsed)
//   POST   /send             → send via Gmail + persist an OUTBOUND EmailMessage
//
// DEFERRED to a later slice (documented so the seams are obvious):
//   - Full inbox → EmailMessage sync + Pub/Sub push (users.watch / history).
//     Needs a dedup key on EmailMessage (e.g. a `gmailMessageId @unique`
//     column) before it can upsert idempotently; `lastHistoryId` on
//     GmailIntegration is already in place for the incremental cursor.
//   - Google Workspace service-account + domain-wide delegation (org-wide
//     mailbox access without per-user OAuth).
//
// Config (reuses the existing Google OAuth app — see calendar_google.js):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  (shared)
//   GMAIL_REDIRECT_URI  (defaults to <host>/api/gmail/callback)
//   FRONTEND_URL        (where the callback bounces the browser back to)
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const express = require("express");
const multer = require("multer");
const { google } = require("googleapis");
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  buildRawMessage,
  parseGmailMessage,
  extractEmailAddress,
} = require("../lib/gmailMessage");

// Memory-based upload — files stay as Buffers, never touch disk.
// 25 MB per file (Gmail's attachment limit); 10 files max per send.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router = express.Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const GMAIL_REDIRECT_URI =
  process.env.GMAIL_REDIRECT_URI ||
  process.env.GOOGLE_GMAIL_REDIRECT_URI ||
  "http://localhost:5000/api/gmail/callback";
// Strip trailing slash AND a stray "/api" suffix so a deployment whose
// FRONTEND_URL is mistakenly set to the API base (e.g. https://host/api)
// still produces a working SPA link instead of /api/gmail.
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173")
  .replace(/\/+$/, "")
  .replace(/\/api$/i, "");

// Scopes: read (sync/list), send (compose from CRM), modify (labels/read-state).
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

const PROVIDER = "google";

function buildOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REDIRECT_URI);
}

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeState(state) {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    try {
      return JSON.parse(Buffer.from(state, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
}

// Detect a revoked/expired refresh token so callers can prompt a reconnect
// instead of leaking the raw googleapis/OAuth error to the user.
function isReauthError(err) {
  const raw = `${(err && err.message) || ""} ${
    err && err.response && err.response.data ? JSON.stringify(err.response.data) : ""
  }`;
  return /invalid_grant|expired or revoked|Token has been expired/i.test(raw);
}

// Gmail API returns 400 "Precondition check failed" (failedPrecondition) when
// the connected Google account has NO active Gmail mailbox — i.e. Gmail isn't
// enabled for that Workspace user, or it's a Google account that isn't
// Gmail-backed. Surface a clear instruction instead of the cryptic raw error.
function isGmailNotEnabledError(err) {
  const raw = `${(err && err.message) || ""} ${
    err && err.response && err.response.data ? JSON.stringify(err.response.data) : ""
  }`;
  return /failedPrecondition|Precondition check failed|Mail service not enabled|not enabled for/i.test(raw);
}

const GMAIL_NOT_ENABLED_MSG =
  "This Google account doesn't have Gmail enabled (no mailbox). Connect a Gmail-enabled account, " +
  "or enable Gmail for this user in Google Workspace Admin.";

async function getAuthorizedClientForUser(userId) {
  const integration = await prisma.gmailIntegration.findUnique({
    where: { userId_provider: { userId, provider: PROVIDER } },
  });
  if (!integration) {
    const err = new Error(
      "Gmail not connected. Please connect your mailbox first via /api/gmail/connect"
    );
    err.status = 404;
    err.code = "NOT_CONNECTED";
    throw err;
  }
  const client = buildOAuthClient();
  client.setCredentials({
    access_token: integration.accessToken,
    refresh_token: integration.refreshToken || undefined,
    expiry_date: integration.expiresAt ? integration.expiresAt.getTime() : undefined,
  });

  // Persist refreshed tokens automatically (same as calendar_google.js).
  client.on("tokens", async (tokens) => {
    try {
      const data = {};
      if (tokens.access_token) data.accessToken = tokens.access_token;
      if (tokens.refresh_token) data.refreshToken = tokens.refresh_token;
      if (tokens.expiry_date) data.expiresAt = new Date(tokens.expiry_date);
      if (Object.keys(data).length) {
        await prisma.gmailIntegration.update({
          where: { userId_provider: { userId, provider: PROVIDER } },
          data,
        });
      }
    } catch (e) {
      console.error("[gmail] failed to persist refreshed tokens:", e.message);
    }
  });

  return { client, integration };
}

// GET /connect — generate the Gmail OAuth consent URL.
router.get("/connect", verifyToken, (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res
        .status(500)
        .json({ error: "Google OAuth credentials not configured on server", code: "NOT_CONFIGURED" });
    }
    const oauth2Client = buildOAuthClient();
    const state = encodeState({ userId: req.user.userId, tenantId: req.user.tenantId, t: Date.now() });
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // force a refresh_token on every (re)connect
      scope: SCOPES,
      state,
    });
    res.json({ authUrl });
  } catch (err) {
    console.error("[gmail] /connect error:", err);
    res.status(500).json({ error: "Failed to generate Gmail OAuth URL" });
  }
});

// GET /callback — public; receives code+state, exchanges + stores tokens.
router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect(`${FRONTEND_URL}/gmail?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/gmail?error=missing_code_or_state`);
  }
  const decoded = decodeState(state);
  if (!decoded || !decoded.userId) {
    return res.redirect(`${FRONTEND_URL}/gmail?error=invalid_state`);
  }
  try {
    const oauth2Client = buildOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    const userId = parseInt(decoded.userId, 10);
    const tenantId = decoded.tenantId ? parseInt(decoded.tenantId, 10) : 1;

    // Resolve the connected mailbox address for the "Connected as …" label.
    let emailAddress = null;
    try {
      oauth2Client.setCredentials(tokens);
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      const profile = await gmail.users.getProfile({ userId: "me" });
      emailAddress = (profile.data && profile.data.emailAddress) || null;
    } catch (e) {
      console.error("[gmail] getProfile failed (non-fatal):", e.message);
    }

    await prisma.gmailIntegration.upsert({
      where: { userId_provider: { userId, provider: PROVIDER } },
      create: {
        userId,
        provider: PROVIDER,
        emailAddress,
        accessToken: tokens.access_token || "",
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        syncEnabled: true,
        tenantId,
      },
      update: {
        accessToken: tokens.access_token || "",
        // Keep the existing refresh token if Google doesn't re-send one.
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        ...(emailAddress ? { emailAddress } : {}),
        syncEnabled: true,
        tenantId,
      },
    });

    // HTML redirect to preserve the browser session/token (same as calendar).
    const redirectUrl = `${FRONTEND_URL}/gmail?connected=gmail`;
    res.send(`
      <script>window.location.href = '${redirectUrl}';</script>
      <p>Redirecting…</p>
    `);
  } catch (err) {
    console.error("[gmail] /callback error:", err);
    res.redirect(`${FRONTEND_URL}/gmail?error=${encodeURIComponent("token_exchange_failed")}`);
  }
});

// GET /status — is the current user's mailbox connected?
router.get("/status", verifyToken, async (req, res) => {
  try {
    const integration = await prisma.gmailIntegration.findUnique({
      where: { userId_provider: { userId: req.user.userId, provider: PROVIDER } },
    });
    if (!integration) {
      return res.json({ connected: false });
    }
    return res.json({
      connected: true,
      emailAddress: integration.emailAddress || null,
      lastSyncAt: integration.lastSyncAt || null,
    });
  } catch (err) {
    console.error("[gmail] /status error:", err);
    return res.status(500).json({ error: "Failed to load Gmail status" });
  }
});

// DELETE /disconnect — drop the integration row.
router.delete("/disconnect", verifyToken, async (req, res) => {
  try {
    await prisma.gmailIntegration
      .delete({ where: { userId_provider: { userId: req.user.userId, provider: PROVIDER } } })
      .catch((err) => {
        if (err && err.code === "P2025") return null; // already gone — fine
        throw err;
      });
    return res.json({ success: true });
  } catch (err) {
    console.error("[gmail] /disconnect error:", err);
    return res.status(500).json({ error: "Failed to disconnect" });
  }
});

// GET /messages — list recent messages (live read), parsed for the CRM UI.
// Query: q (Gmail search, e.g. "in:inbox newer_than:30d"), maxResults (1..50).
router.get("/messages", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    let maxResults = parseInt(req.query.maxResults, 10);
    if (!Number.isFinite(maxResults) || maxResults < 1) maxResults = 15;
    if (maxResults > 50) maxResults = 50;

    const { client } = await getAuthorizedClientForUser(userId);
    const gmail = google.gmail({ version: "v1", auth: client });

    const list = await gmail.users.messages.list({ userId: "me", q, maxResults });
    const ids = (list.data.messages || []).map((m) => m.id).filter(Boolean);

    const messages = await Promise.all(
      ids.map(async (id) => {
        const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        const parsed = parseGmailMessage(full.data);
        // Trim the heavy body for the list view; /messages/:id returns full.
        return {
          id: parsed.id,
          threadId: parsed.threadId,
          from: parsed.from,
          to: parsed.to,
          subject: parsed.subject,
          date: parsed.date,
          snippet: parsed.snippet,
          unread: parsed.labelIds.includes("UNREAD"),
        };
      })
    );

    return res.json({ messages, nextPageToken: list.data.nextPageToken || null });
  } catch (err) {
    if (isReauthError(err)) {
      return res
        .status(401)
        .json({ error: "Your Gmail connection has expired. Please reconnect.", code: "RECONNECT_REQUIRED" });
    }
    if (isGmailNotEnabledError(err)) {
      return res.status(400).json({ error: GMAIL_NOT_ENABLED_MSG, code: "GMAIL_NOT_ENABLED" });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error("[gmail] GET /messages error:", err);
    return res.status(500).json({ error: "Couldn't load your Gmail messages right now." });
  }
});

// GET /messages/:messageId — one full message, parsed.
//
// The param is `:messageId`, NOT `:id`, on purpose: server.js attaches a global
// `app.param("id", validateNumericId)` to every router, which rejects a
// non-numeric `:id` with "Invalid id: must be a positive integer". Gmail
// message IDs are opaque hex strings (e.g. "1977b3c…"), so a `:id` param here
// would be blocked before the handler ever runs. A differently-named param
// sidesteps that validator.
router.get("/messages/:messageId", verifyToken, async (req, res) => {
  try {
    const { client } = await getAuthorizedClientForUser(req.user.userId);
    const gmail = google.gmail({ version: "v1", auth: client });
    const full = await gmail.users.messages.get({ userId: "me", id: req.params.messageId, format: "full" });
    return res.json(parseGmailMessage(full.data));
  } catch (err) {
    if (isReauthError(err)) {
      return res
        .status(401)
        .json({ error: "Your Gmail connection has expired. Please reconnect.", code: "RECONNECT_REQUIRED" });
    }
    if (isGmailNotEnabledError(err)) {
      return res.status(400).json({ error: GMAIL_NOT_ENABLED_MSG, code: "GMAIL_NOT_ENABLED" });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    // A bad/unknown message id surfaces as a 404 from Gmail.
    if (err.code === 404 || (err.response && err.response.status === 404)) {
      return res.status(404).json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" });
    }
    console.error("[gmail] GET /messages/:id error:", err);
    return res.status(500).json({ error: "Couldn't load that message right now." });
  }
});

// POST /send — send an email via the user's Gmail + log it as an OUTBOUND
// EmailMessage (threaded to a Contact when one matches the recipient).
// Accepts either application/json (no attachments) or multipart/form-data
// (with file attachments) — multer handles both transparently.
router.post("/send", verifyToken, upload.array("attachments", 10), async (req, res) => {
  try {
    const { to, subject, text, html, cc, bcc, contactId } = req.body || {};
    if (!to || typeof to !== "string") {
      return res.status(400).json({ error: "`to` is required", code: "MISSING_FIELDS" });
    }
    const hasBody = (typeof text === "string" && text.length) || (typeof html === "string" && html.length);
    if (!hasBody) {
      return res.status(400).json({ error: "`text` or `html` body is required", code: "MISSING_FIELDS" });
    }

    const userId = req.user.userId;
    const tenantId = req.user.tenantId || 1;
    const { client, integration } = await getAuthorizedClientForUser(userId);
    const gmail = google.gmail({ version: "v1", auth: client });

    const attachments = (req.files || []).map((f) => ({
      filename: f.originalname,
      mimeType: f.mimetype,
      data: f.buffer,
    }));

    const raw = buildRawMessage({
      from: integration.emailAddress || undefined,
      to,
      cc: typeof cc === "string" && cc.length ? cc : undefined,
      bcc: typeof bcc === "string" && bcc.length ? bcc : undefined,
      subject: typeof subject === "string" ? subject : "",
      text,
      html,
      attachments,
    });

    const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

    // Best-effort: log the sent mail on the CRM timeline, linked to a Contact.
    // A persistence hiccup must never fail an email that already went out.
    let logged = null;
    try {
      let resolvedContactId = contactId ? parseInt(contactId, 10) : null;
      if (!resolvedContactId) {
        const addr = extractEmailAddress(to);
        if (addr) {
          const match = await prisma.contact.findFirst({
            where: { tenantId, email: addr },
            select: { id: true },
          });
          resolvedContactId = match ? match.id : null;
        }
      }
      logged = await prisma.emailMessage.create({
        data: {
          subject: typeof subject === "string" && subject.length ? subject : "(no subject)",
          body: html || text || "",
          from: integration.emailAddress || "me",
          to,
          cc: typeof cc === "string" && cc.length ? cc : null,
          direction: "OUTBOUND",
          read: true,
          threadId: (sent.data && sent.data.threadId) || null,
          userId,
          tenantId,
          contactId: resolvedContactId,
        },
      });
    } catch (e) {
      console.error("[gmail] failed to log OUTBOUND EmailMessage (non-fatal):", e.message);
    }

    return res.status(201).json({
      success: true,
      gmailMessageId: (sent.data && sent.data.id) || null,
      threadId: (sent.data && sent.data.threadId) || null,
      emailMessageId: logged ? logged.id : null,
    });
  } catch (err) {
    if (isReauthError(err)) {
      return res
        .status(401)
        .json({ error: "Your Gmail connection has expired. Please reconnect.", code: "RECONNECT_REQUIRED" });
    }
    if (isGmailNotEnabledError(err)) {
      return res.status(400).json({ error: GMAIL_NOT_ENABLED_MSG, code: "GMAIL_NOT_ENABLED" });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error("[gmail] POST /send error:", err);
    return res.status(500).json({ error: "Couldn't send that email right now." });
  }
});

module.exports = router;
