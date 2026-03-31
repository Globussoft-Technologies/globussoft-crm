const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");
const prisma = new PrismaClient();

// GET /api/estimates — list with optional status filter
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status) where.status = status;

    const estimates = await prisma.estimate.findMany({
      where,
      include: { contact: true, deal: true, lineItems: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(estimates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch estimates" });
  }
});

// GET /api/estimates/:id — single estimate
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });

    const estimate = await prisma.estimate.findUnique({
      where: { id },
      include: { contact: true, deal: true, lineItems: true },
    });
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });
    res.json(estimate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch estimate" });
  }
});

// POST /api/estimates — create with line items
router.post("/", async (req, res) => {
  try {
    const { title, contactId, dealId, validUntil, notes, lineItems } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const estimateNum = `EST-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const parsedLineItems = Array.isArray(lineItems) ? lineItems : [];
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
    res.status(201).json(estimate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create estimate" });
  }
});

// PUT /api/estimates/:id — update estimate fields (not line items)
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });

    const { title, status, validUntil, notes, contactId, dealId } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (status !== undefined) data.status = status;
    if (validUntil !== undefined) data.validUntil = validUntil ? new Date(validUntil) : null;
    if (notes !== undefined) data.notes = notes;
    if (contactId !== undefined) data.contactId = contactId ? parseInt(contactId) : null;
    if (dealId !== undefined) data.dealId = dealId ? parseInt(dealId) : null;

    const estimate = await prisma.estimate.update({
      where: { id },
      data,
      include: { contact: true, deal: true, lineItems: true },
    });
    res.json(estimate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update estimate" });
  }
});

// PUT /api/estimates/:id/convert — convert estimate to invoice
router.put("/:id/convert", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });

    const estimate = await prisma.estimate.findUnique({
      where: { id },
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
        },
      });

      const updatedEstimate = await tx.estimate.update({
        where: { id },
        data: { status: "Converted" },
        include: { contact: true, deal: true, lineItems: true },
      });

      return { estimate: updatedEstimate, invoice };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to convert estimate to invoice" });
  }
});

// DELETE /api/estimates/:id
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });
    await prisma.estimate.delete({ where: { id } });
    res.json({ message: "Estimate deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete estimate" });
  }
});

module.exports = router;
