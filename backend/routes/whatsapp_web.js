/**
 * /api/whatsapp-web — VERTICAL-AGNOSTIC WhatsApp Web (QR-scan) transport.
 *
 * This is the same QR-scan / send / receive engine the travel vertical uses
 * (services/whatsappWebClient.js), exposed for ANY tenant (wellness / generic /
 * travel) scoped to req.user.tenantId — so the wellness inbox can replace its
 * Meta Cloud API path with "scan the QR and chat", exactly like travel.
 *
 * It deliberately does NOT touch the Meta track (routes/whatsapp.js /send +
 * whatsapp_webhook.js + services/whatsappProvider.js) — those stay intact for
 * the generic vertical + their tests. The READ side (threads list/detail,
 * opt-outs, mark-read, assign, etc.) is the shared tenant-scoped
 * /api/whatsapp/* surface, unchanged; this router only adds the WhatsApp-Web
 * connection lifecycle + the WhatsApp-Web write/ingest legs.
 *
 * Endpoints (all verifyToken; mutations ADMIN-gated):
 *   GET  /status            — { connected, state, phone(masked), qr }
 *   POST /connect           — start/resume session (body { reset })
 *   GET  /qr                — poll the QR / state
 *   POST /disconnect        — tear down + purge imported chats (body { logout })
 *   POST /import            — re-pull existing chats into the inbox
 *   GET  /me                — own WhatsApp profile (number/name/about/DP)
 *   PUT  /me                — update own display name / about
 *   POST /me/avatar         — change own profile picture (multipart)
 *   DELETE /me/avatar       — remove own profile picture
 *   POST /send              — operator text / template send
 *   POST /send-media        — operator media send (multipart)
 *
 * Mirrors routes/travel_whatsapp.js but resolves the tenant from req.user
 * (no travel-vertical guard) so it works for the wellness inbox.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const waClient = require("../services/whatsappWebClient");
const { toE164 } = require("../utils/deduplication");

const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// Stable thread key: group/chat ids (with "@") + lid: keys verbatim; else E.164.
function threadPhone(raw) {
  const s = String(raw || "");
  if (s.includes("@") || s.startsWith("lid:")) return s;
  const e164 = toE164(s);
  if (e164) return e164;
  const digits = s.replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

function maskNumber(num) {
  const s = String(num || "");
  return s.length >= 7 ? `${s.slice(0, 4)}•••${s.slice(-3)}` : s || null;
}

async function matchContact(tenantId, phoneE164) {
  try {
    const digits = String(phoneE164).replace(/\D/g, "");
    return await prisma.contact.findFirst({
      where: { tenantId, OR: [{ phone: phoneE164 }, { phone: digits }, { phone: `+${digits}` }] },
      select: { id: true, name: true },
    });
  } catch {
    return null;
  }
}

let s3Service = null;
try { s3Service = require("../services/s3Service"); } catch { /* optional */ }

async function persistOutboundMedia({ tenantId, buffer, filename, mimeType }) {
  const safeName = `${crypto.randomUUID()}-${String(filename || "file").replace(/[^\w.-]/g, "_")}`;
  if (s3Service && process.env.AWS_S3_BUCKET_NAME) {
    try { return await s3Service.uploadFile(buffer, safeName, mimeType, `whatsapp/${tenantId}/wa-web`); }
    catch (e) { console.error(`[whatsapp-web] outbound media S3 failed (local fallback): ${e.message}`); }
  }
  try {
    const dir = path.join(__dirname, "..", "uploads", "wa-web");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeName), buffer);
    return `/uploads/wa-web/${safeName}`;
  } catch (e) {
    console.error(`[whatsapp-web] outbound media local persist failed: ${e.message}`);
    return null;
  }
}

// ─── Connection lifecycle ──────────────────────────────────────────
router.get("/status", verifyToken, async (req, res) => {
  const st = waClient.getState(req.user.tenantId);
  res.json({
    enabled: st.connected,
    state: st.state,
    connected: st.connected,
    phone: maskNumber(st.phone),
    qr: st.qr || null,
    lastError: st.lastError || null,
  });
});

router.post("/connect", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const reset = Boolean(req.body && (req.body.reset === true || req.body.reset === "true"));
    if (!waClient.getState(req.user.tenantId).connected) {
      await waClient.purgeChats(req.user.tenantId);
    }
    const st = await waClient.connect(req.user.tenantId, { reset });
    res.json({ ...st, phone: maskNumber(st.phone) });
  } catch (e) {
    console.error("[whatsapp-web] connect error:", e.message);
    res.status(500).json({ error: "Failed to start WhatsApp Web session", code: "WA_CONNECT_FAILED" });
  }
});

router.get("/qr", verifyToken, async (req, res) => {
  const st = waClient.getState(req.user.tenantId);
  res.json({ state: st.state, connected: st.connected, qr: st.qr || null, phone: maskNumber(st.phone), lastError: st.lastError || null });
});

router.post("/import", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    if (!waClient.isEnabled(req.user.tenantId)) {
      return res.status(409).json({ error: "WhatsApp is not connected — scan the QR first.", code: "WA_NOT_CONNECTED" });
    }
    res.json(await waClient.importAllChats(req.user.tenantId));
  } catch (e) {
    console.error("[whatsapp-web] import error:", e.message);
    res.status(500).json({ error: "Failed to import chats", code: "WA_IMPORT_FAILED" });
  }
});

router.post("/disconnect", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const logout = (req.body && (req.body.logout === true || req.body.logout === "true")) || false;
    const st = await waClient.disconnect(req.user.tenantId, { logout });
    const purged = await waClient.purgeChats(req.user.tenantId);
    res.json({ ...st, purged });
  } catch (e) {
    console.error("[whatsapp-web] disconnect error:", e.message);
    res.status(500).json({ error: "Failed to disconnect", code: "WA_DISCONNECT_FAILED" });
  }
});

// ─── Own profile ───────────────────────────────────────────────────
router.get("/me", verifyToken, async (req, res) => {
  try { res.json(await waClient.getOwnProfile(req.user.tenantId)); }
  catch { res.status(500).json({ error: "Failed to load profile", code: "WA_ME_FAILED" }); }
});

router.put("/me", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const about = typeof req.body?.about === "string" ? req.body.about : undefined;
    res.json(await waClient.setOwnProfile(req.user.tenantId, { name, about }));
  } catch (e) {
    res.status(e.message === "WhatsApp not connected" ? 409 : 500).json({ error: e.message, code: "WA_ME_UPDATE_FAILED" });
  }
});

router.post("/me/avatar", verifyToken, verifyRole(["ADMIN"]), mediaUpload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: "image file is required", code: "MISSING_FILE" });
    }
    res.json(await waClient.setOwnProfilePicture(req.user.tenantId, req.file.buffer, req.file.mimetype));
  } catch (e) {
    res.status(e.message === "WhatsApp not connected" ? 409 : 500).json({ error: e.message, code: "WA_ME_AVATAR_FAILED" });
  }
});

router.delete("/me/avatar", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try { res.json(await waClient.deleteOwnProfilePicture(req.user.tenantId)); }
  catch (e) { res.status(e.message === "WhatsApp not connected" ? 409 : 500).json({ error: e.message, code: "WA_ME_AVATAR_DEL_FAILED" }); }
});

// ─── Send ──────────────────────────────────────────────────────────
router.post("/send", verifyToken, async (req, res) => {
  try {
    const { to, body, templateName, parameters } = req.body || {};
    const phone = threadPhone(to);
    if (!phone) return res.status(400).json({ error: "to (phone) is required", code: "MISSING_TO" });
    const text = typeof body === "string" ? body.trim() : "";
    if (!templateName && !text) return res.status(400).json({ error: "body or templateName required", code: "MISSING_BODY" });

    const tenantId = req.user.tenantId;
    const optOut = await prisma.whatsAppOptOut.findFirst({ where: { tenantId, contactPhone: phone }, select: { id: true } });
    if (optOut) return res.status(422).json({ error: "Contact has opted out (CONTACT_OPTED_OUT)", code: "CONTACT_OPTED_OUT" });

    const contact = await matchContact(tenantId, phone);
    const thread = await prisma.whatsAppThread.upsert({
      where: { tenantId_contactPhone: { tenantId, contactPhone: phone } },
      create: { tenantId, contactPhone: phone, status: "OPEN", lastMessageAt: new Date(), contactId: contact ? contact.id : null },
      update: { lastMessageAt: new Date(), status: "OPEN" },
    });
    const common = { tenantId, toPhone: phone, contactId: contact ? contact.id : null, threadId: thread.id, userId: req.user.userId, persistTo: phone };

    let result;
    if (templateName) {
      const values = Array.isArray(parameters) ? parameters : [];
      result = await waClient.sendTemplateMessage({ ...common, templateName: String(templateName), parameters: values.map((v, i) => ({ name: String(i + 1), value: String(v) })), bodyPreview: text || `[template] ${templateName}` });
    } else {
      result = await waClient.sendSessionMessage({ ...common, text });
    }
    if (result.status === "FAILED") return res.status(502).json({ error: result.error || "send failed", code: "WA_SEND_FAILED" });
    return res.status(201).json({ success: true, status: result.status, stub: result.stub === true, thread, messageRowId: result.messageRowId || null });
  } catch (e) {
    console.error("[whatsapp-web] send error:", e.message);
    return res.status(500).json({ error: "Failed to send", code: "SEND_FAILED" });
  }
});

router.post("/send-media", verifyToken, mediaUpload.single("file"), async (req, res) => {
  try {
    const phone = threadPhone(req.body && req.body.to);
    if (!phone) return res.status(400).json({ error: "to (phone) is required", code: "MISSING_TO" });
    if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ error: "file is required", code: "MISSING_FILE" });
    const caption = typeof req.body.caption === "string" ? req.body.caption.trim() : "";
    const tenantId = req.user.tenantId;

    const optOut = await prisma.whatsAppOptOut.findFirst({ where: { tenantId, contactPhone: phone }, select: { id: true } });
    if (optOut) return res.status(422).json({ error: "Contact has opted out (CONTACT_OPTED_OUT)", code: "CONTACT_OPTED_OUT" });

    const contact = await matchContact(tenantId, phone);
    const thread = await prisma.whatsAppThread.upsert({
      where: { tenantId_contactPhone: { tenantId, contactPhone: phone } },
      create: { tenantId, contactPhone: phone, status: "OPEN", lastMessageAt: new Date(), contactId: contact ? contact.id : null },
      update: { lastMessageAt: new Date(), status: "OPEN" },
    });
    const mediaUrl = await persistOutboundMedia({ tenantId, buffer: req.file.buffer, filename: req.file.originalname, mimeType: req.file.mimetype });
    const result = await waClient.sendSessionFile({
      tenantId, toPhone: phone, buffer: req.file.buffer, filename: req.file.originalname || "file",
      mimeType: req.file.mimetype || "application/octet-stream", caption: caption || undefined,
      contactId: contact ? contact.id : null, threadId: thread.id, userId: req.user.userId, persistTo: phone, mediaUrl,
    });
    if (result.status === "FAILED") return res.status(502).json({ error: result.error || "media send failed", code: "WA_SEND_FAILED" });
    return res.status(201).json({ success: true, status: result.status, stub: result.stub === true, thread, messageRowId: result.messageRowId || null, mediaUrl });
  } catch (e) {
    console.error("[whatsapp-web] send-media error:", e.message);
    return res.status(500).json({ error: "Failed to send media", code: "SEND_MEDIA_FAILED" });
  }
});

module.exports = router;
