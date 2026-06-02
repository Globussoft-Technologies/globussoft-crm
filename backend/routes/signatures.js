const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const prisma = require("../lib/prisma");
const { notify } = require("../lib/notificationService");
const { fulfillSignedEstimate } = require("../lib/signatureFulfillment");

const router = express.Router();

// ── SendGrid email helper (mirrors email.js + email_scheduling.js) ──
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";

// Resolve the public base URL the signing link should point back at, so the
// link lands on the SAME environment that sent it (demo → demo, staging →
// staging, localhost → localhost) instead of a hardcoded host. Priority:
//   1. Origin header (the frontend origin the admin's browser is on)
//   2. Referer origin
//   3. X-Forwarded-Host / Host (+ proto) — when called behind a proxy
//   4. PUBLIC_BASE_URL / BASE_URL env override
//   5. demo fallback (last resort only)
function resolveBaseUrl(req) {
  const origin = req.get("origin");
  if (origin) return origin.replace(/\/+$/, "");
  const referer = req.get("referer");
  if (referer) {
    try { return new URL(referer).origin; } catch (_e) { /* ignore malformed */ }
  }
  const host = req.get("x-forwarded-host") || req.get("host");
  if (host) {
    const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
    return `${proto}://${host}`;
  }
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    "https://crm.globusdemos.com"
  );
}

function fmtMoney(v, currency, locale) {
  const n = Number(v) || 0;
  try {
    return new Intl.NumberFormat(locale || undefined, { style: "currency", currency: currency || "USD" }).format(n);
  } catch (_e) {
    return `${currency || "USD"} ${n.toFixed(2)}`;
  }
}

// `content` is either a plain string or a { text, html } pair. A string is
// sent as-is with a naive <br> html fallback; the { text, html } shape lets
// callers ship a proper html body (e.g. a clickable signing link).
async function sendSignatureEmail(to, subject, content) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) {
    console.log(`[Signatures] SendGrid not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }
  const text = typeof content === "string" ? content : content.text;
  const html = typeof content === "string" ? content.replace(/\n/g, "<br>") : content.html;
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM_EMAIL },
    subject: subject,
    content: [
      { type: "text/plain", value: text },
      { type: "text/html", value: html },
    ],
  };
  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (response.ok) {
      const messageId = response.headers.get("x-message-id") || "sent";
      return { sent: true, id: messageId };
    }
    const errText = await response.text().catch(() => "");
    console.error(`[Signatures] SendGrid error (${response.status}):`, errText);
    return { sent: false, reason: `sendgrid ${response.status}: ${errText}` };
  } catch (err) {
    console.error("[Signatures] SendGrid send error:", err.message);
    return { sent: false, reason: err.message };
  }
}

const DEFAULT_COMPANY = "Globussoft CRM";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Resolve the tenant's display name so signature emails read with the
// clinic/company brand (e.g. "Enhanced Wellness") instead of the generic
// "Globussoft CRM". Best-effort: any lookup failure falls back to the
// generic name so emailing never breaks on a missing tenant row.
async function fetchCompanyName(tenantId) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return tenant?.name || DEFAULT_COMPANY;
  } catch (_err) {
    return DEFAULT_COMPANY;
  }
}

// Returns { text, html }. The html variant renders the signing URL as a
// real clickable anchor (the plain-text fallback keeps the bare URL).
function buildEmailBody({ signerName, documentType, signUrl, expiresAt, companyName }) {
  const company = companyName || DEFAULT_COMPANY;
  const expiryLine = expiresAt
    ? `\n\nThis link will expire on ${new Date(expiresAt).toLocaleString()}.`
    : "";
  const text =
    `Hello ${signerName},\n\n` +
    `You have been requested to sign a ${documentType} via ${company}.\n\n` +
    `Please click the secure link below to review and sign the document:\n\n` +
    `${signUrl}${expiryLine}\n\n` +
    `If you did not expect this request, please ignore this email.\n\n` +
    `— ${company}`;

  const expiryHtml = expiresAt
    ? `<p style="color:#6b7280;font-size:13px;margin:12px 0;">This link will expire on ${escapeHtml(new Date(expiresAt).toLocaleString())}.</p>`
    : "";
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;line-height:1.5;">` +
    `<p>Hello ${escapeHtml(signerName)},</p>` +
    `<p>You have been requested to sign a ${escapeHtml(documentType)} via <strong>${escapeHtml(company)}</strong>.</p>` +
    `<p>Please click the secure link below to review and sign the document:</p>` +
    `<p style="margin:16px 0;"><a href="${escapeHtml(signUrl)}" target="_blank" rel="noopener noreferrer" ` +
    `style="display:inline-block;padding:10px 18px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">` +
    `Review &amp; sign your ${escapeHtml(documentType)}</a></p>` +
    `<p style="font-size:12px;color:#6b7280;word-break:break-all;">Or paste this link into your browser:<br>` +
    `<a href="${escapeHtml(signUrl)}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;">${escapeHtml(signUrl)}</a></p>` +
    expiryHtml +
    `<p style="color:#6b7280;">If you did not expect this request, please ignore this email.</p>` +
    `<p>— ${escapeHtml(company)}</p>` +
    `</div>`;

  return { text, html };
}

// Payable-invoice email sent to the customer after they sign an Estimate that
// auto-converts to an invoice. Returns { text, html } with a clickable
// "Pay now" button pointing at the gateway-hosted payment link.
function buildPayableEmail({ signerName, invoiceNum, amountStr, payUrl, companyName }) {
  const company = companyName || DEFAULT_COMPANY;
  const text =
    `Hello ${signerName},\n\n` +
    `Thank you for signing. Your invoice ${invoiceNum} for ${amountStr} from ${company} is ready.\n\n` +
    `Pay securely using the link below:\n\n` +
    `${payUrl}\n\n` +
    `Once your payment is received the invoice will be marked paid automatically.\n\n` +
    `— ${company}`;

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;line-height:1.5;">` +
    `<p>Hello ${escapeHtml(signerName)},</p>` +
    `<p>Thank you for signing. Your invoice <strong>${escapeHtml(invoiceNum)}</strong> for ` +
    `<strong>${escapeHtml(amountStr)}</strong> from <strong>${escapeHtml(company)}</strong> is ready.</p>` +
    `<p style="margin:18px 0;"><a href="${escapeHtml(payUrl)}" target="_blank" rel="noopener noreferrer" ` +
    `style="display:inline-block;padding:12px 22px;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:700;">` +
    `Pay ${escapeHtml(amountStr)} now</a></p>` +
    `<p style="font-size:12px;color:#6b7280;word-break:break-all;">Or paste this link into your browser:<br>` +
    `<a href="${escapeHtml(payUrl)}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;">${escapeHtml(payUrl)}</a></p>` +
    `<p style="color:#6b7280;">Once your payment is received the invoice is marked paid automatically.</p>` +
    `<p>— ${escapeHtml(company)}</p>` +
    `</div>`;

  return { text, html };
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

    const tenant = await prisma.tenant.findUnique({
      where: { id: reqRow.tenantId },
      select: { name: true },
    });

    res.json({
      documentType: reqRow.documentType,
      documentId: reqRow.documentId,
      signerName: reqRow.signerName,
      companyName: tenant?.name || DEFAULT_COMPANY,
      status: reqRow.status,
      expiresAt: reqRow.expiresAt,
      signedAt: reqRow.signedAt,
    });
  } catch (err) {
    console.error("[Signatures] sign GET error:", err);
    res.status(500).json({ error: "Failed to load signature request" });
  }
});

// GET /api/signatures/sign/:token/pdf — PUBLIC preview of the linked document.
// Token-scoped (no auth); renders the document so the signer can review what
// they're signing. Streams `inline` so it embeds in the signing page's iframe.
router.get("/sign/:token/pdf", async (req, res) => {
  try {
    const reqRow = await prisma.signatureRequest.findUnique({
      where: { signToken: req.params.token },
    });
    if (!reqRow) return res.status(404).json({ error: "Invalid or expired link" });
    if (reqRow.expiresAt && new Date(reqRow.expiresAt) < new Date()) {
      return res.status(410).json({ error: "This signature request has expired" });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: reqRow.tenantId },
      select: { name: true, defaultCurrency: true, locale: true },
    });
    const companyName = tenant?.name || DEFAULT_COMPANY;
    const currency = tenant?.defaultCurrency || "USD";
    const locale = tenant?.locale || undefined;

    // Estimates carry line items + totals → richer preview. Other document
    // types fall back to the generic linked-document lookup for the contact.
    let estimate = null;
    if (reqRow.documentType === "Estimate") {
      estimate = await prisma.estimate.findFirst({
        where: { id: reqRow.documentId, tenantId: reqRow.tenantId },
        include: { contact: true, lineItems: true },
      });
    }
    const linked = estimate
      ? null
      : await fetchLinkedDocument(reqRow.documentType, reqRow.documentId, reqRow.tenantId);
    const contact = estimate?.contact || linked?.contact || linked?.deal?.contact || null;

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=${reqRow.documentType}-${reqRow.documentId}.pdf`,
    );
    doc.pipe(res);

    doc.fontSize(22).font("Helvetica-Bold").fillColor("#111111").text(companyName, 50, 50);
    doc.fontSize(11).font("Helvetica").fillColor("#666666")
      .text(`${reqRow.documentType} #${reqRow.documentId}`, 50, 80);

    doc.fillColor("#000000").fontSize(11).font("Helvetica-Bold").text("Prepared for", 50, 115);
    doc.font("Helvetica").fillColor("#333333")
      .text(`${reqRow.signerName} <${reqRow.signerEmail}>`, 50, 131);
    if (contact?.company) doc.text(contact.company, 50, 147);

    let y = 180;
    if (estimate) {
      doc.fontSize(13).font("Helvetica-Bold").fillColor("#000000")
        .text(estimate.title || "Estimate", 50, y);
      y += 22;
      doc.fontSize(10).font("Helvetica").fillColor("#333333");
      if (estimate.estimateNum) { doc.text(`Number: ${estimate.estimateNum}`, 50, y); y += 15; }
      doc.text(`Status: ${estimate.status || "Draft"}`, 50, y); y += 15;
      doc.text(`Issued: ${new Date(estimate.createdAt).toLocaleDateString(locale)}`, 50, y); y += 20;

      const items = Array.isArray(estimate.lineItems) ? estimate.lineItems : [];
      doc.fillColor("#ffffff").rect(50, y, 495, 26).fill("#3b82f6");
      doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
        .text("Description", 60, y + 8)
        .text("Qty", 340, y + 8)
        .text("Unit", 400, y + 8, { width: 60, align: "right" })
        .text("Total", 470, y + 8, { width: 70, align: "right" });
      y += 34;

      doc.fillColor("#333333").font("Helvetica").fontSize(10);
      for (const li of items) {
        const lineTotal = (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0);
        doc.text(li.description || "", 60, y, { width: 270 })
          .text(String(li.quantity || 0), 340, y)
          .text(fmtMoney(li.unitPrice, currency, locale), 400, y, { width: 60, align: "right" })
          .text(fmtMoney(lineTotal, currency, locale), 470, y, { width: 70, align: "right" });
        y += 22;
      }
      y += 8;
      doc.moveTo(50, y).lineTo(545, y).strokeColor("#cccccc").stroke();
      y += 10;
      doc.fontSize(12).font("Helvetica-Bold").fillColor("#000000")
        .text("Total:", 380, y, { width: 80, align: "right" })
        .text(fmtMoney(estimate.totalAmount, currency, locale), 470, y, { width: 70, align: "right" });
      if (estimate.notes) {
        y += 40;
        doc.fontSize(10).font("Helvetica").fillColor("#555555")
          .text("Notes:", 50, y).text(estimate.notes, 50, y + 16, { width: 495 });
      }
    } else {
      doc.fontSize(11).font("Helvetica").fillColor("#333333")
        .text(`Please review and sign this ${reqRow.documentType}.`, 50, y, { width: 495 });
      if (linked?.title) {
        y += 24;
        doc.fontSize(13).font("Helvetica-Bold").fillColor("#000000").text(linked.title, 50, y);
      }
    }

    doc.fontSize(9).font("Helvetica").fillColor("#888888")
      .text(
        `Sent by ${companyName} to ${reqRow.signerEmail} for electronic signature.`,
        50, 770, { width: 495 },
      );

    doc.end();
  } catch (err) {
    console.error("[Signatures] pdf error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to render document" });
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
    } catch (_e) { /* non-critical */ }

    // On sign of an Estimate, fully fulfill it: auto-convert to an invoice,
    // email the customer a hosted "pay now" link, and alert the owners. All
    // best-effort — a failure here must never fail the signing itself.
    try {
      let docLabel = `${updated.documentType} #${updated.documentId}`;
      let ownerNote = "";
      let customerEmail = updated.signerEmail;

      if (updated.documentType === "Estimate") {
        const result = await fulfillSignedEstimate({
          documentId: updated.documentId,
          tenantId: updated.tenantId,
          signerName: updated.signerName,
          signerEmail: updated.signerEmail,
        });

        if (result.status === "converted") {
          docLabel = result.invoice.invoiceNum;
          const amountStr = fmtMoney(result.invoice.amount, result.currency);
          customerEmail = result.customerEmail || updated.signerEmail;

          // Email the customer a payable link (when one was minted).
          let customerEmailed = false;
          if (result.payLink && customerEmail) {
            const companyName = await fetchCompanyName(updated.tenantId);
            const body = buildPayableEmail({
              signerName: updated.signerName,
              invoiceNum: result.invoice.invoiceNum,
              amountStr,
              payUrl: result.payLink.url,
              companyName,
            });
            const mail = await sendSignatureEmail(
              customerEmail,
              `Invoice ${result.invoice.invoiceNum} — payment due`,
              body,
            );
            customerEmailed = mail.sent;
          }

          ownerNote = result.payLink
            ? ` Invoice ${result.invoice.invoiceNum} (${amountStr}) was created and a payment link ` +
              `${customerEmailed ? "emailed to" : "generated for"} ${customerEmail}.`
            : ` Invoice ${result.invoice.invoiceNum} (${amountStr}) was created, but no payment link ` +
              `could be generated (${result.payError}). Collect payment manually.`;
        } else if (result.status === "no_contact") {
          if (result.estimate?.estimateNum) docLabel = result.estimate.estimateNum;
          ownerNote = " Link a contact (with an email) to the estimate so it can be invoiced.";
        } else if (result.status === "already_converted") {
          if (result.estimate?.estimateNum) docLabel = result.estimate.estimateNum;
          ownerNote = " (The estimate was already converted to an invoice.)";
        }
      }

      const link = updated.documentType === "Estimate" ? "/invoices" : "/signatures";
      const recipients = await prisma.user.findMany({
        where: { tenantId: updated.tenantId, role: { in: ["ADMIN", "MANAGER"] } },
        select: { id: true },
      });
      const io = req.app.get("io");
      for (const u of recipients) {
        await notify({
          userId: u.id,
          tenantId: updated.tenantId,
          type: "success",
          title: "Document signed",
          message: `${updated.signerName} signed ${docLabel}.${ownerNote}`,
          link,
          entityType: "signature",
          entityId: updated.id,
          channels: ["db", "socket", "email"],
          io,
        });
      }
    } catch (_e) { /* fulfillment + notification are best-effort */ }

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

// GET /api/signatures — list with optional filters (and ?fields=summary)
router.get("/", async (req, res) => {
  try {
    const { status, documentType } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;
    if (documentType) where.documentType = documentType;

    // #920 slice 39: ?fields=summary slim-shape opt-in. Mirrors slices 1-36.
    // SignatureRequest carries one heavy column (`signature @db.LongText` —
    // the base64 data URL of the rendered signature image once signed) plus
    // the sensitive `signToken` (single-use URL key that bypasses the global
    // auth guard) and `signerEmail` (PII). When the caller passes
    // ?fields=summary we drop ALL THREE, plus tenantId, returning only the
    // chrome columns Signatures.jsx's list UI needs (id, documentType,
    // documentId, signerName, status, expiresAt, signedAt, createdAt).
    // Opt-in additive — existing callers (no ?fields, or any non-exact
    // value) get the full row shape unchanged so detail-view and resend
    // flows continue to receive signerEmail + signToken when they need it.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where,
      orderBy: { createdAt: "desc" },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        documentType: true,
        documentId: true,
        signerName: true,
        status: true,
        expiresAt: true,
        signedAt: true,
        createdAt: true,
      };
    }
    const requests = await prisma.signatureRequest.findMany(findManyArgs);
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

    const signUrl = `${resolveBaseUrl(req)}/sign/${signToken}`;
    const companyName = await fetchCompanyName(req.user.tenantId);
    const subject = `Signature requested: ${documentType} #${documentId}`;
    const body = buildEmailBody({ signerName, documentType, signUrl, expiresAt, companyName });
    const mailResult = await sendSignatureEmail(signerEmail, subject, body);

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

    const signUrl = `${resolveBaseUrl(req)}/sign/${reqRow.signToken}`;
    const companyName = await fetchCompanyName(req.user.tenantId);
    const subject = `Reminder: signature requested for ${reqRow.documentType} #${reqRow.documentId}`;
    const body = buildEmailBody({
      signerName: reqRow.signerName,
      documentType: reqRow.documentType,
      signUrl,
      expiresAt: reqRow.expiresAt,
      companyName,
    });
    const mailResult = await sendSignatureEmail(reqRow.signerEmail, subject, body);
    res.json({ success: true, emailDelivered: mailResult.sent });
  } catch (err) {
    console.error("[Signatures] resend error:", err);
    res.status(500).json({ error: "Failed to resend signature request" });
  }
});

module.exports = router;
