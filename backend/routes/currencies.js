const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
// #527 (CRIT-02 hardening): currency CRUD is admin-only. GET stays open
// (USERs need rates to render deal/invoice values). POST /convert is also
// open — it's a calculation endpoint with no side effect.
const adminOnly = [verifyToken, verifyRole(["ADMIN"])];

// Default currency set used when a tenant has not yet initialized anything.
const DEFAULTS = [
  { code: "USD", symbol: "$",  name: "US Dollar",        exchangeRate: 1.0,   isBase: true  },
  // ECB reference rates, 16 Oct 2026, normalized to USD=1.
  { code: "INR", symbol: "₹",  name: "Indian Rupee",     exchangeRate: 94.96,  isBase: false },
  { code: "EUR", symbol: "€",  name: "Euro",             exchangeRate: 0.8887, isBase: false },
  { code: "GBP", symbol: "£",  name: "British Pound",    exchangeRate: 0.7503, isBase: false },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar",  exchangeRate: 1.4161, isBase: false },
  { code: "AUD", symbol: "A$", name: "Australian Dollar",exchangeRate: 1.4371, isBase: false },
];

// Preview and initialization follow the tenant's reporting currency when it
// is part of the starter set. Keep the published cross-rates unchanged.
async function defaultsForTenant(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { defaultCurrency: true },
  });
  const base = DEFAULTS.find((currency) => currency.code === tenant?.defaultCurrency) || DEFAULTS[0];
  return DEFAULTS.map((currency) => ({
    ...currency,
    exchangeRate: currency.exchangeRate / base.exchangeRate,
    isBase: currency.code === base.code,
  }));
}

// GET /api/currencies — list currencies for tenant (fall back to defaults if none)
//
// Slim-shape opt-in (#920 slice 46): when called with ?fields=summary,
// the handler drops the heavier metadata columns (`createdAt`/`updatedAt`)
// from the Prisma select — useful for picker / dropdown / autocomplete
// surfaces (deal-form currency selector, invoice-line currency dropdown,
// settings menu) that only need id+code+symbol+name+exchangeRate+isBase
// and don't render the audit-trail timestamps. Existing callers (no
// ?fields, or any non-exact value) get the full row shape unchanged.
// DEFAULTS fallback also honours the flag and projects to the same slim
// keyset for shape parity. Same strict opt-in pattern as slices 1-45.
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where: { tenantId },
      orderBy: [{ isBase: "desc" }, { code: "asc" }],
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        code: true,
        symbol: true,
        name: true,
        exchangeRate: true,
        isBase: true,
        tenantId: true,
      };
    }
    const rows = await prisma.currency.findMany(findManyArgs);
    if (rows.length === 0) {
      const defaults = (await defaultsForTenant(tenantId)).map((d, i) => ({ id: -(i + 1), tenantId, ...d }));
      if (isSummary) {
        // Project DEFAULTS to the same slim keyset for shape parity.
        return res.json(
          defaults.map((d) => ({
            id: d.id,
            code: d.code,
            symbol: d.symbol,
            name: d.name,
            exchangeRate: d.exchangeRate,
            isBase: d.isBase,
            tenantId: d.tenantId,
          })),
        );
      }
      return res.json(defaults);
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch currencies" });
  }
});

// GET /api/currencies/catalog — available currencies and published rates
// relative to this tenant's base. Used to prefill the Add Currency form.
router.get("/catalog", async (req, res) => {
  try {
    const rows = await prisma.currency.findMany({
      where: { tenantId: req.user.tenantId, isBase: true },
      select: { code: true },
    });
    const baseCode = rows[0]?.code || (await defaultsForTenant(req.user.tenantId)).find((currency) => currency.isBase).code;
    const [detailsResponse, ratesResponse] = await Promise.all([
      fetch("https://api.frankfurter.dev/v2/currencies", { signal: AbortSignal.timeout(8000) }),
      fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(baseCode)}`, { signal: AbortSignal.timeout(8000) }),
    ]);
    if (!detailsResponse.ok || !ratesResponse.ok) {
      return res.status(502).json({ error: "Currency data is temporarily unavailable" });
    }
    const [details, latest] = await Promise.all([detailsResponse.json(), ratesResponse.json()]);
    if (!Array.isArray(details) || !latest?.rates || typeof latest.rates !== "object") {
      return res.status(502).json({ error: "Currency data is temporarily unavailable" });
    }
    const currencies = details
      .map((currency) => ({
        code: currency.iso_code,
        symbol: currency.symbol,
        name: currency.name,
        exchangeRate: Number(latest.rates[currency.iso_code]),
      }))
      .filter((currency) => /^[A-Z]{3}$/.test(currency.code)
        && typeof currency.name === "string" && currency.name.trim()
        && typeof currency.symbol === "string" && currency.symbol.trim()
        && Number.isFinite(currency.exchangeRate) && currency.exchangeRate > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ baseCode, asOf: latest.date, currencies });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Currency data is temporarily unavailable" });
  }
});

// POST /api/currencies — create a new currency for this tenant
router.post("/", ...adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { code, symbol, name, exchangeRate, isBase } = req.body;
    if (!code || !symbol || !name) {
      return res.status(400).json({ error: "code, symbol, and name are required" });
    }
    const rate = exchangeRate != null ? parseFloat(exchangeRate) : 1.0;
    const makeBase = !!isBase;
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ error: "exchangeRate must be greater than zero" });
    }

    const created = await prisma.$transaction(async (tx) => {
      if (makeBase) {
        const existingRows = await tx.currency.findMany({
          where: { tenantId },
          select: { id: true, exchangeRate: true },
        }) || [];
        for (const existing of existingRows) {
          await tx.currency.update({
            where: { id: existing.id },
            data: { exchangeRate: Number(existing.exchangeRate) / rate },
          });
        }
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
          exchangeRate: makeBase ? 1 : rate,
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
router.post("/seed", ...adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const existing = await prisma.currency.count({ where: { tenantId } });
    if (existing > 0) {
      return res.status(400).json({ error: "Currencies already initialized" });
    }
    const defaults = await defaultsForTenant(tenantId);
    const created = await prisma.$transaction(
      defaults.map((d) =>
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
router.put("/:id", ...adminOnly, async (req, res) => {
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
    if (exchangeRate !== undefined) {
      data.exchangeRate = parseFloat(exchangeRate);
    }

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
router.delete("/:id", ...adminOnly, async (req, res) => {
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
    res.status(204).end(); // #550: DELETE → 204 No Content
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete currency" });
  }
});

// POST /api/currencies/:id/set-base — atomically set a currency as the base
router.post("/:id/set-base", ...adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.currency.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Currency not found" });

    const allCurrencies = (await prisma.currency.findMany({ where: { tenantId }, select: { id: true, exchangeRate: true } })) || [];
    const newBaseRate = Number(existing.exchangeRate);
    if (!Number.isFinite(newBaseRate) || newBaseRate <= 0) {
      return res.status(400).json({ error: "Base currency must have a positive exchange rate" });
    }
    const updated = await prisma.$transaction(async (tx) => {
      await tx.currency.updateMany({
        where: { tenantId, isBase: true },
        data: { isBase: false },
      });
      for (const currency of allCurrencies) {
        await tx.currency.update({
          where: { id: currency.id },
          data: { exchangeRate: currency.id === id ? 1.0 : Number(currency.exchangeRate) / newBaseRate },
        });
      }
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
      currencies = (await defaultsForTenant(tenantId)).map((d, i) => ({ id: -(i + 1), tenantId, ...d }));
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
      currencies = (await defaultsForTenant(tenantId)).map((d, i) => ({ id: -(i + 1), tenantId, ...d }));
      usingDefaults = true;
    }
    const base = currencies.find((c) => c.isBase) || currencies[0];
    let tenant = null;
    try {
      if (prisma.tenant?.findUnique) tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultCurrency: true } });
    } catch (_err) { tenant = null; }
    const reportingCode = String(tenant?.defaultCurrency || base.code).toUpperCase();
    const reporting = currencies.find((c) => c.code === reportingCode) || base;
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
    let totalInReporting = 0;
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
        totalInReporting += inBase * reporting.exchangeRate;
      }
    }

    res.json({
      baseCode: base.code,
      baseSymbol: base.symbol,
      totalInBase: Math.round(totalInBase * 100) / 100,
      reportingCode: reporting.code,
      reportingSymbol: reporting.symbol,
      totalInReporting: Math.round(totalInReporting * 100) / 100,
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
