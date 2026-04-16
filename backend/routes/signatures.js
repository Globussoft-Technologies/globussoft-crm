const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const crypto = require("crypto");
const prisma = require("../lib/prisma");

const router = express.Router();

// ── Mailgun email helper ──────────────────────────────────────────
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "crm.globusdemos.com";
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;
const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";

async function sendMailgun(to, subject, body) {
  if (!MAILGUN_API_KEY) {
    console.log(`[Signatures] Mailgun not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }
  const formData = new URLSearchParams();
  formData.append("from", FROM_EMAIL);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", body);
  formData.append("html", body.replace(/\n/g, "<br>"));
  try {
    const response = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from("api:" + MAILGUN_API_KEY).toString("base64") },
      body: formData,
    });
    if (response.ok) {
      const data = await response.json();
      return { sent: true, id: data.id };
    }
    const errText = await response.text();
    console.error(`[Signatures] Mailgun error (${response.status}):`, errText);
    return { sent: false, reason: errText };
  } catch (err) {
    console.error("[Signatures] Mailgun send error:", err.message);
    return { sent: false, reason: err.message };
  }
}

function buildEmailBody({ signerName, documentType, signUrl, expiresAt }) {
  const expiryLine = expiresAt
    ? `\n\nThis link will expire on ${new Date(expiresAt).toLocaleString()}.`
    : "";
  return (
    `Hello ${signerName},\n\n` +
    `You have been requested to sign a ${documentType} via Globussoft CRM.\n\n` +
    `Please click the secure link below to review and sign the document:\n\n` +
    `${signUrl}${expiryLine}\n\n` +
    `If you did not expect this request, please ignore this email.\n\n` +
    `— Globussoft CRM`
  );
}

async function fetchLinkedDocument(documentType, documentId, tenantId) {
  const id = parseInt(documentId);
  if (isNaN(id)) return null;
  try {
    if (documentType === "Contract") {
      return await prisma.contract.findFirst({ where: { id, tenantId }, include: { contact: true } });
    }
    if (documentType === "Estimate") {
      return await prisma.estimate.findFirst({ where: { id, tenantId }, include: { contact: true } });
    }
    if (documentType === "Quote") {
      return await prisma.quote.findFirst({ where: { id, tenantId }, include: { deal: { include: { contact: true } } } });
    }
  } catch (_) { /* swallow */ }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// PUBLIC ROUTES (no auth — token-protected). Mounted before the
// authenticated handlers because the global auth guard whitelists
// "/signatures/sign" as an open path. /decline must be public too.
// ──────────────────────────────────────────────────────────────────

// GET /api/signatures/sign/:token — signer fetches document details
router.get("/sign/:token", async (req, res) => {
  try {
    const reqRow = await prisma.signatureRequest.findUnique({
      where: { signToken: req.params.token },
    });
    if (!reqRow) return res.status(404).json({ error: "Invalid or expired link" });

    if (reqRow.expiresAt && new Date(reqRow.expiresAt) < new Date()) {
      if (reqRow.status === "PENDING") {
        await prisma.signatureRequest.update({ where: { id: reqRow.id }, data: { status: "EXPIRED" } });
      }
      return res.status(410).json({ error: "This signature request has expired" });
    }

    res.json({
      documentType: reqRow.documentType,
      signerName: reqRow.signerName,
      status: reqRow.status,
      expiresAt: reqRow.expiresAt,
      signedAt: reqRow.signedAt,
    });
  } catch (err) {
    console.error("[Signatures] sign GET error:", err);
    res.status(500).json({ error: "Failed to load signature request" });
  }
});

// POST /api/signatures/sign/:token — signer submits the signature
router.post("/sign/:token", async (req, res) => {
  try {
    const { signature } = req.body || {};
    if (!signature || typeof signature !== "string" || !signature.startsWith("data:")) {
      return res.status(400).json({ error: "A valid signature data URL is required" });
    }

    const reqRow = await prisma.signatureRequest.findUnique({
      where: { signToken: req.params.token },
    });
    if (!reqRow) return res.status(404).json({ error: "Invalid signature link" });
    if (reqRow.status !== "PENDING") {
      return res.status(409).json({ error: `Request is already ${reqRow.status}` });
    }
    if (reqRow.expiresAt && new Date(reqRow.expiresAt) < new Date()) {
      await prisma.signatureRequest.update({ where: { id: reqRow.id }, data: { status: "EXPIRED" } });
      return res.status(410).json({ error: "This signature request has expired" });
    }

    const updated = await prisma.signatureRequest.update({
      where: { id: reqRow.id },
      data: { signature, signedAt: new Date(), status: "SIGNED" },
    });

    // Best-effort: log Activity on the linked document's contact
    try {
      const doc = await fetchLinkedDocument(updated.documentType, updated.documentId, updated.tenantId);
      const contactId = doc?.contact?.id || doc?.deal?.contact?.id;
      if (contactId) {
        await prisma.activity.create({
          data: {
            type: "Note",
            description: `${updated.documentType} #${updated.documentId} was electronically signed by ${updated.signerName} (${updated.signerEmail}).`,
            contactId,
            tenantId: updated.tenantId,
          },
        });
      }
    } catch (e) { /* non-critical */ }

    res.json({ success: true });
  } catch (err) {
    console.error("[Signatures] sign POST error:", err);
    res.status(500).json({ error: "Failed to record signature" });
  }
});

// POST /api/signatures/decline/:token — signer declines
router.post("/decline/:token", async (req, res) => {
  try {
    const reqRow = await prisma.signatureRequest.findUnique({
      where: { signToken: req.params.token },
    });
    if (!reqRow) return res.status(404).json({ error: "Invalid signature link" });
    if (reqRow.status !== "PENDING") {
      return res.status(409).json({ error: `Request is already ${reqRow.status}` });
    }
    await prisma.signatureRequest.update({
      where: { id: reqRow.id },
      data: { status: "DECLINED" },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[Signatures] decline error:", err);
    res.status(500).json({ error: "Failed to decline signature request" });
  }
});

// ──────────────────────────────────────────────────────────────────
// AUTHENTICATED ROUTES (tenant-scoped via req.user.tenantId)
// ──────────────────────────────────────────────────────────────────

// GET /api/signatures — list with optional filters
router.get("/", async (req, res) => {
  try {
    const { status, documentType } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;
    if (documentType) where.documentType = documentType;

    const requests = await prisma.signatureRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json(requests);
  } catch (err) {
    console.error("[Signatures] list error:", err);
    res.status(500).json({ error: "Failed to fetch signature requests" });
  }
});

// POST /api/signatures — create + email signing link
router.post("/", async (req, res) => {
  try {
    const { documentType, documentId, signerName, signerEmail } = req.body || {};
    let { expiresInDays } = req.body || {};

    if (!documentType || !documentId || !signerName || !signerEmail) {
      return res.status(400).json({ error: "documentType, documentId, signerName, signerEmail are required" });
    }
    if (!["Contract", "Estimate", "Quote", "Custom"].includes(documentType)) {
      return res.status(400).json({ error: "Invalid documentType" });
    }

    expiresInDays = parseInt(expiresInDays);
    if (!expiresInDays || isNaN(expiresInDays) || expiresInDays <= 0) expiresInDays = 7;

    const signToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const created = await prisma.signatureRequest.create({
      data: {
        documentType,
        documentId: parseInt(documentId),
        signerName,
        signerEmail,
        signToken,
        status: "PENDING",
        expiresAt,
        tenantId: req.user.tenantId,
      },
    });

    const signUrl = `${BASE_URL}/api/signatures/sign/${signToken}`;
    const subject = `Signature requested: ${documentType} #${documentId}`;
    const body = buildEmailBody({ signerName, documentType, signUrl, expiresAt });
    const mailResult = await sendMailgun(signerEmail, subject, body);

    res.status(201).json({ ...created, emailDelivered: mailResult.sent });
  } catch (err) {
    console.error("[Signatures] create error:", err);
    res.status(500).json({ error: "Failed to create signature request" });
  }
});

// GET /api/signatures/:id — single request (tenant scoped)
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const reqRow = await prisma.signatureRequest.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!reqRow) return res.status(404).json({ error: "Signature request not found" });
    res.json(reqRow);
  } catch (err) {
    console.error("[Signatures] detail error:", err);
    res.status(500).json({ error: "Failed to fetch signature request" });
  }
});

// DELETE /api/signatures/:id — cancel/delete request
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const reqRow = await prisma.signatureRequest.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!reqRow) return res.status(404).json({ error: "Signature request not found" });

    await prisma.signatureRequest.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[Signatures] delete error:", err);
    res.status(500).json({ error: "Failed to cancel signature request" });
  }
});

// POST /api/signatures/:id/resend — resend email
router.post("/:id/resend", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const reqRow = await prisma.signatureRequest.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!reqRow) return res.status(404).json({ error: "Signature request not found" });
    if (reqRow.status !== "PENDING") {
      return res.status(409).json({ error: `Cannot resend — request is ${reqRow.status}` });
    }

    const signUrl = `${BASE_URL}/api/signatures/sign/${reqRow.signToken}`;
    const subject = `Reminder: signature requested for ${reqRow.documentType} #${reqRow.documentId}`;
    const body = buildEmailBody({
      signerName: reqRow.signerName,
      documentType: reqRow.documentType,
      signUrl,
      expiresAt: reqRow.expiresAt,
    });
    const mailResult = await sendMailgun(reqRow.signerEmail, subject, body);
    res.json({ success: true, emailDelivered: mailResult.sent });
  } catch (err) {
    console.error("[Signatures] resend error:", err);
    res.status(500).json({ error: "Failed to resend signature request" });
  }
});

module.exports = router;
