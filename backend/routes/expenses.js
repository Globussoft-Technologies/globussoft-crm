const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const eventBus = require("../lib/eventBus");
const { verifyRole, verifyToken } = require("../middleware/auth");

// GET /api/expenses — list with optional filters
router.get("/", async (req, res) => {
  try {
    const { status, category } = req.query;

    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;
    if (category) where.category = category;

    const expenses = await prisma.expense.findMany({
      where,
      include: { user: true, contact: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(expenses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Expenses" });
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
