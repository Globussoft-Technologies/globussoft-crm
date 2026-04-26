const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const prisma = require("../lib/prisma");

// GET /api/estimates — list with optional status filter
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;

    // #172: pagination
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const estimates = await prisma.estimate.findMany({
      where, take: limit, skip: offset,
      include: { contact: true, deal: true, lineItems: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(estimates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch estimates" });
  }
});

// GET /api/estimates/:id
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });

    const estimate = await prisma.estimate.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { contact: true, deal: true, lineItems: true },
    });
    if (!estimate) return res.status(404).json({ error: "Estimate not found" });
    res.json(estimate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch estimate" });
  }
});

// #174: cap line items per estimate to prevent the unbounded-array DoS surface.
// 200 is plenty for any real-world quote and keeps payloads small.
const MAX_LINE_ITEMS = 200;

// POST /api/estimates
router.post("/", async (req, res) => {
  try {
    // #199: accept legacy field names (`name`, `items`) as aliases for the
    // current contract (`title`, `lineItems`). Older mobile builds and cached
    // SPA bundles still post the old shape. The new names win when both are
    // supplied. This is a deprecation-window alias, not a permanent dual-API.
    const { contactId, dealId, validUntil, notes } = req.body;
    const title = req.body.title !== undefined ? req.body.title : req.body.name;
    const lineItems = req.body.lineItems !== undefined ? req.body.lineItems : req.body.items;
    if (!title) return res.status(400).json({ error: "title is required (legacy field 'name' also accepted)" });

    const estimateNum = `EST-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const parsedLineItems = Array.isArray(lineItems) ? lineItems : [];
    // #164: empty estimates clutter the ledger with ₹0 rows; require at least one line.
    if (parsedLineItems.length === 0) {
      return res.status(400).json({ error: "At least one line item is required", code: "LINE_ITEMS_REQUIRED" });
    }
    // #174: hard cap on line item count.
    if (parsedLineItems.length > MAX_LINE_ITEMS) {
      return res.status(400).json({ error: `lineItems cannot exceed ${MAX_LINE_ITEMS} entries`, code: "LINE_ITEMS_LIMIT_EXCEEDED" });
    }
    // #178: validUntil cannot be before today (1900-01-01 was being accepted).
    if (validUntil) {
      const vu = new Date(validUntil);
      if (Number.isNaN(vu.getTime())) {
        return res.status(400).json({ error: "validUntil is not a valid date", code: "INVALID_VALID_UNTIL" });
      }
      // Allow today; reject anything strictly before today's start-of-day.
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      if (vu < todayStart) {
        return res.status(400).json({ error: "validUntil cannot be in the past", code: "VALID_UNTIL_IN_PAST" });
      }
    }
    // #123 + #164: reject negative qty/price AND zero qty (a 0-quantity row is meaningless).
    for (const [i, item] of parsedLineItems.entries()) {
      const q = Number(item.quantity);
      const p = Number(item.unitPrice);
      if (Number.isFinite(q) && q < 1) {
        return res.status(400).json({ error: `Line item ${i + 1}: quantity must be at least 1`, code: "INVALID_QUANTITY" });
      }
      if (Number.isFinite(p) && p < 0) {
        return res.status(400).json({ error: `Line item ${i + 1}: unit price cannot be negative`, code: "NEGATIVE_PRICE" });
      }
    }
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
        tenantId: req.user.tenantId,
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

// PUT /api/estimates/:id
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });

    const existing = await prisma.estimate.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Estimate not found" });

    const { title, status, validUntil, notes, contactId, dealId } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (status !== undefined) data.status = status;
    if (validUntil !== undefined) data.validUntil = validUntil ? new Date(validUntil) : null;
    if (notes !== undefined) data.notes = notes;
    if (contactId !== undefined) data.contactId = contactId ? parseInt(contactId) : null;
    if (dealId !== undefined) data.dealId = dealId ? parseInt(dealId) : null;

    const estimate = await prisma.estimate.update({
      where: { id: existing.id },
      data,
      include: { contact: true, deal: true, lineItems: true },
    });
    res.json(estimate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update estimate" });
  }
});

// PUT /api/estimates/:id/convert — convert to invoice
router.put("/:id/convert", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid estimate ID" });

    const estimate = await prisma.estimate.findFirst({
      where: { id, tenantId: req.user.tenantId },
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
          tenantId: req.user.tenantId,
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
    const existing = await prisma.estimate.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Estimate not found" });
    await prisma.estimate.delete({ where: { id: existing.id } });
    res.json({ message: "Estimate deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete estimate" });
  }
});

module.exports = router;
