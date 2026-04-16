const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// Default currency set used when a tenant has not yet initialized anything.
const DEFAULTS = [
  { code: "USD", symbol: "$",  name: "US Dollar",        exchangeRate: 1.0,   isBase: true  },
  { code: "INR", symbol: "₹",  name: "Indian Rupee",     exchangeRate: 83.0,  isBase: false },
  { code: "EUR", symbol: "€",  name: "Euro",             exchangeRate: 0.92,  isBase: false },
  { code: "GBP", symbol: "£",  name: "British Pound",    exchangeRate: 0.79,  isBase: false },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar",  exchangeRate: 1.36,  isBase: false },
  { code: "AUD", symbol: "A$", name: "Australian Dollar",exchangeRate: 1.52,  isBase: false },
];

// GET /api/currencies — list currencies for tenant (fall back to defaults if none)
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const rows = await prisma.currency.findMany({
      where: { tenantId },
      orderBy: [{ isBase: "desc" }, { code: "asc" }],
    });
    if (rows.length === 0) {
      return res.json(DEFAULTS.map((d, i) => ({ id: -(i + 1), tenantId, ...d })));
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch currencies" });
  }
});

// POST /api/currencies — create a new currency for this tenant
router.post("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { code, symbol, name, exchangeRate, isBase } = req.body;
    if (!code || !symbol || !name) {
      return res.status(400).json({ error: "code, symbol, and name are required" });
    }
    const rate = exchangeRate != null ? parseFloat(exchangeRate) : 1.0;
    const makeBase = !!isBase;

    const created = await prisma.$transaction(async (tx) => {
      if (makeBase) {
        await tx.currency.updateMany({
          where: { tenantId, isBase: true },
          data: { isBase: false },
        });
      }
      return tx.currency.create({
        data: {
          code: String(code).toUpperCase(),
          symbol,
          name,
          exchangeRate: rate,
          isBase: makeBase,
          tenantId,
        },
      });
    });
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Currency code already exists for this tenant" });
    }
    res.status(500).json({ error: "Failed to create currency" });
  }
});

// POST /api/currencies/seed — initialize default currency set for tenant
router.post("/seed", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const existing = await prisma.currency.count({ where: { tenantId } });
    if (existing > 0) {
      return res.status(400).json({ error: "Currencies already initialized" });
    }
    const created = await prisma.$transaction(
      DEFAULTS.map((d) =>
        prisma.currency.create({
          data: { ...d, tenantId },
        })
      )
    );
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to seed currencies" });
  }
});

// PUT /api/currencies/:id — update a currency (tenant-scoped)
router.put("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.currency.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Currency not found" });

    const { code, symbol, name, exchangeRate, isBase } = req.body;
    const data = {};
    if (code !== undefined) data.code = String(code).toUpperCase();
    if (symbol !== undefined) data.symbol = symbol;
    if (name !== undefined) data.name = name;
    if (exchangeRate !== undefined) data.exchangeRate = parseFloat(exchangeRate);

    const updated = await prisma.$transaction(async (tx) => {
      if (isBase === true) {
        await tx.currency.updateMany({
          where: { tenantId, isBase: true, NOT: { id } },
          data: { isBase: false },
        });
        data.isBase = true;
      } else if (isBase === false) {
        data.isBase = false;
      }
      return tx.currency.update({ where: { id }, data });
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update currency" });
  }
});

// DELETE /api/currencies/:id — delete (only if not base)
router.delete("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.currency.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Currency not found" });
    if (existing.isBase) {
      return res.status(400).json({ error: "Cannot delete the base currency" });
    }

    await prisma.currency.delete({ where: { id } });
    res.json({ message: "Currency deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete currency" });
  }
});

// POST /api/currencies/:id/set-base — atomically set a currency as the base
router.post("/:id/set-base", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.currency.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Currency not found" });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.currency.updateMany({
        where: { tenantId, isBase: true },
        data: { isBase: false },
      });
      return tx.currency.update({
        where: { id },
        data: { isBase: true, exchangeRate: 1.0 },
      });
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to set base currency" });
  }
});

// POST /api/currencies/convert — convert between two currencies
router.post("/convert", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { amount, from, to } = req.body;
    if (amount == null || !from || !to) {
      return res.status(400).json({ error: "amount, from, and to are required" });
    }
    const amt = parseFloat(amount);
    const fromCode = String(from).toUpperCase();
    const toCode = String(to).toUpperCase();

    let currencies = await prisma.currency.findMany({ where: { tenantId } });
    if (currencies.length === 0) {
      currencies = DEFAULTS.map((d, i) => ({ id: -(i + 1), tenantId, ...d }));
    }

    const fromCur = currencies.find((c) => c.code === fromCode);
    const toCur = currencies.find((c) => c.code === toCode);
    if (!fromCur || !toCur) {
      return res.status(404).json({ error: "Currency not found" });
    }

    // Rates are relative to the base currency. 1 base = exchangeRate units.
    // amount_base = amount_from / fromCur.exchangeRate
    // amount_to   = amount_base * toCur.exchangeRate
    const rate = toCur.exchangeRate / fromCur.exchangeRate;
    const converted = amt * rate;

    res.json({
      converted: Math.round(converted * 10000) / 10000,
      rate: Math.round(rate * 1000000) / 1000000,
      from: fromCode,
      to: toCode,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to convert" });
  }
});

// GET /api/currencies/pivot/deals — total open-deal value, converted into the base currency
router.get("/pivot/deals", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    let currencies = await prisma.currency.findMany({ where: { tenantId } });
    let usingDefaults = false;
    if (currencies.length === 0) {
      currencies = DEFAULTS.map((d, i) => ({ id: -(i + 1), tenantId, ...d }));
      usingDefaults = true;
    }
    const base = currencies.find((c) => c.isBase) || currencies[0];
    const rateByCode = Object.fromEntries(currencies.map((c) => [c.code, c.exchangeRate]));

    // "Open" = deals not in won or lost stage
    const deals = await prisma.deal.findMany({
      where: {
        tenantId,
        stage: { notIn: ["won", "lost"] },
      },
      select: { amount: true, currency: true },
    });

    const byCurrency = {};
    let totalInBase = 0;
    for (const d of deals) {
      const code = (d.currency || base.code).toUpperCase();
      const amt = d.amount || 0;
      byCurrency[code] = byCurrency[code] || { amount: 0, count: 0 };
      byCurrency[code].amount += amt;
      byCurrency[code].count += 1;

      const fromRate = rateByCode[code];
      if (fromRate) {
        const inBase = amt / fromRate; // convert to base
        totalInBase += inBase * base.exchangeRate; // then scale (base.exchangeRate is 1, but keep explicit)
      }
    }

    res.json({
      baseCode: base.code,
      baseSymbol: base.symbol,
      totalInBase: Math.round(totalInBase * 100) / 100,
      dealCount: deals.length,
      byCurrency,
      usingDefaults,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build pivot" });
  }
});

module.exports = router;
