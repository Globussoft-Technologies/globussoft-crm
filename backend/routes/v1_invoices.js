// Wave 7C — `/api/v1/invoices` stable public-API alias for the legacy
// `/api/billing` route surface (PRD Gap §2 items 7a–d).
//
// Why: PRD Gap doc §2 wants the `/api/v1` namespace as the canonical public
// API positioning for invoice CRUD. The legacy /api/billing path stays for
// backwards-compat with frontend + scim/zapier consumers; this shim mounts a
// thin handler set under /api/v1/invoices that delegates to the same core
// logic.
//
// Mapping:
//   GET    /api/v1/invoices              → routes/billing.js GET  /
//   GET    /api/v1/invoices/:id          → routes/billing.js GET  /:id
//   POST   /api/v1/invoices              → routes/billing.js POST /
//   PATCH  /api/v1/invoices/:id          → routes/billing.js PATCH /:id
//   POST   /api/v1/invoices/:id/payments → NEW (PRD §2 item 7c) — Payment
//                                          row create, auto-flip invoice
//                                          status to PAID when sum reaches
//                                          grand_total ±0.01
//   POST   /api/v1/invoices/:id/complete → routes/billing.js POST /:id/mark-paid
//
// Implementation: instead of copy-pasting handlers, we re-mount the existing
// billing router on this prefix for the shared paths, and add a single new
// payments-create endpoint here. The routes that need a different name
// (mark-paid → /complete; new payments endpoint) get explicit aliases
// declared BEFORE the catch-all billing router pickup so Express's
// first-match-wins dispatch lands on them.
//
// Cross-route validation: §2 item 8 wants `sum(payments) == grand_total ±0.01`
// to auto-flip status. The new POST /:id/payments handler computes the running
// sum after each insert and updates Invoice.status to PAID when reached. The
// `invoice.completed` event is then emitted (sister to billing.js's mark-paid
// emission) so analytics consumers see the same lifecycle event regardless of
// whether the flip came from /complete or from a Payment-row reaching the
// total.

const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
const billingRouter = require("./billing");

const router = express.Router();

// Tolerance for the floating-point sum-equals-total comparison. 0.01 = one
// paise/cent — anything finer is FP noise (0.1 + 0.2 type artefacts) and
// shouldn't block an auto-flip.
const PAYMENT_SUM_TOLERANCE = 0.01;

// ── POST /:id/payments — new endpoint per PRD §2 item 7c ──────────────
//
// Body: { method, amount, currency?, gateway?, reference? }
// Validates: invoice exists in tenant, invoice.status !== VOIDED,
//            amount > 0 (number), method is a non-empty string.
// Side-effects:
//   - Creates a Payment row with gateway=method (or explicit gateway field),
//     gatewayId=reference, amount/currency, status=SUCCESS, paidAt=now.
//   - Re-reads sum of SUCCESS Payment rows for this invoice.
//   - When sum >= invoice.amount - 0.01 AND invoice.status !== PAID, flips
//     status to PAID + emits invoice.completed + payment.collected.
// Returns: { payment, invoice, totalPaid, fullyPaid }.
router.post("/:id/payments", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid invoice id", code: "INVALID_ID" });
    }
    const { method, amount, currency, gateway, reference } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res
        .status(400)
        .json({ error: "amount must be greater than 0", code: "INVALID_AMOUNT" });
    }
    if (!method || typeof method !== "string" || !method.trim()) {
      return res
        .status(400)
        .json({ error: "method is required", code: "METHOD_REQUIRED" });
    }
    const invoice = await prisma.invoice.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === "VOIDED") {
      return res.status(409).json({
        error: "Cannot record payment against a voided invoice",
        code: "INVOICE_VOIDED",
      });
    }

    const paidAt = new Date();
    const resolvedCurrency = (typeof currency === "string" && currency.trim())
      ? currency.trim().toUpperCase()
      : "USD";
    const resolvedGateway = (typeof gateway === "string" && gateway.trim())
      ? gateway.trim().toLowerCase()
      : method.trim().toLowerCase();

    const payment = await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amount: amt,
        currency: resolvedCurrency,
        gateway: resolvedGateway,
        gatewayId: reference ? String(reference).slice(0, 128) : null,
        status: "SUCCESS",
        paidAt,
        tenantId: req.user.tenantId,
      },
    });

    // Recompute the SUCCESS-payment sum to decide whether this push reaches
    // the grand_total. The aggregate is a simple sum across the invoice's
    // Payment rows — keeps the invariant in one place rather than tracking
    // a running total on Invoice (which would drift on out-of-band Payment
    // edits or webhook reconciles).
    const agg = await prisma.payment.aggregate({
      where: { invoiceId: invoice.id, tenantId: req.user.tenantId, status: "SUCCESS" },
      _sum: { amount: true },
    });
    const totalPaid = Number(agg._sum.amount || 0);
    const target = Number(invoice.amount);
    const fullyPaid = totalPaid + PAYMENT_SUM_TOLERANCE >= target;

    let updatedInvoice = invoice;
    if (fullyPaid && invoice.status !== "PAID") {
      updatedInvoice = await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: "PAID", paidAt },
      });
      // Emit the same trio as billing.js POST /:id/mark-paid so analytics
      // consumers don't need a separate subscription per code path.
      try {
        require("../lib/eventBus").emitEvent(
          "invoice.paid",
          {
            invoiceId: updatedInvoice.id,
            amount: updatedInvoice.amount,
            contactId: updatedInvoice.contactId,
            paidAt: updatedInvoice.paidAt,
            paymentMethod: method,
            transactionRef: reference || null,
          },
          req.user.tenantId,
          req.io
        );
      } catch (_e) { /* best-effort */ }
      try {
        require("../lib/eventBus").emitEvent(
          "invoice.completed",
          {
            invoiceId: updatedInvoice.id,
            invoiceNum: updatedInvoice.invoiceNum,
            amount: updatedInvoice.amount,
            contactId: updatedInvoice.contactId,
            dealId: updatedInvoice.dealId,
            paidAt: updatedInvoice.paidAt,
            status: updatedInvoice.status,
          },
          req.user.tenantId,
          req.io
        );
      } catch (_e) { /* best-effort */ }
      try {
        require("../lib/eventBus").emitEvent(
          "payment.collected",
          {
            invoiceId: updatedInvoice.id,
            paymentId: payment.id,
            amount: amt,
            method: resolvedGateway,
            currency: resolvedCurrency,
            transactionRef: reference || null,
            paidAt,
          },
          req.user.tenantId,
          req.io
        );
      } catch (_e) { /* best-effort */ }

      await writeAudit(
        "Invoice",
        "MARK_PAID",
        updatedInvoice.id,
        req.user.userId,
        req.user.tenantId,
        {
          invoiceNum: updatedInvoice.invoiceNum,
          amount: updatedInvoice.amount,
          via: "v1_invoices.payments",
          totalPaid,
          paymentId: payment.id,
        }
      );
    } else {
      // Partial-pay emits payment.collected only — no invoice flip.
      try {
        require("../lib/eventBus").emitEvent(
          "payment.collected",
          {
            invoiceId: invoice.id,
            paymentId: payment.id,
            amount: amt,
            method: resolvedGateway,
            currency: resolvedCurrency,
            transactionRef: reference || null,
            paidAt,
          },
          req.user.tenantId,
          req.io
        );
      } catch (_e) { /* best-effort */ }
    }

    res.status(201).json({
      payment,
      invoice: updatedInvoice,
      totalPaid: +totalPaid.toFixed(2),
      fullyPaid,
    });
  } catch (err) {
    console.error("[v1_invoices/payments] error:", err);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// ── POST /:id/complete — alias for /mark-paid per PRD §2 item 7d ──────
//
// Re-route the request through billingRouter's POST /:id/mark-paid by
// rewriting the URL and calling the billing router's handler chain. This
// keeps the single source of truth for the mark-paid contract in
// routes/billing.js (idempotency, terminal-status guard, event trio) and
// avoids drift between the two surfaces.
router.post("/:id/complete", (req, res, next) => {
  req.url = `/${req.params.id}/mark-paid`;
  return billingRouter.handle(req, res, next);
});

// ── Catch-all delegation: GET / GET/:id / POST / PATCH /:id ──────────
//
// Every other path goes through the billing router unchanged. Order matters:
// the explicit /:id/payments + /:id/complete handlers above run first, then
// this catch-all picks up the remaining surfaces. Express's router-as-handler
// pattern handles auth + verifyRole on each path the same way it does at
// /api/billing, so RBAC stays consistent across both prefixes.
router.use("/", billingRouter);

module.exports = router;
