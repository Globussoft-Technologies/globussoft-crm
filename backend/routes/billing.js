const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken, verifyRole } = require("../middleware/auth");
const crypto = require("crypto");

const router = express.Router();
const prisma = new PrismaClient();

// Fetch all ledgers
router.get("/", verifyToken, async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      include: { contact: true, deal: true },
      orderBy: [{ status: "desc" }, { dueDate: "asc" }]
    });
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: "Failed to locate invoice ledger" });
  }
});

// Draft new Invoice
router.post("/", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const { amount, dueDate, contactId, dealId } = req.body;
    const invNum = `INV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNum: invNum,
        amount: parseFloat(amount),
        dueDate: new Date(dueDate),
        contactId: parseInt(contactId),
        dealId: dealId ? parseInt(dealId) : null
      },
      include: { contact: true, deal: true }
    });
    res.status(201).json(invoice);
  } catch (err) {
    res.status(500).json({ error: "Invoice compilation and issuance failed" });
  }
});

// Reconcile Payment (Mark as Paid)
router.put("/:id/pay", verifyToken, async (req, res) => {
  try {
    const invoice = await prisma.invoice.update({
      where: { id: parseInt(req.params.id) },
      data: { status: "PAID" },
      include: { contact: true }
    });
    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: "Payment reconciliation operation failed" });
  }
});

// Obliterate Invoice
router.delete("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    await prisma.invoice.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: "Ledger deletion failure" });
  }
});

module.exports = router;
