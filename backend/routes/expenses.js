const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

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
    res.json({ message: "Expense Deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete Expense" });
  }
});

module.exports = router;
