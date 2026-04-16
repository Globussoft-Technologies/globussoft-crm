const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// Get Product Catalog Master Array
router.get("/products", verifyToken, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { name: 'asc' }
    });
    res.json(products);
  } catch(err) {
    res.status(500).json({ error: "Failed to fetch master product payload." });
  }
});

// Push new SKUs to Product Catalog
router.post("/products", verifyToken, async (req, res) => {
  try {
    const product = await prisma.product.create({ data: { ...req.body, tenantId: req.user.tenantId } });
    res.status(201).json(product);
  } catch(err) {
    res.status(500).json({ error: "Product matrix mutation failed structurally." });
  }
});

// Fetch all Quotes for an individual Deal
router.get("/quotes/:dealId", verifyToken, async (req, res) => {
  try {
    const quotes = await prisma.quote.findMany({
      where: { dealId: parseInt(req.params.dealId), tenantId: req.user.tenantId },
      include: { lineItems: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(quotes);
  } catch(err) {
    res.status(500).json({ error: "Fetching CPQ arrays failed." });
  }
});

// Compile a new CPQ Quote schema mapping multiple SaaS line items
router.post("/quotes", verifyToken, async (req, res) => {
  try {
    const { dealId, title, lineItems } = req.body;

    let computedTotal = 0;
    let computedMrr = 0;

    const linesToInject = lineItems.map(item => {
      const lineCost = item.quantity * item.unitPrice;
      if (item.isRecurring) computedMrr += lineCost;
      else computedTotal += lineCost;

      return {
        quantity: parseInt(item.quantity) || 1,
        unitPrice: parseFloat(item.unitPrice),
        productName: item.productName,
        isRecurring: Boolean(item.isRecurring),
        productId: item.productId ? parseInt(item.productId) : null
      };
    });

    const quote = await prisma.quote.create({
      data: {
        title,
        dealId: parseInt(dealId),
        totalAmount: computedTotal,
        mrr: computedMrr,
        tenantId: req.user.tenantId,
        lineItems: { create: linesToInject }
      },
      include: { lineItems: true }
    });

    res.status(201).json(quote);
  } catch(err) {
    res.status(500).json({ error: "CPQ SaaS Pipeline matrix compilation failed." });
  }
});

module.exports = router;
