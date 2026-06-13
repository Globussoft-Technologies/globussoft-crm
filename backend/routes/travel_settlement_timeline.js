// PRD_TRAVEL_BILLING G024 (FR-3.6.c) — settlement-timeline aggregator.
//
// Drives the SettlementGantt.jsx Gantt-chart UI. One read-only endpoint
// returns the unified inflow (TravelPaymentSchedule) + outflow
// (TravelSupplierPayable) timeline for a date range, colour-coded by
// status. Sub-brand isolation: payables join through their supplier's
// subBrand; payment-schedule milestones join through their invoice's
// subBrand.
//
// Endpoint:
//   GET /api/travel/settlements/timeline
//        ?from=YYYY-MM-DD  (inclusive)
//        ?to=YYYY-MM-DD    (inclusive)
//        ?subBrand=...     (optional — narrows on both sides)
//
// Response shape (matches the prompt's contract):
//   {
//     items: [
//       { type: "invoice_payment_schedule", id, invoiceId, supplierId: null,
//         dueDate, amount, status, label },
//       { type: "supplier_payable", id, supplierId, invoiceId: null,
//         dueDate, amount, status, label },
//     ],
//     summary: { totalInflowExpected, totalOutflowExpected, netExpected }
//   }
//
// Colour mapping is a frontend concern; the route just emits raw status
// strings so the UI can map green/amber/red without hardcoded coupling.

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
} = require("../middleware/travelGuards");

function parseDate(s, fallback) {
  if (!s) return fallback;
  const d = new Date(String(s));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

router.get(
  "/settlements/timeline",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const now = new Date();
      const defaultFrom = new Date(now);
      defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
      const defaultTo = new Date(now);
      defaultTo.setUTCDate(defaultTo.getUTCDate() + 90);

      const from = parseDate(req.query.from, defaultFrom);
      const to = parseDate(req.query.to, defaultTo);
      if (!from || !to) {
        return res.status(400).json({ error: "from / to must be ISO dates", code: "INVALID_DATE_RANGE" });
      }
      if (from > to) {
        return res.status(400).json({ error: "from must be <= to", code: "INVERTED_DATE_RANGE" });
      }

      const subBrand = req.query.subBrand ? String(req.query.subBrand) : null;
      const allowed = await getSubBrandAccessSet(req.user.userId);
      // If operator's allowed set is non-null AND request's subBrand isn't
      // in it → 403. Same gate pattern as other sub-brand-scoped reads.
      if (allowed && subBrand && !allowed.has(subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }
      const allowedBrands = allowed ? Array.from(allowed) : null;

      // ── inflow: TravelPaymentSchedule ──
      const schedWhere = {
        tenantId: req.travelTenant.id,
        dueDate: { gte: from, lte: to },
      };
      if (subBrand) {
        schedWhere.invoice = { subBrand };
      } else if (allowedBrands) {
        schedWhere.invoice = { subBrand: { in: allowedBrands } };
      }

      // ── outflow: TravelSupplierPayable ──
      const payWhere = {
        tenantId: req.travelTenant.id,
        dueDate: { gte: from, lte: to },
      };
      if (subBrand) {
        payWhere.supplier = { subBrand };
      } else if (allowedBrands) {
        payWhere.supplier = { subBrand: { in: allowedBrands } };
      }

      const [schedules, payables] = await Promise.all([
        prisma.travelPaymentSchedule.findMany({
          where: schedWhere,
          include: {
            invoice: { select: { id: true, invoiceNum: true, subBrand: true } },
          },
          orderBy: { dueDate: "asc" },
        }),
        prisma.travelSupplierPayable.findMany({
          where: payWhere,
          include: {
            supplier: { select: { id: true, name: true, subBrand: true } },
          },
          orderBy: { dueDate: "asc" },
        }),
      ]);

      const items = [];
      let totalInflowExpected = 0;
      let totalOutflowExpected = 0;
      for (const s of schedules) {
        const amt = Number(s.expectedAmount || 0);
        const status = s.status || "pending";
        items.push({
          type: "invoice_payment_schedule",
          id: s.id,
          invoiceId: s.invoiceId,
          supplierId: null,
          dueDate: s.dueDate,
          amount: amt,
          currency: s.expectedCurrency || "INR",
          status,
          label: `${s.invoice ? s.invoice.invoiceNum : "INV-?"} M${s.milestoneOrder}`,
        });
        if (!["paid", "waived", "cancelled"].includes(status)) {
          totalInflowExpected += amt;
        }
      }
      for (const p of payables) {
        const amt = Number(p.amount || 0);
        const status = p.status || "pending";
        items.push({
          type: "supplier_payable",
          id: p.id,
          invoiceId: null,
          supplierId: p.supplierId,
          dueDate: p.dueDate,
          amount: amt,
          currency: p.currency || "INR",
          status,
          label: `${p.supplier ? p.supplier.name : "Supplier?"} — ${p.description || ""}`.slice(0, 120),
        });
        if (!["paid", "cancelled"].includes(status)) {
          totalOutflowExpected += amt;
        }
      }

      // Sort merged items by dueDate ascending so the UI can render
      // chronologically. null dueDates go to the end.
      items.sort((a, b) => {
        if (a.dueDate == null) return 1;
        if (b.dueDate == null) return -1;
        return new Date(a.dueDate) - new Date(b.dueDate);
      });

      res.json({
        items,
        summary: {
          totalInflowExpected,
          totalOutflowExpected,
          netExpected: totalInflowExpected - totalOutflowExpected,
        },
        range: { from: from.toISOString(), to: to.toISOString() },
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-settlement-timeline] error:", e.message);
      res.status(500).json({ error: "Failed to load settlement timeline" });
    }
  },
);

module.exports = router;
