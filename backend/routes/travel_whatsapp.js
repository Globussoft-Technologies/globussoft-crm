/**
 * /api/travel/whatsapp — TRAVEL vertical 2-way WhatsApp chat (Wati, Q9).
 *
 * Powers the travel chat surface (frontend/src/pages/travel/WhatsAppChat.jsx,
 * a clone of the wellness agent inbox). The READ side of the chat — threads
 * list/detail/assign/close/snooze/mark-read, opt-outs — reuses the existing
 * tenant-scoped /api/whatsapp/* routes UNCHANGED. This router adds only the
 * travel-specific WRITE/INGEST legs:
 *
 *   GET  /whatsapp/status    — Wati config state for the UI status strip:
 *                              { enabled, channelNumber } (channel masked).
 *
 *   POST /whatsapp/send      — operator sends a chat message via Wati
 *                              (NOT Meta — the wellness/generic /api/whatsapp/send
 *                              path is a separate transport and is untouched).
 *                              Body (matches the wellness composer contract):
 *                                { to, body }                      — session text
 *                                { to, templateName, parameters[] }— template
 *                              Effects: opt-out gate → watiClient send →
 *                              WhatsAppThread upsert (tenantId+contactPhone,
 *                              same key the Meta path + webhook use) →
 *                              thread-linked WhatsAppMessage row (persisted
 *                              INSIDE watiClient via threadId pass-through —
 *                              single row, no duplicates).
 *                              201 { success, status, thread } on QUEUED/SENT;
 *                              502 WATI_SEND_FAILED when Wati rejects.
 *
 *   POST /whatsapp/webhook   — Wati → CRM inbound webhook (OPEN path; added
 *                              to server.js openPaths). Register in the Wati
 *                              dashboard as:
 *                                https://<host>/api/travel/whatsapp/webhook?tenantId=<id>&token=<WATI_WEBHOOK_TOKEN>
 *                              Handles:
 *                                eventType "message" + owner!==true → INBOUND
 *                                  WhatsAppMessage row + thread upsert
 *                                  (unreadCount++ when unassigned, mirroring
 *                                  the Meta webhook) + socket emit
 *                                  "whatsapp:received" to room tenant:<id> —
 *                                  the SAME event the chat UI already
 *                                  subscribes to, so bubbles appear live.
 *                                eventType matching DELIVERED/READ/FAILED →
 *                                  status update on the row matched by
 *                                  providerMsgId (+ errorMessage on FAILED)
 *                                  + "whatsapp:status" emit.
 *                              ALWAYS answers 200 { received: true } so Wati
 *                              never retry-bombs on processing hiccups.
 *
 *   GET  /whatsapp/webhook   — 200 echo for Wati's URL-verification ping.
 *
 * Webhook auth: if WATI_WEBHOOK_TOKEN env is set, the ?token= query param
 * must match (401 otherwise). Unset = accepted with a console warning (dev).
 * Tenant resolution: ?tenantId= must be a travel-vertical tenant; falls back
 * to the first active travel tenant (single-travel-tenant deployments).
 *
 * Phone normalisation: thread keys + message rows store toE164() form
 * (+9198...) — matching what the Meta-track webhook/threads use — while the
 * Wati API itself receives bare digits (watiClient normalises internally).
 *
 * Wellness/generic isolation: this file only ADDS routes under /api/travel;
 * routes/whatsapp.js, whatsapp_webhook.js and whatsappProvider.js are not
 * imported or modified.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const prisma = require("../lib/prisma");
// ── WhatsApp transport swap (Q9) ───────────────────────────────────────────
// The Wati REST transport is COMMENTED OUT (kept on disk, not removed) — the
// travel vertical now sends/receives over WhatsApp Web (QR-scan) via
// services/whatsappWebClient.js, a drop-in that exposes the same method
// surface. The local name stays `watiClient` so the call sites below are
// unchanged; only the module behind it changed.
// const watiClient = require("../services/watiClient"); // legacy Wati REST (disabled)
const watiClient = require("../services/whatsappWebClient");
const { toE164 } = require("../utils/deduplication");
// Per-user device-session governance (device lock + relink cooldown). This is a
// thin claim layer over the SHARED tenant session — it never touches the
// whatsappWebClient connection engine. See lib/whatsappSessionGuard.js.
const waGuard = require("../lib/whatsappSessionGuard");

// Human-friendly label for the "controlled from another device" warning:
// the operator's name/email + a coarse browser/OS hint from the user-agent.
function deviceLabelFor(req) {
  const who = (req.user && (req.user.name || req.user.email)) || `user#${req.user && req.user.userId}`;
  const ua = String(req.headers["user-agent"] || "");
  let browser = "browser";
  if (/edg/i.test(ua)) browser = "Edge";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua)) browser = "Safari";
  let os = "";
  if (/windows/i.test(ua)) os = "Windows";
  else if (/android/i.test(ua)) os = "Android";
  else if (/iphone|ipad|ios/i.test(ua)) os = "iOS";
  else if (/mac os|macintosh/i.test(ua)) os = "macOS";
  else if (/linux/i.test(ua)) os = "Linux";
  return `${who} · ${browser}${os ? ` on ${os}` : ""}`;
}

// Outbound media upload (paperclip in the travel chat) — memory storage,
// 16MB cap (WhatsApp's own media ceiling, mirroring the Meta-track
// /send-media route's limit).
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});

// Normalise any inbound phone shape to the thread-key form. toE164 returns
// null on garbage — fall back to a digits-only best effort so a weird Wati
// waId still produces a stable, consistent key.
function threadPhone(raw) {
  const s = String(raw || "");
  // Group / chat ids (contain "@", e.g. "<id>@g.us") and our lid: keys are used
  // verbatim — they're stable thread keys, not phone numbers to normalise.
  if (s.includes("@") || s.startsWith("lid:")) return s;
  const e164 = toE164(s);
  if (e164) return e164;
  const digits = s.replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

// Best-effort Contact match for thread linking — checks both the E.164 and
// bare-digit spellings since seed/import data varies. Never throws.
async function matchContact(tenantId, phoneE164) {
  try {
    const digits = phoneE164.replace(/\D/g, "");
    return await prisma.contact.findFirst({
      where: {
        tenantId,
        OR: [
          { phone: phoneE164 },
          { phone: digits },
          { phone: `+${digits}` },
        ],
      },
      select: { id: true, name: true },
    });
  } catch {
    return null;
  }
}

// Attach an inbound emoji reaction to its target message (matched via the
// reaction payload's context/reply id → providerMsgId). Mirrors the Meta
// webhook's reactionsJson contract ([{ emoji, fromPhone, addedAt }]) so
// the chat's reaction pills render unchanged. Empty emoji = removal.
async function applyReaction({ tenantId, phone, item, io }) {
  try {
    const targetRef = item.replyContextId || item.contextId || item.reactionMessageId
      || (item.reaction && item.reaction.message_id) || null;
    const emoji = (item.reaction && item.reaction.emoji) || item.text || item.emoji || "";
    if (!targetRef) return;
    const target = await prisma.whatsAppMessage.findFirst({
      where: { tenantId, providerMsgId: String(targetRef) },
      select: { id: true, threadId: true, reactionsJson: true },
    });
    if (!target) return;
    let reactions = [];
    try { reactions = JSON.parse(target.reactionsJson || "[]"); } catch { reactions = []; }
    reactions = reactions.filter((r) => r.fromPhone !== phone);
    if (emoji) reactions.push({ emoji, fromPhone: phone, addedAt: new Date().toISOString() });
    await prisma.whatsAppMessage.update({
      where: { id: target.id },
      data: { reactionsJson: JSON.stringify(reactions) },
    });
    if (io) {
      io.to(`tenant:${tenantId}`).emit("whatsapp:reaction", {
        tenantId,
        threadId: target.threadId,
        messageId: target.id,
        emoji,
        fromPhone: phone,
      });
    }
  } catch (e) {
    console.error(`[travel-whatsapp] reaction apply failed (non-fatal): ${e.message}`);
  }
}

// ───────────────────────────────────────────────────────────────────
// GET /whatsapp/media — streaming proxy for Wati-hosted media. The chat
// renders <img>/<video>/<audio> tags pointing here (browsers can't send
// Authorization headers on media tags, and Wati's storage needs the
// Bearer token). OPEN path (server.js openPaths) — the unguessable Wati
// storage path in ?fileName= is the access key, the same trust model as
// the wellness track's public S3 media URLs.
// ───────────────────────────────────────────────────────────────────
router.get("/whatsapp/media", async (req, res) => {
  try {
    const fileName = String(req.query.fileName || "");
    if (!fileName || fileName.length < 4) {
      return res.status(400).json({ error: "fileName required" });
    }
    const upstream = await watiClient.getMediaResponse(fileName);
    if (!upstream) {
      return res.status(404).json({ error: "media unavailable (stub mode or not found)" });
    }
    res.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.set("Cache-Control", "private, max-age=86400");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    console.error("[travel-whatsapp] media proxy error:", e.message);
    res.status(502).json({ error: "Failed to fetch media" });
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /whatsapp/status — WhatsApp Web connection state for the chat
// status strip + QR connect panel.
//
//   { enabled, state, connected, phone(masked), qr(dataURL|null), channelNumber }
//
// `enabled`/`channelNumber` are retained for back-compat with the existing
// chat header; the new fields (state/connected/phone/qr) drive the QR
// connect flow. The legacy Wati-shaped status the old strip read is
// preserved in spirit: connected ⇒ enabled:true with the masked number.
// ───────────────────────────────────────────────────────────────────
function maskNumber(num) {
  const s = String(num || "");
  return s.length >= 7 ? `${s.slice(0, 4)}•••${s.slice(-3)}` : s || null;
}

router.get(
  "/whatsapp/status",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    const st = watiClient.getState(req.travelTenant.id);
    res.json({
      enabled: st.connected,
      state: st.state,
      connected: st.connected,
      phone: maskNumber(st.phone),
      channelNumber: maskNumber(st.phone),
      qr: st.qr || null,
      lastError: st.lastError || null,
    });
  },
);

// ───────────────────────────────────────────────────────────────────
// QR connection lifecycle (ADMIN). The operator scans the QR from their
// phone (WhatsApp → Linked devices) to link the number; thereafter the
// CRM sends/receives on it. State + QR are pushed live over the
// "whatsapp:qr" / "whatsapp:wa-state" socket events AND pollable here.
// ───────────────────────────────────────────────────────────────────

// POST /whatsapp/connect — start (or resume) the session; returns the
// current state (QR arrives moments later via socket / GET /whatsapp/qr).
router.post(
  "/whatsapp/connect",
  verifyToken,
  requireTravelTenant,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      // { reset:true } wipes any saved/stale session + kills a stuck Chromium
      // before relaunching — the escape hatch for a wedged "Generating QR…".
      const reset = Boolean(req.body && (req.body.reset === true || req.body.reset === "true"));

      // ── Device-session gate (per-user device lock + per-tenant relink
      // cooldown). Runs BEFORE any purge/connect so a blocked attempt neither
      // wipes chats nor generates a QR. deviceId rides in the body (NOT stripped
      // by stripDangerous); userId comes from the token. A caller with no
      // deviceId degrades to allow (backward compatible).
      const claim = await waGuard.claim(
        req.travelTenant.id,
        req.user.userId,
        req.body && req.body.deviceId,
        {
          deviceLabel: deviceLabelFor(req),
          ip: req.ip,
          reset,
          isConnected: watiClient.isConnected(req.travelTenant.id),
        },
      );
      if (!claim.allowed) {
        return res.status(409).json({
          error: claim.message,
          code: claim.code,
          activeDevice: claim.activeDevice || null,
          cooldownRemainingMs: claim.cooldownRemainingMs || null,
        });
      }

      // Only purge the mirror on an explicit RESET (fresh QR / new number). The
      // old `!connected` guard wiped ALL imported threads whenever the panel was
      // opened while the saved session was still resuming on boot (state is
      // INITIALIZING/AUTHENTICATED → connected:false for a few seconds), so a
      // routine page-open after a restart destroyed the operator's whole inbox.
      // reset already wipes the session dir; pair the chat purge with it.
      if (reset) {
        await watiClient.purgeChats(req.travelTenant.id);
      }
      const st = await watiClient.connect(req.travelTenant.id, { reset });
      res.json({ ...st, phone: maskNumber(st.phone) });
    } catch (e) {
      console.error("[travel-whatsapp] connect error:", e.message);
      res.status(500).json({ error: "Failed to start WhatsApp Web session", code: "WA_CONNECT_FAILED" });
    }
  },
);

// GET /whatsapp/qr — poll the current QR / connection state (socket fallback).
router.get(
  "/whatsapp/qr",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    const st = watiClient.getState(req.travelTenant.id);
    res.json({ state: st.state, connected: st.connected, qr: st.qr || null, phone: maskNumber(st.phone), lastError: st.lastError || null });
  },
);

// POST /whatsapp/heartbeat — the device currently holding the control claim
// pings this (~every 45s) so its lock doesn't go stale. NOT admin-gated (any
// claim holder pings). Returns { ok, lost }: lost=true means the claim expired
// or was taken by the user's other device, so the UI should stop pinging.
router.post(
  "/whatsapp/heartbeat",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const out = await waGuard.heartbeat(req.travelTenant.id, req.user.userId, req.body && req.body.deviceId);
      res.json(out);
    } catch (e) {
      console.error("[travel-whatsapp] heartbeat error:", e.message);
      res.status(500).json({ error: "Heartbeat failed", code: "WA_HEARTBEAT_FAILED" });
    }
  },
);

// POST /whatsapp/import — re-pull the linked account's existing chats into the
// CRM inbox (runs automatically on connect; this is the manual "refresh all"
// button). Real 1:1 chats only — groups / channels / @lid are skipped.
// When a connectivity guard fails, distinguish a TRANSIENT reconnect (boot
// restore after a server restart — the session is INITIALIZING / resuming) from
// a genuine needs-QR / disconnected state. Without this the UI told the operator
// to "scan the QR" during the few seconds the saved session takes to resume on
// boot — even though no QR was needed. Returns { status, body }.
function notReadyResponse(tenantId) {
  const st = watiClient.getState(tenantId) || {};
  if (st.state === "INITIALIZING" || st.state === "AUTHENTICATED") {
    return { status: 409, body: { error: "WhatsApp is reconnecting after a restart — please wait a few seconds and try again.", code: "WA_RECONNECTING" } };
  }
  if (st.state === "QR" || st.qr) {
    return { status: 409, body: { error: "Scan the WhatsApp QR to connect.", code: "WA_NEEDS_QR" } };
  }
  return { status: 409, body: { error: "WhatsApp is not connected — open the WhatsApp panel and scan the QR.", code: "WA_NOT_CONNECTED" } };
}

router.post(
  "/whatsapp/import",
  verifyToken,
  requireTravelTenant,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      if (!watiClient.isEnabled(req.travelTenant.id)) {
        const nr = notReadyResponse(req.travelTenant.id);
        return res.status(nr.status).json(nr.body);
      }
      const result = await watiClient.importAllChats(req.travelTenant.id);
      res.json(result);
    } catch (e) {
      console.error("[travel-whatsapp] import error:", e.message);
      res.status(500).json({ error: "Failed to import chats", code: "WA_IMPORT_FAILED" });
    }
  },
);

// POST /whatsapp/threads/:id/backfill-history — pull this ONE chat's complete
// history from WhatsApp Web. Not ADMIN-gated: any operator opening a chat with
// more history than the CRM has stored can trigger it (read-only pull against
// the linked account, same trust level as viewing the thread). See
// whatsappWebClient.backfillThreadHistory for why this is per-thread rather
// than part of the bulk import sweep.
router.post(
  "/whatsapp/threads/:id/backfill-history",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
      const thread = await prisma.whatsAppThread.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        select: { id: true },
      });
      if (!thread) return res.status(404).json({ error: "Thread not found" });
      if (!watiClient.isEnabled(req.travelTenant.id)) {
        const nr = notReadyResponse(req.travelTenant.id);
        return res.status(nr.status).json(nr.body);
      }
      const result = await watiClient.backfillThreadHistory(req.travelTenant.id, id);
      res.json(result);
    } catch (e) {
      console.error("[travel-whatsapp] backfill-history error:", e.message);
      res.status(500).json({ error: "Failed to backfill history", code: "WA_BACKFILL_FAILED" });
    }
  },
);

// POST /whatsapp/disconnect — tear down the session. body { logout:true }
// also clears the saved link so the next connect needs a fresh scan.
router.post(
  "/whatsapp/disconnect",
  verifyToken,
  requireTravelTenant,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const logout = (req.body && (req.body.logout === true || req.body.logout === "true")) || false;
      const st = await watiClient.disconnect(req.travelTenant.id, { logout });
      // Release this user's control claim + stamp logoutAt (starts the tenant
      // relink cooldown). Best-effort — never blocks the disconnect response.
      await waGuard.release(req.travelTenant.id, req.user.userId, req.body && req.body.deviceId, { logout });
      // The linked account is a live mirror — disconnecting clears the imported
      // chats so a fresh connect re-fetches from scratch (no stale threads).
      const purged = await watiClient.purgeChats(req.travelTenant.id);
      res.json({ ...st, purged });
    } catch (e) {
      console.error("[travel-whatsapp] disconnect error:", e.message);
      res.status(500).json({ error: "Failed to disconnect WhatsApp Web session", code: "WA_DISCONNECT_FAILED" });
    }
  },
);

// ───────────────────────────────────────────────────────────────────
// Own WhatsApp profile (the linked account) — view + edit (ADMIN).
//   GET    /whatsapp/me            → { connected, phone, name, about, avatar }
//   PUT    /whatsapp/me            → update display name / about
//   POST   /whatsapp/me/avatar     → change own profile picture (multipart)
//   DELETE /whatsapp/me/avatar     → remove own profile picture
// ───────────────────────────────────────────────────────────────────
router.get(
  "/whatsapp/me",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const me = await watiClient.getOwnProfile(req.travelTenant.id);
      res.json(me);
    } catch (e) {
      console.error("[travel-whatsapp] me error:", e.message);
      res.status(500).json({ error: "Failed to load WhatsApp profile", code: "WA_ME_FAILED" });
    }
  },
);

router.put(
  "/whatsapp/me",
  verifyToken,
  requireTravelTenant,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : undefined;
      const about = typeof req.body?.about === "string" ? req.body.about : undefined;
      const out = await watiClient.setOwnProfile(req.travelTenant.id, { name, about });
      res.json(out);
    } catch (e) {
      console.error("[travel-whatsapp] me update error:", e.message);
      res.status(e.message === "WhatsApp not connected" ? 409 : 500)
        .json({ error: e.message || "Failed to update WhatsApp profile", code: "WA_ME_UPDATE_FAILED" });
    }
  },
);

router.post(
  "/whatsapp/me/avatar",
  verifyToken,
  requireTravelTenant,
  verifyRole(["ADMIN"]),
  mediaUpload.single("file"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ error: "image file is required", code: "MISSING_FILE" });
      }
      const out = await watiClient.setOwnProfilePicture(req.travelTenant.id, req.file.buffer, req.file.mimetype);
      res.json(out);
    } catch (e) {
      console.error("[travel-whatsapp] me avatar error:", e.message);
      res.status(e.message === "WhatsApp not connected" ? 409 : 500)
        .json({ error: e.message || "Failed to set profile picture", code: "WA_ME_AVATAR_FAILED" });
    }
  },
);

router.delete(
  "/whatsapp/me/avatar",
  verifyToken,
  requireTravelTenant,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const out = await watiClient.deleteOwnProfilePicture(req.travelTenant.id);
      res.json(out);
    } catch (e) {
      console.error("[travel-whatsapp] me avatar delete error:", e.message);
      res.status(e.message === "WhatsApp not connected" ? 409 : 500)
        .json({ error: e.message || "Failed to remove profile picture", code: "WA_ME_AVATAR_DEL_FAILED" });
    }
  },
);

// Template cache for the send path — the Wati template list changes
// rarely, so a 60s in-memory cache keeps per-send latency flat. Stores
// the ordered customParams names AND the template body so the chat can
// persist the FULL rendered message (placeholders substituted) instead
// of a "[template] name" stub.
let _tplCache = { at: 0, byName: new Map() };
async function resolveTemplate(templateName) {
  try {
    if (Date.now() - _tplCache.at > 60_000) {
      const out = await watiClient.getMessageTemplates();
      const byName = new Map();
      for (const t of out.templates || []) {
        const name = t.elementName || t.name;
        if (!name) continue;
        byName.set(name, {
          params: Array.isArray(t.customParams)
            ? t.customParams.map((p) => p.paramName).filter(Boolean)
            : [],
          body: t.bodyOriginal || t.body || "",
        });
      }
      _tplCache = { at: Date.now(), byName };
    }
    return _tplCache.byName.get(templateName) || null;
  } catch (e) {
    console.error(`[travel-whatsapp] template resolve failed (positional fallback): ${e.message}`);
    return null;
  }
}

// Substitute a template body's placeholders with the supplied values.
// Handles BOTH spellings Wati exposes: named ({{name}}, {{otp}} — the
// bodyOriginal form) and positional ({{1}}, {{2}} — the rendered form).
function renderTemplateBody(body, paramNames, values) {
  if (!body) return null;
  let out = body;
  values.forEach((v, i) => {
    const value = String(v);
    if (paramNames[i]) {
      out = out.split(`{{${paramNames[i]}}}`).join(value);
    }
    out = out.split(`{{${i + 1}}}`).join(value);
  });
  return out;
}

// Defensive media extraction from a Wati message item / webhook payload.
// Media items carry the file reference in `data` (a storage path like
// "data/images/….jpeg"); type ∈ image|video|audio|document|sticker.
// Returns null for plain text.
const MEDIA_MIME = {
  image: "image/jpeg",
  sticker: "image/webp",
  video: "video/mp4",
  audio: "audio/ogg",
  voice: "audio/ogg",
  document: "application/octet-stream",
};
function extractMedia(m) {
  const type = String(m.type || "").toLowerCase();
  if (!type || type === "text" || type === "reaction") return null;
  const pathCandidate = [m.data, m.mediaPath, m.filePath, m.fileName, m.finalFileName]
    .find((v) => typeof v === "string" && v.length > 3 && /[/.]/.test(v));
  if (!pathCandidate && !MEDIA_MIME[type]) return null;
  return {
    metaType: type,
    mediaType: MEDIA_MIME[type] || "application/octet-stream",
    fileName: pathCandidate || null,
  };
}

// S3 persistence for inbound Wati media — mirrors the wellness pipeline
// (cron/whatsappMediaEngine.js: download provider bytes → s3Service.uploadFile
// → permanent S3 URL on WhatsAppMessage.mediaUrl), executed inline at
// ingest time since Wati media is fetched with a simple Bearer GET (no
// Meta two-step URL dance, so no job queue needed). Falls back to the
// streaming proxy URL when S3 isn't configured (local dev) or the
// download/upload fails — the bubble still renders either way.
let s3Service = null;
try {
  s3Service = require("../services/s3Service");
} catch {
  console.warn("[travel-whatsapp] s3Service unavailable — Wati media will serve via the streaming proxy");
}

async function resolveInboundMediaUrl({ tenantId, fileName, mediaType }) {
  if (!fileName) return null;
  const proxyUrl = `/api/travel/whatsapp/media?fileName=${encodeURIComponent(fileName)}`;
  if (!s3Service || !process.env.AWS_S3_BUCKET_NAME) return proxyUrl;
  try {
    const upstream = await watiClient.getMediaResponse(fileName);
    if (!upstream) return proxyUrl;
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const mime = upstream.headers.get("content-type") || mediaType || "application/octet-stream";
    const baseName = fileName.split("/").pop() || "wati-media";
    return await s3Service.uploadFile(bytes, baseName, mime, `whatsapp/${tenantId}/wati-media`);
  } catch (e) {
    console.error(`[travel-whatsapp] media S3 persist failed (proxy fallback): ${e.message}`);
    return proxyUrl;
  }
}

// ───────────────────────────────────────────────────────────────────
// GET /whatsapp/templates — the Wati account's message templates,
// mapped to the chat picker's shape ({ name, body, status, language }).
// Templates are AUTHORED/approved in the Wati dashboard (which fronts
// Meta's approval flow) — the CRM surface is read-only.
// ───────────────────────────────────────────────────────────────────
router.get(
  "/whatsapp/templates",
  verifyToken,
  requireTravelTenant,
  async (_req, res) => {
    try {
      const out = await watiClient.getMessageTemplates();
      const templates = (out.templates || []).map((t) => ({
        // Wati names the template `elementName`; older payloads use `name`.
        name: t.elementName || t.name || "",
        body: t.body || t.bodyOriginal || "",
        status: String(t.status || "").toUpperCase(),
        language: (t.language && (t.language.value || t.language)) || "en",
        category: t.category || null,
      })).filter((t) => t.name);
      res.json({ templates, stub: out.stub === true });
    } catch (e) {
      console.error("[travel-whatsapp] templates error:", e.message);
      res.status(502).json({ error: "Failed to load Wati templates", code: "WATI_TEMPLATES_FAILED" });
    }
  },
);

// ───────────────────────────────────────────────────────────────────
// POST /whatsapp/send — operator chat send via Wati.
// ───────────────────────────────────────────────────────────────────
router.post(
  "/whatsapp/send",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const { to, body, templateName, parameters } = req.body || {};
      const phone = threadPhone(to);
      if (!phone) {
        return res.status(400).json({ error: "to (phone) is required", code: "MISSING_TO" });
      }
      const text = typeof body === "string" ? body.trim() : "";
      if (!templateName && !text) {
        return res.status(400).json({ error: "body or templateName required", code: "MISSING_BODY" });
      }

      // Opt-out gate — same semantics (and code) as the Meta-track send so
      // the chat UI's CONTACT_OPTED_OUT handling fires unchanged.
      const optOut = await prisma.whatsAppOptOut.findFirst({
        where: { tenantId: req.travelTenant.id, contactPhone: phone },
        select: { id: true },
      });
      if (optOut) {
        return res.status(422).json({
          error: "Contact has opted out of WhatsApp messages (CONTACT_OPTED_OUT)",
          code: "CONTACT_OPTED_OUT",
        });
      }

      const contact = await matchContact(req.travelTenant.id, phone);

      // Thread upsert FIRST so the send persists with threadId in one row.
      const thread = await prisma.whatsAppThread.upsert({
        where: {
          tenantId_contactPhone: {
            tenantId: req.travelTenant.id,
            contactPhone: phone,
          },
        },
        create: {
          tenantId: req.travelTenant.id,
          contactPhone: phone,
          status: "OPEN",
          lastMessageAt: new Date(),
          contactId: contact ? contact.id : null,
        },
        update: { lastMessageAt: new Date(), status: "OPEN" },
      });

      const common = {
        tenantId: req.travelTenant.id,
        toPhone: phone,
        contactId: contact ? contact.id : null,
        threadId: thread.id,
        userId: req.user.userId,
        persistTo: phone,
      };

      let result;
      if (templateName) {
        // The composer sends positional params (string[]). Wati templates
        // use NAMED placeholders ({{name}}, {{otp}} …) under the hood —
        // the rendered body shows {{1}}-style but sends must address the
        // customParams names (live-verified: positional names get rejected
        // with "check your template"). Zip the positional values onto the
        // template's param names; fall back to 1-based positions when the
        // template (or its param spec) isn't resolvable.
        const values = Array.isArray(parameters) ? parameters : [];
        const tpl = await resolveTemplate(String(templateName));
        const paramNames = tpl ? tpl.params : [];
        const params = values.map((v, i) => ({
          name: paramNames[i] || String(i + 1),
          value: String(v),
        }));
        // Persist the FULL rendered message (variables substituted) so the
        // chat bubble shows what the recipient actually received — not a
        // "[template] name" stub.
        const rendered = tpl ? renderTemplateBody(tpl.body, paramNames, values) : null;
        result = await watiClient.sendTemplateMessage({
          ...common,
          templateName: String(templateName),
          parameters: params,
          broadcastName: "travel-chat-template",
          bodyPreview: rendered || text || `[template] ${templateName}`,
        });
      } else {
        result = await watiClient.sendSessionMessage({ ...common, text });
      }

      if (result.status === "FAILED") {
        return res.status(502).json({
          error: result.error || "Wati send failed",
          code: "WATI_SEND_FAILED",
        });
      }

      return res.status(201).json({
        success: true,
        status: result.status, // QUEUED (stub) | SENT
        stub: result.stub === true,
        thread,
        messageRowId: result.messageRowId || null,
      });
    } catch (e) {
      console.error("[travel-whatsapp] send error:", e.message);
      return res.status(500).json({ error: "Failed to send WhatsApp message", code: "SEND_FAILED" });
    }
  },
);

// Persist an OUTBOUND media file so the chat bubble can render it:
// S3 when configured (wellness parity), else the local /uploads static
// mount (dev fallback — server.js already serves backend/uploads/).
async function persistOutboundMedia({ tenantId, buffer, filename, mimeType }) {
  const safeName = `${crypto.randomUUID()}-${String(filename || "file").replace(/[^\w.-]/g, "_")}`;
  if (s3Service && process.env.AWS_S3_BUCKET_NAME) {
    try {
      return await s3Service.uploadFile(buffer, safeName, mimeType, `whatsapp/${tenantId}/wati-media`);
    } catch (e) {
      console.error(`[travel-whatsapp] outbound media S3 persist failed (local fallback): ${e.message}`);
    }
  }
  try {
    const dir = path.join(__dirname, "..", "uploads", "wati-media");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeName), buffer);
    return `/uploads/wati-media/${safeName}`;
  } catch (e) {
    console.error(`[travel-whatsapp] outbound media local persist failed: ${e.message}`);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// POST /whatsapp/send-media — operator sends a file from the chat
// composer (paperclip). Multipart: file + to + caption?. Same opt-out +
// thread semantics as /whatsapp/send; transport = Wati sendSessionFile
// (session window — the recipient must have messaged within 24h, which
// is inherently true for chat replies).
// ───────────────────────────────────────────────────────────────────
router.post(
  "/whatsapp/send-media",
  verifyToken,
  requireTravelTenant,
  mediaUpload.single("file"),
  async (req, res) => {
    try {
      const phone = threadPhone(req.body && req.body.to);
      if (!phone) {
        return res.status(400).json({ error: "to (phone) is required", code: "MISSING_TO" });
      }
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ error: "file is required", code: "MISSING_FILE" });
      }
      const caption = typeof req.body.caption === "string" ? req.body.caption.trim() : "";

      const optOut = await prisma.whatsAppOptOut.findFirst({
        where: { tenantId: req.travelTenant.id, contactPhone: phone },
        select: { id: true },
      });
      if (optOut) {
        return res.status(422).json({
          error: "Contact has opted out of WhatsApp messages (CONTACT_OPTED_OUT)",
          code: "CONTACT_OPTED_OUT",
        });
      }

      const contact = await matchContact(req.travelTenant.id, phone);
      const thread = await prisma.whatsAppThread.upsert({
        where: { tenantId_contactPhone: { tenantId: req.travelTenant.id, contactPhone: phone } },
        create: {
          tenantId: req.travelTenant.id,
          contactPhone: phone,
          status: "OPEN",
          lastMessageAt: new Date(),
          contactId: contact ? contact.id : null,
        },
        update: { lastMessageAt: new Date(), status: "OPEN" },
      });

      const mediaUrl = await persistOutboundMedia({
        tenantId: req.travelTenant.id,
        buffer: req.file.buffer,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
      });

      const result = await watiClient.sendSessionFile({
        tenantId: req.travelTenant.id,
        toPhone: phone,
        buffer: req.file.buffer,
        filename: req.file.originalname || "file",
        mimeType: req.file.mimetype || "application/octet-stream",
        caption: caption || undefined,
        contactId: contact ? contact.id : null,
        threadId: thread.id,
        userId: req.user.userId,
        persistTo: phone,
        mediaUrl,
      });

      if (result.status === "FAILED") {
        // Live-probed 2026-06-11: Wati answers 200 {result:false, info:
        // "Failed to send file"} for EVERY media upload on this account —
        // valid JPEG, with/without caption/channel — while text sends on
        // the same open session succeed. That's a plan/trial restriction
        // on API media sends, not a payload issue; say so instead of
        // surfacing the cryptic raw line.
        const friendly = /failed to send file/i.test(result.error || "")
          ? "Wati refused the file upload — this Wati plan/trial doesn't allow media sends via the API (text messages still work). Try sending media from the Wati dashboard, or upgrade the Wati plan."
          : (result.error || "Wati media send failed");
        return res.status(502).json({ error: friendly, code: "WATI_SEND_FAILED" });
      }
      return res.status(201).json({
        success: true,
        status: result.status,
        stub: result.stub === true,
        thread,
        messageRowId: result.messageRowId || null,
        mediaUrl,
      });
    } catch (e) {
      console.error("[travel-whatsapp] send-media error:", e.message);
      return res.status(500).json({ error: "Failed to send media", code: "SEND_MEDIA_FAILED" });
    }
  },
);

// ───────────────────────────────────────────────────────────────────
// POST /whatsapp/sync — PULL-based inbound sync (webhook fallback).
//
// The webhook below is the real-time path, but it requires Wati's cloud
// to reach this backend — impossible on localhost dev without a tunnel.
// This endpoint pulls the recent Wati conversations instead:
//   getContacts (most recently active) → getMessages per contact →
//   reconcile OUTBOUND rows' delivery state (statusString/failedDetail →
//   status/errorMessage, "whatsapp:status" emit per change) →
//   upsert threads + insert NEW inbound rows (deduped by providerMsgId)
//   → emit "whatsapp:received" per new inbound so the chat updates.
//
// The travel chat fires this fire-and-forget on every list poll; a
// per-tenant in-memory debounce keeps the Wati API call volume far below
// the page's 10s poll cadence.
//
// WATI_SYNC_DEBOUNCE_MS tunes the pull cadence to the Wati plan's API
// budget: 25s default suits Pro+ (200k calls/mo); on the Growth plan
// (10k calls/mo, no webhooks) set ~300000 (5 min) so a month of normal
// chat usage stays inside the cap. Once the webhook is registered on a
// public deployment, real-time delivery comes from the webhook and this
// sync is just the safety net — a high debounce costs nothing then.
// ───────────────────────────────────────────────────────────────────
const _lastSyncAt = new Map(); // tenantId → epoch ms (legacy Wati pull state)
// LEGACY Wati pull-sync config (used only by the disabled pull body below):
// const SYNC_DEBOUNCE_MS = (() => {
//   const v = parseInt(process.env.WATI_SYNC_DEBOUNCE_MS, 10);
//   return Number.isFinite(v) && v >= 5_000 ? v : 25_000;
// })();
// const SYNC_CONTACTS = 15;
// Wati statusString → our enum, rank-ordered so reconciliation only ever
// ADVANCES a row (an older poll item saying DELIVERED must not downgrade a
// READ row). FAILED and DELIVERED share a rank because neither can follow
// the other: a failed message never delivered, a delivered one can't
// retroactively fail.
// const OUTBOUND_STATUS_RANK = { QUEUED: 0, SENT: 1, FAILED: 2, DELIVERED: 2, READ: 3 };

router.post(
  "/whatsapp/sync",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      // WhatsApp Web delivers inbound in REAL TIME via the puppeteer session's
      // `message` event (no webhook/tunnel needed), so the old Wati pull-sync
      // is redundant. When connected we report "realtime"; when not yet
      // scanned we report "not-connected". The chat fires this fire-and-forget
      // on every poll — both answers are harmless no-ops.
      if (!watiClient.isEnabled(req.travelTenant.id)) {
        return res.json({ synced: false, reason: "not-connected" });
      }
      return res.json({ synced: false, reason: "realtime" });

      /* ── LEGACY Wati pull-sync (DISABLED, kept for reference) ────────────
         The block below is the old Wati REST pull (getContacts → getMessages
         → reconcile + ingest). WhatsApp Web replaces it with the real-time
         `message` event in services/whatsappWebClient.js, so this is no longer
         reached. Preserved verbatim (nothing removed) per the transport swap.
      const tenantId = req.travelTenant.id;
      const now = Date.now();
      const last = _lastSyncAt.get(tenantId) || 0;
      if (now - last < SYNC_DEBOUNCE_MS && !req.query.force) {
        return res.json({ synced: false, reason: "debounced" });
      }
      _lastSyncAt.set(tenantId, now);

      const { contacts } = await watiClient.getContacts({ pageSize: SYNC_CONTACTS });
      let newMessages = 0;
      let threadsTouched = 0;
      let statusUpdates = 0;

      for (const c of contacts) {
        const rawPhone = c.wAid || c.waId || c.phone || c.whatsappNumber;
        const phone = threadPhone(rawPhone);
        if (!phone) continue;

        let items = [];
        try {
          ({ items } = await watiClient.getMessages({ whatsappNumber: rawPhone, pageSize: 30 }));
        } catch (e) {
          // "Can't find Conversation" is Wati's normal answer for a contact
          // that has never replied — expected on every poll until they do.
          // Only surface unexpected failures.
          if (!/can't find conversation/i.test(e.message)) {
            console.error(`[travel-whatsapp] sync getMessages(${phone}) failed: ${e.message}`);
          }
          continue;
        }

        // ── Outbound delivery-state reconciliation ──────────────────
        // The send path stamps SENT the moment Wati's HTTP API accepts the
        // call, but Meta can still reject asynchronously (live-confirmed
        // 2026-06-12: "(#131037) display name approval" failed every send
        // while the UI showed a grey SENT tick). Without a public webhook
        // that verdict only surfaces here: Wati's getMessages items carry
        // the real state (statusString SENT|DELIVERED|READ|FAILED +
        // failedDetail with Meta's error). Items match our rows by id →
        // providerMsgId; rank-guarded so a stale poll never downgrades.
        for (const m of items) {
          if (!m || m.owner !== true || !m.id || !m.statusString) continue;
          const next = String(m.statusString).toUpperCase();
          if (!(next in OUTBOUND_STATUS_RANK)) continue;
          const row = await prisma.whatsAppMessage.findFirst({
            where: { tenantId, providerMsgId: String(m.id), direction: "OUTBOUND" },
            select: { id: true, status: true, threadId: true },
          });
          if (!row) continue;
          const currentRank = OUTBOUND_STATUS_RANK[row.status] !== undefined
            ? OUTBOUND_STATUS_RANK[row.status]
            : 0;
          if (OUTBOUND_STATUS_RANK[next] <= currentRank) continue;
          const failDetail = next === "FAILED" && m.failedDetail ? String(m.failedDetail) : null;
          await prisma.whatsAppMessage.update({
            where: { id: row.id },
            data: { status: next, ...(failDetail ? { errorMessage: failDetail } : {}) },
          });
          statusUpdates += 1;
          if (req.io) {
            req.io.to(`tenant:${tenantId}`).emit("whatsapp:status", {
              tenantId,
              threadId: row.threadId,
              providerMsgId: String(m.id),
              status: next,
              errorMessage: failDetail,
            });
          }
        }

        // Oldest-first so lastMessageAt/unread ordering lands naturally.
        // Includes media items (image/video/audio/document/sticker — they
        // often carry no text) and reactions (handled separately below).
        const inbound = items
          .filter((m) => m && m.owner !== true
            && (m.eventType === "message" || m.text || extractMedia(m)
              || String(m.type || "").toLowerCase() === "reaction"))
          .reverse();
        if (inbound.length === 0) continue;

        const contact = await matchContact(tenantId, phone);
        let thread = null;

        for (const m of inbound) {
          // ── Reactions: attach to the target message, no own bubble ──
          if (String(m.type || "").toLowerCase() === "reaction"
            || String(m.eventType || "").toLowerCase() === "reaction") {
            await applyReaction({ tenantId, phone, item: m, io: req.io });
            continue;
          }

          const providerMsgId = m.id ? String(m.id) : null;
          if (providerMsgId) {
            const dupe = await prisma.whatsAppMessage.findFirst({
              where: { tenantId, providerMsgId },
              select: { id: true },
            });
            if (dupe) continue;
          }

          if (!thread) {
            const existing = await prisma.whatsAppThread.findUnique({
              where: { tenantId_contactPhone: { tenantId, contactPhone: phone } },
            });
            if (existing) {
              thread = existing;
            } else {
              thread = await prisma.whatsAppThread.create({
                data: {
                  tenantId,
                  contactPhone: phone,
                  status: "OPEN",
                  lastMessageAt: new Date(),
                  lastInboundAt: new Date(),
                  unreadCount: 0,
                  contactId: contact ? contact.id : null,
                },
              });
            }
            threadsTouched += 1;
          }

          const created = m.created ? new Date(m.created) : new Date();
          const createdAt = Number.isNaN(created.getTime()) ? new Date() : created;
          const media = extractMedia(m);
          const mediaUrl = media
            ? await resolveInboundMediaUrl({ tenantId, fileName: media.fileName, mediaType: media.mediaType })
            : null;
          const message = await prisma.whatsAppMessage.create({
            data: {
              to: watiClient.getConfig().channelNumber || "travel-wati",
              from: phone,
              body: typeof m.text === "string" && m.text !== "" ? m.text : null,
              mediaUrl,
              mediaType: media ? media.mediaType : null,
              direction: "INBOUND",
              status: "DELIVERED",
              providerMsgId,
              metaType: media ? media.metaType : (m.type ? String(m.type) : "text"),
              tenantId,
              threadId: thread.id,
              contactId: contact ? contact.id : null,
              createdAt,
            },
          });
          newMessages += 1;

          const updates = {
            lastMessageAt: createdAt,
            lastInboundAt: createdAt,
            status: "OPEN",
            snoozedUntil: null,
          };
          if (!thread.assignedToId) updates.unreadCount = (thread.unreadCount || 0) + 1;
          if (!thread.contactId && contact) updates.contactId = contact.id;
          thread = await prisma.whatsAppThread.update({ where: { id: thread.id }, data: updates });

          if (req.io) {
            req.io.to(`tenant:${tenantId}`).emit("whatsapp:received", {
              tenantId,
              threadId: thread.id,
              messageId: message.id,
              contactPhone: phone,
              from: phone,
              body: m.text || "(media)",
            });
          }
        }
      }

      res.json({ synced: true, contactsChecked: contacts.length, newMessages, threadsTouched, statusUpdates });
      ── end legacy Wati pull-sync ──────────────────────────────────────── */
    } catch (e) {
      console.error("[travel-whatsapp] sync error:", e.message);
      res.json({ synced: false, error: e.message });
    }
  },
);

// ───────────────────────────────────────────────────────────────────
// Wati inbound webhook — OPEN path (see server.js openPaths).
// ───────────────────────────────────────────────────────────────────

// Resolve the target tenant for a webhook hit. ?tenantId= wins when it
// names a travel tenant; otherwise the first active travel tenant.
async function resolveWebhookTenant(req) {
  const raw = parseInt(req.query.tenantId, 10);
  if (Number.isFinite(raw) && raw > 0) {
    const t = await prisma.tenant.findFirst({
      where: { id: raw, vertical: "travel" },
      select: { id: true },
    });
    if (t) return t.id;
  }
  const first = await prisma.tenant.findFirst({
    where: { vertical: "travel", isActive: true },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return first ? first.id : null;
}

router.get("/whatsapp/webhook", (_req, res) => {
  // Wati's dashboard pings the URL on save — a 200 echo is all it needs.
  res.json({ ok: true, transport: "wati", vertical: "travel" });
});

router.post("/whatsapp/webhook", async (req, res) => {
  // ALWAYS 200 (after auth) — webhook processing errors must not trigger
  // Wati-side retry storms; failures are logged for the ops console.
  try {
    const expected = (process.env.WATI_WEBHOOK_TOKEN || "").trim();
    if (expected) {
      if (String(req.query.token || "") !== expected) {
        return res.status(401).json({ error: "invalid webhook token" });
      }
    } else {
      console.warn("[travel-whatsapp] webhook accepted WITHOUT token guard — set WATI_WEBHOOK_TOKEN for production");
    }

    const tenantId = await resolveWebhookTenant(req);
    if (!tenantId) {
      console.error("[travel-whatsapp] webhook: no travel tenant resolvable — event dropped");
      return res.json({ received: true, dropped: true });
    }

    const p = req.body || {};
    const eventType = String(p.eventType || p.event || "").trim();

    // ── Delivery / read / failure receipts ───────────────────────
    // Wati event names vary across account versions (sentMessageDELIVERED,
    // sentMessageREAD, deliveredMessage, sentMessageFAILED…) — match
    // liberally on the verb. Failure wins the tie-break: Meta rejections
    // (e.g. "(#131037) display name approval") must flip the row to FAILED
    // with the reason, or the operator sees a grey SENT tick forever.
    if (/delivered/i.test(eventType) || /read/i.test(eventType) || /fail/i.test(eventType)) {
      const providerMsgId = p.whatsappMessageId || p.id || null;
      const newStatus = /fail/i.test(eventType)
        ? "FAILED"
        : /read/i.test(eventType) ? "READ" : "DELIVERED";
      if (providerMsgId) {
        const failDetail = newStatus === "FAILED"
          ? String(p.failedDetail || p.failureReason || p.errorMessage || "send failed at provider")
          : null;
        const updated = await prisma.whatsAppMessage.updateMany({
          where: { tenantId, providerMsgId: String(providerMsgId) },
          data: { status: newStatus, ...(failDetail ? { errorMessage: failDetail } : {}) },
        });
        if (updated.count > 0 && req.io) {
          req.io.to(`tenant:${tenantId}`).emit("whatsapp:status", {
            tenantId,
            providerMsgId: String(providerMsgId),
            status: newStatus,
            errorMessage: failDetail,
          });
        }
      }
      return res.json({ received: true });
    }

    // ── Inbound reaction (no own bubble — attaches to the target) ──
    if (String(p.type || "").toLowerCase() === "reaction" && p.owner !== true && (p.waId || p.from)) {
      const reactPhone = threadPhone(p.waId || p.from);
      if (reactPhone) {
        await applyReaction({ tenantId, phone: reactPhone, item: p, io: req.io });
      }
      return res.json({ received: true, reaction: true });
    }

    // ── Inbound customer message ─────────────────────────────────
    // owner === true marks operator-sent echoes (sessionMessageSent /
    // templateMessageSent) — we already persisted those at send time.
    const isInbound = eventType === "message" && p.owner !== true && (p.waId || p.from);
    if (!isInbound) {
      return res.json({ received: true, ignored: eventType || "(no eventType)" });
    }

    const phone = threadPhone(p.waId || p.from);
    if (!phone) return res.json({ received: true, dropped: "unparseable waId" });
    const media = extractMedia(p);
    const webhookMediaUrl = media
      ? await resolveInboundMediaUrl({ tenantId, fileName: media.fileName, mediaType: media.mediaType })
      : null;
    const body = typeof p.text === "string" && p.text !== "" ? p.text : null;

    const contact = await matchContact(tenantId, phone);

    // Thread upsert — mirrors the Meta webhook's unread semantics: bump
    // unreadCount only while the thread is unassigned (an assigned agent
    // is presumed watching it).
    const existing = await prisma.whatsAppThread.findUnique({
      where: { tenantId_contactPhone: { tenantId, contactPhone: phone } },
    });
    let thread;
    if (existing) {
      const updates = {
        lastMessageAt: new Date(),
        lastInboundAt: new Date(),
        status: "OPEN",
        snoozedUntil: null,
      };
      if (!existing.assignedToId) updates.unreadCount = (existing.unreadCount || 0) + 1;
      if (!existing.contactId && contact) updates.contactId = contact.id;
      thread = await prisma.whatsAppThread.update({ where: { id: existing.id }, data: updates });
    } else {
      thread = await prisma.whatsAppThread.create({
        data: {
          tenantId,
          contactPhone: phone,
          status: "OPEN",
          lastMessageAt: new Date(),
          lastInboundAt: new Date(),
          unreadCount: 1,
          contactId: contact ? contact.id : null,
        },
      });
    }

    const message = await prisma.whatsAppMessage.create({
      data: {
        to: watiClient.getConfig().channelNumber || "travel-wati",
        from: phone,
        body,
        mediaUrl: webhookMediaUrl,
        mediaType: media ? media.mediaType : null,
        direction: "INBOUND",
        status: "DELIVERED",
        providerMsgId: p.whatsappMessageId || p.id || null,
        metaType: media ? media.metaType : (p.type ? String(p.type) : "text"),
        tenantId,
        threadId: thread.id,
        contactId: contact ? contact.id : null,
      },
    });

    // Same event name + envelope the wellness chat (and our travel clone)
    // subscribe to — bubbles + toast + desktop notification fire live.
    if (req.io) {
      req.io.to(`tenant:${tenantId}`).emit("whatsapp:received", {
        tenantId,
        threadId: thread.id,
        messageId: message.id,
        contactPhone: phone,
        from: phone,
        body: body || "(media)",
      });
    }

    return res.json({ received: true, threadId: thread.id, messageId: message.id });
  } catch (e) {
    console.error("[travel-whatsapp] webhook error:", e.message);
    return res.json({ received: true, error: true });
  }
});

module.exports = router;
