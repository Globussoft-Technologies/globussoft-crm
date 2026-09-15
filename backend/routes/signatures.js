const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const prisma = require("../lib/prisma");
const { notify } = require("../lib/notificationService");
const { fulfillSignedEstimate } = require("../lib/signatureFulfillment");
const { getFrontendUrlFromRequest } = require("../lib/requestOrigin");
const { blockCustomers } = require("../middleware/blockCustomers");
const { renderConsentPdf } = require("../services/pdfRenderer");
const { writeAudit } = require("../lib/audit");

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

// SMTP fallback transport (lazy-initialised) — used when SendGrid rejects
// with 403 unverified-sender or any other 4xx/5xx.
let smtpTransporter = null;
function getSmtpTransporter() {
  if (smtpTransporter) return smtpTransporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  smtpTransporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: (process.env.SMTP_SECURE || "false") === "true",
    auth: {
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
    },
  });
  return smtpTransporter;
}

async function sendViaSmtp(to, subject, text, html) {
  const transporter = getSmtpTransporter();
  if (!transporter) return { sent: false, reason: "smtp_not_configured" };
  try {
    const info = await transporter.sendMail({
      from: `"Globussoft CRM" <${FROM_EMAIL}>`,
      to,
      subject,
      text,
      html,
    });
    return { sent: true, id: info.messageId || "smtp" };
  } catch (err) {
    console.error("[Signatures] SMTP fallback error:", err.message);
    return { sent: false, reason: `smtp_error: ${err.message}` };
  }
}

// `content` is either a plain string or a { text, html } pair. A string is
// sent as-is with a naive <br> html fallback; the { text, html } shape lets
// callers ship a proper html body (e.g. a clickable signing link).
async function sendSignatureEmail(to, subject, content) {
  const key = process.env.SENDGRID_API_KEY;
  const text = typeof content === "string" ? content : content.text;
  const html = typeof content === "string" ? content.replace(/\n/g, "<br>") : content.html;

  if (!key) {
    console.log(`[Signatures] SendGrid not configured — falling back to SMTP for ${to}`);
    return sendViaSmtp(to, subject, text, html);
  }

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
    // Fallback to SMTP on 403 (unverified sender/domain) or any other failure
    // so staging environments with unverified domains still deliver.
    if (response.status === 403 || response.status >= 400) {
      console.log(`[Signatures] SendGrid ${response.status} — attempting SMTP fallback for ${to}`);
      return sendViaSmtp(to, subject, text, html);
    }
    return { sent: false, reason: `sendgrid ${response.status}: ${errText}` };
  } catch (err) {
    console.error("[Signatures] SendGrid send error:", err.message);
    console.log(`[Signatures] SendGrid network error — attempting SMTP fallback for ${to}`);
    return sendViaSmtp(to, subject, text, html);
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

// Email needs the same tenant logo that the CRM stores, but email clients
// cannot resolve a browser-relative `/uploads/...` path. Resolve only the
// configured HTTP(S) URL or the CRM's own uploads path against the current
// environment so demo/staging/prod emails never point at the wrong host.
async function fetchCompanyBrand(tenantId) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, logoUrl: true },
    });
    return {
      name: tenant?.name || DEFAULT_COMPANY,
      logoUrl: tenant?.logoUrl || null,
    };
  } catch (_err) {
    return { name: DEFAULT_COMPANY, logoUrl: null };
  }
}

function resolveEmailLogoUrl(req, logoUrl) {
  if (typeof logoUrl !== "string" || !logoUrl.trim()) return null;
  const raw = logoUrl.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!/^\/(?:api\/)?uploads\//i.test(raw)) return null;
  try {
    const absolute = new URL(raw, `${resolveBaseUrl(req)}/`);
    return ["http:", "https:"].includes(absolute.protocol) ? absolute.toString() : null;
  } catch (_err) {
    return null;
  }
}

// Returns { text, html }. The HTML variant is intentionally table-based and
// uses inline styles so it renders consistently in Gmail, Outlook, and mobile
// mail clients. Keep the plain-text version equally useful for clients that
// strip HTML.
function buildEmailBody({ signerName, documentType, signUrl, expiresAt, companyName, logoUrl }) {
  const company = companyName || DEFAULT_COMPANY;
  const expiryText = expiresAt ? new Date(expiresAt).toLocaleString() : "Not specified";
  const copyrightYear = new Date().getFullYear();
  const logoMarkup = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(company)} logo" width="42" height="42" ` +
      `style="display:block;width:42px;height:42px;border-radius:50%;object-fit:contain;background:#eee8ff;">`
    : `<div style="width:42px;height:42px;border-radius:50%;background:#eee8ff;color:#6231dc;font-size:27px;line-height:42px;text-align:center;font-weight:bold;">❧</div>`;
  const expiryLine = expiresAt
    ? `\n\nThis link will expire on ${expiryText}.`
    : "";
  const text =
    `Hello ${signerName},\n\n` +
    `You have been requested to sign a ${documentType} via ${company}.\n\n` +
    `Please click the secure link below to review and sign the document.\n\n` +
    `Review & Sign Your ${documentType}: ${signUrl}${expiryLine}\n\n` +
    `For your security, please do not share this link with anyone.\n\n` +
    `If you did not expect this request, please ignore this email.\n\n` +
    `— ${company}\n\n` +
    `© ${copyrightYear} ${company}. All rights reserved.`;

  const html =
    `<!doctype html>` +
    `<html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
    `<title>Signature request from ${escapeHtml(company)}</title>` +
    `<style>` +
    `@media only screen and (max-width:620px){` +
    `.email-shell{width:100%!important;border-radius:0!important}` +
    `.email-pad{padding-left:22px!important;padding-right:22px!important}` +
    `.brand-tagline{display:none!important}` +
    `.detail-cell{display:block!important;width:100%!important;border:0!important;padding:0 0 18px!important}` +
    `.detail-cell:last-child{padding-bottom:0!important}` +
    `}` +
    `</style></head>` +
    `<body style="margin:0;padding:0;background:#f5f6fb;font-family:Arial,Helvetica,sans-serif;color:#1d2344;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f5f6fb;">` +
    `<tr><td align="center" style="padding:28px 12px;">` +
    `<table role="presentation" class="email-shell" width="680" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:680px;max-width:680px;background:#ffffff;border:1px solid #e6e8f2;border-radius:10px;overflow:hidden;">` +
    `<tr><td class="email-pad" style="padding:28px 38px 20px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr>` +
    `<td valign="middle" style="width:58%;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle" style="padding-right:12px;">` +
    logoMarkup +
    `</td>` +
    `<td valign="middle">` +
    `<div style="font-size:23px;line-height:27px;font-weight:700;letter-spacing:-0.4px;color:#172044;">${escapeHtml(company)}</div>` +
    `<div style="font-size:10px;line-height:15px;letter-spacing:2px;color:#8b90aa;">PEOPLE&nbsp;&nbsp;•&nbsp;&nbsp;WELLBEING&nbsp;&nbsp;•&nbsp;&nbsp;BRIGHTER TOMORROWS</div>` +
    `</td></tr></table>` +
    `</td>` +
    `<td class="brand-tagline" align="right" valign="middle" style="width:42%;font-size:13px;line-height:18px;color:#8b90aa;">` +
    `Healthier People<br>Stronger Workplaces<br>` +
    `<span style="display:inline-block;width:40px;border-top:2px solid #7342e8;margin-top:10px;"></span>` +
    `</td>` +
    `</tr></table>` +
    `</td></tr>` +
    `<tr><td class="email-pad" style="padding:22px 38px 34px;">` +
    `<p style="margin:0 0 14px;font-size:20px;line-height:29px;color:#1d2344;">Hello <strong style="color:#6430d9;">${escapeHtml(signerName)},</strong></p>` +
    `<p style="margin:0 0 4px;font-size:17px;line-height:27px;color:#1d2344;">` +
    `You have been requested to sign a <strong>${escapeHtml(documentType)}</strong> via <strong>${escapeHtml(company)}</strong>.</p>` +
    `<p style="margin:0 0 22px;font-size:17px;line-height:27px;color:#1d2344;">Please click the secure link below to review and sign the document.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">` +
    `<tr><td align="center" bgcolor="#6331df" style="border-radius:8px;background:#6331df;background-image:linear-gradient(105deg,#5b2bdd,#7643e9);">` +
    `<a href="${escapeHtml(signUrl)}" target="_blank" rel="noopener noreferrer" ` +
    `style="display:inline-block;padding:14px 22px;border-radius:8px;color:#ffffff;text-decoration:none;font-size:16px;line-height:22px;font-weight:700;">` +
    `Review &amp; Sign Your ${escapeHtml(documentType)} <span style="font-size:22px;line-height:16px;vertical-align:-2px;padding-left:10px;">→</span></a>` +
    `</td></tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background:#f7f4ff;border:1px solid #eee9ff;border-radius:10px;">` +
    `<tr><td valign="top" style="padding:15px 13px 15px 15px;width:34px;">` +
    `<div style="width:32px;height:32px;border-radius:50%;background:#e9e1ff;color:#6030dc;font-size:19px;line-height:32px;text-align:center;">↗</div>` +
    `</td><td valign="middle" style="padding:13px 15px 13px 0;font-size:13px;line-height:20px;color:#6f7694;">` +
    `<div style="margin-bottom:2px;">Or copy this link into your browser:</div>` +
    `<a href="${escapeHtml(signUrl)}" target="_blank" rel="noopener noreferrer" style="color:#5130e5;text-decoration:none;word-break:break-all;">${escapeHtml(signUrl)}</a>` +
    `</td></tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">` +
    `<tr>` +
    `<td class="detail-cell" valign="top" style="width:50%;padding:0 22px 0 0;border-right:1px solid #e3e5ef;font-size:13px;line-height:20px;color:#6f7694;">` +
    `<div style="font-size:22px;line-height:26px;color:#6331df;margin-bottom:5px;">▣</div>` +
    `This link will expire on<br><strong style="color:#1d2344;">${escapeHtml(expiryText)}</strong>` +
    `</td>` +
    `<td class="detail-cell" valign="top" style="width:50%;padding:0 0 0 22px;font-size:13px;line-height:20px;color:#6f7694;">` +
    `<div style="font-size:22px;line-height:26px;color:#6331df;margin-bottom:5px;">◇</div>` +
    `For your security, please do not<br>share this link with anyone.` +
    `</td>` +
    `</tr></table>` +
    `<p style="margin:0 0 7px;font-size:14px;line-height:22px;color:#565d7b;">If you did not request this, please ignore this email.</p>` +
    `<p style="margin:0;font-size:16px;line-height:24px;font-weight:700;color:#1d2344;">— ${escapeHtml(company)}</p>` +
    `</td></tr>` +
    `<tr><td class="email-pad" style="padding:20px 38px 24px;border-top:1px solid #e6e8f2;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="font-size:12px;line-height:18px;color:#9298ad;">© ${copyrightYear} ${escapeHtml(company)}. All rights reserved.</td>` +
    `<td align="right" style="font-size:10px;line-height:16px;letter-spacing:1.5px;color:#9298ad;">WELLNESS TODAY&nbsp;&nbsp;A BRIGHTER TOMORROW<br>` +
    `<span style="display:inline-block;width:38px;border-top:2px solid #7342e8;margin-top:7px;"></span></td>` +
    `</tr></table>` +
    `</td></tr>` +
    `</table></td></tr></table>` +
    `</body></html>`;

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

function parseServiceIds(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

// Patient e-signatures deliberately use explicit scalar links instead of
// Prisma relation includes: SignatureRequest predates the wellness schema
// relations and its nullable patient/visit context must remain backwards
// compatible with generic Contract/Estimate/Quote requests.
async function fetchPatientSignatureContext(reqRow) {
  const patientId = Number(reqRow?.patientId);
  const visitId = Number(reqRow?.visitId);
  if (!Number.isInteger(patientId) || !Number.isInteger(visitId)) return null;
  if (!prisma.patient?.findFirst || !prisma.visit?.findFirst) return null;

  const tenantId = Number(reqRow.tenantId);
  const [patient, visit] = await Promise.all([
    prisma.patient.findFirst({
      where: { id: patientId, tenantId },
      select: { id: true, name: true, email: true, phone: true },
    }),
    prisma.visit.findFirst({
      where: { id: visitId, patientId, tenantId },
      select: {
        id: true,
        visitDate: true,
        status: true,
        serviceId: true,
        service: { select: { id: true, name: true } },
      },
    }),
  ]);
  if (!patient || !visit) return null;

  const requestedServiceIds = parseServiceIds(reqRow.serviceIds)
    .map(Number)
    .filter(Number.isInteger);
  const serviceIds = [...new Set(
    [...requestedServiceIds, Number(visit.serviceId)]
      .filter((id) => Number.isInteger(id) && id > 0),
  )];

  let services = [];
  if (serviceIds.length && prisma.service?.findMany) {
    services = await prisma.service.findMany({
      where: { id: { in: serviceIds }, tenantId },
      select: { id: true, name: true },
    });
  }
  if (visit.service && !services.some((service) => service.id === visit.service.id)) {
    services = [...services, visit.service];
  }

  return { patient, visit, services };
}

async function fetchPrimaryClinic(tenantId) {
  if (!prisma.location?.findFirst) return null;
  const where = { tenantId };
  return (
    (await prisma.location.findFirst({ where: { ...where, isActive: true }, orderBy: { id: "asc" } })) ||
    (await prisma.location.findFirst({ where, orderBy: { id: "asc" } }))
  );
}

async function renderPatientSignatureRequestPdf(reqRow, signatureDataUrl) {
  const context = await fetchPatientSignatureContext(reqRow);
  if (!context) return null;

  const service = context.services.length === 1
    ? context.services[0]
    : context.services.length > 1
      ? { name: context.services.map((item) => item.name).join(", ") }
      : context.visit.service;
  const clinic = await fetchPrimaryClinic(Number(reqRow.tenantId));

  return renderConsentPdf(
    {
      templateName: reqRow.documentName || "general",
      signedAt: reqRow.signedAt,
    },
    context.patient,
    service,
    clinic,
    signatureDataUrl ?? reqRow.signature,
    { visit: context.visit, services: context.services },
  );
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
    if (reqRow.status === "CANCELLED") {
      return res.status(410).json({ error: "This signature request has been cancelled" });
    }

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
      ...(reqRow.documentName ? { documentName: reqRow.documentName } : {}),
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
    if (reqRow.status === "CANCELLED") {
      return res.status(410).json({ error: "This signature request has been cancelled" });
    }
    if (reqRow.expiresAt && new Date(reqRow.expiresAt) < new Date()) {
      return res.status(410).json({ error: "This signature request has expired" });
    }

    // Patient requests use the same consent-form renderer as the wellness
    // clinical surface, so the signer reviews the exact patient/visit/service
    // context that the admin selected instead of a generic Custom document.
    if (reqRow.documentType === "Custom" && reqRow.patientId && reqRow.visitId) {
      const patientPdf = await renderPatientSignatureRequestPdf(reqRow);
      if (patientPdf) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="consent-${reqRow.id}.pdf"`,
        );
        res.setHeader("Content-Length", patientPdf.length);
        return res.send(patientPdf);
      }
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
        .text(`Please review and sign this ${reqRow.documentName || reqRow.documentType}.`, 50, y, { width: 495 });
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
        const frontendBase = getFrontendUrlFromRequest(req);
        const result = await fulfillSignedEstimate({
          documentId: updated.documentId,
          tenantId: updated.tenantId,
          signerName: updated.signerName,
          signerEmail: updated.signerEmail,
          baseUrl: frontendBase,
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
router.use(blockCustomers);

router.get("/", async (req, res) => {
  try {
    const { status, documentType, patientId } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;
    if (documentType) where.documentType = documentType;
    if (patientId !== undefined) {
      const parsedPatientId = parseInt(patientId, 10);
      if (!Number.isInteger(parsedPatientId) || parsedPatientId < 1) {
        return res.status(400).json({ error: "patientId must be a valid integer" });
      }
      where.patientId = parsedPatientId;
    }

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
    const isPatientConsent = req.query.fields === "patient-consent";
    const findManyArgs = {
      where,
      orderBy: { createdAt: "desc" },
    };
    if (isPatientConsent) {
      // PatientDetail's Consent tab only needs the immutable linkage and
      // status metadata. Never expose signToken or the captured signature to
      // this list response.
      findManyArgs.select = {
        id: true,
        documentType: true,
        documentId: true,
        documentName: true,
        signerName: true,
        status: true,
        signedAt: true,
        patientId: true,
        visitId: true,
        serviceIds: true,
      };
    } else if (isSummary) {
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

// GET /api/signatures/:id/pdf — signed PDF for a linked wellness patient
// request. This route is staff-only; customer accounts use the scoped
// /api/wellness/portal/consents/:id/pdf endpoint instead.
router.get("/:id/pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

    const reqRow = await prisma.signatureRequest.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!reqRow) return res.status(404).json({ error: "Signature request not found" });
    if (reqRow.status !== "SIGNED") {
      return res.status(409).json({ error: "A PDF is available after the request is signed" });
    }
    if (reqRow.documentType !== "Custom" || !reqRow.patientId || !reqRow.visitId) {
      return res.status(400).json({ error: "This request is not linked to a wellness patient visit" });
    }

    const buf = await renderPatientSignatureRequestPdf(reqRow);
    if (!buf) return res.status(404).json({ error: "Linked patient visit not found" });

    try {
      await writeAudit(
        "SignatureRequest",
        "SIGNATURE_PDF_DOWNLOAD",
        reqRow.id,
        req.user.userId,
        req.user.tenantId,
        {
          signatureRequestId: reqRow.id,
          patientId: reqRow.patientId,
          visitId: reqRow.visitId,
          serviceIds: parseServiceIds(reqRow.serviceIds),
        },
      );
    } catch (auditErr) {
      console.warn("[Signatures] audit PDF download failed:", auditErr.message);
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="consent-${id}.pdf"`);
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.send(buf);
  } catch (err) {
    console.error("[Signatures] linked patient PDF error:", err);
    res.status(500).json({ error: "Failed to render signature PDF" });
  }
});

// POST /api/signatures — create + email signing link
router.post("/", async (req, res) => {
  try {
    const {
      documentType, documentId, signerName, signerEmail,
      documentName, targetPatientId, visitId, serviceIds,
    } = req.body || {};
    let { expiresInDays } = req.body || {};

    if (!documentType || !documentId || !signerName || !signerEmail) {
      return res.status(400).json({ error: "documentType, documentId, signerName, signerEmail are required" });
    }
    if (!["Contract", "Estimate", "Quote", "Custom"].includes(documentType)) {
      return res.status(400).json({ error: "Invalid documentType" });
    }

    let patientContext = {};
    if (documentType === "Custom" && targetPatientId != null) {
      const patientId = parseInt(targetPatientId);
      const linkedVisitId = parseInt(visitId);
      if (!Number.isInteger(patientId) || !Number.isInteger(linkedVisitId)) {
        return res.status(400).json({ error: "targetPatientId and visitId must be valid integers" });
      }
      const visit = await prisma.visit.findFirst({
        where: { id: linkedVisitId, patientId, tenantId: req.user.tenantId },
        select: { id: true, serviceId: true },
      });
      if (!visit) return res.status(404).json({ error: "Patient visit not found" });

      let normalizedServiceIds = Array.isArray(serviceIds)
        ? [...new Set(serviceIds.map(Number).filter(Number.isInteger))]
        : [];
      // A visit's service is the safe default when the caller did not send a
      // separate service selection. Patient requests must always retain at
      // least one service link so they can be found from Consent forms.
      if (!normalizedServiceIds.length && Number.isInteger(visit.serviceId)) {
        normalizedServiceIds = [visit.serviceId];
      }
      if (!normalizedServiceIds.length) {
        return res.status(400).json({ error: "At least one service is required for a patient signature request" });
      }
      if (normalizedServiceIds.length) {
        const serviceCount = await prisma.service.count({
          where: { id: { in: normalizedServiceIds }, tenantId: req.user.tenantId },
        });
        if (serviceCount !== normalizedServiceIds.length) {
          return res.status(400).json({ error: "One or more services are invalid" });
        }
      }
      patientContext = {
        documentName: String(documentName || "Patient document").trim().slice(0, 191),
        patientId,
        visitId: linkedVisitId,
        serviceIds: JSON.stringify(normalizedServiceIds),
      };
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
        ...patientContext,
      },
    });

    const signUrl = `${resolveBaseUrl(req)}/sign/${signToken}`;
    const companyBrand = await fetchCompanyBrand(req.user.tenantId);
    const subject = `Signature requested: ${documentType} #${documentId}`;
    const body = buildEmailBody({
      signerName,
      documentType,
      signUrl,
      expiresAt,
      companyName: companyBrand.name,
      logoUrl: resolveEmailLogoUrl(req, companyBrand.logoUrl),
    });
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

// DELETE /api/signatures/:id — cancel request without deleting its audit trail.
// Keep the DELETE method for backwards compatibility with the existing UI/API
// contract, but soft-cancel the row so signature history and patient links are
// never lost from the database.
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const reqRow = await prisma.signatureRequest.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!reqRow) return res.status(404).json({ error: "Signature request not found" });
    if (reqRow.status !== "PENDING") {
      return res.status(409).json({ error: `Cannot cancel — request is already ${reqRow.status}` });
    }

    await prisma.signatureRequest.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
    res.json({ success: true, status: "CANCELLED" });
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
    const companyBrand = await fetchCompanyBrand(req.user.tenantId);
    const subject = `Reminder: signature requested for ${reqRow.documentType} #${reqRow.documentId}`;
    const body = buildEmailBody({
      signerName: reqRow.signerName,
      documentType: reqRow.documentType,
      signUrl,
      expiresAt: reqRow.expiresAt,
      companyName: companyBrand.name,
      logoUrl: resolveEmailLogoUrl(req, companyBrand.logoUrl),
    });
    const mailResult = await sendSignatureEmail(reqRow.signerEmail, subject, body);
    res.json({ success: true, emailDelivered: mailResult.sent });
  } catch (err) {
    console.error("[Signatures] resend error:", err);
    res.status(500).json({ error: "Failed to resend signature request" });
  }
});

module.exports = router;
