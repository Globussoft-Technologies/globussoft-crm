/**
 * /api/fx — FX-rate read endpoints (PRD_TRAVEL_QUOTE_BUILDER G018 / DD-5.4)
 *
 * Mounted at /api/fx (not /api/travel/fx) — the FX cache is tenant-agnostic
 * cross-currency reference data, no sub-brand isolation needed. Endpoints
 * are still guarded by the global verifyToken middleware so anonymous
 * traffic cannot poll our cache; future cred-blocked external integrations
 * may surface their own /api/v1/external/fx/* alias with API-key auth.
 *
 * Endpoints:
 *   GET /api/fx/latest?base=INR&quote=USD
 *     → 200 { base, quote, rate, fetchedAt, source } | 404 NO_RATE
 *   GET /api/fx/history?base=INR&quote=USD&from=2026-01-01&to=2026-01-31
 *     → 200 { base, quote, rows: [{ rate, fetchedAt, source }, ...] }
 *
 * Read-only — the cron is the sole writer (fxRateEngine.js). All write
 * paths return 405 implicitly (Express default for an unmatched verb on a
 * mounted router). The FxRate model is admin-managed, never edited by
 * end-users.
 */

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const fxRates = require("../lib/fxRates");

function validatePair(req, res) {
  const { base, quote } = req.query || {};
  if (!base || !quote) {
    res.status(400).json({
      error: "base and quote query params are required",
      code: "MISSING_FIELDS",
    });
    return null;
  }
  const baseN = String(base).toUpperCase();
  const quoteN = String(quote).toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseN) || !/^[A-Z]{3}$/.test(quoteN)) {
    res.status(400).json({
      error: "base and quote must be 3-character ISO 4217 codes",
      code: "INVALID_CURRENCY_CODE",
    });
    return null;
  }
  return { base: baseN, quote: quoteN };
}

// GET /api/fx/latest — freshest cached rate for the pair.
router.get("/latest", verifyToken, async (req, res) => {
  try {
    const pair = validatePair(req, res);
    if (!pair) return;
    const row = await fxRates.getLatestFromDb(prisma, pair.base, pair.quote);
    if (!row) {
      return res.status(404).json({
        error: "No rate available for this pair yet",
        code: "NO_RATE",
        base: pair.base,
        quote: pair.quote,
      });
    }
    return res.json({
      base: row.baseCurrency,
      quote: row.quoteCurrency,
      rate: Number(row.rate),
      fetchedAt: row.fetchedAt,
      source: row.source,
    });
  } catch (e) {
    console.error("[travel-fx] latest error:", e && e.message);
    return res.status(500).json({ error: "Failed to read FX rate", code: "INTERNAL_ERROR" });
  }
});

// GET /api/fx/history — historical rate series for the pair.
router.get("/history", verifyToken, async (req, res) => {
  try {
    const pair = validatePair(req, res);
    if (!pair) return;
    const { from, to } = req.query || {};
    let fromDate = null;
    let toDate = null;
    if (from) {
      fromDate = new Date(from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({
          error: "from must be a parseable ISO date",
          code: "INVALID_DATE",
        });
      }
    }
    if (to) {
      toDate = new Date(to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({
          error: "to must be a parseable ISO date",
          code: "INVALID_DATE",
        });
      }
    }
    const rows = await fxRates.getHistoryFromDb(prisma, pair.base, pair.quote, fromDate, toDate);
    return res.json({
      base: pair.base,
      quote: pair.quote,
      rows: rows.map((r) => ({
        rate: Number(r.rate),
        fetchedAt: r.fetchedAt,
        source: r.source,
      })),
    });
  } catch (e) {
    console.error("[travel-fx] history error:", e && e.message);
    return res.status(500).json({ error: "Failed to read FX history", code: "INTERNAL_ERROR" });
  }
});

module.exports = router;
