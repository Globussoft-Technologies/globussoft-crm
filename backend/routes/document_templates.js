const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const prisma = require("../lib/prisma");

const router = express.Router();

// ── Mailgun helper (mirrors routes/communications.js) ───────────────
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "crm.globusdemos.com";
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;

async function sendMailgun(to, subject, html) {
  if (!MAILGUN_API_KEY) {
    console.log(`[DocTemplates] Mailgun not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }
  const formData = new URLSearchParams();
  formData.append("from", FROM_EMAIL);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("html", html);
  // strip tags for text fallback
  formData.append("text", String(html).replace(/<[^>]+>/g, ""));
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
    const err = await response.text();
    console.error(`[DocTemplates] Mailgun error (${response.status}):`, err);
    return { sent: false, reason: err };
  } catch (err) {
    console.error("[DocTemplates] Send error:", err.message);
    return { sent: false, reason: err.message };
  }
}

// ── Variable helpers ────────────────────────────────────────────────
function flatten(obj, prefix = "", out = {}) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
        flatten(v, key, out);
      } else {
        out[key] = v == null ? "" : String(v);
      }
    }
  }
  return out;
}

function substitute(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, key) => {
    const k = key.trim();
    if (Object.prototype.hasOwnProperty.call(vars, k)) return vars[k];
    return full; // leave placeholder if not found
  });
}

async function buildVariableMap({ tenantId, userId, contactId, dealId, overrides }) {
  const map = {};

  if (contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: parseInt(contactId), tenantId },
    });
    if (contact) {
      Object.assign(map, flatten({
        contact: {
          name: contact.name || "",
          email: contact.email || "",
          phone: contact.phone || "",
          company: contact.company || "",
          title: contact.title || "",
          status: contact.status || "",
          industry: contact.industry || "",
          website: contact.website || "",
        },
      }));
    }
  }

  if (dealId) {
    const deal = await prisma.deal.findFirst({
      where: { id: parseInt(dealId), tenantId },
    });
    if (deal) {
      Object.assign(map, flatten({
        deal: {
          title: deal.title || "",
          amount: deal.amount != null ? deal.amount : "",
          currency: deal.currency || "",
          stage: deal.stage || "",
          probability: deal.probability != null ? deal.probability : "",
        },
      }));
    }
  }

  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (tenant) {
      Object.assign(map, flatten({ tenant: { name: tenant.name || "", plan: tenant.plan || "" } }));
    }
  } catch {}

  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      Object.assign(map, flatten({
        user: { name: user.name || "", email: user.email || "", role: user.role || "" },
      }));
    }
  }

  // Today / now convenience
  const now = new Date();
  map["date.today"] = now.toISOString().slice(0, 10);
  map["date.now"] = now.toISOString();

  // Explicit overrides take precedence
  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides)) {
      map[k] = v == null ? "" : String(v);
    }
  }

  return map;
}

// ── CRUD ─────────────────────────────────────────────────────────────

// GET / — list (optional ?type=)
router.get("/", async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.type) where.type = String(req.query.type);
    const templates = await prisma.documentTemplate.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });
    res.json(templates);
  } catch (err) {
    console.error("[DocTemplates] list error:", err);
    res.status(500).json({ error: "Failed to list templates" });
  }
});

// POST / — create
router.post("/", async (req, res) => {
  try {
    const { name, type, content, variables } = req.body;
    if (!name || !content) return res.status(400).json({ error: "name and content are required" });
    const tmpl = await prisma.documentTemplate.create({
      data: {
        name,
        type: type || "PROPOSAL",
        content,
        variables: variables ? (typeof variables === "string" ? variables : JSON.stringify(variables)) : null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(tmpl);
  } catch (err) {
    console.error("[DocTemplates] create error:", err);
    res.status(500).json({ error: "Failed to create template" });
  }
});

// GET /:id
router.get("/:id", async (req, res) => {
  try {
    const tmpl = await prisma.documentTemplate.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!tmpl) return res.status(404).json({ error: "Template not found" });
    res.json(tmpl);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch template" });
  }
});

// PUT /:id
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.documentTemplate.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Template not found" });

    const { name, type, content, variables } = req.body;
    const tmpl = await prisma.documentTemplate.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(variables !== undefined
          ? { variables: typeof variables === "string" ? variables : JSON.stringify(variables) }
          : {}),
      },
    });
    res.json(tmpl);
  } catch (err) {
    console.error("[DocTemplates] update error:", err);
    res.status(500).json({ error: "Failed to update template" });
  }
});

// DELETE /:id
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.documentTemplate.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    await prisma.documentTemplate.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete template" });
  }
});

// POST /:id/render — substitute variables, return rendered HTML
router.post("/:id/render", async (req, res) => {
  try {
    const tmpl = await prisma.documentTemplate.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!tmpl) return res.status(404).json({ error: "Template not found" });

    const { contactId, dealId, variables } = req.body || {};
    const vars = await buildVariableMap({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      contactId,
      dealId,
      overrides: variables,
    });
    const html = substitute(tmpl.content, vars);
    res.json({ html, variables: vars, template: { id: tmpl.id, name: tmpl.name, type: tmpl.type } });
  } catch (err) {
    console.error("[DocTemplates] render error:", err);
    res.status(500).json({ error: "Failed to render template" });
  }
});

// POST /:id/render-pdf — return printable HTML payload for client-side PDF
router.post("/:id/render-pdf", async (req, res) => {
  try {
    const tmpl = await prisma.documentTemplate.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!tmpl) return res.status(404).json({ error: "Template not found" });

    const { contactId, dealId, variables } = req.body || {};
    const vars = await buildVariableMap({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      contactId,
      dealId,
      overrides: variables,
    });
    const rendered = substitute(tmpl.content, vars);

    // Wrap with print stylesheet so the client can window.print() to PDF
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${tmpl.name}</title>
<style>
  @media print { @page { size: A4; margin: 16mm; } body { -webkit-print-color-adjust: exact; } }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; line-height: 1.6; max-width: 800px; margin: 24px auto; padding: 0 16px; }
  h1,h2,h3 { color: #111; }
  table { border-collapse: collapse; width: 100%; }
  td, th { padding: 6px 8px; border: 1px solid #ddd; }
</style></head><body>${rendered}</body></html>`;

    res.json({ html, downloadable: true, filename: `${tmpl.name.replace(/\s+/g, "_")}.html` });
  } catch (err) {
    console.error("[DocTemplates] render-pdf error:", err);
    res.status(500).json({ error: "Failed to render PDF" });
  }
});

// POST /:id/send-email — render and email via Mailgun, log EmailMessage
router.post("/:id/send-email", async (req, res) => {
  try {
    const tmpl = await prisma.documentTemplate.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!tmpl) return res.status(404).json({ error: "Template not found" });

    const { contactId, subject, dealId, variables, to } = req.body || {};
    if (!subject) return res.status(400).json({ error: "subject is required" });

    let recipient = to;
    let contactRecord = null;
    if (contactId) {
      contactRecord = await prisma.contact.findFirst({
        where: { id: parseInt(contactId), tenantId: req.user.tenantId },
      });
      if (!contactRecord) return res.status(404).json({ error: "Contact not found" });
      recipient = recipient || contactRecord.email;
    }
    if (!recipient) return res.status(400).json({ error: "recipient email required (contactId or to)" });

    const vars = await buildVariableMap({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      contactId,
      dealId,
      overrides: variables,
    });
    const renderedSubject = substitute(subject, vars);
    const renderedBody = substitute(tmpl.content, vars);

    const emailRecord = await prisma.emailMessage.create({
      data: {
        subject: renderedSubject,
        body: renderedBody,
        from: FROM_EMAIL,
        to: recipient,
        direction: "OUTBOUND",
        read: true,
        contactId: contactRecord ? contactRecord.id : null,
        userId: req.user ? req.user.userId : null,
        tenantId: req.user.tenantId,
      },
    });

    const mailResult = await sendMailgun(recipient, renderedSubject, renderedBody);

    if (contactRecord) {
      await prisma.activity.create({
        data: {
          type: "Email",
          description: `Sent template "${tmpl.name}" — ${renderedSubject}`,
          contactId: contactRecord.id,
          userId: req.user ? req.user.userId : null,
          tenantId: req.user.tenantId,
        },
      }).catch(() => {});
    }

    if (req.io) req.io.emit("email_sent", emailRecord);

    res.json({
      success: true,
      delivered: mailResult.sent,
      reason: mailResult.sent ? undefined : mailResult.reason,
      email: emailRecord,
    });
  } catch (err) {
    console.error("[DocTemplates] send-email error:", err);
    res.status(500).json({ error: "Failed to send templated email" });
  }
});

module.exports = router;
