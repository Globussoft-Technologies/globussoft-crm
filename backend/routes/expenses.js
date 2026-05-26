const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const eventBus = require("../lib/eventBus");
const { verifyRole, verifyToken } = require("../middleware/auth");

// GET /api/expenses — list with optional filters
//
// #920 slice 6 — opt-in slim shape via `?fields=summary`. When set, returns a
// Prisma `select` dropping nested includes (user/contact) and heavy flat
// columns (description, notes, receiptUrl) from the wire. ADDITIVE only:
// any non-`summary` value (or absent param) preserves the existing
// full-shape include path. Mirrors the contacts/deals/tickets/tasks/projects
// shape from slices 1-5.
router.get("/", async (req, res) => {
  try {
    const { status, category } = req.query;

    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;
    if (category) where.category = category;

    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where,
      orderBy: { createdAt: "desc" },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        title: true,
        amount: true,
        category: true,
        status: true,
        currency: true,
        expenseDate: true,
        userId: true,
        contactId: true,
        tenantId: true,
        createdAt: true,
      };
    } else {
      findManyArgs.include = { user: true, contact: true };
    }

    const expenses = await prisma.expense.findMany(findManyArgs);

    res.json(expenses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Expenses" });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/expenses/stats
//
// CRM polish — first /stats aggregate for the Expense CRUD route.
// Read-only tenant-wide KPI surface backing the finance dashboard's
// expense tile. Mirrors billing.js /stats + travel_suppliers.js
// /stats posture — anodyne aggregate, NO audit row written.
//
// Auth: verifyToken (matches the explicit gate on billing.js /stats).
// The Expense list endpoint above relies on the global auth guard;
// the per-route gate here is for parity with other /stats endpoints
// and for unit-test mount-the-router-bare ergonomics.
//
// Schema notes — actual Expense columns (verified against schema.prisma
// model Expense): amount (Float), status (default "Pending"; live values
// per the schema comment: Draft, Pending, Approved, Rejected, Reimbursed),
// category (default "General"), createdAt. NO submittedAt column — date
// bounds operate on createdAt (matches billing.js /stats).
//
// approvedAmount sums Approved + Reimbursed (terminal-positive states).
// pendingAmount sums Pending (awaiting decision). totalAmount sums every
// row regardless of status.
//
// Query params:
//   ?from / ?to — optional ISO date bounds on createdAt. Invalid → 400
//                 INVALID_DATE. Both optional, independent validation.
//
// Response envelope:
//   { total, byStatus, byCategory, totalAmount, approvedAmount,
//     pendingAmount, lastCreatedAt }
//
// Express route ordering: literal-path /stats MUST be declared BEFORE
// the /:id family or `:id="stats"` would 400 INVALID_ID before reaching
// this handler. Same convention as billing.js + travel_suppliers.js.
// ────────────────────────────────────────────────────────────────
router.get("/stats", verifyToken, async (req, res) => {
  try {
    // Validate optional date bounds. Independent validation so a bad
    // ?from doesn't get masked by a missing ?to and vice-versa.
    const createdAtClause = {};
    if (req.query.from !== undefined) {
      const fromDate = new Date(req.query.from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: "invalid from date", code: "INVALID_DATE" });
      }
      createdAtClause.gte = fromDate;
    }
    if (req.query.to !== undefined) {
      const toDate = new Date(req.query.to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ error: "invalid to date", code: "INVALID_DATE" });
      }
      createdAtClause.lte = toDate;
    }

    const where = { tenantId: req.user.tenantId };
    if (Object.keys(createdAtClause).length > 0) {
      where.createdAt = createdAtClause;
    }

    // Pull only the columns needed for aggregation — avoids dragging
    // user/contact joins into memory just to sum.
    const rows = await prisma.expense.findMany({
      where,
      select: { status: true, category: true, amount: true, createdAt: true },
    });

    const total = rows.length;
    const byStatus = {};
    const byCategory = {};
    let totalSum = 0;
    let approvedSum = 0;
    let pendingSum = 0;
    let lastCreatedAt = null;
    const APPROVED_STATES = new Set(["Approved", "Reimbursed"]);

    for (const r of rows) {
      const status = r.status || "Pending";
      byStatus[status] = (byStatus[status] || 0) + 1;

      const category = r.category || "General";
      byCategory[category] = (byCategory[category] || 0) + 1;

      const amt = Number(r.amount) || 0;
      totalSum += amt;
      if (APPROVED_STATES.has(status)) approvedSum += amt;
      if (status === "Pending") pendingSum += amt;

      if (r.createdAt && (lastCreatedAt === null || new Date(r.createdAt) > lastCreatedAt)) {
        lastCreatedAt = new Date(r.createdAt);
      }
    }

    // Half-up 2dp rounding — EPSILON tweak collapses JS float noise
    // (0.1+0.2 type artefacts) so 100.555 rounds to 100.56 not 100.55.
    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

    res.json({
      total,
      byStatus,
      byCategory,
      totalAmount: round2(totalSum),
      approvedAmount: round2(approvedSum),
      pendingAmount: round2(pendingSum),
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[expenses/stats]", err);
    res.status(500).json({ error: "Failed to compute expense stats" });
  }
});

// GET /api/expenses/:id — single expense
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid expense ID" });

    const expense = await prisma.expense.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { user: true, contact: true },
    });

    if (!expense) return res.status(404).json({ error: "Expense not found" });
    res.json(expense);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Expense" });
  }
});

// POST /api/expenses — create expense
router.post("/", async (req, res) => {
  try {
    const { title, amount, category, notes, expenseDate, contactId, receiptUrl } = req.body;

    if (!title) return res.status(400).json({ error: "title is required" });
    if (amount === undefined || amount === null) return res.status(400).json({ error: "amount is required" });

    const expense = await prisma.expense.create({
      data: {
        title,
        amount: parseFloat(amount),
        category: category || "General",
        notes: notes || null,
        receiptUrl: receiptUrl || null,
        expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
        userId: req.user.userId ? parseInt(req.user.userId) : null,
        contactId: contactId ? parseInt(contactId) : null,
        tenantId: req.user.tenantId,
      },
      include: { user: true, contact: true },
    });

    // Emit event for notification engine when expense is created
    const submitterName = expense.user?.name || "Employee";
    console.log('[expenses.post] Emitting expense.created event:', { submitterName, amount: expense.amount, title: expense.title });
    eventBus.emitEvent("expense.created", {
      expenseId: expense.id,
      submitterId: expense.userId,
      submitterName,
      amount: expense.amount,
      title: expense.title
    }, req.user.tenantId);

    res.status(201).json(expense);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create Expense" });
  }
});

// PUT /api/expenses/:id — update expense
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid expense ID" });

    const existing = await prisma.expense.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Expense not found" });

    const { title, amount, category, status, notes, expenseDate, contactId, receiptUrl } = req.body;

    const data = {};
    if (title !== undefined) data.title = title;
    if (amount !== undefined) data.amount = parseFloat(amount);
    if (category !== undefined) data.category = category;
    if (status !== undefined) data.status = status;
    if (notes !== undefined) data.notes = notes;
    if (receiptUrl !== undefined) data.receiptUrl = receiptUrl;
    if (expenseDate !== undefined) data.expenseDate = expenseDate ? new Date(expenseDate) : null;
    if (contactId !== undefined) data.contactId = contactId ? parseInt(contactId) : null;

    const expense = await prisma.expense.update({
      where: { id: existing.id },
      data,
      include: { user: true, contact: true },
    });

    res.json(expense);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update Expense" });
  }
});

// DELETE /api/expenses/:id — delete expense
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid expense ID" });

    const existing = await prisma.expense.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Expense not found" });

    await prisma.expense.delete({ where: { id: existing.id } });
    res.status(204).end(); // #550: DELETE → 204 No Content
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete Expense" });
  }
});

// PATCH /api/expenses/:id/submit — submit expense for approval
router.patch("/:id/submit", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid expense ID" });

    const expense = await prisma.expense.findFirst({
      where: { id, tenantId: req.user.tenantId }
    });

    if (!expense || expense.tenantId !== req.user.tenantId) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const updated = await prisma.expense.update({
      where: { id },
      data: { status: "Pending" }
    });

    // Emit event for notification engine
    const submitter = await prisma.user.findUnique({
      where: { id: updated.userId },
      select: { name: true }
    });
    eventBus.emitEvent("expense.submitted", {
      expenseId: updated.id,
      submitterId: updated.userId,
      submitterName: submitter?.name || "Employee",
      title: updated.title,
      amount: updated.amount
    }, req.user.tenantId);

    res.json(updated);
  } catch (err) {
    console.error('[expenses.patch/submit]', err.message);
    res.status(500).json({ error: "Failed to submit Expense", details: err.message });
  }
});

// PATCH /api/expenses/:id/approve — admin approves expense
router.patch("/:id/approve", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid expense ID" });

    const expense = await prisma.expense.findFirst({
      where: { id, tenantId: req.user.tenantId }
    });

    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const updated = await prisma.expense.update({
      where: { id },
      data: {
        status: "Approved",
        approvedById: req.user.userId
      }
    });

    // Emit event for notification engine
    eventBus.emitEvent("expense.approved", {
      expenseId: updated.id,
      submitterId: updated.userId,
      title: updated.title,
      amount: updated.amount,
      approverName: req.user.name || "Admin"
    }, req.user.tenantId);

    res.json(updated);
  } catch (err) {
    console.error('[expenses.patch/approve]', err.message);
    res.status(500).json({ error: "Failed to approve Expense", details: err.message });
  }
});

// PATCH /api/expenses/:id/reject — admin rejects expense
router.patch("/:id/reject", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid expense ID" });

    const { reason } = req.body;

    const expense = await prisma.expense.findFirst({
      where: { id, tenantId: req.user.tenantId }
    });

    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const updated = await prisma.expense.update({
      where: { id },
      data: {
        status: "Rejected",
        approvedById: req.user.userId,
        notes: reason ? `${expense.notes || ""}\nRejection reason: ${reason}` : expense.notes
      }
    });

    // Emit event for notification engine
    eventBus.emitEvent("expense.rejected", {
      expenseId: updated.id,
      submitterId: updated.userId,
      title: updated.title,
      amount: updated.amount,
      rejectionReason: reason || "No reason provided"
    }, req.user.tenantId);

    res.json(updated);
  } catch (err) {
    console.error('[expenses.patch/reject]', err.message);
    res.status(500).json({ error: "Failed to reject Expense", details: err.message });
  }
});

module.exports = router;
