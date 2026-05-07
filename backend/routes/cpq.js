const express = require("express");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");
// #577 — wire fieldFilter into Quote routes so FieldPermissions UI rules
// are actually enforced. Mirrors deals.js + contacts.js + billing.js
// adoption pattern from #464.
const { filterReadFields, filterWriteFields } = require("../middleware/fieldFilter");

// Get Product Catalog Master Array
router.get("/products", verifyToken, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { name: 'asc' }
    });
    res.json(products);
  } catch(_err) {
    res.status(500).json({ error: "Failed to fetch master product payload." });
  }
});

// Push new SKUs to Product Catalog
router.post("/products", verifyToken, async (req, res) => {
  try {
    const product = await prisma.product.create({ data: { ...req.body, tenantId: req.user.tenantId } });
    res.status(201).json(product);
  } catch(_err) {
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
    // #577: strip read-restricted fields per the caller's role.
    const filtered = await filterReadFields(quotes, req.user.role, "Quote", req.user.tenantId);
    res.json(filtered);
  } catch(_err) {
    res.status(500).json({ error: "Fetching CPQ arrays failed." });
  }
});

// Compile a new CPQ Quote schema mapping multiple SaaS line items
router.post("/quotes", verifyToken, async (req, res) => {
  try {
    // #577: strip write-restricted fields before destructuring the body.
    req.body = await filterWriteFields(req.body, req.user.role, "Quote", req.user.tenantId);
    const { dealId, title, lineItems } = req.body;

    let computedTotal = 0;
    let computedMrr = 0;

    const linesToInject = lineItems.map(item => {
      // Normalize numeric inputs BEFORE computing line totals — otherwise
      // missing quantity → undefined * unitPrice → NaN, which Prisma rejects
      // on the Float column and surfaces as a generic 500.
      //
      // Use Number.isFinite to distinguish missing/non-numeric from explicit
      // zero. `parseInt(0) || 1` returns 1 because 0 is falsy in JS, which
      // silently rewrote a deliberate quantity=0 into 1 and corrupted
      // totalAmount (cpq-api spec line 382). isFinite-guard keeps explicit 0
      // and only falls back to 1 on NaN (undefined / null / 'abc').
      const parsedQty = parseInt(item.quantity);
      const qty = Number.isFinite(parsedQty) ? parsedQty : 1;
      const parsedPrice = parseFloat(item.unitPrice);
      const price = Number.isFinite(parsedPrice) ? parsedPrice : 0;
      const lineCost = qty * price;
      if (item.isRecurring) computedMrr += lineCost;
      else computedTotal += lineCost;

      return {
        quantity: qty,
        unitPrice: price,
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
  } catch(_err) {
    res.status(500).json({ error: "CPQ SaaS Pipeline matrix compilation failed." });
  }
});

module.exports = router;
