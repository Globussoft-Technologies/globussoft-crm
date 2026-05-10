// Wave 2 Agent II — POS / cash register / shift / sale backbone (Google Doc
// audit, 8 May 2026 — "Confirmed-missing entirely" row 1).
//
// This module owns the wellness-vertical Point-of-Sale primitives:
//
//   Register          — physical/virtual cash register per Location.
//                       ADMIN-only CRUD.
//   Shift             — register session (open → close). One OPEN shift per
//                       Register at any time. Cashier (or ADMIN) closes it.
//                       Variance = closingTotal - expectedCash.
//   Sale + LineItems  — cash-and-carry checkout (sibling of Invoice). Uses
//                       polymorphic SaleLineItem (lineType + refId) so the
//                       same line model handles SERVICE / PRODUCT / MEMBERSHIP
//                       / GIFTCARD / PACKAGE without 5 nullable FKs.
//
// Why a separate file (not extending wellness.js): wellness.js is 5k+ lines
// and concurrent agents are touching it. A separate route file mounted at
// /api/pos lets II ship without colliding with sibling waves.
//
// All endpoints are wellness-vertical-gated (verifyWellnessRole) so generic
// CRM tenants get a clean 403. Admin/manager can do everything; clinical
// staff (doctor/professional/telecaller/helper) can open + close their OWN
// shifts and ring up sales while their shift is open. Refunds + register
// CRUD are admin/manager only.
//
// Tenant scope: every read/write filters by req.user.tenantId via tenantWhere.
// Audit: every mutation emits writeAudit('Register' | 'Shift' | 'Sale', ...)
// so the audit hash chain captures POS activity for compliance.

const express = require("express");
const prisma = require("../lib/prisma");
const { writeAudit, diffFields } = require("../lib/audit");
const { verifyWellnessRole } = require("../middleware/wellnessRole");

const router = express.Router();

const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });

// admin/manager can do everything; clinical staff (doctor/professional/
// telecaller/helper) can ring up sales + manage their own shift but not
// configure registers / refund.
const adminGate = verifyWellnessRole(["admin", "manager"]);
const cashierGate = verifyWellnessRole([
  "admin",
  "manager",
  "doctor",
  "professional",
  "telecaller",
  "helper",
]);

// ── Sale-side loyalty auto-credit (PRD Gap §2 item 9) ────────────────
// Sibling of routes/wellness.js maybeAutoCreditLoyalty(visit, ...). The
// visit-side helper credits on Visit completion using visit.amountCharged;
// the sale-side helper credits on Sale completion using sale.total. Same
// LoyaltyConfig rules (earnPerVisit, earnPercentOfSpend, earnPerCurrencyUnit,
// autoEarnEnabled) apply uniformly across both completion surfaces — a sale
// to a patient is the same earnable economic event as a visit charge, so
// rule semantics are reused 1:1.
//
// Idempotency: LoyaltyTransaction has a `visitId` column but no `saleId`.
// Adding a column would step into Agent 6D's schema turf, so we use a
// reason-based idempotency probe ("Sale #<id> (auto earn)") — a second
// invocation with the same sale id finds the existing row and no-ops.
//
// Failures swallowed so a flaky loyalty layer can never red a legitimate
// sale create. Same-shape contract as the visit-side helper.
async function maybeAutoCreditLoyaltyForSale(sale, tenantId) {
  try {
    if (!sale || sale.status !== "COMPLETED") return;
    if (!sale.patientId) return; // anonymous walk-in — no loyalty link
    let cfg;
    try {
      cfg = await prisma.loyaltyConfig.findUnique({ where: { tenantId } });
    } catch {
      cfg = null;
    }
    const autoEnabled = cfg ? cfg.autoEarnEnabled !== false : true;
    if (!autoEnabled) return;
    const earnPerVisit = cfg?.earnPerVisit ?? 0;
    const earnPercent = cfg?.earnPercentOfSpend ?? 10;
    const earnPerUnit = cfg?.earnPerCurrencyUnit ?? 0;

    const amt = parseFloat(sale.total) || 0;
    let points = earnPerVisit;
    if (amt > 0) {
      points += Math.floor((amt * earnPercent) / 100);
      points += Math.floor(amt * earnPerUnit);
    }
    if (points <= 0) return;
    const reason = `Sale #${sale.id} (auto earn)`;
    // Idempotency probe — match on patient + tenant + reason. Same
    // semantics as the visit-side visitId probe.
    const existing = await prisma.loyaltyTransaction.findFirst({
      where: { tenantId, patientId: sale.patientId, type: "earned", reason },
      select: { id: true },
    });
    if (existing) return;
    await prisma.loyaltyTransaction.create({
      data: {
        patientId: sale.patientId,
        tenantId,
        type: "earned",
        points,
        reason,
      },
    });
  } catch (err) {
    console.error("[pos] auto-credit loyalty failed:", err.message);
  }
}

// ── invoiceNumber generator ──────────────────────────────────────────
// Tenant-scoped human-readable receipt id "POS-YYYY-NNNN". Inlined here
// because it's a single use; if a second route needs the same shape we'll
// promote it to backend/lib/posInvoiceNumber.js (mirrors lib/inventoryReceiptNumber.js).

function formatInvoiceNumber(year, seq) {
  return `POS-${year}-${String(seq).padStart(4, "0")}`;
}

function parseInvoiceNumber(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^POS-(\d{4})-(\d+)$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), seq: parseInt(m[2], 10) };
}

async function generateInvoiceNumber(tx, tenantId, now = new Date()) {
  const year = now.getUTCFullYear();
  const prefix = `POS-${year}-`;
  const latest = await tx.sale.findFirst({
    where: { tenantId, invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: "desc" },
    select: { invoiceNumber: true },
  });
  let nextSeq = 1;
  if (latest) {
    const parsed = parseInvoiceNumber(latest.invoiceNumber);
    if (parsed && parsed.year === year) nextSeq = parsed.seq + 1;
  }
  return formatInvoiceNumber(year, nextSeq);
}

// ── Register CRUD ────────────────────────────────────────────────────

router.get("/registers", cashierGate, async (req, res) => {
  try {
    const { isActive } = req.query;
    const where = tenantWhere(req);
    if (isActive === "true") where.isActive = true;
    if (isActive === "false") where.isActive = false;
    const items = await prisma.register.findMany({
      where,
      orderBy: [{ name: "asc" }],
      include: { location: { select: { id: true, name: true, city: true } } },
    });
    res.json(items);
  } catch (e) {
    console.error("[pos] list registers error:", e.message);
    res.status(500).json({ error: "Failed to list registers" });
  }
});

router.get("/registers/:id", cashierGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const reg = await prisma.register.findFirst({
      where: tenantWhere(req, { id }),
      include: { location: { select: { id: true, name: true } } },
    });
    if (!reg) return res.status(404).json({ error: "Register not found" });
    res.json(reg);
  } catch (e) {
    console.error("[pos] get register error:", e.message);
    res.status(500).json({ error: "Failed to load register" });
  }
});

router.post("/registers", adminGate, async (req, res) => {
  try {
    const { locationId, name, openingFloat, isActive } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required", code: "NAME_REQUIRED" });
    }
    if (!locationId || !Number.isFinite(parseInt(locationId))) {
      return res.status(400).json({ error: "locationId is required", code: "LOCATION_REQUIRED" });
    }
    const loc = await prisma.location.findFirst({
      where: tenantWhere(req, { id: parseInt(locationId) }),
    });
    if (!loc) return res.status(400).json({ error: "locationId does not exist in this tenant", code: "LOCATION_NOT_FOUND" });
    const float = openingFloat !== undefined ? parseFloat(openingFloat) : 0;
    if (!Number.isFinite(float) || float < 0) {
      return res.status(400).json({ error: "openingFloat must be a non-negative number", code: "INVALID_FLOAT" });
    }
    const reg = await prisma.register.create({
      data: {
        name: name.trim(),
        locationId: parseInt(locationId),
        openingFloat: float,
        isActive: isActive !== false,
        tenantId: req.user.tenantId,
      },
    });
    await writeAudit("Register", "CREATE", reg.id, req.user.userId, req.user.tenantId, {
      name: reg.name,
      locationId: reg.locationId,
    });
    res.status(201).json(reg);
  } catch (e) {
    console.error("[pos] create register error:", e.message);
    res.status(500).json({ error: "Failed to create register" });
  }
});

router.put("/registers/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const existing = await prisma.register.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Register not found" });

    const data = {};
    const allowed = ["name", "openingFloat", "isActive", "locationId"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    if (data.openingFloat !== undefined) {
      const f = parseFloat(data.openingFloat);
      if (!Number.isFinite(f) || f < 0) {
        return res.status(400).json({ error: "openingFloat must be a non-negative number", code: "INVALID_FLOAT" });
      }
      data.openingFloat = f;
    }
    if (data.locationId !== undefined) {
      const loc = await prisma.location.findFirst({
        where: tenantWhere(req, { id: parseInt(data.locationId) }),
      });
      if (!loc) return res.status(400).json({ error: "locationId does not exist in this tenant", code: "LOCATION_NOT_FOUND" });
      data.locationId = parseInt(data.locationId);
    }
    if (data.name !== undefined) {
      if (typeof data.name !== "string" || !data.name.trim()) {
        return res.status(400).json({ error: "name must be a non-empty string", code: "INVALID_NAME" });
      }
      data.name = data.name.trim();
    }
    const updated = await prisma.register.update({ where: { id }, data });
    const changes = diffFields(existing, updated, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      await writeAudit("Register", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }
    res.json(updated);
  } catch (e) {
    console.error("[pos] update register error:", e.message);
    res.status(500).json({ error: "Failed to update register" });
  }
});

router.delete("/registers/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const existing = await prisma.register.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Register not found" });

    // Block delete if there's an OPEN shift on this register — operators
    // shouldn't lose drawer-state via accidental delete.
    const openShift = await prisma.shift.findFirst({
      where: tenantWhere(req, { registerId: id, status: "OPEN" }),
    });
    if (openShift) {
      return res.status(409).json({
        error: "Register has an open shift. Close it before deleting.",
        code: "REGISTER_HAS_OPEN_SHIFT",
        shiftId: openShift.id,
      });
    }
    await prisma.register.delete({ where: { id } });
    await writeAudit("Register", "DELETE", id, req.user.userId, req.user.tenantId, {
      name: existing.name,
    });
    res.status(204).end();
  } catch (e) {
    console.error("[pos] delete register error:", e.message);
    res.status(500).json({ error: "Failed to delete register" });
  }
});

// ── Shift open / close / current ─────────────────────────────────────

router.post("/shifts/open", cashierGate, async (req, res) => {
  try {
    const { registerId, openingFloat } = req.body;
    if (!registerId || !Number.isFinite(parseInt(registerId))) {
      return res.status(400).json({ error: "registerId is required", code: "REGISTER_REQUIRED" });
    }
    const reg = await prisma.register.findFirst({
      where: tenantWhere(req, { id: parseInt(registerId) }),
    });
    if (!reg) return res.status(404).json({ error: "Register not found" });
    if (!reg.isActive) {
      return res.status(409).json({ error: "Register is inactive", code: "REGISTER_INACTIVE" });
    }
    // 409 if a shift is already open on this register.
    const existing = await prisma.shift.findFirst({
      where: tenantWhere(req, { registerId: reg.id, status: "OPEN" }),
    });
    if (existing) {
      return res.status(409).json({
        error: "Register already has an open shift",
        code: "SHIFT_ALREADY_OPEN",
        shiftId: existing.id,
      });
    }
    const float =
      openingFloat !== undefined && openingFloat !== null
        ? parseFloat(openingFloat)
        : reg.openingFloat;
    if (!Number.isFinite(float) || float < 0) {
      return res.status(400).json({ error: "openingFloat must be a non-negative number", code: "INVALID_FLOAT" });
    }
    const shift = await prisma.shift.create({
      data: {
        tenantId: req.user.tenantId,
        registerId: reg.id,
        userId: req.user.userId,
        openingFloat: float,
        status: "OPEN",
      },
    });
    await writeAudit("Shift", "OPEN", shift.id, req.user.userId, req.user.tenantId, {
      registerId: reg.id,
      openingFloat: float,
    });
    // PRD Gap §13 item 4 — emit shift.opened so AutomationRules + outbound
    // webhooks can react (e.g. Slack ping the manager when a register opens).
    // Failure here MUST NOT roll back the shift create — fire-and-forget with
    // a swallow so the cashier always gets their 201.
    try {
      const { emitEvent } = require("../lib/eventBus");
      emitEvent(
        "shift.opened",
        {
          shiftId: shift.id,
          registerId: reg.id,
          userId: req.user.userId,
          openingFloat: float,
        },
        req.user.tenantId,
        req.io
      );
    } catch (_e) { /* event bus optional */ }
    res.status(201).json(shift);
  } catch (e) {
    console.error("[pos] open shift error:", e.message);
    res.status(500).json({ error: "Failed to open shift" });
  }
});

router.post("/shifts/:id/close", cashierGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const shift = await prisma.shift.findFirst({ where: tenantWhere(req, { id }) });
    if (!shift) return res.status(404).json({ error: "Shift not found" });
    if (shift.status !== "OPEN") {
      return res.status(409).json({ error: "Shift is not open", code: "SHIFT_NOT_OPEN", status: shift.status });
    }
    // Only the cashier who opened the shift OR an admin can close it.
    if (req.user.role !== "ADMIN" && shift.userId !== req.user.userId) {
      return res.status(403).json({
        error: "Only the cashier who opened this shift (or an admin) can close it",
        code: "SHIFT_NOT_OWNER",
      });
    }
    const { closingTotal, notes } = req.body;
    if (closingTotal === undefined || closingTotal === null) {
      return res.status(400).json({ error: "closingTotal is required", code: "CLOSING_TOTAL_REQUIRED" });
    }
    const closing = parseFloat(closingTotal);
    if (!Number.isFinite(closing) || closing < 0) {
      return res.status(400).json({ error: "closingTotal must be a non-negative number", code: "INVALID_CLOSING_TOTAL" });
    }
    // expectedCash = openingFloat + sum(CASH sales during shift)
    const cashSales = await prisma.sale.aggregate({
      where: {
        tenantId: req.user.tenantId,
        shiftId: shift.id,
        status: "COMPLETED",
        paymentMethod: "CASH",
      },
      _sum: { paidAmount: true },
    });
    const cashTaken = cashSales._sum.paidAmount || 0;
    const expectedCash = shift.openingFloat + cashTaken;
    const variance = closing - expectedCash;
    const closed = await prisma.shift.update({
      where: { id },
      data: {
        closingTotal: closing,
        expectedCash,
        variance,
        notes: typeof notes === "string" ? notes.slice(0, 4000) : null,
        closedAt: new Date(),
        status: "CLOSED",
      },
    });
    await writeAudit("Shift", "CLOSE", id, req.user.userId, req.user.tenantId, {
      closingTotal: closing,
      expectedCash,
      variance,
    });
    // PRD Gap §13 item 4 — emit shift.closed so AutomationRules + webhooks can
    // react (e.g. flag |variance| > N for manager review). Variance is signed:
    // positive = drawer over expected, negative = under. Same swallow pattern
    // as shift.opened above so a flaky bus never reds a legitimate close.
    try {
      const { emitEvent } = require("../lib/eventBus");
      emitEvent(
        "shift.closed",
        {
          shiftId: id,
          registerId: shift.registerId,
          expectedCash,
          closingTotal: closing,
          variance,
        },
        req.user.tenantId,
        req.io
      );
    } catch (_e) { /* event bus optional */ }
    res.json(closed);
  } catch (e) {
    console.error("[pos] close shift error:", e.message);
    res.status(500).json({ error: "Failed to close shift" });
  }
});

router.get("/shifts/current", cashierGate, async (req, res) => {
  try {
    const shift = await prisma.shift.findFirst({
      where: tenantWhere(req, { userId: req.user.userId, status: "OPEN" }),
      include: {
        register: { select: { id: true, name: true, locationId: true } },
      },
      orderBy: { openedAt: "desc" },
    });
    res.json(shift); // null is a valid response — caller checks for it
  } catch (e) {
    console.error("[pos] current shift error:", e.message);
    res.status(500).json({ error: "Failed to load current shift" });
  }
});

router.get("/shifts", adminGate, async (req, res) => {
  try {
    const { registerId, from, to, status } = req.query;
    const where = tenantWhere(req);
    if (registerId && Number.isFinite(parseInt(registerId))) where.registerId = parseInt(registerId);
    if (status) where.status = status;
    if (from || to) {
      where.openedAt = {};
      if (from) where.openedAt.gte = new Date(from);
      if (to) where.openedAt.lte = new Date(to);
    }
    const items = await prisma.shift.findMany({
      where,
      orderBy: [{ openedAt: "desc" }],
      take: 200,
      include: {
        register: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    });
    res.json(items);
  } catch (e) {
    console.error("[pos] list shifts error:", e.message);
    res.status(500).json({ error: "Failed to list shifts" });
  }
});

router.get("/shifts/:id", cashierGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const shift = await prisma.shift.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        register: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, email: true } },
        sales: { select: { id: true, invoiceNumber: true, total: true, paymentMethod: true, status: true, createdAt: true } },
      },
    });
    if (!shift) return res.status(404).json({ error: "Shift not found" });
    // Cashiers can only see their own shifts; admin/manager can see all.
    if (
      req.user.role !== "ADMIN" &&
      req.user.role !== "MANAGER" &&
      shift.userId !== req.user.userId
    ) {
      return res.status(403).json({
        error: "Cannot view another cashier's shift",
        code: "SHIFT_NOT_OWNER",
      });
    }
    res.json(shift);
  } catch (e) {
    console.error("[pos] get shift error:", e.message);
    res.status(500).json({ error: "Failed to load shift" });
  }
});

// ── Sale create / list / get / refund ────────────────────────────────

const VALID_LINE_TYPES = ["SERVICE", "PRODUCT", "MEMBERSHIP", "GIFTCARD", "PACKAGE"];
const VALID_PAYMENT_METHODS = ["CASH", "CARD", "UPI", "WALLET", "GIFTCARD", "COMBINED"];

router.post("/sales", cashierGate, async (req, res) => {
  try {
    const {
      shiftId,
      patientId,
      lineItems,
      paymentMethod,
      paidAmount,
      discountTotal,
      taxTotal,
      paymentBreakdownJson,
    } = req.body;

    // Validate shift
    if (!shiftId || !Number.isFinite(parseInt(shiftId))) {
      return res.status(400).json({ error: "shiftId is required", code: "SHIFT_REQUIRED" });
    }
    const shift = await prisma.shift.findFirst({
      where: tenantWhere(req, { id: parseInt(shiftId) }),
    });
    if (!shift) return res.status(404).json({ error: "Shift not found" });
    if (shift.status !== "OPEN") {
      return res.status(409).json({
        error: "Cannot record a sale against a closed shift",
        code: "SHIFT_CLOSED",
      });
    }
    // Cashiers can only ring up sales on their own shift; admin/manager bypass
    if (
      req.user.role !== "ADMIN" &&
      req.user.role !== "MANAGER" &&
      shift.userId !== req.user.userId
    ) {
      return res.status(403).json({
        error: "Cannot ring up a sale on another cashier's shift",
        code: "SHIFT_NOT_OWNER",
      });
    }

    // Validate lineItems
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({ error: "lineItems must be a non-empty array", code: "LINE_ITEMS_REQUIRED" });
    }
    if (lineItems.length > 200) {
      return res.status(400).json({ error: "lineItems exceeds 200 rows", code: "LINE_ITEMS_TOO_MANY" });
    }
    const normalisedLines = [];
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      if (!li || typeof li !== "object") {
        return res.status(400).json({ error: `lineItems[${i}] must be an object`, code: "INVALID_LINE_ITEM" });
      }
      if (!VALID_LINE_TYPES.includes(li.lineType)) {
        return res.status(400).json({
          error: `lineItems[${i}].lineType must be one of ${VALID_LINE_TYPES.join(", ")}`,
          code: "INVALID_LINE_TYPE",
        });
      }
      const refId = parseInt(li.refId);
      if (!Number.isFinite(refId)) {
        return res.status(400).json({ error: `lineItems[${i}].refId must be numeric`, code: "INVALID_REF_ID" });
      }
      // Use ?? not || so quantity=0 isn't silently coerced to 1.
      const quantity = parseInt(li.quantity ?? 1);
      if (!Number.isFinite(quantity) || quantity < 1) {
        return res.status(400).json({ error: `lineItems[${i}].quantity must be >= 1`, code: "INVALID_QUANTITY" });
      }
      const unitPrice = parseFloat(li.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return res.status(400).json({ error: `lineItems[${i}].unitPrice must be >= 0`, code: "INVALID_UNIT_PRICE" });
      }
      const lineDiscount = parseFloat(li.lineDiscount || 0);
      if (!Number.isFinite(lineDiscount) || lineDiscount < 0) {
        return res.status(400).json({ error: `lineItems[${i}].lineDiscount must be >= 0`, code: "INVALID_LINE_DISCOUNT" });
      }
      const lineTotal = Math.max(0, quantity * unitPrice - lineDiscount);
      const name = (li.name && typeof li.name === "string" ? li.name : `${li.lineType} #${refId}`).slice(0, 240);
      normalisedLines.push({
        lineType: li.lineType,
        refId,
        name,
        quantity,
        unitPrice,
        lineDiscount,
        lineTotal,
      });
    }

    // Validate paymentMethod
    const pm = paymentMethod || "CASH";
    if (!VALID_PAYMENT_METHODS.includes(pm)) {
      return res.status(400).json({
        error: `paymentMethod must be one of ${VALID_PAYMENT_METHODS.join(", ")}`,
        code: "INVALID_PAYMENT_METHOD",
      });
    }

    // Compute totals
    const subtotal = normalisedLines.reduce((acc, l) => acc + l.quantity * l.unitPrice, 0);
    const lineDiscounts = normalisedLines.reduce((acc, l) => acc + l.lineDiscount, 0);
    const orderDiscount = Math.max(0, parseFloat(discountTotal || 0));
    const totalDiscount = lineDiscounts + orderDiscount;
    const tax = Math.max(0, parseFloat(taxTotal || 0));
    const total = Math.max(0, subtotal - totalDiscount + tax);
    const paid = paidAmount !== undefined ? parseFloat(paidAmount) : total;
    if (!Number.isFinite(paid) || paid < 0) {
      return res.status(400).json({ error: "paidAmount must be >= 0", code: "INVALID_PAID_AMOUNT" });
    }

    // PRD Gap §2 item 8 — `sum(payments) == grand_total ±0.01` validation.
    // When paymentMethod=COMBINED a structured breakdown JSON is required;
    // every method's amount must sum to `total` within one paise/cent. This
    // catches client-side splits that drop or duplicate a tender (a common
    // POS class-bug — the cashier hits "Add" twice, the second tender shows
    // visually but the JSON payload omits it). FP tolerance = 0.01 so float
    // noise (0.1 + 0.2 = 0.30000000000000004) doesn't trip a false negative.
    if (pm === "COMBINED") {
      let breakdown;
      if (typeof paymentBreakdownJson === "string") {
        try { breakdown = JSON.parse(paymentBreakdownJson); } catch { breakdown = null; }
      } else if (paymentBreakdownJson && typeof paymentBreakdownJson === "object") {
        breakdown = paymentBreakdownJson;
      }
      if (!Array.isArray(breakdown) || breakdown.length === 0) {
        return res.status(400).json({
          error: "paymentBreakdownJson must be a non-empty array when paymentMethod=COMBINED",
          code: "BREAKDOWN_REQUIRED",
        });
      }
      const sum = breakdown.reduce((acc, row) => {
        const a = parseFloat(row && row.amount);
        return acc + (Number.isFinite(a) ? a : 0);
      }, 0);
      if (Math.abs(sum - total) > 0.01) {
        return res.status(400).json({
          error: `sum(paymentBreakdownJson amounts) must equal grand total ±0.01 (got ${sum.toFixed(2)} vs ${total.toFixed(2)})`,
          code: "INVALID_PAYMENT_TOTAL",
          breakdownSum: +sum.toFixed(2),
          grandTotal: +total.toFixed(2),
        });
      }
    } else if (paid > 0 && Math.abs(paid - total) > 0.01) {
      // For non-COMBINED methods, paidAmount IS the entire tender. If the
      // caller supplied a paid value that mismatches the computed total
      // (and isn't 0 — 0 means "credit / charge later", a valid pattern),
      // reject 400. Same INVALID_PAYMENT_TOTAL code as the COMBINED branch
      // so consumers can handle both shapes uniformly.
      return res.status(400).json({
        error: `paidAmount must equal grand total ±0.01 for single-tender sales (got ${paid.toFixed(2)} vs ${total.toFixed(2)})`,
        code: "INVALID_PAYMENT_TOTAL",
        paidAmount: +paid.toFixed(2),
        grandTotal: +total.toFixed(2),
      });
    }

    // Patient sanity-check (optional)
    let resolvedPatientId = null;
    if (patientId !== undefined && patientId !== null && patientId !== "") {
      const pid = parseInt(patientId);
      if (!Number.isFinite(pid)) {
        return res.status(400).json({ error: "patientId must be numeric", code: "INVALID_PATIENT_ID" });
      }
      const p = await prisma.patient.findFirst({ where: tenantWhere(req, { id: pid }) });
      if (!p) return res.status(400).json({ error: "patientId does not exist in this tenant", code: "PATIENT_NOT_FOUND" });
      resolvedPatientId = pid;
    }

    // PRD Gap §2 item 9 — Sale-completion inventory consumption. PRODUCT
    // lineItems decrement Product.currentStock atomically inside the same
    // transaction as the Sale create, so a partial-failure can never leave
    // stock and ledger out of sync. SERVICE / MEMBERSHIP / GIFTCARD / PACKAGE
    // lines do not touch Product (they reference different tables via the
    // polymorphic refId).
    const productLines = normalisedLines.filter((l) => l.lineType === "PRODUCT");

    // Transactional create — invoiceNumber + Sale + SaleLineItem rows +
    // Product.currentStock decrements (PRODUCT lines only).
    const sale = await prisma.$transaction(async (tx) => {
      const invoiceNumber = await generateInvoiceNumber(tx, req.user.tenantId);
      const created = await tx.sale.create({
        data: {
          tenantId: req.user.tenantId,
          registerId: shift.registerId,
          shiftId: shift.id,
          cashierId: req.user.userId,
          patientId: resolvedPatientId,
          invoiceNumber,
          subtotal,
          taxTotal: tax,
          discountTotal: totalDiscount,
          total,
          paidAmount: paid,
          status: "COMPLETED",
          paymentMethod: pm,
          paymentBreakdownJson:
            pm === "COMBINED" && typeof paymentBreakdownJson === "string"
              ? paymentBreakdownJson.slice(0, 4000)
              : null,
          lineItems: {
            create: normalisedLines.map((l) => ({
              tenantId: req.user.tenantId,
              ...l,
            })),
          },
        },
        include: { lineItems: true },
      });
      // Decrement Product.currentStock for each PRODUCT line. Tenant-scoped
      // updateMany so a wrong tenantId can't decrement a sibling tenant's
      // stock (Prisma update by-id alone wouldn't tenant-gate). Negative
      // stock is permitted by design — backorder flow needs visibility into
      // oversells; the LowStock alert engine surfaces sub-threshold counts.
      for (const line of productLines) {
        await tx.product.updateMany({
          where: { id: line.refId, tenantId: req.user.tenantId },
          data: { currentStock: { decrement: line.quantity } },
        });
      }
      return created;
    });

    await writeAudit("Sale", "CREATE", sale.id, req.user.userId, req.user.tenantId, {
      invoiceNumber: sale.invoiceNumber,
      total: sale.total,
      paymentMethod: sale.paymentMethod,
      lineCount: sale.lineItems.length,
    });

    // PRD Gap §2 item 9 — auto-credit loyalty on Sale completion. Same
    // earn-rule shape as the visit-side hook; runs post-transaction so a
    // loyalty hiccup can never roll back the sale itself. Anonymous sales
    // (no patientId) and non-COMPLETED states are no-ops.
    await maybeAutoCreditLoyaltyForSale(sale, req.user.tenantId);

    res.status(201).json(sale);
  } catch (e) {
    console.error("[pos] create sale error:", e.message);
    res.status(500).json({ error: "Failed to create sale" });
  }
});

router.get("/sales", cashierGate, async (req, res) => {
  try {
    const { shiftId, from, to, patientId, status } = req.query;
    const where = tenantWhere(req);
    if (shiftId && Number.isFinite(parseInt(shiftId))) where.shiftId = parseInt(shiftId);
    if (patientId && Number.isFinite(parseInt(patientId))) where.patientId = parseInt(patientId);
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    // Cashiers see only their own sales unless admin/manager
    if (req.user.role !== "ADMIN" && req.user.role !== "MANAGER") {
      where.cashierId = req.user.userId;
    }
    const items = await prisma.sale.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        invoiceNumber: true,
        total: true,
        paymentMethod: true,
        status: true,
        createdAt: true,
        cashierId: true,
        patientId: true,
        shiftId: true,
        registerId: true,
      },
    });
    res.json(items);
  } catch (e) {
    console.error("[pos] list sales error:", e.message);
    res.status(500).json({ error: "Failed to list sales" });
  }
});

router.get("/sales/:id", cashierGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const sale = await prisma.sale.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        lineItems: true,
        register: { select: { id: true, name: true } },
        shift: { select: { id: true, status: true, userId: true } },
        patient: { select: { id: true, name: true, phone: true } },
      },
    });
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    // Cashier scope: own sales only unless admin/manager
    if (
      req.user.role !== "ADMIN" &&
      req.user.role !== "MANAGER" &&
      sale.cashierId !== req.user.userId
    ) {
      return res.status(403).json({
        error: "Cannot view another cashier's sale",
        code: "SALE_NOT_OWNER",
      });
    }
    res.json(sale);
  } catch (e) {
    console.error("[pos] get sale error:", e.message);
    res.status(500).json({ error: "Failed to load sale" });
  }
});

router.post("/sales/:id/refund", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const sale = await prisma.sale.findFirst({ where: tenantWhere(req, { id }) });
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (sale.status === "REFUNDED") {
      return res.status(409).json({
        error: "Sale already refunded",
        code: "SALE_ALREADY_REFUNDED",
      });
    }
    if (sale.status === "CANCELLED") {
      return res.status(409).json({
        error: "Cannot refund a cancelled sale",
        code: "SALE_CANCELLED",
      });
    }
    const { reason } = req.body;
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return res.status(400).json({ error: "reason is required", code: "REASON_REQUIRED" });
    }
    const refunded = await prisma.sale.update({
      where: { id },
      data: {
        status: "REFUNDED",
        refundedAt: new Date(),
        refundReason: reason.trim().slice(0, 1000),
      },
    });
    await writeAudit("Sale", "REFUND", id, req.user.userId, req.user.tenantId, {
      invoiceNumber: sale.invoiceNumber,
      total: sale.total,
      reason: reason.trim().slice(0, 200),
    });
    res.json(refunded);
  } catch (e) {
    console.error("[pos] refund sale error:", e.message);
    res.status(500).json({ error: "Failed to refund sale" });
  }
});

module.exports = router;
