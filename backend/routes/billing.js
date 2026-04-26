const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");

const router = express.Router();
const prisma = require("../lib/prisma");

// Fetch all ledgers for current tenant
router.get("/", verifyToken, async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { tenantId: req.user.tenantId },
      include: { contact: true, deal: true },
      orderBy: [{ status: "desc" }, { dueDate: "asc" }]
    });
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: "Failed to locate invoice ledger" });
  }
});

// #196: deep-link / portal / SMS-link load — fetch a single invoice by id.
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
      include: { contact: true, deal: true }
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch invoice" });
  }
});

// Draft new Invoice
router.post("/", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const { amount, dueDate, contactId, dealId } = req.body;
    // #158 #177: validate amount > 0 and within sane cap, dueDate >= today.
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "amount must be greater than 0", code: "INVALID_AMOUNT" });
    }
    if (amt > 1e10) {
      return res.status(400).json({ error: "amount exceeds maximum allowed", code: "AMOUNT_TOO_HIGH" });
    }
    // #198: reject sub-paise precision. The smallest currency unit is 0.01 —
    // anything finer drifts under aggregation and breaks GST filings. The
    // 1e-9 epsilon swallows JS float noise (0.1+0.2 type artefacts) while
    // still catching genuine 6-decimal inputs like 123.456789.
    if (Math.abs(amt - Math.round(amt * 100) / 100) > 1e-9) {
      return res.status(400).json({ error: "amount must have at most 2 decimal places", code: "INVALID_AMOUNT_PRECISION" });
    }
    const due = dueDate ? new Date(dueDate) : null;
    if (!due || Number.isNaN(due.getTime())) {
      return res.status(400).json({ error: "dueDate is required and must be a valid date", code: "INVALID_DUE_DATE" });
    }
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    if (due < todayStart) {
      return res.status(400).json({ error: "dueDate cannot be in the past", code: "DUE_DATE_IN_PAST" });
    }
    if (!contactId) {
      return res.status(400).json({ error: "contactId is required", code: "CONTACT_REQUIRED" });
    }
    const invNum = `INV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNum: invNum,
        amount: Math.round(amt * 100) / 100, // #198: store to-the-paise; reject was above
        dueDate: due,
        contactId: parseInt(contactId),
        dealId: dealId ? parseInt(dealId) : null,
        tenantId: req.user.tenantId,
      },
      include: { contact: true, deal: true }
    });
    res.status(201).json(invoice);
  } catch (err) {
    res.status(500).json({ error: "Invoice compilation and issuance failed" });
  }
});

// #177: POST /:id/pay alias for the existing PUT /:id/pay so older clients
// (and the bug reporter's POST attempts) work without the API contract gymnastics.
router.post("/:id/pay", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    const wasPaid = existing.status === "PAID";
    const data = { status: "PAID" };
    if (!wasPaid) data.paidAt = new Date();
    const invoice = await prisma.invoice.update({ where: { id: existing.id }, data, include: { contact: true } });
    if (!wasPaid) {
      try {
        require("../lib/eventBus").emitEvent(
          "invoice.paid",
          { invoiceId: invoice.id, amount: invoice.amount, contactId: invoice.contactId, paidAt: invoice.paidAt },
          req.user.tenantId,
          req.io
        );
      } catch(e) {}
    }
    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: "Payment reconciliation operation failed" });
  }
});

// Reconcile Payment (Mark as Paid)
router.put("/:id/pay", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    // #119: stamp paidAt so "Paid This Month" KPI can filter on it. Don't overwrite
    // if already paid (preserves the original payment date).
    const wasPaid = existing.status === "PAID";
    const data = { status: "PAID" };
    if (!wasPaid) data.paidAt = new Date();
    const invoice = await prisma.invoice.update({
      where: { id: existing.id },
      data,
      include: { contact: true }
    });
    if (!wasPaid) {
      try {
        require("../lib/eventBus").emitEvent(
          "invoice.paid",
          { invoiceId: invoice.id, amount: invoice.amount, contactId: invoice.contactId, paidAt: invoice.paidAt },
          req.user.tenantId,
          req.io
        );
      } catch(e) {}
    }
    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: "Payment reconciliation operation failed" });
  }
});

// Generate Invoice PDF
router.get("/:id/pdf", verifyToken, async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
      include: { contact: true },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const doc = new PDFDocument({ size: "A4", margin: 50 });

    const filename = `${invoice.invoiceNum || "INV-" + invoice.id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    doc.pipe(res);

    // Header
    doc.fontSize(24).font("Helvetica-Bold").text("Globussoft CRM", 50, 50);
    doc.fontSize(10).font("Helvetica").fillColor("#666666")
      .text("Enterprise Invoice", 50, 80);

    // Invoice details box
    doc.fillColor("#000000").fontSize(14).font("Helvetica-Bold")
      .text(`Invoice: ${invoice.invoiceNum || "N/A"}`, 50, 130);

    doc.fontSize(10).font("Helvetica").fillColor("#333333");
    const statusLabel = invoice.status || "UNPAID";
    doc.text(`Status: ${statusLabel}`, 50, 155);
    doc.text(`Issue Date: ${new Date(invoice.createdAt).toLocaleDateString()}`, 50, 172);
    doc.text(`Due Date: ${new Date(invoice.dueDate).toLocaleDateString()}`, 50, 189);

    // Contact info
    doc.fontSize(12).font("Helvetica-Bold").fillColor("#000000")
      .text("Bill To:", 50, 225);
    doc.fontSize(10).font("Helvetica").fillColor("#333333")
      .text(invoice.contact?.name || "Unknown Contact", 50, 245)
      .text(invoice.contact?.email || "", 50, 260)
      .text(invoice.contact?.company || "", 50, 275);

    // Line separator
    doc.moveTo(50, 310).lineTo(545, 310).strokeColor("#cccccc").stroke();

    // Amount table header
    doc.fillColor("#ffffff").rect(50, 325, 495, 30).fill("#3b82f6");
    doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
      .text("Description", 60, 333)
      .text("Amount", 450, 333, { width: 85, align: "right" });

    // Amount row
    doc.fillColor("#333333").font("Helvetica").fontSize(10)
      .text("Invoice Charge", 60, 370)
      .text(`$${Number(invoice.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 450, 370, { width: 85, align: "right" });

    // Total
    doc.moveTo(50, 400).lineTo(545, 400).strokeColor("#cccccc").stroke();
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#000000")
      .text("Total:", 350, 415)
      .text(`$${Number(invoice.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 450, 415, { width: 85, align: "right" });

    // Footer
    doc.fontSize(8).font("Helvetica").fillColor("#999999")
      .text("Generated by Globussoft CRM", 50, 750, { align: "center" });

    doc.end();
  } catch (err) {
    console.error("[PDF Generation Error]:", err);
    res.status(500).json({ error: "Failed to generate invoice PDF" });
  }
});

// Set invoice as recurring
router.put("/:id/recurring", verifyToken, async (req, res) => {
  try {
    const { isRecurring, recurFrequency } = req.body;
    const invoice = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const nextDate = isRecurring ? new Date() : null;
    if (nextDate && recurFrequency) {
      switch (recurFrequency) {
        case "monthly": nextDate.setMonth(nextDate.getMonth() + 1); break;
        case "quarterly": nextDate.setMonth(nextDate.getMonth() + 3); break;
        case "yearly": nextDate.setFullYear(nextDate.getFullYear() + 1); break;
      }
    }

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { isRecurring: !!isRecurring, recurFrequency: recurFrequency || null, nextRecurDate: nextDate },
      include: { contact: true }
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to update recurring status" });
  }
});

// Soft-void: status flips to VOIDED, row + audit trail preserved.
// This is what the UI's "Void" button calls.
async function voidInvoiceHandler(req, res) {
  try {
    const existing = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (existing.status === "PAID") return res.status(400).json({ error: "Cannot void a paid invoice — use /refund instead", code: "INVOICE_ALREADY_PAID" });
    if (existing.status === "VOIDED") return res.json({ ...existing, idempotent: true });
    const invoice = await prisma.invoice.update({
      where: { id: existing.id },
      data: { status: "VOIDED" },
      include: { contact: true, deal: true }
    });
    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: "Failed to void invoice" });
  }
}
router.put("/:id/void", verifyToken, verifyRole(["ADMIN", "MANAGER"]), voidInvoiceHandler);
// #193: POST alias so callers that follow REST conventions (POST for actions) work.
router.post("/:id/void", verifyToken, verifyRole(["ADMIN", "MANAGER"]), voidInvoiceHandler);

// #193: refund a PAID invoice. Status flips to REFUNDED; original paidAt
// preserved so we still know when money came in. Partial refunds are not
// supported here yet — for partial reversals issue a credit-note instead.
router.post("/:id/refund", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const existing = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (existing.status !== "PAID") {
      return res.status(400).json({ error: "Only PAID invoices can be refunded", code: "INVOICE_NOT_PAID" });
    }
    const invoice = await prisma.invoice.update({
      where: { id: existing.id },
      data: { status: "REFUNDED" },
      include: { contact: true, deal: true }
    });
    res.json(invoice);
  } catch (err) {
    console.error("[billing] refund error:", err);
    res.status(500).json({ error: "Failed to refund invoice" });
  }
});

// #193: GST-compliant credit note — creates a NEW invoice with a negative
// amount, linked back to the original via parentInvoiceId. The original row
// is left as-is (PAID stays PAID), the credit note carries its own CN- number
// and shows up alongside the original in the ledger.
router.post("/:id/credit-note", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const original = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!original) return res.status(404).json({ error: "Invoice not found" });
    if (original.status === "VOIDED") return res.status(400).json({ error: "Cannot issue credit note against a voided invoice", code: "INVOICE_VOIDED" });

    const requestedAmount = req.body.amount !== undefined ? Number(req.body.amount) : Number(original.amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      return res.status(400).json({ error: "credit-note amount must be greater than 0", code: "INVALID_AMOUNT" });
    }
    if (requestedAmount > Number(original.amount) + 1e-9) {
      return res.status(400).json({ error: "credit-note amount cannot exceed the original invoice amount", code: "AMOUNT_EXCEEDS_ORIGINAL" });
    }
    const cnAmount = -1 * (Math.round(requestedAmount * 100) / 100);
    const cnNum = `CN-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const creditNote = await prisma.invoice.create({
      data: {
        invoiceNum: cnNum,
        amount: cnAmount,
        dueDate: original.dueDate,
        contactId: original.contactId,
        dealId: original.dealId,
        parentInvoiceId: original.id,
        status: "CREDIT_NOTE",
        tenantId: req.user.tenantId,
      },
      include: { contact: true, deal: true }
    });
    res.status(201).json({ creditNote, originalInvoiceId: original.id, reason: req.body.reason || null });
  } catch (err) {
    console.error("[billing] credit-note error:", err);
    res.status(500).json({ error: "Failed to issue credit note" });
  }
});

// #122 reopen: DELETE was a hard delete that destroyed billing records. Now
// it's a soft-void — same code path as PUT/POST /:id/void. The verb stays
// for backwards-compat with any old client, but the data is preserved.
router.delete("/:id", verifyToken, verifyRole(["ADMIN"]), voidInvoiceHandler);

module.exports = router;
