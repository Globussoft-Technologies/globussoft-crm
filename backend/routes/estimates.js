const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const prisma = require("../lib/prisma");
const { verifyRole } = require("../middleware/auth");
const { writeAudit, diffFields } = require("../lib/audit");
const { httpFromPrismaError } = require("../lib/validators");

// Lightweight currency formatter for inline PDF rendering. Mirrors the
// pattern at backend/routes/billing.js (invoice PDF) — Intl.NumberFormat
// with the tenant's currency + locale; fall through to USD on missing.
function fmtMoney(amount, currency = "USD", locale) {
  try {
    return new Intl.NumberFormat(locale || "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(Number(amount) || 0);
  } catch (_e) {
    return `${currency} ${(Number(amount) || 0).toFixed(2)}`;
  }
}

// #168: shared validators so PUT mirrors POST. POST already inlines these
// checks; PUT historically skipped them and returned 500 on bad input.
// Centralised here so future field additions stay symmetric.
const ALLOWED_ESTIMATE_STATUSES = new Set([
  "Draft", "Sent", "Accepted", "Rejected", "Expired", "Converted",
]);
function validateEstimateInput(body, { isUpdate = false } = {}) {
  // title — required on create, optional on update; reject empty string.
  if (!isUpdate) {
    if (body.title == null || String(body.title).trim() === "") {
      return { status: 400, error: "title is required", code: "TITLE_REQUIRED" };
    }
  } else if (body.title !== undefined && String(body.title).trim() === "") {
    return { status: 400, error: "title cannot be empty", code: "TITLE_REQUIRED" };
  }
  // status — only meaningful on update (POST always starts as Draft) but
  // validate on both sides so a junk value can't slip through either path.
  if (body.status !== undefined && body.status !== null && body.status !== "") {
    if (!ALLOWED_ESTIMATE_STATUSES.has(body.status)) {
      return {
        status: 400,
        error: `status must be one of: ${[...ALLOWED_ESTIMATE_STATUSES].join(", ")}`,
        code: "INVALID_STATUS",
      };
    }
  }
  // validUntil — must parse, must not be in the past, must not be more than
  // 10 years in the future. POST inlined this; PUT didn't, so a stale
  // "2010-01-01" could land via update and the estimate looked permanently
  // expired in the UI.
  //
  // Upper-bound cap (#178/#322 closure): a 10-year sliding window is wide
  // enough for multi-year service plans / typical contract retention but
  // tight enough to reject nonsense like 2150-06-01 (which previously
  // succeeded — surfaced 2026-05-07 by regression-coverage-backlog #11).
  if (body.validUntil !== undefined && body.validUntil !== null && body.validUntil !== "") {
    const vu = new Date(body.validUntil);
    if (Number.isNaN(vu.getTime())) {
      return { status: 400, error: "validUntil is not a valid date", code: "INVALID_VALID_UNTIL" };
    }
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    if (vu < todayStart) {
      return { status: 400, error: "validUntil cannot be in the past", code: "VALID_UNTIL_IN_PAST" };
    }
    const maxFuture = new Date(todayStart);
    maxFuture.setFullYear(maxFuture.getFullYear() + 10);
    if (vu > maxFuture) {
      return {
        status: 400,
        error: "validUntil cannot be more than 10 years in the future",
        code: "INVALID_VALID_UNTIL_FUTURE",
      };
    }
  }
  return null;
}

// GET /api/estimates — list with optional status filter
// #167: soft-deleted rows hidden by default; opt in with ?includeDeleted=true.
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;
    if (req.query.includeDeleted !== "true") where.deletedAt = null;

    // #172: pagination
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const estimates = await prisma.estimate.findMany({
      where, take: limit, skip: offset,
      include: { contact: true, deal: true, lineItems: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(estimates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch estimates" });
  }
});

// GET /api/estimates/:id
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });
    const includeDeleted = req.query.includeDeleted === "true";

    const estimate = await prisma.estimate.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { contact: true, deal: true, lineItems: true },
    });
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });
    // #167: 404 soft-deleted rows unless opted in.
    if (estimate.deletedAt && !includeDeleted) return res.status(404).json({ error: "Estimate not found" });
    res.json(estimate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch estimate" });
  }
});

// #174: cap line items per estimate to prevent the unbounded-array DoS surface.
// 200 is plenty for any real-world quote and keeps payloads small.
const MAX_LINE_ITEMS = 200;

// POST /api/estimates
router.post("/", async (req, res) => {
  try {
    // #199: accept legacy field names (`name`, `items`) as aliases for the
    // current contract (`title`, `lineItems`). Older mobile builds and cached
    // SPA bundles still post the old shape. The new names win when both are
    // supplied. This is a deprecation-window alias, not a permanent dual-API.
    const { contactId, dealId, validUntil, notes } = req.body;
    const title = req.body.title !== undefined ? req.body.title : req.body.name;
    const lineItems = req.body.lineItems !== undefined ? req.body.lineItems : req.body.items;
    if (!title) return res.status(400).json({ error: "title is required (legacy field 'name' also accepted)" });
    // #168: shared validator — mirrors PUT so future field additions stay aligned.
    const inputErr = validateEstimateInput({ ...req.body, title }, { isUpdate: false });
    if (inputErr) return res.status(inputErr.status).json(inputErr);

    const estimateNum = `EST-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const parsedLineItems = Array.isArray(lineItems) ? lineItems : [];
    // #164: empty estimates clutter the ledger with ₹0 rows; require at least one line.
    if (parsedLineItems.length === 0) {
      return res.status(400).json({ error: "At least one line item is required", code: "LINE_ITEMS_REQUIRED" });
    }
    // #174: hard cap on line item count.
    if (parsedLineItems.length > MAX_LINE_ITEMS) {
      return res.status(400).json({ error: `lineItems cannot exceed ${MAX_LINE_ITEMS} entries`, code: "LINE_ITEMS_LIMIT_EXCEEDED" });
    }
    // #178: validUntil cannot be before today (1900-01-01 was being accepted).
    if (validUntil) {
      const vu = new Date(validUntil);
      if (Number.isNaN(vu.getTime())) {
        return res.status(400).json({ error: "validUntil is not a valid date", code: "INVALID_VALID_UNTIL" });
      }
      // Allow today; reject anything strictly before today's start-of-day.
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      if (vu < todayStart) {
        return res.status(400).json({ error: "validUntil cannot be in the past", code: "VALID_UNTIL_IN_PAST" });
      }
    }
    // #123 + #164: reject negative qty/price AND zero qty (a 0-quantity row is meaningless).
    for (const [i, item] of parsedLineItems.entries()) {
      const q = Number(item.quantity);
      const p = Number(item.unitPrice);
      if (Number.isFinite(q) && q < 1) {
        return res.status(400).json({ error: `Line item ${i + 1}: quantity must be at least 1`, code: "INVALID_QUANTITY" });
      }
      if (Number.isFinite(p) && p < 0) {
        return res.status(400).json({ error: `Line item ${i + 1}: unit price cannot be negative`, code: "NEGATIVE_PRICE" });
      }
    }
    const totalAmount = parsedLineItems.reduce(
      (sum, item) => sum + (Number(item.quantity) || 1) * (Number(item.unitPrice) || 0),
      0
    );

    const estimate = await prisma.estimate.create({
      data: {
        estimateNum,
        title,
        totalAmount,
        validUntil: validUntil ? new Date(validUntil) : null,
        notes: notes || null,
        contactId: contactId ? parseInt(contactId) : null,
        dealId: dealId ? parseInt(dealId) : null,
        tenantId: req.user.tenantId,
        lineItems: {
          create: parsedLineItems.map((item) => ({
            description: item.description || "",
            quantity: Number(item.quantity) || 1,
            unitPrice: Number(item.unitPrice) || 0,
          })),
        },
      },
      include: { contact: true, deal: true, lineItems: true },
    });
    // #179: audit estimate creation.
    await writeAudit('Estimate', 'CREATE', estimate.id, req.user.userId, req.user.tenantId, {
      estimateNum: estimate.estimateNum,
      title: estimate.title,
      totalAmount: estimate.totalAmount,
      lineItemCount: parsedLineItems.length,
    });
    res.status(201).json(estimate);
  } catch (err) {
    console.error(err);
    // #165: surface Prisma validation errors as 400, not 500.
    const mapped = httpFromPrismaError(err);
    if (mapped) return res.status(mapped.status).json(mapped);
    res.status(500).json({ error: "Failed to create estimate" });
  }
});

// PUT /api/estimates/:id
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });

    const existing = await prisma.estimate.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Estimate not found" });

    // #168: PUT now runs the same validators as POST. Pre-fix this endpoint
    // accepted any junk value and 500'd at the DB layer (e.g. validUntil
    // = "not-a-date" → Prisma threw, surfaced as "Failed to update estimate").
    const inputErr = validateEstimateInput(req.body, { isUpdate: true });
    if (inputErr) return res.status(inputErr.status).json(inputErr);

    const { title, status, validUntil, notes, contactId, dealId } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (status !== undefined) data.status = status;
    if (validUntil !== undefined) data.validUntil = validUntil ? new Date(validUntil) : null;
    if (notes !== undefined) data.notes = notes;
    if (contactId !== undefined) data.contactId = contactId ? parseInt(contactId) : null;
    if (dealId !== undefined) data.dealId = dealId ? parseInt(dealId) : null;

    const estimate = await prisma.estimate.update({
      where: { id: existing.id },
      data,
      include: { contact: true, deal: true, lineItems: true },
    });
    // #179: audit only the keys that changed.
    const changes = diffFields(existing, estimate, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      await writeAudit('Estimate', 'UPDATE', estimate.id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }
    res.json(estimate);
  } catch (err) {
    console.error(err);
    // #168 #165: bad input through PUT now returns 400 with a clear code.
    const mapped = httpFromPrismaError(err);
    if (mapped) return res.status(mapped.status).json(mapped);
    res.status(500).json({ error: "Failed to update estimate" });
  }
});

// PUT /api/estimates/:id/convert — convert to invoice
router.put("/:id/convert", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });

    const estimate = await prisma.estimate.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { lineItems: true },
    });
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });
    if (estimate.status === "Converted") {
      return res.status(400).json({ error: "Estimate already converted" });
    }
    if (!estimate.contactId) {
      return res.status(400).json({ error: "Estimate must have a contact to convert to invoice" });
    }

    const invoiceNum = `INV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);

    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          invoiceNum,
          amount: estimate.totalAmount,
          status: "UNPAID",
          dueDate,
          contactId: estimate.contactId,
          dealId: estimate.dealId || null,
          tenantId: req.user.tenantId,
        },
      });

      const updatedEstimate = await tx.estimate.update({
        where: { id },
        data: { status: "Converted" },
        include: { contact: true, deal: true, lineItems: true },
      });

      return { estimate: updatedEstimate, invoice };
    });

    // #179: audit conversion. Two-sided trail: estimate side records the resulting
    // invoice id; invoice side records the source estimate id. This makes it cheap
    // for auditors to walk either direction.
    await writeAudit('Estimate', 'CONVERT_TO_INVOICE', estimate.id, req.user.userId, req.user.tenantId, {
      invoiceId: result.invoice.id,
      invoiceNum: result.invoice.invoiceNum,
      amount: result.invoice.amount,
    });
    await writeAudit('Invoice', 'CREATE', result.invoice.id, req.user.userId, req.user.tenantId, {
      invoiceNum: result.invoice.invoiceNum,
      amount: result.invoice.amount,
      sourceEstimateId: estimate.id,
      via: 'estimate-conversion',
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to convert estimate to invoice" });
  }
});

// DELETE /api/estimates/:id — soft-delete (#167). ADMIN only. Idempotent.
// Cascade onDelete on EstimateLineItem is unchanged (only fires on hard-delete,
// which we no longer perform here).
router.delete("/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });
    const existing = await prisma.estimate.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Estimate not found" });
    if (existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, softDeleted: true });
    }
    try {
      await prisma.auditLog.create({
        data: { action: "SOFT_DELETE", entity: "Estimate", entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ estimateNum: existing.estimateNum, title: existing.title }) }
      });
    } catch (_) { /* audit failures must not block */ }
    const estimate = await prisma.estimate.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    res.json({ ...estimate, message: "Estimate soft-deleted", softDeleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete estimate" });
  }
});

// POST /api/estimates/:id/restore — undo a soft-delete (#167)
router.post("/:id/restore", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });
    const existing = await prisma.estimate.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Estimate not found" });
    if (!existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, restored: false });
    }
    try {
      await prisma.auditLog.create({
        data: { action: "RESTORE", entity: "Estimate", entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ estimateNum: existing.estimateNum }) }
      });
    } catch (_) { /* non-critical */ }
    const estimate = await prisma.estimate.update({
      where: { id: existing.id },
      data: { deletedAt: null },
      include: { contact: true, deal: true, lineItems: true },
    });
    res.json({ ...estimate, restored: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to restore estimate" });
  }
});

// #603: per-row PDF + Email actions for the Estimates list. Pre-fix the
// Estimates list only had Open/Edit; users had to navigate into the row
// detail to download a PDF or email a customer. Mirrors the per-row
// PDF/email pattern already in billing.js (Invoices).

// GET /api/estimates/:id/pdf — stream a PDF rendering of the estimate.
router.get("/:id/pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });
    const estimate = await prisma.estimate.findFirst({
      where: { id, tenantId: req.user.tenantId, deletedAt: null },
      include: { contact: true, lineItems: true, deal: true },
    });
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { name: true, defaultCurrency: true, locale: true },
    });
    const currency = tenant?.defaultCurrency || "USD";
    const locale = tenant?.locale || undefined;

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const filename = `${estimate.estimateNum || "EST-" + estimate.id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    doc.pipe(res);

    doc.fontSize(22).font("Helvetica-Bold").text(tenant?.name || "Globussoft CRM", 50, 50);
    doc.fontSize(10).font("Helvetica").fillColor("#666666").text("Estimate", 50, 78);

    doc.fillColor("#000000").fontSize(14).font("Helvetica-Bold")
      .text(`Estimate: ${estimate.estimateNum || "N/A"}`, 50, 120);
    doc.fontSize(10).font("Helvetica").fillColor("#333333");
    doc.text(`Title: ${estimate.title || ""}`, 50, 145);
    doc.text(`Status: ${estimate.status || "Draft"}`, 50, 162);
    doc.text(`Issued: ${new Date(estimate.createdAt).toLocaleDateString()}`, 50, 179);
    if (estimate.validUntil) {
      doc.text(`Valid until: ${new Date(estimate.validUntil).toLocaleDateString()}`, 50, 196);
    }

    doc.fontSize(12).font("Helvetica-Bold").fillColor("#000000")
      .text("Bill To:", 50, 230);
    doc.fontSize(10).font("Helvetica").fillColor("#333333")
      .text(estimate.contact?.name || "(no contact)", 50, 248)
      .text(estimate.contact?.email || "", 50, 263)
      .text(estimate.contact?.company || "", 50, 278);

    doc.moveTo(50, 310).lineTo(545, 310).strokeColor("#cccccc").stroke();

    doc.fillColor("#ffffff").rect(50, 325, 495, 28).fill("#3b82f6");
    doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
      .text("Description", 60, 333)
      .text("Qty", 340, 333)
      .text("Unit", 400, 333, { width: 60, align: "right" })
      .text("Total", 470, 333, { width: 70, align: "right" });

    let y = 365;
    doc.fillColor("#333333").font("Helvetica").fontSize(10);
    for (const li of estimate.lineItems || []) {
      const lineTotal = (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0);
      doc.text(li.description || "", 60, y, { width: 270 })
        .text(String(li.quantity || 0), 340, y)
        .text(fmtMoney(li.unitPrice, currency, locale), 400, y, { width: 60, align: "right" })
        .text(fmtMoney(lineTotal, currency, locale), 470, y, { width: 70, align: "right" });
      y += 22;
    }

    y += 10;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#cccccc").stroke();
    y += 10;
    doc.fontSize(12).font("Helvetica-Bold").fillColor("#000000")
      .text("Total:", 380, y, { width: 80, align: "right" })
      .text(fmtMoney(estimate.totalAmount, currency, locale), 470, y, { width: 70, align: "right" });

    if (estimate.notes) {
      y += 50;
      doc.fontSize(10).font("Helvetica").fillColor("#555555")
        .text("Notes:", 50, y).text(estimate.notes, 50, y + 16, { width: 495 });
    }

    doc.end();
  } catch (err) {
    console.error("[estimates] pdf error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate estimate PDF" });
    }
  }
});

// POST /api/estimates/:id/email — email the estimate (with PDF link) to its
// linked contact. Records an EmailMessage row + Activity. The actual SendGrid
// dispatch reuses the same env var as routes/communications.js.
router.post("/:id/email", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });
    const estimate = await prisma.estimate.findFirst({
      where: { id, tenantId: req.user.tenantId, deletedAt: null },
      include: { contact: true, lineItems: true },
    });
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });

    // Allow override via body.to; default to the linked contact.
    const to = (req.body && req.body.to) || estimate.contact?.email;
    if (!to) {
      return res.status(400).json({
        error: "Estimate has no contact email; pass `to` in the request body.",
        code: "NO_RECIPIENT",
      });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { name: true, defaultCurrency: true, locale: true, emailRetention: true },
    });
    const currency = tenant?.defaultCurrency || "USD";
    const locale = tenant?.locale || undefined;
    const senderName = tenant?.name || "Globussoft CRM";

    const subject = req.body?.subject || `Estimate ${estimate.estimateNum} from ${senderName}`;
    const body = req.body?.body || (
      `Hello ${estimate.contact?.name || "there"},\n\n` +
      `Please find your estimate "${estimate.title}" for a total of ` +
      `${fmtMoney(estimate.totalAmount, currency, locale)}.\n\n` +
      (estimate.validUntil
        ? `Valid until: ${new Date(estimate.validUntil).toLocaleDateString()}\n\n`
        : "") +
      `Thanks,\n${senderName}`
    );

    // Persist the EmailMessage row when retention is on (#611).
    let emailRecord = null;
    const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";
    if (tenant?.emailRetention !== false) {
      emailRecord = await prisma.emailMessage.create({
        data: {
          subject,
          body,
          from: FROM_EMAIL,
          to,
          direction: "OUTBOUND",
          read: true,
          contactId: estimate.contactId || null,
          userId: req.user.userId,
          tenantId: req.user.tenantId,
        },
      });
    }

    // Best-effort SendGrid dispatch. If the key isn't configured (CI / local
    // dev), the row still lands but `delivered` is false.
    let delivered = false;
    let reason = "no_api_key";
    if (process.env.SENDGRID_API_KEY) {
      try {
        const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.SENDGRID_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: to }] }],
            from: { email: FROM_EMAIL, name: senderName },
            subject,
            content: [{ type: "text/plain", value: body }],
          }),
        });
        delivered = r.ok;
        if (!r.ok) reason = `sendgrid_${r.status}`;
      } catch (err) {
        reason = err.message || "send_error";
      }
    }

    if (estimate.contactId) {
      await prisma.activity.create({
        data: {
          type: "Email",
          description: `Sent estimate ${estimate.estimateNum}: "${estimate.title}"`,
          contactId: estimate.contactId,
          userId: req.user.userId,
          tenantId: req.user.tenantId,
        },
      }).catch(() => { /* non-critical */ });
    }

    // Flip status from Draft → Sent on first email so the ledger reflects it.
    const wasFirstSend = estimate.status === "Draft";
    if (wasFirstSend) {
      try {
        await prisma.estimate.update({ where: { id: estimate.id }, data: { status: "Sent" } });
      } catch (_e) { /* ignore */ }
    }

    await writeAudit('Estimate', 'EMAIL', estimate.id, req.user.userId, req.user.tenantId, {
      to, delivered, retainedMessage: !!emailRecord,
    }).catch(() => { /* audit non-critical */ });

    // #929 Part B — fire-and-forget webhook emission for first-send.
    // Subscribers (Callified.ai, partner SaaSes) can react to quote
    // lifecycle without polling. Only fires on Draft → Sent transition
    // (avoid duplicate emissions on re-sends). Uses shared safeEmitEvent
    // helper (extracted to lib/eventBus.js tick #47).
    if (wasFirstSend) {
      const { safeEmitEvent } = require("../lib/eventBus");
      safeEmitEvent(
        "quote.sent",
        {
          id: estimate.id,
          estimateNumber: estimate.estimateNum,
          contactId: estimate.contactId || null,
          to,
          delivered,
          totalAmount: estimate.totalAmount,
          currency,
          validUntil: estimate.validUntil,
          tenantId: req.user.tenantId,
          sentAt: new Date().toISOString(),
        },
        req.user.tenantId,
        "estimates/email",
      );
    }

    res.json({
      success: true,
      delivered,
      to,
      email: emailRecord,
      ...(delivered ? {} : { reason }),
    });
  } catch (err) {
    console.error("[estimates] email error:", err);
    res.status(500).json({ error: "Failed to email estimate" });
  }
});

module.exports = router;
