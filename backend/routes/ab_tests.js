const express = require("express");
const prisma = require("../lib/prisma");
// v3.4.11: sanitization adopted from the v3.4.10 audit. AbTest variantA /
// variantB are JSON blobs storing the email/SMS variant content (subject,
// body, button text, etc.) — re-rendered in the AB-test detail page +
// (potentially) email previews. HTML payloads here would land as stored
// XSS the next time an admin opens the test or recipients receive a
// preview email. Same #398/#447 class as lead_routing.js (v3.4.11 097ef5a).
const { verifyRole } = require("../middleware/auth");
const { sanitizeText, sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────
function tenantOf(req, res) {
  const id = req.user?.tenantId;
  if (!id) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return id;
}

function safeJsonParse(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return fallback;
  }
}

function serialize(test) {
  if (!test) return test;
  return {
    ...test,
    variantA: safeJsonParse(test.variantA, {}),
    variantB: safeJsonParse(test.variantB, {}),
  };
}

function computeStats(test) {
  const sentA = test.variantASent || 0;
  const sentB = test.variantBSent || 0;
  const clickA = test.variantAClicked || 0;
  const clickB = test.variantBClicked || 0;
  const ctrA = sentA > 0 ? (clickA / sentA) * 100 : 0;
  const ctrB = sentB > 0 ? (clickB / sentB) * 100 : 0;
  const totalSent = sentA + sentB;
  const significant = Math.abs(ctrA - ctrB) > 5 && totalSent > 100;
  let leader = null;
  if (sentA > 0 || sentB > 0) {
    leader = ctrA === ctrB ? "TIE" : ctrA > ctrB ? "A" : "B";
  }
  return {
    variantA: {
      sent: sentA,
      clicked: clickA,
      ctr: Math.round(ctrA * 100) / 100,
    },
    variantB: {
      sent: sentB,
      clicked: clickB,
      ctr: Math.round(ctrB * 100) / 100,
    },
    totalSent,
    significant,
    leader,
  };
}

// ── GET / — list AB tests ────────────────────────────────────────
//
// Slim-shape opt-in (#920 slice 45): when called with ?fields=summary,
// the handler drops the heavy `variantA`/`variantB` JSON-text columns
// from the Prisma select and skips the `serialize()` + `computeStats()`
// decoration — useful for the marketing-AB-test admin index /
// autocomplete / picker surfaces that only need id+name+status+counter
// columns and don't render the variant bodies. Existing callers (no
// ?fields, or any non-exact value) get the full row shape with parsed
// variants + stats envelope unchanged. Same strict opt-in pattern as
// routes/canned_responses.js + routes/sla.js (slices 1-42).
router.get("/", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        name: true,
        campaignId: true,
        status: true,
        winningVariant: true,
        variantASent: true,
        variantBSent: true,
        variantAClicked: true,
        variantBClicked: true,
        createdAt: true,
        updatedAt: true,
      };
    }
    const tests = await prisma.abTest.findMany(findManyArgs);
    if (isSummary) {
      // Slim rows ship as-is — no variant JSON to parse, no stats envelope.
      res.json(tests);
      return;
    }
    res.json(tests.map((t) => ({ ...serialize(t), stats: computeStats(t) })));
  } catch (err) {
    console.error("[ab_tests/list]", err);
    res.status(500).json({ error: "Failed to fetch AB tests" });
  }
});

// ── POST / — create ──────────────────────────────────────────────
router.post("/", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const { name, campaignId, variantA, variantB } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });

    // v3.4.11: HTML-strip name + sanitize variant JSON for the
    // re-render path (admin detail page, email preview).
    // sanitizeJsonForStringColumn handles object-or-string inputs uniformly
    // and stringifies for the `String @db.Text` column.
    const test = await prisma.abTest.create({
      data: {
        name: sanitizeText(name),
        campaignId: campaignId ? Number(campaignId) : null,
        variantA: sanitizeJsonForStringColumn(variantA || {}),
        variantB: sanitizeJsonForStringColumn(variantB || {}),
        status: "DRAFT",
        tenantId,
      },
    });
    res.status(201).json(serialize(test));
  } catch (err) {
    console.error("[ab_tests/create]", err);
    res.status(500).json({ error: "Failed to create AB test" });
  }
});

// ── GET /stats — tenant-wide aggregate ───────────────────────────
//
// Marketing polish: per-tenant rollup over the AbTest population powering
// the marketing-AB-test admin dashboard's "fleet view" tiles. Computed
// in-memory after a single findMany select (no GROUP BY round-trip), since
// the AbTest population per tenant is bounded by human admin creation
// (~tens-to-low-hundreds in practice, not the per-second-write cardinality
// of EmailMessage / SmsMessage).
//
// Express route ordering note: this literal-path /stats MUST be declared
// BEFORE the /:id family below — otherwise the dynamic /:id matcher
// catches the literal string "stats" and treats it as a numeric id parse
// failure. Same pattern as routes/landing_pages.js /stats (#163).
//
// Aggregates returned:
//   - total            number of AbTest rows in tenant (optionally
//                      windowed by createdAt via ?from/?to)
//   - byStatus         { DRAFT, RUNNING, COMPLETED, ... } count map
//   - completedCount   count where status='COMPLETED'
//   - activeCount      count where status='RUNNING' (non-terminal)
//   - winnerDistribution { A, B, none } over winningVariant column
//                      (none = winningVariant IS NULL, including
//                      DRAFT + RUNNING + COMPLETED-without-winner)
//   - lastCreatedAt    max createdAt ISO string, or null when empty
//
// NO audit row written (read-only meta surface).
router.get("/stats", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const where = { tenantId };

    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res
          .status(400)
          .json({ error: "from must be a valid ISO date", code: "INVALID_DATE" });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res
          .status(400)
          .json({ error: "to must be a valid ISO date", code: "INVALID_DATE" });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    const rows = await prisma.abTest.findMany({
      where,
      select: { status: true, winningVariant: true, createdAt: true },
    });

    const byStatus = {};
    const winnerDistribution = { A: 0, B: 0, none: 0 };
    let completedCount = 0;
    let activeCount = 0;
    let lastCreatedAt = null;

    for (const r of rows) {
      const bucket = r.status || "DRAFT";
      byStatus[bucket] = (byStatus[bucket] || 0) + 1;
      if (bucket === "COMPLETED") completedCount += 1;
      if (bucket === "RUNNING") activeCount += 1;

      if (r.winningVariant === "A") winnerDistribution.A += 1;
      else if (r.winningVariant === "B") winnerDistribution.B += 1;
      else winnerDistribution.none += 1;

      if (r.createdAt) {
        const ca = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
        if (!lastCreatedAt || ca > lastCreatedAt) lastCreatedAt = ca;
      }
    }

    res.json({
      total: rows.length,
      byStatus,
      completedCount,
      activeCount,
      winnerDistribution,
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[ab_tests/stats-tenant]", err);
    res.status(500).json({ error: "Failed to compute AB-test stats" });
  }
});

// ── GET /:id — full details + stats ──────────────────────────────
router.get("/:id", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const id = Number(req.params.id);
    const test = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!test) return res.status(404).json({ error: "AB test not found" });
    res.json({ ...serialize(test), stats: computeStats(test) });
  } catch (err) {
    console.error("[ab_tests/detail]", err);
    res.status(500).json({ error: "Failed to fetch AB test" });
  }
});

// ── PUT /:id — update ────────────────────────────────────────────
router.put("/:id", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const id = Number(req.params.id);
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });

    const { name, campaignId, variantA, variantB, status, winningVariant } =
      req.body || {};
    const data = {};
    // v3.4.11: same sanitization as POST. variantA/B fall back to "{}" for
    // null inputs (was `JSON.stringify(null)` → "null" string before, which
    // was already a weird value); empty object is a more sensible default.
    if (name !== undefined) data.name = sanitizeText(name);
    if (campaignId !== undefined)
      data.campaignId = campaignId ? Number(campaignId) : null;
    if (variantA !== undefined)
      data.variantA = sanitizeJsonForStringColumn(variantA || {});
    if (variantB !== undefined)
      data.variantB = sanitizeJsonForStringColumn(variantB || {});
    if (status !== undefined) data.status = status;
    if (winningVariant !== undefined) data.winningVariant = winningVariant;

    const updated = await prisma.abTest.update({ where: { id }, data });
    res.json(serialize(updated));
  } catch (err) {
    console.error("[ab_tests/update]", err);
    res.status(500).json({ error: "Failed to update AB test" });
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────
router.delete("/:id", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const id = Number(req.params.id);
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });
    await prisma.abTest.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[ab_tests/delete]", err);
    res.status(500).json({ error: "Failed to delete AB test" });
  }
});

// ── POST /:id/start ──────────────────────────────────────────────
router.post("/:id/start", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const id = Number(req.params.id);
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });
    const updated = await prisma.abTest.update({
      where: { id },
      data: { status: "RUNNING" },
    });
    res.json(serialize(updated));
  } catch (err) {
    console.error("[ab_tests/start]", err);
    res.status(500).json({ error: "Failed to start AB test" });
  }
});

// ── POST /:id/track ──────────────────────────────────────────────
// body: { variant: "A"|"B", action: "sent"|"clicked" }
router.post("/:id/track", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const id = Number(req.params.id);
    const { variant, action } = req.body || {};
    if (!["A", "B"].includes(variant)) {
      return res.status(400).json({ error: "variant must be 'A' or 'B'" });
    }
    if (!["sent", "clicked"].includes(action)) {
      return res.status(400).json({ error: "action must be 'sent' or 'clicked'" });
    }
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });

    const fieldMap = {
      "A:sent": "variantASent",
      "A:clicked": "variantAClicked",
      "B:sent": "variantBSent",
      "B:clicked": "variantBClicked",
    };
    const field = fieldMap[`${variant}:${action}`];
    const updated = await prisma.abTest.update({
      where: { id },
      data: { [field]: { increment: 1 } },
    });
    res.json(serialize(updated));
  } catch (err) {
    console.error("[ab_tests/track]", err);
    res.status(500).json({ error: "Failed to track AB test event" });
  }
});

// ── POST /:id/declare-winner ─────────────────────────────────────
router.post("/:id/declare-winner", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const id = Number(req.params.id);
    const { winner } = req.body || {};
    if (!["A", "B"].includes(winner)) {
      return res.status(400).json({ error: "winner must be 'A' or 'B'" });
    }
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });

    const updated = await prisma.abTest.update({
      where: { id },
      data: { winningVariant: winner, status: "COMPLETED" },
    });
    res.json(serialize(updated));
  } catch (err) {
    console.error("[ab_tests/declare-winner]", err);
    res.status(500).json({ error: "Failed to declare winner" });
  }
});

// ── GET /:id/stats ───────────────────────────────────────────────
router.get("/:id/stats", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const id = Number(req.params.id);
    const test = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!test) return res.status(404).json({ error: "AB test not found" });
    res.json({
      id: test.id,
      name: test.name,
      status: test.status,
      winningVariant: test.winningVariant,
      ...computeStats(test),
    });
  } catch (err) {
    console.error("[ab_tests/stats]", err);
    res.status(500).json({ error: "Failed to compute stats" });
  }
});

module.exports = router;
