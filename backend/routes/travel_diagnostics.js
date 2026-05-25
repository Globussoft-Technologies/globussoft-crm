// Travel CRM — diagnostic engine routes (Phase 1 MVP).
//
// Endpoints:
//   GET    /api/travel/diagnostic-banks                     — list active banks for caller's tenant
//   POST   /api/travel/diagnostic-banks                     — ADMIN: create a new bank version
//   GET    /api/travel/diagnostic-banks/:id                 — fetch one bank
//   POST   /api/travel/diagnostics                          — submit a diagnostic (authed)
//   GET    /api/travel/diagnostics                          — list diagnostics (paginated, filterable)
//   GET    /api/travel/diagnostics/:id                      — fetch one diagnostic
//   POST   /api/travel/diagnostics/:id/talking-points/regen — ADMIN/MANAGER: regen LLM brief (PRD §4.2)
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
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { scoreDiagnostic, parseBank } = require("../lib/travelDiagnosticScoring");
const { renderTravelDiagnosticPdf } = require("../services/pdfRenderer");
const { findDuplicateContactFull } = require("../utils/deduplication");
const llmRouter = require("../lib/llmRouter");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");

// PRD §4.2 branded PDF — saved under backend/uploads/diagnostics/ and
// served via the existing /uploads static mount (server.js:710). Filename
// includes a 16-byte random suffix so the URL is unguessable for casual
// access; auth'd surfaces (WhatsApp / email delivery, advisor download)
// resolve via the stored TravelDiagnostic.reportPdfUrl column.
const DIAG_PDF_DIR = path.join(__dirname, "..", "uploads", "diagnostics");
try { fs.mkdirSync(DIAG_PDF_DIR, { recursive: true }); } catch { /* best-effort */ }

async function generateDiagnosticPdfBestEffort(diag, bank) {
  // Best-effort: if PDF generation fails, we don't break the diagnostic
  // submission — the row is already saved, the advisor still sees it on
  // the dashboard, and a future endpoint can re-generate. Logs the error
  // for observability but swallows.
  try {
    const contact = diag.contactId
      ? await prisma.contact.findUnique({
          where: { id: diag.contactId },
          select: { name: true, email: true, phone: true },
        })
      : { name: "Anonymous customer", email: null, phone: null };
    const pdfBuf = await renderTravelDiagnosticPdf(diag, contact, bank);
    const rand = crypto.randomBytes(16).toString("hex");
    const filename = `diag-${diag.id}-${rand}.pdf`;
    const filepath = path.join(DIAG_PDF_DIR, filename);
    await fs.promises.writeFile(filepath, pdfBuf);
    const url = `/uploads/diagnostics/${filename}`;
    await prisma.travelDiagnostic.update({
      where: { id: diag.id },
      data: { reportPdfUrl: url },
    });
    return url;
  } catch (e) {
    console.error("[travel-diag] PDF generation failed:", e.message);
    return null;
  }
}

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

    // PRD §4.2: branded PDF generated on submission. Awaited so the
    // response includes reportPdfUrl; if generation fails, the diagnostic
    // row is still returned (PDF can be regenerated later).
    const reportPdfUrl = await generateDiagnosticPdfBestEffort(diag, bank);

    res.status(201).json({
      diagnostic: { ...diag, reportPdfUrl: reportPdfUrl || diag.reportPdfUrl },
      score: result.score,
      classification: result.classification,
      classificationLabel: result.classificationLabel,
      recommendedTier: result.recommendedTier,
      warnings: result.warnings,
      reportPdfUrl,
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

// ============================================================================
// GET /api/travel/diagnostics/stats — tenant-wide Diagnostic submissions rollup
// (PRD_TRAVEL_RFU_DIAGNOSTIC §3).
//
// Mirrors #905 slice 18 /commission-profiles/stats + #903 slice 23
// /suppliers/stats + #908 slice 19 /flyer-templates/global-stats. USER-readable
// anodyne aggregate. Powers the Diagnostics dashboard's header summary strip
// ("42 submissions · 18 TMC · 12 RFU · 8 TS · 4 VS · across 3 banks · last
// submitted 2h ago"). Without this, the frontend has to fire {list,
// count by subBrand×4, count by bank×N} — N+1 round-trips for a single
// visual surface.
//
// Distinct from GET /diagnostics (paginated list with row payload) and
// GET /diagnostics/:id (single row). This is the tenant-wide rollup across
// the count + per-bucket breakdown surfaces.
//
// Behaviour:
//   - Sub-brand-scoped: MANAGER restricted to one sub-brand sees ONLY their
//     allowed sub-brands' diagnostics in the counts. Same gate as the
//     /diagnostics list endpoint.
//   - Rollup:
//       total                                — count of matching diagnostics
//       bySubBrand: { <sb|_tenant>: { count } }
//       byBank: { <bankId>: { count, bankName } }   — bankName = `${subBrand} v${version}`
//                                                     since QuestionBank has no name field
//       lastSubmittedAt                      — max(createdAt) across matching rows
//   - ?from / ?to (ISO date bounds) filter Diagnostic.createdAt before aggregation.
//
// Public/auth split: the TravelDiagnostic schema has NO marker distinguishing
// public-quiz submissions from authenticated submissions (both land in the
// same model with the same fields). publicCount / authCount are intentionally
// omitted from the response shape — the prompt allows skipping these when
// the schema doesn't model the distinction.
//
// Safety cap: process at most 2000 diagnostics per call; if matching total >
// 2000, return counts but mark aggregateExceedsCap=true.
//
// USER-readable: anodyne aggregate (counts + timestamps); safe. No audit row:
// read-only meta surface, mirrors /commission-profiles/stats + /suppliers/stats.
//
// Express route ordering: literal-path /stats MUST be declared BEFORE the
// /:id family or `:id="stats"` would 400 INVALID_ID before reaching this
// handler. Mirrors travel_suppliers.js + travel_commission_profiles.js placement.
// ============================================================================
const DIAGNOSTICS_STATS_CAP = 2000;

router.get(
  "/diagnostics/stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Optional ISO date bounds on Diagnostic.createdAt
      const diagWhere = { tenantId };
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw) {
        const d = new Date(fromRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        diagWhere.createdAt = Object.assign(diagWhere.createdAt || {}, { gte: d });
      }
      if (toRaw) {
        const d = new Date(toRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        diagWhere.createdAt = Object.assign(diagWhere.createdAt || {}, { lte: d });
      }

      // Sub-brand narrowing — same gate as the /diagnostics list endpoint.
      // MANAGER subBrandAccess restricts the visible-set BEFORE counting.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (allowed.size > 0) {
          diagWhere.subBrand = { in: [...allowed] };
        } else {
          // Empty allowed set = deny everything; force-empty query.
          diagWhere.subBrand = "__none__";
        }
      }

      // Bounded fetch to keep in-process aggregation safe.
      const diagnostics = await prisma.travelDiagnostic.findMany({
        where: diagWhere,
        select: {
          id: true,
          subBrand: true,
          questionBankId: true,
          createdAt: true,
        },
        orderBy: [{ id: "asc" }],
        take: DIAGNOSTICS_STATS_CAP,
      });

      // Get the true total so callers know if aggregation is bounded.
      const totalMatching = await prisma.travelDiagnostic.count({ where: diagWhere });
      const aggregateExceedsCap = totalMatching > DIAGNOSTICS_STATS_CAP;

      // Empty short-circuit — return zeroed shape.
      if (diagnostics.length === 0) {
        return res.json({
          total: 0,
          bySubBrand: {},
          byBank: {},
          lastSubmittedAt: null,
          aggregateExceedsCap: false,
        });
      }

      // Bucket counts.
      let lastSubmittedAt = null;
      const bySubBrand = {};
      const byBank = {};
      const bankIdsSeen = new Set();

      for (const d of diagnostics) {
        const ts = d.createdAt instanceof Date ? d.createdAt : new Date(d.createdAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastSubmittedAt || ts > lastSubmittedAt) lastSubmittedAt = ts;
        }

        // TravelDiagnostic.subBrand is non-nullable in schema, but defensively
        // coalesce falsy → '_tenant' for forward-compat (matches sibling stats
        // endpoint shape — see travel_suppliers.js /suppliers/stats).
        const sbKey = d.subBrand ? String(d.subBrand) : "_tenant";
        if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0 };
        bySubBrand[sbKey].count += 1;

        if (d.questionBankId != null) {
          const bankKey = String(d.questionBankId);
          if (!byBank[bankKey]) byBank[bankKey] = { count: 0, bankName: null };
          byBank[bankKey].count += 1;
          bankIdsSeen.add(d.questionBankId);
        }
      }

      // Resolve bank names. TravelDiagnosticQuestionBank has no `name` column;
      // synthesise from subBrand + version (e.g. "tmc v1"). Tenant-scoped fetch
      // — defensive against any future cross-tenant FK leak.
      if (bankIdsSeen.size > 0) {
        const banks = await prisma.travelDiagnosticQuestionBank.findMany({
          where: { tenantId, id: { in: [...bankIdsSeen] } },
          select: { id: true, subBrand: true, version: true },
        });
        for (const b of banks) {
          const k = String(b.id);
          if (byBank[k]) {
            byBank[k].bankName = `${b.subBrand} v${b.version}`;
          }
        }
      }

      res.json({
        total: diagnostics.length,
        bySubBrand,
        byBank,
        lastSubmittedAt: lastSubmittedAt ? lastSubmittedAt.toISOString() : null,
        aggregateExceedsCap,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-diag] stats error:", e.message);
      res.status(500).json({ error: "Failed to summarise diagnostics" });
    }
  },
);

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

// POST /api/travel/diagnostics/:id/talking-points/regen
//
// PRD §4.2 + §6.1: generate an advisor talking-points brief for a
// completed diagnostic via the LLM router (per PRD §9.1 this is a
// reasoning task → Claude Opus primary, GPT-4 fallback). First consumer
// of the lib/llmRouter.js scaffold (commit 583c06b) — until Q11 API
// keys land the router returns deterministic [STUB-TALKING-POINTS]
// synthetic text so the advisor UI can render SOMETHING and tests can
// pin the contract.
//
// ADMIN/MANAGER-gated: regenerating costs LLM tokens (in real mode) +
// surfaces a fresh brief that downstream advisors will act on; we
// don't want every USER firing it on every page load. USERs read the
// already-persisted brief via GET /diagnostics/:id (talkingPointsJson).
//
// Persists the result envelope to TravelDiagnostic.talkingPointsJson
// as JSON-stringified { text, model, generatedAt, stub } so the next
// GET serves the cached brief without re-billing the LLM.
//
// PII discipline: payload contents (customer answers + contact info)
// are forwarded to the router but NEVER logged from the route — the
// router's own log line only emits token counts. Don't add a
// console.log of `payload` here.
router.post(
  "/diagnostics/:id/talking-points/regen",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const diag = await prisma.travelDiagnostic.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!diag) {
        return res.status(404).json({ error: "Diagnostic not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, diag.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Load the contact for prompt context (name + company). Tolerant
      // of contact-not-found — talking-points still rendered against
      // the diagnostic answers alone, just without contact framing.
      const contact = diag.contactId
        ? await prisma.contact.findFirst({
            where: { id: diag.contactId, tenantId: req.travelTenant.id },
            select: { name: true, company: true },
          })
        : null;

      // Build a clean payload — answers parsed back from the stored
      // JSON string so the LLM sees the structured object, not the
      // raw escaped text. Tolerate parse failure (bank corruption) by
      // forwarding an empty object; the LLM still has classification
      // + tier to work with.
      let answers = {};
      try {
        answers = JSON.parse(diag.answersJson || "{}");
      } catch (_e) {
        answers = {};
      }
      const payload = {
        classification: diag.classification,
        classificationLabel: diag.classificationLabel,
        recommendedTier: diag.recommendedTier,
        subBrand: diag.subBrand,
        answers,
        contact: {
          name: contact?.name || null,
          company: contact?.company || null,
        },
      };

      const result = await llmRouter.routeRequest({
        task: "talking-points",
        payload,
        tenantId: req.travelTenant.id,
      });

      const generatedAt = new Date().toISOString();
      const envelope = {
        text: result.text,
        model: result.model,
        generatedAt,
        stub: Boolean(result.stub),
      };

      const updated = await prisma.travelDiagnostic.update({
        where: { id: diag.id },
        data: { talkingPointsJson: JSON.stringify(envelope) },
      });

      res.status(201).json({
        diagnostic: updated,
        talkingPoints: envelope,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-diag] talking-points regen error:", e.message);
      res.status(500).json({ error: "Failed to regenerate talking points" });
    }
  },
);

// POST /api/travel/diagnostics/:id/form-vs-call/compare
//
// PRD §4.1 — form-vs-call comparison panel. The customer fills the web
// diagnostic (stored in TravelDiagnostic.answersJson) AND independently
// answers the same Qs via the AI qualification call (Callified.ai, Q1
// cred-blocked). This endpoint reconciles the two answer sets and
// classifies the lead into match / review / mismatch by the 80% / 60%
// confidence thresholds so the advisor knows whether they can run
// straight at the quote OR need to resolve a contradiction first.
//
// Callified.ai itself is cred-blocked, but the comparison logic is
// fixture-driven — the caller supplies BOTH answer sets in the body
// (the form side parsed back from the stored diagnostic, the call side
// from the request body). Same shape works today against synthetic
// call answers AND lights up the moment Callified delivers real ones.
//
// ADMIN/MANAGER-gated (same as talking-points): comparison surfaces a
// follow-up recommendation that drives advisor action; we don't want
// every USER firing it on every page load.
//
// Body: { callAnswers?: object, callTranscript?: string }
//   At least ONE of callAnswers / callTranscript must be present —
//   the LLM can derive a comparison from either (the answers set is
//   the cleaner structured input; the raw transcript fallback lets
//   the call side land before Callified maps to question IDs).
//
// Response: { diagnosticId, classification, scorePercent, summary,
//             model, stub, perFieldDiff[], generatedAt }
//
// Persists the result envelope (minus diagnosticId — that's the row
// itself) to TravelDiagnostic.formVsCallJson via fire-and-forget update
// so the next GET /diagnostics/:id surfaces the cached panel without
// re-billing the LLM. Mirrors the talkingPointsJson pattern. A persist
// failure surfaces in logs but does NOT 500 the user's compute response
// — the LLM call is already billed by then.
//
// PII discipline: payload contents (answers + transcripts) are
// forwarded to the router but NEVER logged from the route — the
// router's own log line only emits token counts.
router.post(
  "/diagnostics/:id/form-vs-call/compare",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const { callAnswers, callTranscript } = req.body || {};
      // Coerce to boolean — bare `&&` propagates `undefined` when
      // callAnswers is missing, which then poisons `matched: hasCallAnswers && ...`
      // downstream (gate spec at travel-diagnostics-api.spec.js:984 caught this).
      const hasCallAnswers = Boolean(
        callAnswers && typeof callAnswers === "object" && !Array.isArray(callAnswers),
      );
      const hasCallTranscript =
        typeof callTranscript === "string" && callTranscript.trim().length > 0;
      if (!hasCallAnswers && !hasCallTranscript) {
        return res.status(400).json({
          error: "callAnswers (object) or callTranscript (string) required",
          code: "MISSING_FIELDS",
        });
      }

      const diag = await prisma.travelDiagnostic.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!diag) {
        return res.status(404).json({ error: "Diagnostic not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, diag.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Parse the stored form answers. Tolerate corruption by treating
      // as an empty set — the comparison still runs (the perFieldDiff
      // will be empty and the LLM still produces a summary against
      // the call side alone).
      let formAnswers = {};
      try {
        formAnswers = JSON.parse(diag.answersJson || "{}");
        if (!formAnswers || typeof formAnswers !== "object" || Array.isArray(formAnswers)) {
          formAnswers = {};
        }
      } catch (_e) {
        formAnswers = {};
      }

      const payload = {
        subBrand: diag.subBrand,
        classification: diag.classification,
        classificationLabel: diag.classificationLabel,
        formAnswers,
        callAnswers: hasCallAnswers ? callAnswers : null,
        callTranscript: hasCallTranscript ? callTranscript : null,
      };

      const result = await llmRouter.routeRequest({
        task: "form-vs-call",
        payload,
        tenantId: req.travelTenant.id,
      });

      // Parse the LLM text for a confidence percentage. The stub
      // returns "85% match (synthetic)"; real Claude output is
      // expected to surface a "\d+%" token in the prose. When
      // absent we return null + classify as "unknown" so the UI
      // can render an advisor-review prompt rather than guessing.
      let scorePercent = null;
      const pctMatch = typeof result.text === "string" ? result.text.match(/(\d{1,3})\s*%/) : null;
      if (pctMatch) {
        const n = parseInt(pctMatch[1], 10);
        if (Number.isFinite(n) && n >= 0 && n <= 100) scorePercent = n;
      }

      let classification = "unknown";
      if (scorePercent !== null) {
        if (scorePercent >= 80) classification = "match";
        else if (scorePercent >= 60) classification = "review";
        else classification = "mismatch";
      }

      // Per-field diff via key intersection. The form-side keys are
      // the canonical set (they come from the bank's question IDs);
      // call-side answers that DON'T map to a form key are ignored
      // for the diff (the LLM still sees them in its payload).
      const perFieldDiff = Object.keys(formAnswers).map((k) => {
        const formValue = formAnswers[k] ?? null;
        const callValue =
          hasCallAnswers && Object.prototype.hasOwnProperty.call(callAnswers, k)
            ? callAnswers[k] ?? null
            : null;
        return {
          question: k,
          formValue,
          callValue,
          matched: hasCallAnswers && formValue === callValue,
        };
      });

      // Hoisted so the persisted snapshot and the response envelope share
      // the exact same ISO timestamp — gate spec pins parity.
      const generatedAt = new Date().toISOString();

      // Persist the result envelope so subsequent GETs serve the cached
      // comparison without re-billing the LLM. Mirrors the talkingPointsJson
      // pattern. Fire-and-forget — a persist failure surfaces in logs but
      // MUST NOT 500 the user's compute response (we already paid for the
      // LLM call).
      const persistEnvelope = {
        classification,
        scorePercent,
        summary: result.text,
        model: result.model,
        stub: Boolean(result.stub),
        perFieldDiff,
        generatedAt,
      };
      try {
        await prisma.travelDiagnostic.update({
          where: { id: diag.id },
          data: { formVsCallJson: JSON.stringify(persistEnvelope) },
        });
      } catch (e) {
        console.error("[travel-diag] form-vs-call persist error (non-fatal):", e.message);
      }

      res.json({
        diagnosticId: diag.id,
        classification,
        scorePercent,
        summary: result.text,
        model: result.model,
        stub: Boolean(result.stub),
        perFieldDiff,
        generatedAt,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-diag] form-vs-call compare error:", e.message);
      res.status(500).json({ error: "Failed to compute form-vs-call comparison" });
    }
  },
);

// ─── PUBLIC ENDPOINTS (no auth) — PRD §4.7 Travel Stall landing-page wizard ──
//
// Public-facing quiz flow for unauthenticated leads (Travel Stall family
// audience, Phase 2). Allowlisted in server.js openPaths under prefix
// `/travel/diagnostics/public`.
//
// Tenant is resolved via `?tenantSlug=...` query/body — required because
// the public path has no auth context. Refuses non-travel tenants.
//
// Sub-brand can be any of VALID_SUB_BRANDS but the immediate consumer is
// `travelstall`; the route stays generic so the same flow lights up for
// other sub-brands once their content lands.
//
// What's deliberately NOT exposed:
//   - scoringRulesJson is stripped from GET so visitors can't reverse-
//     engineer band thresholds to manipulate their classification.
//   - raw numeric score is omitted from POST submit response; only the
//     human-readable label + recommendedTier come back (UX choice — the
//     advisor can see the score, the customer sees the persona).
//   - tenant.id is never leaked in the response — only the slug echoed
//     back so the wizard can confirm it's talking to the right brand.

async function resolveTravelTenantBySlug(slug) {
  if (!slug) return null;
  const tenant = await prisma.tenant.findFirst({
    where: { slug: String(slug), vertical: "travel", isActive: true },
    select: { id: true, slug: true, name: true, vertical: true },
  });
  return tenant;
}

// GET /api/travel/diagnostics/public/banks?tenantSlug=X&subBrand=Y
//
// Returns the active v1 bank's questions for the (tenant, subBrand) pair,
// stripped of scoring rules. Caller renders the quiz from the response.
router.get("/diagnostics/public/banks", async (req, res) => {
  try {
    const { tenantSlug, subBrand } = req.query;
    if (!tenantSlug || !subBrand) {
      return res.status(400).json({
        error: "tenantSlug and subBrand query params required",
        code: "MISSING_FIELDS",
      });
    }
    try { assertValidSubBrand(String(subBrand)); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code || "INVALID_SUB_BRAND" }); }

    const tenant = await resolveTravelTenantBySlug(tenantSlug);
    if (!tenant) {
      return res.status(404).json({ error: "Travel tenant not found", code: "TENANT_NOT_FOUND" });
    }

    const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
      where: { tenantId: tenant.id, subBrand: String(subBrand), isActive: true },
      orderBy: { version: "desc" },
    });
    if (!bank) {
      return res.status(404).json({ error: "No active bank for this sub-brand", code: "BANK_NOT_FOUND" });
    }

    let questions;
    try { questions = JSON.parse(bank.questionsJson); }
    catch { return res.status(500).json({ error: "Bank questions JSON unparseable", code: "BANK_CORRUPTED" }); }

    // Strip per-option weights so the public payload can't be used to
    // reverse-engineer the scoring. Keeps id + text + label + value.
    const sanitisedQuestions = (questions.questions || []).map((q) => ({
      id: q.id,
      text: q.text,
      type: q.type,
      options: (q.options || []).map((o) => ({ value: o.value, label: o.label })),
    }));

    res.json({
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      subBrand: bank.subBrand,
      bankId: bank.id,
      version: bank.version,
      questions: sanitisedQuestions,
    });
  } catch (e) {
    console.error("[travel-diag-public] banks error:", e.message);
    res.status(500).json({ error: "Failed to load bank" });
  }
});

// POST /api/travel/diagnostics/public/submit
//
// Body: { tenantSlug, subBrand, bankId, answers, name, phone, email? }
//
// Captures the lead, runs dedup against the tenant's Contacts via
// findDuplicateContactFull (email + phone), creates/links the Contact,
// scores the diagnostic, persists, and returns the customer-facing
// classification.
router.post("/diagnostics/public/submit", async (req, res) => {
  try {
    const { tenantSlug, subBrand, bankId, answers, name, phone, email } = req.body || {};
    if (!tenantSlug || !subBrand || !bankId || !answers || !name || !phone) {
      return res.status(400).json({
        error: "tenantSlug, subBrand, bankId, answers, name, phone all required",
        code: "MISSING_FIELDS",
      });
    }
    try { assertValidSubBrand(String(subBrand)); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code || "INVALID_SUB_BRAND" }); }

    const tenant = await resolveTravelTenantBySlug(tenantSlug);
    if (!tenant) {
      return res.status(404).json({ error: "Travel tenant not found", code: "TENANT_NOT_FOUND" });
    }

    const bankIdNum = parseInt(bankId, 10);
    if (!Number.isFinite(bankIdNum)) {
      return res.status(400).json({ error: "bankId must be a number", code: "INVALID_BANK_ID" });
    }
    const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
      where: { id: bankIdNum, tenantId: tenant.id, subBrand: String(subBrand), isActive: true },
    });
    if (!bank) {
      return res.status(404).json({ error: "Bank not found or not active", code: "BANK_NOT_FOUND" });
    }

    // PRD §4.5 dedup: try to attach to an existing Contact by email or
    // phone before creating a new one — prevents the duplicate-pop-up
    // problem and keeps the pilgrim's history on one record.
    let contactId = null;
    let dedupResult = null;
    try {
      dedupResult = await findDuplicateContactFull({
        email: email || null,
        phone,
        tenantId: tenant.id,
      });
    } catch (e) {
      console.error("[travel-diag-public] dedup error:", e.message);
    }
    if (dedupResult) {
      contactId = dedupResult.contact.id;
    } else {
      // Public-intake contact create. subBrand stamped so the lead lands
      // in the right pipeline. Email defaults to a synthetic placeholder
      // when not provided — the @@unique([email, tenantId]) constraint
      // requires SOMETHING; the synthetic form sidesteps it.
      const safeEmail = email || `public-diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@public.local`;
      const newContact = await prisma.contact.create({
        data: {
          tenantId: tenant.id,
          name: String(name).trim() || "Anonymous lead",
          email: safeEmail,
          phone,
          subBrand: bank.subBrand,
          status: "Lead",
          source: "Travel Stall public quiz",
        },
      });
      contactId = newContact.id;
    }

    // Score the diagnostic.
    const { bank: parsed, warnings: parseWarnings } = parseBank(bank.questionsJson, bank.scoringRulesJson);
    if (!parsed) {
      return res.status(500).json({ error: "Bank JSON unparseable", code: "BANK_CORRUPTED", warnings: parseWarnings });
    }
    const result = scoreDiagnostic(parsed, answers);

    const snapshot = JSON.stringify({
      bankId: bank.id,
      bankVersion: bank.version,
      questionsJson: bank.questionsJson,
      scoringRulesJson: bank.scoringRulesJson,
      scoringWarnings: result.warnings,
    });

    const diag = await prisma.travelDiagnostic.create({
      data: {
        tenantId: tenant.id,
        subBrand: bank.subBrand,
        contactId,
        questionBankId: bank.id,
        questionsJson: snapshot,
        answersJson: JSON.stringify(answers),
        score: result.score,
        classification: result.classification,
        classificationLabel: result.classificationLabel,
        recommendedTier: result.recommendedTier,
      },
    });

    // PDF generation best-effort — Phase 2 will email/WhatsApp the report
    // to the lead once Wati BSP creds (Q9) land.
    const reportPdfUrl = await generateDiagnosticPdfBestEffort(diag, bank).catch(() => null);

    // Customer-facing payload: NO raw score, NO contact id, NO diagnostic id.
    // The advisor sees those internally. The public confirmation just
    // surfaces the persona ("you're a Confident Family Traveller") +
    // recommended tier so the next-step booking widget can theme itself.
    res.status(201).json({
      tenantSlug: tenant.slug,
      subBrand: bank.subBrand,
      classification: result.classification,
      classificationLabel: result.classificationLabel,
      recommendedTier: result.recommendedTier,
      reportPdfUrl: reportPdfUrl || null,
      message: `Thanks ${String(name).split(" ")[0]} — our advisor will reach out to you on ${phone} shortly.`,
    });
  } catch (e) {
    console.error("[travel-diag-public] submit error:", e.message);
    res.status(500).json({ error: "Failed to submit diagnostic" });
  }
});

module.exports = router;
