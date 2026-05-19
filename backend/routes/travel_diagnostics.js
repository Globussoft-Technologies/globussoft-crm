// Travel CRM — diagnostic engine routes (Phase 1 MVP).
//
// Endpoints:
//   GET    /api/travel/diagnostic-banks                     — list active banks for caller's tenant
//   POST   /api/travel/diagnostic-banks                     — ADMIN: create a new bank version
//   GET    /api/travel/diagnostic-banks/:id                 — fetch one bank
//   POST   /api/travel/diagnostics                          — submit a diagnostic (authed)
//   GET    /api/travel/diagnostics                          — list diagnostics (paginated, filterable)
//   GET    /api/travel/diagnostics/:id                      — fetch one diagnostic
//
// Mounted at /api/travel by server.js. All endpoints scope to
// req.user.tenantId + vertical=travel (via requireTravelTenant guard,
// shared with backend/routes/travel.js).
//
// Q16 — editable scoring is P1.5. POST /diagnostic-banks (admin) creates
// a NEW bank version; existing banks are not mutated. PUT is intentionally
// omitted in P1 — admins ship a v2 bank by POSTing a new row + flipping
// isActive on the old one.
//
// See docs/TRAVEL_CRM_PRD.md §4.2 + §5.1 for the contract.

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { scoreDiagnostic, parseBank } = require("../lib/travelDiagnosticScoring");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");

// ─── Question banks ───────────────────────────────────────────────────

// GET /api/travel/diagnostic-banks?subBrand=tmc&active=true
router.get("/diagnostic-banks", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.active === "true") where.isActive = true;
    if (req.query.active === "false") where.isActive = false;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      // Scope to allowed sub-brands only.
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand) ? where.subBrand : "__none__"
        : { in: [...allowed] };
    }

    const banks = await prisma.travelDiagnosticQuestionBank.findMany({
      where,
      orderBy: [{ subBrand: "asc" }, { version: "desc" }],
      take: 100,
    });
    res.json({ banks });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-diag] list banks error:", e.message);
    res.status(500).json({ error: "Failed to list banks" });
  }
});

// GET /api/travel/diagnostic-banks/:id
router.get("/diagnostic-banks/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!bank) return res.status(404).json({ error: "Bank not found", code: "NOT_FOUND" });

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, bank.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(bank);
  } catch (e) {
    console.error("[travel-diag] get bank error:", e.message);
    res.status(500).json({ error: "Failed to get bank" });
  }
});

// POST /api/travel/diagnostic-banks
// Admin-only: creates a new bank version. Body must include subBrand,
// questionsJson (string), scoringRulesJson (string). version auto-
// increments (max(version)+1) per (tenantId, subBrand). isActive default
// true; admin should mark the prior active bank inactive via a separate
// PATCH (or via re-POST with isActive=false).
router.post(
  "/diagnostic-banks",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { subBrand, questionsJson, scoringRulesJson, isActive } = req.body || {};
      if (!subBrand || !questionsJson || !scoringRulesJson) {
        return res.status(400).json({
          error: "subBrand, questionsJson, scoringRulesJson required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidSubBrand(subBrand);

      // Validate JSON parseability up-front — a non-parseable bank can't
      // be scored against, so we reject at create time rather than at
      // submit time.
      const { bank, warnings } = parseBank(questionsJson, scoringRulesJson);
      if (!bank) {
        return res.status(400).json({
          error: "questionsJson or scoringRulesJson is not valid JSON",
          code: "INVALID_JSON",
          warnings,
        });
      }
      if (!Array.isArray(bank.questions) || bank.questions.length === 0) {
        return res.status(400).json({
          error: "questionsJson must define at least one question",
          code: "EMPTY_QUESTIONS",
        });
      }
      if (!Array.isArray(bank.bands) || bank.bands.length === 0) {
        return res.status(400).json({
          error: "scoringRulesJson must define at least one band",
          code: "EMPTY_BANDS",
        });
      }

      // Compute next version per (tenantId, subBrand).
      const latest = await prisma.travelDiagnosticQuestionBank.findFirst({
        where: { tenantId: req.travelTenant.id, subBrand },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const nextVersion = (latest?.version || 0) + 1;

      const created = await prisma.travelDiagnosticQuestionBank.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand,
          version: nextVersion,
          questionsJson,
          scoringRulesJson,
          isActive: isActive !== false,
        },
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-diag] create bank error:", e.message);
      res.status(500).json({ error: "Failed to create bank" });
    }
  },
);

// ─── Diagnostic submissions ───────────────────────────────────────────

// POST /api/travel/diagnostics
// Submit a completed diagnostic. Caller provides bankId + answersJson;
// the route scores it, stamps the questionsJson snapshot, and persists.
// Optional links: contactId (the lead) and leadId (the deal).
router.post("/diagnostics", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const { bankId, answers, contactId, leadId, consentCapturedAt } = req.body || {};
    if (!bankId || !answers) {
      return res.status(400).json({
        error: "bankId and answers required",
        code: "MISSING_FIELDS",
      });
    }
    const bankIdNum = parseInt(bankId, 10);
    if (!Number.isFinite(bankIdNum)) {
      return res.status(400).json({ error: "bankId must be a number", code: "INVALID_BANK_ID" });
    }

    const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
      where: { id: bankIdNum, tenantId: req.travelTenant.id },
    });
    if (!bank) {
      return res.status(404).json({ error: "Bank not found", code: "BANK_NOT_FOUND" });
    }
    if (!bank.isActive) {
      return res.status(409).json({ error: "Bank is not active", code: "BANK_INACTIVE" });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, bank.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    // Parse the bank's stored JSON, compute the score.
    const { bank: parsed, warnings: parseWarnings } = parseBank(
      bank.questionsJson,
      bank.scoringRulesJson,
    );
    if (!parsed) {
      // Bank passed create-time validation; if it fails now it's been
      // corrupted in-storage. Refuse to write a score in that case.
      return res.status(500).json({
        error: "Bank JSON has become unparseable",
        code: "BANK_CORRUPTED",
        warnings: parseWarnings,
      });
    }

    const result = scoreDiagnostic(parsed, answers);

    // Capture the questionsJson + scoringRulesJson snapshot for audit.
    // Combined into a single JSON-as-string to keep the schema simple.
    const snapshot = JSON.stringify({
      bankId: bank.id,
      bankVersion: bank.version,
      questionsJson: bank.questionsJson,
      scoringRulesJson: bank.scoringRulesJson,
      scoringWarnings: result.warnings,
    });

    const diag = await prisma.travelDiagnostic.create({
      data: {
        tenantId: req.travelTenant.id,
        subBrand: bank.subBrand,
        contactId: contactId ? parseInt(contactId, 10) : null,
        leadId: leadId ? parseInt(leadId, 10) : null,
        questionBankId: bank.id,
        questionsJson: snapshot,
        answersJson: JSON.stringify(answers),
        score: result.score,
        classification: result.classification,
        classificationLabel: result.classificationLabel,
        recommendedTier: result.recommendedTier,
        consentCapturedAt: consentCapturedAt ? new Date(consentCapturedAt) : null,
      },
    });

    res.status(201).json({
      diagnostic: diag,
      score: result.score,
      classification: result.classification,
      classificationLabel: result.classificationLabel,
      recommendedTier: result.recommendedTier,
      warnings: result.warnings,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-diag] submit diagnostic error:", e.message);
    res.status(500).json({ error: "Failed to submit diagnostic" });
  }
});

// GET /api/travel/diagnostics?subBrand=tmc&classification=level_2&contactId=42
router.get("/diagnostics", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.classification) where.classification = String(req.query.classification);
    if (req.query.contactId) {
      const cid = parseInt(req.query.contactId, 10);
      if (Number.isFinite(cid)) where.contactId = cid;
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand) ? where.subBrand : "__none__"
        : { in: [...allowed] };
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [diagnostics, total] = await Promise.all([
      prisma.travelDiagnostic.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.travelDiagnostic.count({ where }),
    ]);
    res.json({ diagnostics, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-diag] list diagnostics error:", e.message);
    res.status(500).json({ error: "Failed to list diagnostics" });
  }
});

// GET /api/travel/diagnostics/:id
router.get("/diagnostics/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const diag = await prisma.travelDiagnostic.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!diag) return res.status(404).json({ error: "Diagnostic not found", code: "NOT_FOUND" });

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, diag.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(diag);
  } catch (e) {
    console.error("[travel-diag] get diagnostic error:", e.message);
    res.status(500).json({ error: "Failed to get diagnostic" });
  }
});

module.exports = router;
