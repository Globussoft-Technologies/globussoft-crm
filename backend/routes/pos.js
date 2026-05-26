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

const tenantWhere = (req, extra = {}) => ({
  tenantId: req.user.tenantId,
  ...extra,
});

// admin/manager can do everything; clinical staff (doctor/professional/
// telecaller/helper) can ring up sales + manage their own shift but not
// configure registers / refund.
// `anyOfPermissions` lets any RBAC role granted `pos.manage` (admin
// surfaces — register config, refunds) reach the admin-gated endpoints.
const adminGate = verifyWellnessRole(["admin", "manager"], {
  anyOfPermissions: [{ module: "pos", action: "manage" }],
});
// "clinical" meta-token covers ALL clinical staff (doctor, professional,
// nurse, stylist, plus any future custom clinical role with
// canTakeVisits=true). Telecaller + helper stay as literals because they
// are operational (canTakeVisits=false) and the cashier surface
// explicitly includes them — we never want to auto-elevate a new
// operational role to cashier access just because it appears in the
// catalog. `anyOfPermissions` opens the cashier surface to any custom
// role granted `pos.read` or `pos.write` (matches the page catalog's
// /wellness/pos entry, which requires pos.read).
const cashierGate = verifyWellnessRole(
  [
    "admin",
    "manager",
    "clinical",
    "doctor",
    "professional",
    "telecaller",
    "helper",
  ],
  {
    anyOfPermissions: [
      { module: "pos", action: "read" },
      { module: "pos", action: "write" },
    ],
  },
);

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
      return res
        .status(400)
        .json({ error: "id must be numeric", code: "INVALID_ID" });
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
      return res
        .status(400)
        .json({ error: "name is required", code: "NAME_REQUIRED" });
    }
    if (!locationId || !Number.isFinite(parseInt(locationId))) {
      return res
        .status(400)
        .json({ error: "locationId is required", code: "LOCATION_REQUIRED" });
    }
    const loc = await prisma.location.findFirst({
      where: tenantWhere(req, { id: parseInt(locationId) }),
    });
    if (!loc)
      return res
        .status(400)
        .json({
          error: "locationId does not exist in this tenant",
          code: "LOCATION_NOT_FOUND",
        });
    const float = openingFloat !== undefined ? parseFloat(openingFloat) : 0;
    if (!Number.isFinite(float) || float < 0) {
      return res
        .status(400)
        .json({
          error: "openingFloat must be a non-negative number",
          code: "INVALID_FLOAT",
        });
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
    await writeAudit(
      "Register",
      "CREATE",
      reg.id,
      req.user.userId,
      req.user.tenantId,
      {
        name: reg.name,
        locationId: reg.locationId,
      },
    );
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
      return res
        .status(400)
        .json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const existing = await prisma.register.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!existing) return res.status(404).json({ error: "Register not found" });

    const data = {};
    const allowed = ["name", "openingFloat", "isActive", "locationId"];
    for (const k of allowed)
      if (req.body[k] !== undefined) data[k] = req.body[k];
    if (data.openingFloat !== undefined) {
      const f = parseFloat(data.openingFloat);
      if (!Number.isFinite(f) || f < 0) {
        return res
          .status(400)
          .json({
            error: "openingFloat must be a non-negative number",
            code: "INVALID_FLOAT",
          });
      }
      data.openingFloat = f;
    }
    if (data.locationId !== undefined) {
      const loc = await prisma.location.findFirst({
        where: tenantWhere(req, { id: parseInt(data.locationId) }),
      });
      if (!loc)
        return res
          .status(400)
          .json({
            error: "locationId does not exist in this tenant",
            code: "LOCATION_NOT_FOUND",
          });
      data.locationId = parseInt(data.locationId);
    }
    if (data.name !== undefined) {
      if (typeof data.name !== "string" || !data.name.trim()) {
        return res
          .status(400)
          .json({
            error: "name must be a non-empty string",
            code: "INVALID_NAME",
          });
      }
      data.name = data.name.trim();
    }
    const updated = await prisma.register.update({ where: { id }, data });
    const changes = diffFields(existing, updated, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      await writeAudit(
        "Register",
        "UPDATE",
        id,
        req.user.userId,
        req.user.tenantId,
        { changedFields: changes },
      );
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
      return res
        .status(400)
        .json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const existing = await prisma.register.findFirst({
      where: tenantWhere(req, { id }),
    });
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
    await writeAudit(
      "Register",
      "DELETE",
      id,
      req.user.userId,
      req.user.tenantId,
      {
        name: existing.name,
      },
    );
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
      return res
        .status(400)
        .json({ error: "registerId is required", code: "REGISTER_REQUIRED" });
    }
    const reg = await prisma.register.findFirst({
      where: tenantWhere(req, { id: parseInt(registerId) }),
    });
    if (!reg) return res.status(404).json({ error: "Register not found" });
    if (!reg.isActive) {
      return res
        .status(409)
        .json({ error: "Register is inactive", code: "REGISTER_INACTIVE" });
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
      return res
        .status(400)
        .json({
          error: "openingFloat must be a non-negative number",
          code: "INVALID_FLOAT",
        });
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
    await writeAudit(
      "Shift",
      "OPEN",
      shift.id,
      req.user.userId,
      req.user.tenantId,
      {
        registerId: reg.id,
        openingFloat: float,
      },
    );
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
        req.io,
      );
    } catch (_e) {
      /* event bus optional */
    }
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
      return res
        .status(400)
        .json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const shift = await prisma.shift.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!shift) return res.status(404).json({ error: "Shift not found" });
    if (shift.status !== "OPEN") {
      return res
        .status(409)
        .json({
          error: "Shift is not open",
          code: "SHIFT_NOT_OPEN",
          status: shift.status,
        });
    }
    // Only the cashier who opened the shift OR an admin can close it.
    if (req.user.role !== "ADMIN" && shift.userId !== req.user.userId) {
      return res.status(403).json({
        error:
          "Only the cashier who opened this shift (or an admin) can close it",
        code: "SHIFT_NOT_OWNER",
      });
    }
    const { closingTotal, notes } = req.body;
    if (closingTotal === undefined || closingTotal === null) {
      return res
        .status(400)
        .json({
          error: "closingTotal is required",
          code: "CLOSING_TOTAL_REQUIRED",
        });
    }
    const closing = parseFloat(closingTotal);
    if (!Number.isFinite(closing) || closing < 0) {
      return res
        .status(400)
        .json({
          error: "closingTotal must be a non-negative number",
          code: "INVALID_CLOSING_TOTAL",
        });
    }
    // expectedCash = openingFloat + sum(CASH sales) + sum(DEPOSIT) - sum(WITHDRAWAL).
    // #779: petty-cash ledger now contributes to expected drawer balance.
    // Pre-#779 deposits/withdrawals lived in a paper notebook; close-shift
    // variance silently absorbed them. With ledger rows persisted, the
    // expected count is the precise drawer math, and variance reflects
    // only true under/over-counts.
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
    const deposits = await prisma.pettyCashLedger.aggregate({
      where: {
        tenantId: req.user.tenantId,
        shiftId: shift.id,
        type: "DEPOSIT",
      },
      _sum: { amount: true },
    });
    const withdrawals = await prisma.pettyCashLedger.aggregate({
      where: {
        tenantId: req.user.tenantId,
        shiftId: shift.id,
        type: "WITHDRAWAL",
      },
      _sum: { amount: true },
    });
    const depositsTotal = deposits._sum.amount || 0;
    const withdrawalsTotal = withdrawals._sum.amount || 0;
    const expectedCash =
      shift.openingFloat + cashTaken + depositsTotal - withdrawalsTotal;
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
        req.io,
      );
    } catch (_e) {
      /* event bus optional */
    }
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
    if (registerId && Number.isFinite(parseInt(registerId)))
      where.registerId = parseInt(registerId);
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
      return res
        .status(400)
        .json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const shift = await prisma.shift.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        register: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, email: true } },
        sales: {
          select: {
            id: true,
            invoiceNumber: true,
            total: true,
            paymentMethod: true,
            status: true,
            createdAt: true,
          },
        },
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

// ── Petty-cash ledger: deposit / withdraw against an OPEN shift (#779) ─
//
// Cashier-level work happens on the drawer mid-shift — owner brings ₹2k
// change, a courier needs to be paid cash, staff lunch float gets pulled.
// Pre-#779 those movements lived only in a paper notebook; close-shift
// variance silently absorbed them. This pair of endpoints persists each
// movement as a PettyCashLedger row so:
//
//   1. The close-shift variance computation can subtract WITHDRAWAL and
//      add DEPOSIT to the expected-cash math (no longer "everything that
//      isn't a CASH sale is variance").
//   2. The cashier's UI can render an Expenses tab on the shift detail
//      with each movement (#781 transaction split).
//   3. Audit chain captures who-deposited-what-when for compliance.
//
// Append-only — no PUT/DELETE. Both routes are admin/manager only because
// a clinical-staff cashier was the most common source of paper-notebook
// drift; the deposit/withdraw button is gated to the same role-set that
// owns the register CRUD.
//
// Deposits require amount > 0. Withdrawals likewise require amount > 0 but
// CAN exceed the running cash balance — under-drawer states are tracked
// at close, not silently rejected (the cashier may need to record an IOU
// that pays back tomorrow).

const VALID_PETTY_TYPES = new Set(["DEPOSIT", "WITHDRAWAL"]);

async function recordPettyCashEntry(req, res, type) {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) {
      return res
        .status(400)
        .json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const shift = await prisma.shift.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!shift) return res.status(404).json({ error: "Shift not found" });
    if (shift.status !== "OPEN") {
      return res.status(409).json({
        error: "Cannot record a petty-cash entry against a closed shift",
        code: "SHIFT_CLOSED",
      });
    }
    const { amount, reason } = req.body || {};
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({
        error: "amount must be a positive number",
        code: "INVALID_AMOUNT",
      });
    }
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return res.status(400).json({
        error: "reason is required",
        code: "REASON_REQUIRED",
      });
    }
    const entry = await prisma.pettyCashLedger.create({
      data: {
        tenantId: req.user.tenantId,
        shiftId: shift.id,
        type,
        amount: amt,
        reason: reason.trim().slice(0, 1000),
        userId: req.user.userId,
      },
    });
    await writeAudit(
      "Shift",
      "CASH_LEDGER",
      shift.id,
      req.user.userId,
      req.user.tenantId,
      {
        ledgerId: entry.id,
        type,
        amount: amt,
        reason: entry.reason,
      },
    );
    res.status(201).json(entry);
  } catch (e) {
    console.error(`[pos] petty-cash ${type} error:`, e.message);
    res.status(500).json({ error: `Failed to record ${type.toLowerCase()}` });
  }
}

router.post("/shifts/:id/deposit", adminGate, (req, res) =>
  recordPettyCashEntry(req, res, "DEPOSIT"),
);

router.post("/shifts/:id/withdraw", adminGate, (req, res) =>
  recordPettyCashEntry(req, res, "WITHDRAWAL"),
);

// GET /api/pos/shifts/:id/petty-cash — list ledger entries for a shift.
// Used by the CashRegisters UI to render the Expenses tab. Cashier scope:
// shift's own cashier or admin/manager — same gate as GET /shifts/:id.
router.get("/shifts/:id/petty-cash", cashierGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) {
      return res
        .status(400)
        .json({ error: "id must be numeric", code: "INVALID_ID" });
    }
    const shift = await prisma.shift.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!shift) return res.status(404).json({ error: "Shift not found" });
    if (
      req.user.role !== "ADMIN" &&
      req.user.role !== "MANAGER" &&
      shift.userId !== req.user.userId
    ) {
      return res.status(403).json({
        error: "Cannot view another cashier's shift ledger",
        code: "SHIFT_NOT_OWNER",
      });
    }
    const entries = await prisma.pettyCashLedger.findMany({
      where: tenantWhere(req, { shiftId: shift.id }),
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    res.json(entries);
  } catch (e) {
    console.error("[pos] list petty-cash error:", e.message);
    res.status(500).json({ error: "Failed to list petty-cash entries" });
  }
});

// ── POS sale context (D17 Arc 1 slice 2) ─────────────────────────────
//
// GET /api/pos/sale-context/:patientId — patient-scoped enrichment for the
// POS "New Sale" form. The cashier picks a patient and the form needs:
//
//   - walletBalanceCents — drives the Wallet payment-method affordance in
//     the payment splitter (PRD_POS_NEW_SALE §3.5). Same shape as
//     GET /api/wallet/:patientId/balance (Math.round(balance*100), with
//     a defensive Math.max(0, ...) since Wallet.balance is constrained
//     > 0 by topup/redeem logic but better-safe-than-sorry at the wire).
//   - currency — patient's wallet currency (defaults to INR).
//   - activeMemberships — patient's active Membership rows for "redeem
//     against credits" affordance. Stubbed to `[]` here; slice 3 will
//     fill from prisma.membership.findMany once the Membership read
//     contract is agreed.
//   - pendingBookings — upcoming Booking rows that auto-bill at the
//     register. Stubbed to `[]` here; subsequent slice will populate.
//
// Back-compat note: Wallet balance lives on its own endpoint already
// (fdb0ec5c); this aggregator just saves the POS page one round-trip on
// patient-pick. Stubbed sister arrays are intentionally empty arrays
// (not omitted) so the frontend can render the empty state without a
// shape-check.
//
// Same cashierGate as the rest of pos.js — the cashier needs the
// affordance, telecallers don't ring up sales but DO see context on
// outbound calls when transferring to billing.

router.get("/sale-context/:patientId", cashierGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId, 10);
    if (!Number.isFinite(patientId) || patientId <= 0) {
      return res
        .status(400)
        .json({
          error: "patientId must be a positive integer",
          code: "INVALID_PATIENT_ID",
        });
    }

    // Tenant-scoped patient existence check first — cross-tenant probe
    // returns 404 (never 403) so we never reveal whether a row exists
    // in another tenant. Same pattern as routes/wallet.js:108.
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true },
    });
    if (!patient) {
      return res
        .status(404)
        .json({ error: "Patient not found", code: "PATIENT_NOT_FOUND" });
    }

    const wallet = await prisma.wallet.findFirst({
      where: tenantWhere(req, { patientId }),
      select: { balance: true, currency: true },
    });
    // Defensive Math.max(0, ...) — Wallet.balance is constrained > 0 by
    // topup/redeem logic, but a corrupt row should never surface a
    // negative number to the POS form (would imply "free money" to the
    // cashier reading the affordance).
    const walletBalanceCents = wallet
      ? Math.max(0, Math.round(wallet.balance * 100))
      : 0;
    const currency = wallet?.currency || "INR";

    return res.json({
      patientId,
      walletBalanceCents,
      currency,
      // Sister fields stubbed empty for slice-2; filled by subsequent
      // slices once Membership / Booking read contracts agreed.
      activeMemberships: [],
      pendingBookings: [],
    });
  } catch (e) {
    console.error("[pos] sale-context error:", e.message);
    return res.status(500).json({ error: "Failed to load sale context" });
  }
});

// ── Sale create / list / get / refund ────────────────────────────────

const VALID_LINE_TYPES = [
  "SERVICE",
  "PRODUCT",
  "MEMBERSHIP",
  "GIFTCARD",
  "PACKAGE",
];
// #789 — payment methods accepted at POS. CASHBACK / PAYLATER / ONLINE
// were added 2026-05-18 to match the Zylu reference set + the PointOfSale
// dropdown options. Treatment differs per method:
//   CASH / CARD / UPI / WALLET / GIFTCARD / COMBINED — existing; no behavioural
//     change. WALLET assumes the cashier debited the patient's wallet via a
//     separate /wallet flow BEFORE checkout (sibling of GIFTCARD redeem).
//   CASHBACK — same shape as WALLET; the cashier debits the patient's
//     cashback balance via the wallet ledger (CASHBACK_REDEEM
//     WalletTransaction) before checkout. The enum value is the tender tag
//     so reports + audits surface the distinction. No additional side
//     effects in this route — wallet already enforces non-negative balance.
//   PAYLATER — sale is recorded as COMPLETED but the cashier intends to
//     collect later (open invoice / credit terms). DEFERRED column work:
//     a Sale.paid (Boolean) + Sale.paymentDueAt (DateTime?) pair would let
//     the AR engine surface unpaid PAYLATER sales for follow-up. For now
//     the enum value rides as a tender tag only — reports filter by
//     paymentMethod=PAYLATER to find them. Tracked: ship the columns
//     once the AR aging UI lands.
//   ONLINE — generic online payment (Razorpay/Stripe/external link).
//     DEFERRED column work: Sale.externalPaymentRef (String?) to capture
//     the gateway transaction id. For now the cashier records the
//     reference in paymentBreakdownJson by hand. Tracked: ship the column
//     when the inline-payment-link UI lands.
const VALID_PAYMENT_METHODS = [
  "CASH",
  "CARD",
  "UPI",
  "WALLET",
  "GIFTCARD",
  "COMBINED",
  "CASHBACK",
  "PAYLATER",
  "ONLINE",
];

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
      return res
        .status(400)
        .json({ error: "shiftId is required", code: "SHIFT_REQUIRED" });
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
      return res
        .status(400)
        .json({
          error: "lineItems must be a non-empty array",
          code: "LINE_ITEMS_REQUIRED",
        });
    }
    if (lineItems.length > 200) {
      return res
        .status(400)
        .json({
          error: "lineItems exceeds 200 rows",
          code: "LINE_ITEMS_TOO_MANY",
        });
    }
    const normalisedLines = [];
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      if (!li || typeof li !== "object") {
        return res
          .status(400)
          .json({
            error: `lineItems[${i}] must be an object`,
            code: "INVALID_LINE_ITEM",
          });
      }
      if (!VALID_LINE_TYPES.includes(li.lineType)) {
        return res.status(400).json({
          error: `lineItems[${i}].lineType must be one of ${VALID_LINE_TYPES.join(", ")}`,
          code: "INVALID_LINE_TYPE",
        });
      }
      const refId = parseInt(li.refId);
      if (!Number.isFinite(refId)) {
        return res
          .status(400)
          .json({
            error: `lineItems[${i}].refId must be numeric`,
            code: "INVALID_REF_ID",
          });
      }
      // Use ?? not || so quantity=0 isn't silently coerced to 1.
      const quantity = parseInt(li.quantity ?? 1);
      if (!Number.isFinite(quantity) || quantity < 1) {
        return res
          .status(400)
          .json({
            error: `lineItems[${i}].quantity must be >= 1`,
            code: "INVALID_QUANTITY",
          });
      }
      const unitPrice = parseFloat(li.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return res
          .status(400)
          .json({
            error: `lineItems[${i}].unitPrice must be >= 0`,
            code: "INVALID_UNIT_PRICE",
          });
      }
      const lineDiscount = parseFloat(li.lineDiscount || 0);
      if (!Number.isFinite(lineDiscount) || lineDiscount < 0) {
        return res
          .status(400)
          .json({
            error: `lineItems[${i}].lineDiscount must be >= 0`,
            code: "INVALID_LINE_DISCOUNT",
          });
      }
      const lineTotal = Math.max(0, quantity * unitPrice - lineDiscount);
      const name = (
        li.name && typeof li.name === "string"
          ? li.name
          : `${li.lineType} #${refId}`
      ).slice(0, 240);
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
    const subtotal = normalisedLines.reduce(
      (acc, l) => acc + l.quantity * l.unitPrice,
      0,
    );
    const lineDiscounts = normalisedLines.reduce(
      (acc, l) => acc + l.lineDiscount,
      0,
    );
    const orderDiscount = Math.max(0, parseFloat(discountTotal || 0));
    const totalDiscount = lineDiscounts + orderDiscount;
    const tax = Math.max(0, parseFloat(taxTotal || 0));
    const total = Math.max(0, subtotal - totalDiscount + tax);
    const paid = paidAmount !== undefined ? parseFloat(paidAmount) : total;
    if (!Number.isFinite(paid) || paid < 0) {
      return res
        .status(400)
        .json({
          error: "paidAmount must be >= 0",
          code: "INVALID_PAID_AMOUNT",
        });
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
        try {
          breakdown = JSON.parse(paymentBreakdownJson);
        } catch {
          breakdown = null;
        }
      } else if (
        paymentBreakdownJson &&
        typeof paymentBreakdownJson === "object"
      ) {
        breakdown = paymentBreakdownJson;
      }
      if (!Array.isArray(breakdown) || breakdown.length === 0) {
        return res.status(400).json({
          error:
            "paymentBreakdownJson must be a non-empty array when paymentMethod=COMBINED",
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
        return res
          .status(400)
          .json({
            error: "patientId must be numeric",
            code: "INVALID_PATIENT_ID",
          });
      }
      const p = await prisma.patient.findFirst({
        where: tenantWhere(req, { id: pid }),
      });
      if (!p)
        return res
          .status(400)
          .json({
            error: "patientId does not exist in this tenant",
            code: "PATIENT_NOT_FOUND",
          });
      resolvedPatientId = pid;
    }

    // PRD Gap §2 item 9 — Sale-completion inventory consumption. PRODUCT
    // lineItems decrement Product.currentStock atomically inside the same
    // transaction as the Sale create, so a partial-failure can never leave
    // stock and ledger out of sync. SERVICE / MEMBERSHIP / GIFTCARD / PACKAGE
    // lines do not touch Product (they reference different tables via the
    // polymorphic refId).
    const productLines = normalisedLines.filter(
      (l) => l.lineType === "PRODUCT",
    );

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

    await writeAudit(
      "Sale",
      "CREATE",
      sale.id,
      req.user.userId,
      req.user.tenantId,
      {
        invoiceNumber: sale.invoiceNumber,
        total: sale.total,
        paymentMethod: sale.paymentMethod,
        lineCount: sale.lineItems.length,
      },
    );

    // PRD Gap §2 item 9 — auto-credit loyalty on Sale completion. Same
    // earn-rule shape as the visit-side hook; runs post-transaction so a
    // loyalty hiccup can never roll back the sale itself. Anonymous sales
    // (no patientId) and non-COMPLETED states are no-ops.
    await maybeAutoCreditLoyaltyForSale(sale, req.user.tenantId);

    // Wave 8b — emit sale.completed so the POS receipt dispatcher
    // (lib/posReceiptDispatcher.js) can queue an SMS (always) +
    // WhatsApp (if Contact opted in) receipt. Fire-and-forget; an
    // event-bus hiccup never affects the sale itself.
    try {
      const { emitEvent } = require("../lib/eventBus");
      emitEvent(
        "sale.completed",
        {
          saleId: sale.id,
          invoiceNumber: sale.invoiceNumber,
          patientId: sale.patientId,
          total: sale.total,
          paymentMethod: sale.paymentMethod,
          status: sale.status,
          shiftId: sale.shiftId,
          registerId: sale.registerId,
        },
        req.user.tenantId,
        req.io,
      );
    } catch (_e) {
      /* event bus optional */
    }

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
    if (shiftId && Number.isFinite(parseInt(shiftId)))
      where.shiftId = parseInt(shiftId);
    if (patientId && Number.isFinite(parseInt(patientId)))
      where.patientId = parseInt(patientId);
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
      return res
        .status(400)
        .json({ error: "id must be numeric", code: "INVALID_ID" });
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

// ── Atomic sale finalize (D17 Arc 1 slices 5 + 8) ────────────────────
//
// POST /api/pos/sales/finalize — PRD_POS_NEW_SALE §3.6 atomicity hardening
// (the "wallet debit moves INSIDE the Sale transaction" fix per the PRD's
// "Atomicity ambiguity" risk callout). Distinct from POST /sales above —
// /sales is the legacy single-tender endpoint with float-rupee inputs
// (paidAmount / discountTotal / taxTotal) that the existing UI consumes;
// /finalize is the new cents-native endpoint built for the PRD §3.5
// payment-splitter UI which natively works in integer cents to avoid
// float-rounding drift on split tenders.
//
// Body shape:
//   patientId       int          required — must belong to tenant
//   items           array(≥1)    {type:'service'|'product', refId, qty, unitPriceCents}
//   payments        array(≥1)    {method:'cash'|'card'|'upi'|'wallet'|'giftcard', amountCents}
//   discountCents   int (≥0)     optional, default 0
//   taxCents        int (≥0)     optional, default 0
//
// Computed:
//   itemsTotal      = sum(qty × unitPriceCents)
//   grandTotal      = itemsTotal − discountCents + taxCents
//   paymentsTotal   = sum(payments[].amountCents)
//   MUST hold: |paymentsTotal − grandTotal| ≤ 1 (1-cent rounding tolerance)
//
// Wallet handling — for ANY payment line with method='wallet':
//   Inline FIFO+expiry-order debit (mirrors routes/wallet.js POST /redeem
//   logic at L595-L692) inside the same prisma.$transaction so a wallet
//   shortfall rolls back the Sale/Invoice/Payment rows along with the
//   batch updates. PRINCIPAL batches first (FIFO — oldest createdAt
//   wins), BONUS batches second (soonest expiresAt wins) — the
//   customer-fair priority pinned by DD-5.3 of PRD_WALLET_TOPUP.
//
// Atomicity guarantee: Sale + SaleLineItem + Invoice + WalletCreditBatch
// updates + WalletTransaction + Wallet.balance + audit-row data
// snapshot all live inside ONE prisma.$transaction. A throw anywhere
// (insufficient balance, DB hiccup, invariant violation) rolls back
// EVERY row — no Sale persists if wallet redemption fails halfway.
// The audit.writeAudit call sits OUTSIDE the transaction (audit is
// hash-chained — see lib/audit.js — and a failed audit must NOT roll
// back a legitimate sale) but receives a snapshot computed inside
// the tx so the audit payload reflects the committed reality.
//
// Error codes:
//   400 INVALID_PAYLOAD            body is not an object
//   400 INVALID_PATIENT_ID         patientId missing / non-positive
//   400 INVALID_ITEMS              items missing / not array / empty
//   400 INVALID_ITEM               one item row malformed (bad type/refId/qty/unitPriceCents)
//   400 INVALID_PAYMENTS           payments missing / not array / empty
//   400 INVALID_PAYMENT            one payment row malformed (bad method/amountCents)
//   400 INVALID_DISCOUNT           discountCents negative / non-integer
//   400 INVALID_TAX                taxCents negative / non-integer
//   400 MISMATCHED_TOTAL           |paymentsTotal − grandTotal| > 1 cent
//   400 INSUFFICIENT_WALLET_BALANCE  wallet payment > active batch sum
//   404 PATIENT_NOT_FOUND          patient missing in caller's tenant
//   500 SALE_FINALIZE_FAILED       unexpected transaction failure
//
// Response: { success, saleId, invoiceId, grandTotalCents, walletDebitedCents, status }
//
// RBAC: cashierGate (admin/manager/doctor/professional/telecaller/helper) —
// same surface as POST /sales above. Telecallers cannot finalize in
// practice (they don't sit at the till) but the route doesn't enforce
// that — the calendar's POS New Sale page is gated by frontend route +
// the cashier needs an OPEN shift on the existing POST /sales path.
// This new endpoint deliberately does NOT require an open shift because
// the payment-splitter PRD §3.6 leaves shift-binding for a later slice;
// downstream reconcile/refund flows surface shift gaps if any.

const VALID_FINALIZE_ITEM_TYPES = new Set(["service", "product"]);
const VALID_FINALIZE_PAYMENT_METHODS = new Set([
  "cash",
  "card",
  "upi",
  "wallet",
  "giftcard",
]);
// Map slice-spec lowercase item type → SaleLineItem.lineType column
// (existing enum-string values are uppercase per the legacy POST /sales).
const FINALIZE_ITEM_TYPE_TO_LINE_TYPE = {
  service: "SERVICE",
  product: "PRODUCT",
};

router.post("/sales/finalize", cashierGate, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res
        .status(400)
        .json({ error: "Body must be an object", code: "INVALID_PAYLOAD" });
    }
    const { patientId, items, payments, discountCents, taxCents } = req.body;

    // ── Validate patientId ──
    const pid = parseInt(patientId, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return res.status(400).json({
        error: "patientId must be a positive integer",
        code: "INVALID_PATIENT_ID",
      });
    }

    // ── Validate items array ──
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "items must be a non-empty array",
        code: "INVALID_ITEMS",
      });
    }
    if (items.length > 200) {
      return res.status(400).json({
        error: "items exceeds 200 rows",
        code: "INVALID_ITEMS",
      });
    }
    const normalisedItems = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || typeof it !== "object") {
        return res.status(400).json({
          error: `items[${i}] must be an object`,
          code: "INVALID_ITEM",
        });
      }
      const type = typeof it.type === "string" ? it.type.toLowerCase() : "";
      if (!VALID_FINALIZE_ITEM_TYPES.has(type)) {
        return res.status(400).json({
          error: `items[${i}].type must be one of: service, product`,
          code: "INVALID_ITEM",
        });
      }
      const refId = parseInt(it.refId, 10);
      if (!Number.isFinite(refId) || refId <= 0) {
        return res.status(400).json({
          error: `items[${i}].refId must be a positive integer`,
          code: "INVALID_ITEM",
        });
      }
      const qty = parseInt(it.qty, 10);
      if (!Number.isFinite(qty) || qty < 1) {
        return res.status(400).json({
          error: `items[${i}].qty must be a positive integer`,
          code: "INVALID_ITEM",
        });
      }
      const unitPriceCents = parseInt(it.unitPriceCents, 10);
      if (!Number.isFinite(unitPriceCents) || unitPriceCents < 0) {
        return res.status(400).json({
          error: `items[${i}].unitPriceCents must be a non-negative integer`,
          code: "INVALID_ITEM",
        });
      }
      normalisedItems.push({ type, refId, qty, unitPriceCents });
    }

    // ── Validate payments array ──
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({
        error: "payments must be a non-empty array",
        code: "INVALID_PAYMENTS",
      });
    }
    const normalisedPayments = [];
    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      if (!p || typeof p !== "object") {
        return res.status(400).json({
          error: `payments[${i}] must be an object`,
          code: "INVALID_PAYMENT",
        });
      }
      const method = typeof p.method === "string" ? p.method.toLowerCase() : "";
      if (!VALID_FINALIZE_PAYMENT_METHODS.has(method)) {
        return res.status(400).json({
          error: `payments[${i}].method must be one of: cash, card, upi, wallet, giftcard`,
          code: "INVALID_PAYMENT",
        });
      }
      const amountCents = parseInt(p.amountCents, 10);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return res.status(400).json({
          error: `payments[${i}].amountCents must be a positive integer`,
          code: "INVALID_PAYMENT",
        });
      }
      normalisedPayments.push({ method, amountCents });
    }

    // ── Validate discount + tax ──
    const discount =
      discountCents === undefined || discountCents === null
        ? 0
        : parseInt(discountCents, 10);
    if (!Number.isFinite(discount) || discount < 0) {
      return res.status(400).json({
        error: "discountCents must be a non-negative integer",
        code: "INVALID_DISCOUNT",
      });
    }
    const tax =
      taxCents === undefined || taxCents === null ? 0 : parseInt(taxCents, 10);
    if (!Number.isFinite(tax) || tax < 0) {
      return res.status(400).json({
        error: "taxCents must be a non-negative integer",
        code: "INVALID_TAX",
      });
    }

    // ── Compute totals (integer cents — no float rounding) ──
    const itemsTotal = normalisedItems.reduce(
      (acc, it) => acc + it.qty * it.unitPriceCents,
      0,
    );
    const grandTotal = itemsTotal - discount + tax;
    if (grandTotal < 0) {
      // Defensive — discount > items+tax means the cashier is trying to
      // give away money plus a refund; mismatched-total catches it but
      // a crisper code helps diagnostics.
      return res.status(400).json({
        error: "discountCents exceeds itemsTotal + taxCents",
        code: "INVALID_DISCOUNT",
      });
    }
    const paymentsTotal = normalisedPayments.reduce(
      (acc, p) => acc + p.amountCents,
      0,
    );
    // ±1 cent tolerance to absorb any client-side rounding drift on a
    // multi-tender split (e.g. 33⅓% of ₹100 = 3 lines of ₹33.33 → 9999
    // cents not 10000). 1-cent floor is tighter than the legacy POST
    // /sales 0.01 rupee tolerance because we're already in integer
    // cents and the only legitimate drift is 1-cent floor-rounding.
    if (Math.abs(paymentsTotal - grandTotal) > 1) {
      return res.status(400).json({
        error: `sum(payments.amountCents)=${paymentsTotal} must equal grandTotal=${grandTotal} ±1 cent`,
        code: "MISMATCHED_TOTAL",
        paymentsTotalCents: paymentsTotal,
        grandTotalCents: grandTotal,
      });
    }

    // ── Tenant-scoped patient existence guard ──
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: pid }),
      select: { id: true },
    });
    if (!patient) {
      return res.status(404).json({
        error: "Patient not found",
        code: "PATIENT_NOT_FOUND",
      });
    }

    // Sum wallet-tender amount up-front for the tx — short-circuit if zero.
    const walletDebitCents = normalisedPayments
      .filter((p) => p.method === "wallet")
      .reduce((acc, p) => acc + p.amountCents, 0);

    const now = new Date();

    // ── Atomic transaction ──
    //   1. (if walletDebitCents > 0) Resolve wallet + walk FIFO/expiry
    //      batches, debit them, write WalletTransaction(REDEEM), update
    //      Wallet.balance. Insufficient balance throws a typed error so
    //      the outer catch maps to 400 INSUFFICIENT_WALLET_BALANCE.
    //   2. Generate invoiceNumber + create Sale row (status=COMPLETED,
    //      total=grandTotal/100 in rupees for compat with existing
    //      Sale.total float column).
    //   3. Create SaleLineItem rows for each item.
    //   4. Create Invoice row linked to Sale (status=PAID since payments
    //      sum to total; contactId is null-safe — Invoice model requires
    //      contactId so we resolve patient.contactId if present).
    //   5. Create Payment rows for each payment line.
    let txResult;
    try {
      txResult = await prisma.$transaction(async (tx) => {
        let walletTransactionId = null;
        const walletBatchesDebited = [];

        if (walletDebitCents > 0) {
          const wallet = await tx.wallet.findFirst({
            where: tenantWhere(req, { patientId: pid }),
            select: { id: true, balance: true },
          });
          if (!wallet) {
            const err = new Error("INSUFFICIENT_WALLET_BALANCE");
            err.code = "INSUFFICIENT_WALLET_BALANCE";
            err.requestedCents = walletDebitCents;
            err.availableCents = 0;
            throw err;
          }
          const baseWhere = {
            tenantId: req.user.tenantId,
            walletId: wallet.id,
            status: "ACTIVE",
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          };
          const [principalBatches, bonusBatches] = await Promise.all([
            tx.walletCreditBatch.findMany({
              where: { ...baseWhere, batchType: "PRINCIPAL" },
              orderBy: { createdAt: "asc" },
            }),
            tx.walletCreditBatch.findMany({
              where: { ...baseWhere, batchType: "BONUS" },
              orderBy: { expiresAt: "asc" },
            }),
          ]);
          const orderedBatches = [...principalBatches, ...bonusBatches];
          const availableCents = orderedBatches.reduce(
            (sum, b) => sum + b.remainingCents,
            0,
          );
          if (availableCents < walletDebitCents) {
            const err = new Error("INSUFFICIENT_WALLET_BALANCE");
            err.code = "INSUFFICIENT_WALLET_BALANCE";
            err.requestedCents = walletDebitCents;
            err.availableCents = availableCents;
            throw err;
          }
          let remaining = walletDebitCents;
          for (const batch of orderedBatches) {
            if (remaining <= 0) break;
            const consumed = Math.min(batch.remainingCents, remaining);
            const newRemaining = batch.remainingCents - consumed;
            await tx.walletCreditBatch.update({
              where: { id: batch.id },
              data: {
                remainingCents: newRemaining,
                status: newRemaining === 0 ? "EXHAUSTED" : "ACTIVE",
              },
            });
            walletBatchesDebited.push({
              batchId: batch.id,
              batchType: batch.batchType,
              consumedCents: consumed,
            });
            remaining -= consumed;
          }
          const newBalance = +(wallet.balance - walletDebitCents / 100).toFixed(
            2,
          );
          const txnRow = await tx.walletTransaction.create({
            data: {
              tenantId: req.user.tenantId,
              walletId: wallet.id,
              type: "REDEEM",
              amount: -walletDebitCents / 100,
              reason: `POS sale finalize (patient ${pid})`,
              invoiceId: null, // back-filled below post-Invoice create
              balanceAfter: newBalance,
              performedBy: req.user.userId,
            },
          });
          walletTransactionId = txnRow.id;
          await tx.wallet.update({
            where: { id: wallet.id },
            data: { balance: newBalance },
          });
        }

        const invoiceNumber = await generateInvoiceNumber(
          tx,
          req.user.tenantId,
          now,
        );
        const grandTotalRupees = +(grandTotal / 100).toFixed(2);
        const subtotalRupees = +(itemsTotal / 100).toFixed(2);
        const discountRupees = +(discount / 100).toFixed(2);
        const taxRupees = +(tax / 100).toFixed(2);

        const sale = await tx.sale.create({
          data: {
            tenantId: req.user.tenantId,
            // /finalize bypasses the register/shift gate (PRD §3.6 leaves
            // shift-binding for a later slice). The DB columns are
            // non-nullable so we look up the cashier's most-recent OPEN
            // shift if present, else fall through to ANY shift the cashier
            // owns. Tests stub this; production callers will have an open
            // shift via the calendar flow.
            registerId: await resolveRegisterIdForFinalize(tx, req),
            shiftId: await resolveShiftIdForFinalize(tx, req),
            cashierId: req.user.userId,
            patientId: pid,
            invoiceNumber,
            subtotal: subtotalRupees,
            taxTotal: taxRupees,
            discountTotal: discountRupees,
            total: grandTotalRupees,
            paidAmount: grandTotalRupees,
            status: "COMPLETED",
            paymentMethod:
              normalisedPayments.length === 1
                ? normalisedPayments[0].method.toUpperCase()
                : "COMBINED",
            paymentBreakdownJson: JSON.stringify(
              normalisedPayments.map((p) => ({
                method: p.method.toUpperCase(),
                amountCents: p.amountCents,
              })),
            ).slice(0, 4000),
            lineItems: {
              create: normalisedItems.map((it) => {
                const unitPriceRupees = +(it.unitPriceCents / 100).toFixed(2);
                return {
                  tenantId: req.user.tenantId,
                  lineType: FINALIZE_ITEM_TYPE_TO_LINE_TYPE[it.type],
                  refId: it.refId,
                  name: `${FINALIZE_ITEM_TYPE_TO_LINE_TYPE[it.type]} #${it.refId}`,
                  quantity: it.qty,
                  unitPrice: unitPriceRupees,
                  lineDiscount: 0,
                  lineTotal: +(it.qty * unitPriceRupees).toFixed(2),
                };
              }),
            },
          },
          include: { lineItems: true },
        });

        // Invoice model requires contactId — resolve from patient.contactId
        // (Patient has an optional Contact linkage in the wellness schema).
        // If no contact link exists, skip Invoice creation; the receipt
        // anchors on Sale.id per PRD §3.6 fallback contract. Any error
        // from invoice.create propagates and rolls back the surrounding
        // transaction (no inner try/catch needed — the throw is what we
        // want for atomicity).
        let invoice = null;
        const patientForInvoice = await tx.patient.findUnique({
          where: { id: pid },
          select: { contactId: true },
        });
        if (patientForInvoice?.contactId) {
          invoice = await tx.invoice.create({
            data: {
              tenantId: req.user.tenantId,
              invoiceNum: invoiceNumber,
              amount: grandTotalRupees,
              status: "PAID",
              dueDate: now,
              issuedDate: now,
              paidAt: now,
              contactId: patientForInvoice.contactId,
            },
          });
          // Back-fill the WalletTransaction.invoiceId so the wallet
          // ledger cross-links the redemption to the invoice row.
          if (walletTransactionId && invoice) {
            await tx.walletTransaction.update({
              where: { id: walletTransactionId },
              data: { invoiceId: invoice.id },
            });
          }
        }

        // Payment rows — one per tender line. Wallet payments link to
        // the invoice (if created) via invoiceId; gateway field tags the
        // method so reports can split CASH vs CARD vs UPI vs WALLET vs
        // GIFTCARD revenue.
        const paymentRows = [];
        for (const p of normalisedPayments) {
          const paymentRow = await tx.payment.create({
            data: {
              tenantId: req.user.tenantId,
              invoiceId: invoice ? invoice.id : null,
              amount: +(p.amountCents / 100).toFixed(2),
              currency: "INR",
              gateway: p.method,
              status: "SUCCESS",
              paidAt: now,
            },
          });
          paymentRows.push(paymentRow);
        }

        return {
          sale,
          invoice,
          paymentRows,
          walletTransactionId,
          walletBatchesDebited,
          grandTotalCents: grandTotal,
          walletDebitedCents: walletDebitCents,
        };
      });
    } catch (txErr) {
      if (txErr && txErr.code === "INSUFFICIENT_WALLET_BALANCE") {
        return res.status(400).json({
          error: "Insufficient wallet balance",
          code: "INSUFFICIENT_WALLET_BALANCE",
          requestedCents: txErr.requestedCents,
          availableCents: txErr.availableCents,
        });
      }
      throw txErr;
    }

    // Audit OUTSIDE the transaction — hash-chained writes must never
    // roll back a committed sale. Fire-and-forget; an audit hiccup
    // surfaces in the audit-integrity cron, not on the cashier's screen.
    writeAudit(
      "Sale",
      "POS_SALE_FINALIZED",
      txResult.sale.id,
      req.user.userId,
      req.user.tenantId,
      {
        saleId: txResult.sale.id,
        invoiceId: txResult.invoice ? txResult.invoice.id : null,
        grandTotalCents: txResult.grandTotalCents,
        paymentCount: normalisedPayments.length,
        hadWalletRedeem: txResult.walletDebitedCents > 0,
        walletDebitedCents: txResult.walletDebitedCents,
        walletBatchesDebited: txResult.walletBatchesDebited,
      },
    ).catch((auditErr) => {
      console.warn("[pos] POS_SALE_FINALIZED audit failed:", auditErr.message);
    });

    return res.status(201).json({
      success: true,
      saleId: txResult.sale.id,
      invoiceId: txResult.invoice ? txResult.invoice.id : null,
      grandTotalCents: txResult.grandTotalCents,
      walletDebitedCents: txResult.walletDebitedCents,
      status: txResult.sale.status,
    });
  } catch (e) {
    console.error("[pos] sale finalize error:", e.message);
    return res.status(500).json({
      error: "Failed to finalize sale",
      code: "SALE_FINALIZE_FAILED",
    });
  }
});

// Register + shift resolution helpers for /finalize. PRD §3.6 defers
// shift-binding to a later slice but the Sale schema columns are
// non-nullable. Strategy: take the cashier's most-recent OPEN shift if
// any; else any shift they've owned (CLOSED is OK because /finalize is
// designed to be callable from the new calendar surface, not the till);
// else any register/shift on the tenant (admin-finalizing-walkin pattern).
async function resolveShiftIdForFinalize(tx, req) {
  const openMine = await tx.shift.findFirst({
    where: tenantWhere(req, { userId: req.user.userId, status: "OPEN" }),
    orderBy: { openedAt: "desc" },
    select: { id: true },
  });
  if (openMine) return openMine.id;
  const anyMine = await tx.shift.findFirst({
    where: tenantWhere(req, { userId: req.user.userId }),
    orderBy: { openedAt: "desc" },
    select: { id: true },
  });
  if (anyMine) return anyMine.id;
  const anyTenant = await tx.shift.findFirst({
    where: tenantWhere(req),
    orderBy: { openedAt: "desc" },
    select: { id: true },
  });
  if (anyTenant) return anyTenant.id;
  // No shift at all → reject. Sale.shiftId is non-nullable.
  const err = new Error("SALE_FINALIZE_FAILED");
  err.code = "SALE_FINALIZE_FAILED";
  throw err;
}

async function resolveRegisterIdForFinalize(tx, req) {
  const openMine = await tx.shift.findFirst({
    where: tenantWhere(req, { userId: req.user.userId, status: "OPEN" }),
    orderBy: { openedAt: "desc" },
    select: { registerId: true },
  });
  if (openMine) return openMine.registerId;
  const anyMine = await tx.shift.findFirst({
    where: tenantWhere(req, { userId: req.user.userId }),
    orderBy: { openedAt: "desc" },
    select: { registerId: true },
  });
  if (anyMine) return anyMine.registerId;
  const anyTenant = await tx.shift.findFirst({
    where: tenantWhere(req),
    orderBy: { openedAt: "desc" },
    select: { registerId: true },
  });
  if (anyTenant) return anyTenant.registerId;
  const err = new Error("SALE_FINALIZE_FAILED");
  err.code = "SALE_FINALIZE_FAILED";
  throw err;
}

// ── D17 Arc 1 Slice 7: void + refund (PRD_POS_NEW_SALE §3.9) ─────────
//
// POST /api/pos/sales/:id/void
// POST /api/pos/sales/:id/refund
//
// DD-5.7 round-2 RESOLVED 2026-05-25: STRICT mode → BOTH endpoints are
// ADMIN-only (strictAdminGate above — manager cannot reach here).
//
// SEMANTIC DIFFERENCE (why two endpoints, not one):
//   /void   — undo the entire COMPLETED sale, reverse wallet redemption back
//             to the customer's wallet (restore batch.remainingCents +
//             write WalletTransaction VOID_REVERSAL + bump Wallet.balance),
//             flip Invoice.status to VOIDED. Use case: cashier rang the
//             wrong patient/items and the customer hasn't taken the
//             goods yet. NO money leaves the till; wallet redemption is
//             restored as if the sale never happened.
//   /refund — issue a cash-out (full or partial). Writes a negative-amount
//             Payment row tagged gateway='refund'. Does NOT touch the
//             wallet — wallet redemption stays consumed; the refund is a
//             real cash payout to the customer. Use case: customer returns
//             goods after the fact, or admin grants a goodwill partial
//             refund. Multiple partial refunds accumulate; status flips to
//             PARTIALLY_REFUNDED until the sum equals total → REFUNDED.
//
// WALLET REVERSAL MECHANISM (void only):
//   The original /sales/finalize audit log row carries the per-batch
//   debit ledger in its details JSON (POS_SALE_FINALIZED →
//   walletBatchesDebited: [{batchId, batchType, consumedCents}, ...]).
//   We read that ledger, restore each batch's remainingCents +
//   status=ACTIVE, increment Wallet.balance by the total reversed, and
//   write a single WalletTransaction(type=VOID_REVERSAL). The audit log
//   IS the source of truth for the reversal trail since the schema has
//   no direct Sale→Batch FK linkage (the finalize tx records batches in
//   audit, not in a relational table — see /sales/finalize line ~1610).
//   If no audit row exists (legacy sales pre-slice-7) the void still
//   succeeds but walletReversedCents=0 with a diagnostic note.
//
// PARTIAL-REFUND TRACKING:
//   The Sale schema has no "refundedTotalCents" column (schema mods are
//   out of scope for this slice). We compute refunded-to-date on every
//   request by summing Payment rows where invoiceId = sale's invoice AND
//   amount < 0 AND gateway = 'refund'. The new refund row is rejected
//   with REFUND_EXCEEDS_BALANCE if (refundedSoFar + amountCents) >
//   sale.totalCents. Status flips: COMPLETED → PARTIALLY_REFUNDED on
//   first partial; PARTIALLY_REFUNDED → REFUNDED when sum reaches total.
//
// Error codes (both endpoints unless noted):
//   400 INVALID_ID             :id is not numeric
//   400 INVALID_REASON         body.reason missing / not string / >500 chars
//   400 INVALID_AMOUNT         (refund only) amountCents missing / non-int / ≤0
//   403 WELLNESS_ROLE_FORBIDDEN  RBAC (manager / user / clinical role denied)
//   404 SALE_NOT_FOUND         sale missing OR cross-tenant
//   409 SALE_NOT_VOIDABLE      (void) sale.status not COMPLETED
//   409 SALE_NOT_REFUNDABLE    (refund) sale.status not COMPLETED/PARTIALLY_REFUNDED
//   409 REFUND_EXCEEDS_BALANCE (refund) amountCents > remaining refundable
//   500 SALE_VOID_FAILED / SALE_REFUND_FAILED  unexpected tx failure

router.post("/sales/:id/void", strictAdminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res
        .status(400)
        .json({ error: "id must be a positive integer", code: "INVALID_ID" });
    }

    const { reason } = req.body || {};
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return res
        .status(400)
        .json({ error: "reason is required", code: "INVALID_REASON" });
    }
    if (reason.length > 500) {
      return res
        .status(400)
        .json({ error: "reason exceeds 500 chars", code: "INVALID_REASON" });
    }

    const sale = await prisma.sale.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!sale) {
      return res
        .status(404)
        .json({ error: "Sale not found", code: "SALE_NOT_FOUND" });
    }
    if (sale.status !== "COMPLETED") {
      return res.status(409).json({
        error: `Sale status=${sale.status} is not voidable (must be COMPLETED)`,
        code: "SALE_NOT_VOIDABLE",
        currentStatus: sale.status,
      });
    }

    // Look up the POS_SALE_FINALIZED audit row to recover wallet-batch
    // debit ledger. If not present (legacy sales pre-slice-7), the void
    // still succeeds with walletReversedCents=0.
    const finalizeAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: req.user.tenantId,
        entity: "Sale",
        action: "POS_SALE_FINALIZED",
        entityId: id,
      },
      orderBy: { createdAt: "desc" },
    });
    let batchesToReverse = [];
    let walletIdFromAudit = null;
    if (finalizeAudit && finalizeAudit.details) {
      try {
        const parsed =
          typeof finalizeAudit.details === "string"
            ? JSON.parse(finalizeAudit.details)
            : finalizeAudit.details;
        if (Array.isArray(parsed.walletBatchesDebited)) {
          batchesToReverse = parsed.walletBatchesDebited.filter(
            (b) =>
              b &&
              Number.isFinite(b.batchId) &&
              Number.isFinite(b.consumedCents) &&
              b.consumedCents > 0,
          );
        }
      } catch (_parseErr) {
        // Malformed audit JSON — proceed with empty reversal list (no wallet
        // path to undo). The void itself is still valid; the diagnostic is
        // logged for operators.
        console.warn(
          `[pos] void: malformed finalize audit details for sale ${id}`,
        );
      }
    }
    // Resolve walletId via the patient (Wallet has @unique patientId).
    // Only needed if there ARE batches to reverse.
    let walletReversedCents = 0;
    if (batchesToReverse.length > 0 && sale.patientId) {
      const wallet = await prisma.wallet.findFirst({
        where: tenantWhere(req, { patientId: sale.patientId }),
        select: { id: true, balance: true },
      });
      if (wallet) {
        walletIdFromAudit = wallet.id;
        walletReversedCents = batchesToReverse.reduce(
          (sum, b) => sum + b.consumedCents,
          0,
        );
      } else {
        // Wallet was deleted between finalize and void — cannot reverse,
        // but the sale void itself is still legitimate.
        batchesToReverse = [];
      }
    }

    // Look up the linked Invoice (no FK; matched by invoiceNum). Optional —
    // if no Invoice was created during finalize (patient lacked a Contact),
    // skip the Invoice.status flip.
    const linkedInvoice = await prisma.invoice.findFirst({
      where: { tenantId: req.user.tenantId, invoiceNum: sale.invoiceNumber },
      select: { id: true },
    });

    const now = new Date();
    try {
      await prisma.$transaction(async (tx) => {
        // 1) Reverse each wallet batch: restore remainingCents + flip
        //    EXHAUSTED → ACTIVE (newRemaining > 0 always since we're adding).
        for (const b of batchesToReverse) {
          const current = await tx.walletCreditBatch.findUnique({
            where: { id: b.batchId },
            select: { remainingCents: true, status: true },
          });
          if (!current) continue; // batch was hard-deleted; skip silently
          const restored = current.remainingCents + b.consumedCents;
          await tx.walletCreditBatch.update({
            where: { id: b.batchId },
            data: { remainingCents: restored, status: "ACTIVE" },
          });
        }
        // 2) Bump Wallet.balance by total reversed + write VOID_REVERSAL txn.
        if (walletIdFromAudit && walletReversedCents > 0) {
          const wallet = await tx.wallet.findUnique({
            where: { id: walletIdFromAudit },
            select: { balance: true },
          });
          const reversedRupees = walletReversedCents / 100;
          const newBalance = +(wallet.balance + reversedRupees).toFixed(2);
          await tx.wallet.update({
            where: { id: walletIdFromAudit },
            data: { balance: newBalance },
          });
          await tx.walletTransaction.create({
            data: {
              tenantId: req.user.tenantId,
              walletId: walletIdFromAudit,
              type: "VOID_REVERSAL",
              amount: reversedRupees,
              reason: `Void sale #${id}: ${reason.trim().slice(0, 200)}`,
              balanceAfter: newBalance,
              performedBy: req.user.userId,
            },
          });
        }
        // 3) Flip Invoice to VOIDED (if one was created).
        if (linkedInvoice) {
          await tx.invoice.update({
            where: { id: linkedInvoice.id },
            data: { status: "VOIDED" },
          });
        }
        // 4) Flip Sale to VOIDED. Schema has no voidedAt / voidedReason
        //    columns; reuse refundedAt + refundReason (only DateTime / Text
        //    free fields available) and tag the reason with a VOID: prefix
        //    so operators reading the row can distinguish void from refund.
        await tx.sale.update({
          where: { id },
          data: {
            status: "VOIDED",
            refundedAt: now,
            refundReason: `VOID: ${reason.trim().slice(0, 480)}`,
          },
        });
      });
    } catch (txErr) {
      console.error("[pos] void sale tx error:", txErr.message);
      return res
        .status(500)
        .json({ error: "Failed to void sale", code: "SALE_VOID_FAILED" });
    }

    // Audit OUTSIDE the transaction (hash-chained — never blocks the void).
    writeAudit(
      "Sale",
      "POS_SALE_VOIDED",
      id,
      req.user.userId,
      req.user.tenantId,
      {
        saleId: id,
        invoiceNumber: sale.invoiceNumber,
        reason: reason.trim().slice(0, 200),
        walletReversedCents,
        batchesReversed: batchesToReverse.length,
      },
    ).catch((auditErr) => {
      console.warn("[pos] POS_SALE_VOIDED audit failed:", auditErr.message);
    });

    return res.json({
      success: true,
      saleId: id,
      status: "VOIDED",
      walletReversedCents,
    });
  } catch (e) {
    console.error("[pos] void sale error:", e.message);
    return res
      .status(500)
      .json({ error: "Failed to void sale", code: "SALE_VOID_FAILED" });
  }
});

router.post("/sales/:id/refund", strictAdminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res
        .status(400)
        .json({ error: "id must be a positive integer", code: "INVALID_ID" });
    }

    const { reason, amountCents } = req.body || {};
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return res
        .status(400)
        .json({ error: "reason is required", code: "INVALID_REASON" });
    }
    if (reason.length > 500) {
      return res
        .status(400)
        .json({ error: "reason exceeds 500 chars", code: "INVALID_REASON" });
    }
    const amt = parseInt(amountCents, 10);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({
        error: "amountCents must be a positive integer",
        code: "INVALID_AMOUNT",
      });
    }

    const sale = await prisma.sale.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!sale) {
      return res
        .status(404)
        .json({ error: "Sale not found", code: "SALE_NOT_FOUND" });
    }
    if (sale.status !== "COMPLETED" && sale.status !== "PARTIALLY_REFUNDED") {
      return res.status(409).json({
        error: `Sale status=${sale.status} is not refundable (must be COMPLETED or PARTIALLY_REFUNDED)`,
        code: "SALE_NOT_REFUNDABLE",
        currentStatus: sale.status,
      });
    }

    // Sale.total is float rupees; promote to cents for integer math.
    const saleTotalCents = Math.round((sale.total || 0) * 100);

    // Resolve the linked Invoice (matched by invoiceNum — no FK in schema).
    // Refund Payment rows persist regardless of whether an Invoice was
    // created during finalize; an absent Invoice just means invoiceId=null
    // on the refund Payment, mirroring the finalize handler's contract.
    const linkedInvoice = await prisma.invoice.findFirst({
      where: { tenantId: req.user.tenantId, invoiceNum: sale.invoiceNumber },
      select: { id: true },
    });

    // Sum prior refund Payments (negative-amount, gateway='refund') for this
    // invoice to compute remaining refundable. If no Invoice was created
    // (linkedInvoice=null), refunded-so-far is 0 (nothing to sum against).
    let refundedSoFarCents = 0;
    if (linkedInvoice) {
      const priorRefunds = await prisma.payment.findMany({
        where: {
          tenantId: req.user.tenantId,
          invoiceId: linkedInvoice.id,
          gateway: "refund",
          amount: { lt: 0 },
        },
        select: { amount: true },
      });
      refundedSoFarCents = priorRefunds.reduce(
        (sum, p) => sum + Math.abs(Math.round(p.amount * 100)),
        0,
      );
    }
    const remainingRefundableCents = saleTotalCents - refundedSoFarCents;
    if (amt > remainingRefundableCents) {
      return res.status(409).json({
        error: `amountCents=${amt} exceeds remaining refundable=${remainingRefundableCents}`,
        code: "REFUND_EXCEEDS_BALANCE",
        requestedCents: amt,
        remainingCents: remainingRefundableCents,
      });
    }

    const newRefundedTotalCents = refundedSoFarCents + amt;
    const isFullRefund = newRefundedTotalCents >= saleTotalCents;
    const newStatus = isFullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED";
    const now = new Date();

    try {
      await prisma.$transaction(async (tx) => {
        // 1) Write the refund Payment row (negative amount, gateway='refund').
        await tx.payment.create({
          data: {
            tenantId: req.user.tenantId,
            invoiceId: linkedInvoice ? linkedInvoice.id : null,
            amount: -(amt / 100),
            currency: "INR",
            gateway: "refund",
            status: "SUCCESS",
            paidAt: now,
            metadata: JSON.stringify({
              saleId: id,
              reason: reason.trim().slice(0, 480),
              previousRefundedCents: refundedSoFarCents,
              newRefundedTotalCents,
            }).slice(0, 4000),
          },
        });
        // 2) Flip Sale.status; preserve refundReason as a running log
        //    (newest reason wins since schema has no per-refund log table).
        await tx.sale.update({
          where: { id },
          data: {
            status: newStatus,
            refundedAt: now,
            refundReason: reason.trim().slice(0, 1000),
          },
        });
      });
    } catch (txErr) {
      console.error("[pos] refund sale tx error:", txErr.message);
      return res
        .status(500)
        .json({ error: "Failed to refund sale", code: "SALE_REFUND_FAILED" });
    }

    writeAudit(
      "Sale",
      "POS_SALE_REFUNDED",
      id,
      req.user.userId,
      req.user.tenantId,
      {
        saleId: id,
        invoiceNumber: sale.invoiceNumber,
        amountCents: amt,
        reason: reason.trim().slice(0, 200),
        refundedTotalCents: newRefundedTotalCents,
        saleTotalCents,
        isFullRefund,
      },
    ).catch((auditErr) => {
      console.warn("[pos] POS_SALE_REFUNDED audit failed:", auditErr.message);
    });

    return res.json({
      success: true,
      saleId: id,
      status: newStatus,
      refundedTotalCents: newRefundedTotalCents,
    });
  } catch (e) {
    console.error("[pos] refund sale error:", e.message);
    return res
      .status(500)
      .json({ error: "Failed to refund sale", code: "SALE_REFUND_FAILED" });
  }
});

module.exports = router;
