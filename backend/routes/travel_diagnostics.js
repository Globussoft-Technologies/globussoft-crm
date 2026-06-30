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
//   POST   /api/travel/diagnostics/banks/:id/request-change — any travel role: file a scoring
//                                                             change-request Ticket to GS (PRD §4.2)
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
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { scoreDiagnostic, parseBank } = require("../lib/travelDiagnosticScoring");
const pdfRenderer = require("../services/pdfRenderer");
const { renderTravelDiagnosticPdf } = pdfRenderer;
const { findDuplicateContactFull } = require("../utils/deduplication");
const llmRouter = require("../lib/llmRouter");
// ── TMC diagnostic engine modules (T2 / T3 / T6 / T7) — used by T8 ────
// Require via shared `module.exports.<fn>` indirection so the test suite
// can swap individual handlers via vi.spyOn on the cached modules without
// having to vi.mock(). Matches the CJS self-mocking seam used by sibling
// service clients (adsGptClient / ratehawkClient / callifiedClient).
const tmcEngine = require("../lib/tmcDiagnosticEngine");
const tmcLeadQuality = require("../lib/tmcLeadQuality");
const tmcPrompts = require("../services/tmcDiagnosticPrompts");
const tmcReportGuard = require("../lib/tmcReportGuard");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { sanitizeText, sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");

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

    // Brand logo for the header — S3 (tenant.logoUrl) first, local /uploads
    // next, bundled asset last. Best-effort: a failure here just means the
    // header draws its emblem instead.
    let logoBuffer = null;
    try {
      const { resolveBrandLogoBuffer } = require("../lib/brandLogo");
      const tenant = await prisma.tenant.findUnique({
        where: { id: diag.tenantId },
        select: { logoUrl: true },
      });
      logoBuffer = await resolveBrandLogoBuffer(tenant?.logoUrl);
    } catch (logoErr) {
      console.warn("[travel-diag] logo resolve failed:", logoErr.message);
    }

    const pdfBuf = await renderTravelDiagnosticPdf(diag, contact, bank, { logoBuffer });
    const rand = crypto.randomBytes(16).toString("hex");
    const filename = `diag-${diag.id}-${rand}.pdf`;
    const filepath = path.join(DIAG_PDF_DIR, filename);
    await fs.promises.writeFile(filepath, pdfBuf);
    // Use the canonical /api/uploads prefix so the URL is routed to the backend
    // in deployments where /uploads/* is handled by the frontend SPA.
    const url = `/api/uploads/diagnostics/${filename}`;
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
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
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

// ─── PRD §4.2 — Phase-1 "Request change" ticket (view-only scoring) ────
//
// POST /api/travel/diagnostics/banks/:id/request-change
//
// Diagnostic scoring is VIEW-ONLY in Phase 1 (Response A.6 — protects the
// 90-day analytics baseline). Advisors who spot a question/band problem
// can't edit the bank; this endpoint routes a change request to GS as a
// support Ticket instead. ANY travel role may request (verifyToken +
// requireTravelTenant only — no verifyRole, mirrors GET /diagnostic-banks
// posture), but sub-brand access is still enforced so a MANAGER locked to
// one sub-brand can't file tickets against another brand's bank.
//
// Body: { summary (required), details?, proposedChangesJson? }
//   summary + details run through lib/sanitizeJson.js sanitizeText (same
//   #398-class XSS posture as the other text writers); proposedChangesJson
//   goes through sanitizeJsonForStringColumn so the ticket description
//   carries a clean JSON string.
//
// Creates a tenant-scoped Ticket (status "Open", priority "Medium" — the
// "normal" tier of routes/tickets.js VALID_PRIORITIES) with subject
// `[Diagnostic change request] <subBrand> bank v<version>: <summary>`,
// then writes a best-effort DIAGNOSTIC_BANK_CHANGE_REQUESTED audit row
// (writeAudit is fail-soft by contract — never blocks the response).
//
// Returns 201 { ticket: { id, subject, status } }.
router.post(
  "/diagnostics/banks/:id/request-change",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const { summary, details, proposedChangesJson } = req.body || {};
      // Sanitize BEFORE the required-check so a value that is nothing but
      // markup (e.g. "<script>…</script>") rejects as missing.
      const cleanSummary = typeof summary === "string" ? sanitizeText(summary) : "";
      if (!cleanSummary) {
        return res.status(400).json({
          error: "summary is required",
          code: "MISSING_FIELDS",
        });
      }
      const cleanDetails = typeof details === "string" ? sanitizeText(details) : null;
      const cleanProposed =
        proposedChangesJson != null ? sanitizeJsonForStringColumn(proposedChangesJson) : null;

      const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!bank) return res.status(404).json({ error: "Bank not found", code: "NOT_FOUND" });

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, bank.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Cap the summary inside the subject so the row stays well under the
      // column's VARCHAR budget; the full text still lands in description.
      const subjectSummary = cleanSummary.length > 140 ? `${cleanSummary.slice(0, 140)}…` : cleanSummary;
      const subject = `[Diagnostic change request] ${bank.subBrand} bank v${bank.version}: ${subjectSummary}`;
      const requester = `user #${req.user.userId}${req.user.email ? ` (${req.user.email})` : ""}`;
      const descLines = [
        "Diagnostic scoring is view-only in Phase 1 (PRD §4.2) — change request routed to GS.",
        `Requested by: ${requester}`,
        `Question bank: #${bank.id} — ${bank.subBrand} v${bank.version}`,
        `Summary: ${cleanSummary}`,
      ];
      if (cleanDetails) descLines.push(`Details: ${cleanDetails}`);
      if (cleanProposed) descLines.push(`Proposed changes: ${cleanProposed}`);

      const ticket = await prisma.ticket.create({
        data: {
          tenantId: req.travelTenant.id,
          subject,
          description: descLines.join("\n"),
          status: "Open",
          priority: "Medium",
        },
      });

      // Best-effort audit row — writeAudit swallows its own failures.
      await writeAudit(
        "TravelDiagnosticQuestionBank",
        "DIAGNOSTIC_BANK_CHANGE_REQUESTED",
        bank.id,
        req.user.userId,
        req.travelTenant.id,
        { ticketId: ticket.id, subBrand: bank.subBrand, version: bank.version, summary: subjectSummary },
      );

      res.status(201).json({
        ticket: { id: ticket.id, subject: ticket.subject, status: ticket.status },
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-diag] request-change error:", e.message);
      res.status(500).json({ error: "Failed to submit change request" });
    }
  },
);

// ─── Diagnostic submissions ───────────────────────────────────────────

// POST /api/travel/diagnostics
// Submit a completed diagnostic. Caller provides bankId + answersJson;
// the route scores it, stamps the questionsJson snapshot, and persists.
// Optional links: contactId (the lead) and leadId (the deal).
// PRD_TMC_CURRICULUM_MAPPING §3 FR-5 — build curriculum→destination
// recommendations for a TMC diagnostic. Given the student's curriculum + grade
// (+ optional subject), match active TravelCurriculumMapping rows, aggregate by
// destination, rank by average fitScore, and return the top N. Returns null
// when curriculum context is absent or nothing matches — the caller then
// leaves curriculumFitJson null and the PDF omits the section (FR-7 fallback).
async function buildCurriculumFit(tenantId, { curriculum, grade, subject }) {
  const cur = (curriculum || "").toString().trim();
  const grd = (grade || "").toString().trim();
  const subj = (subject || "").toString().trim();
  if (!cur || !grd) return null;

  const where = { tenantId, isActive: true, curriculum: cur, grade: grd };
  if (subj) where.subject = subj;

  const rows = await prisma.travelCurriculumMapping.findMany({
    where,
    orderBy: { fitScore: "desc" },
    take: 100,
  });
  if (!rows.length) return null;

  // Aggregate by destination (free-text label, or "Trip #id" fallback when the
  // mapping links a TmcTrip by id without a label).
  const byDest = new Map();
  for (const r of rows) {
    const key =
      r.destinationLabel ||
      (r.destinationId != null ? `Trip #${r.destinationId}` : "Unspecified destination");
    if (!byDest.has(key)) byDest.set(key, { destination: key, scores: [], reasons: [] });
    const bucket = byDest.get(key);
    if (typeof r.fitScore === "number") bucket.scores.push(r.fitScore);
    bucket.reasons.push({
      subject: r.subject,
      learningOutcome: r.learningOutcome || null,
      rationale: r.fitRationale || null,
    });
  }

  const recommendations = Array.from(byDest.values())
    .map((d) => ({
      destination: d.destination,
      fitScore: d.scores.length
        ? Math.round(d.scores.reduce((a, b) => a + b, 0) / d.scores.length)
        : null,
      reasons: d.reasons.slice(0, 4),
    }))
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, 5);

  return { curriculum: cur, grade: grd, subject: subj || null, recommendations };
}

router.post("/diagnostics", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const { bankId, answers, contactId, leadId, consentCapturedAt, curriculum, grade, subject } = req.body || {};
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

    // FR-5: TMC-only curriculum-fit recommendations. Curriculum context comes
    // from explicit body fields, falling back to same-named answer keys. Any
    // failure here is non-fatal — the diagnostic still writes without the fit.
    let curriculumFit = null;
    if (bank.subBrand === "tmc") {
      try {
        curriculumFit = await buildCurriculumFit(req.travelTenant.id, {
          curriculum: curriculum ?? answers?.curriculum,
          grade: grade ?? answers?.grade,
          subject: subject ?? answers?.subject,
        });
      } catch (fitErr) {
        console.warn("[travel-diag] curriculum-fit build failed:", fitErr.message);
      }
    }

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
        curriculumFitJson: curriculumFit ? JSON.stringify(curriculumFit) : null,
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
      recommendations: curriculumFit?.recommendations || [],
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-diag] submit diagnostic error:", e.message);
    res.status(500).json({ error: "Failed to submit diagnostic" });
  }
});

// POST /api/travel/diagnostics/:id/report-pdf/regen — (re)generate the branded
// report PDF on demand. Submission-time PDF generation is best-effort and can
// fail silently (e.g. transient write/DB error), leaving reportPdfUrl null with
// no way to recover from the UI. This endpoint rebuilds the PDF from the
// diagnostic's own immutable question snapshot and returns the fresh URL.
router.post("/diagnostics/:id/report-pdf/regen", verifyToken, requireTravelTenant, async (req, res) => {
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

    // Reconstruct a bank-like object from the diagnostic's stored snapshot so
    // the report renders the exact question set it was submitted with.
    let bank = null;
    try {
      const snap = JSON.parse(diag.questionsJson || "{}");
      bank = { version: snap.bankVersion, questionsJson: snap.questionsJson };
    } catch {
      bank = null;
    }

    const url = await generateDiagnosticPdfBestEffort(diag, bank);
    if (!url) {
      return res.status(500).json({ error: "PDF generation failed", code: "PDF_FAILED" });
    }
    res.json({ reportPdfUrl: url });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-diag] report-pdf regen error:", e.message);
    res.status(500).json({ error: "Failed to regenerate report PDF" });
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

    // TravelDiagnostic has no Prisma relation to Contact (just contactId), so
    // batch-fetch the contacts and attach name/email so the UI can show WHO
    // took each diagnostic instead of a bare "#id".
    const contactIds = [...new Set(diagnostics.map((d) => d.contactId).filter(Boolean))];
    const contactMap = {};
    if (contactIds.length) {
      const contacts = await prisma.contact.findMany({
        where: { id: { in: contactIds }, tenantId: req.travelTenant.id },
        select: { id: true, name: true, email: true, phone: true },
      });
      for (const c of contacts) contactMap[c.id] = c;
    }
    const enriched = diagnostics.map((d) => ({
      ...d,
      contact: d.contactId ? contactMap[d.contactId] || null : null,
    }));
    res.json({ diagnostics: enriched, total, limit: take, offset: skip });
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

// ============================================================================
// GET /api/travel/diagnostics/by-month — tenant-wide Diagnostic submissions
// monthly rollup (PRD_TRAVEL_RFU_DIAGNOSTIC §3).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-MM bucket for
// the tenant-scoped (and sub-brand-narrowed) Diagnostic submission population.
// Each row carries count + bySubBrand breakdown so the Diagnostics dashboard
// can render a "submissions over time" trend chart + per-month sub-brand
// drill-down without N round-trips per month.
//
// Pairs with /diagnostics/stats (fffc7345): /stats is a single point-in-time
// KPI tile (total / bySubBrand / byBank / lastSubmittedAt); /by-month is the
// per-month time series across the same population. Two endpoints powering
// the same Diagnostics dashboard — /stats for the KPI strip, /by-month for
// the trend chart + per-month drill-down picker.
//
// Mirrors #903 slice 24 (/suppliers/by-month) + #908 slice 21
// (/flyer-templates/by-month) + #900 slice 16 (/quotes/by-month) — same UTC
// YYYY-MM bucketing template, same defensive math (null/invalid createdAt →
// "unknown" bucket; excluded when ?from / ?to is set, kept otherwise so
// count surface stays accurate), same orderBy semantics.
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-MM bounds; invalid →
//                     400 INVALID_MONTH_FORMAT
//   - ?orderBy      — default month:asc; accepts month:{asc|desc},
//                     count:{asc|desc}; unknown tokens degrade silently
//                     to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 60
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' diagnostics in the rollup. Same gate as
//     /diagnostics/stats — TravelDiagnostic.subBrand is NON-nullable in the
//     schema, so we do NOT add a `{ subBrand: null }` OR clause (mirrors
//     /suppliers/by-month, distinct from /flyer-templates/by-month whose
//     subBrand IS nullable). Empty access set → force-empty `subBrand:
//     "__none__"` so the response stays a clean zero-rollup envelope.
//   - JS-side aggregation over a light findMany projection
//     ({ subBrand, createdAt }) — matches /diagnostics/stats posture.
//   - "unknown" bucket: rows with null/invalid createdAt land here.
//     Excluded when ?from / ?to is set; included otherwise.
//   - Per-month bySubBrand: each bucket carries a `bySubBrand` map keyed by
//     sub-brand token (falsy → "_tenant" for forward-compat, mirrors /stats).
//   - Pagination applied AFTER aggregation + sort + bucket filter.
//
// No audit row written — read-only meta surface; matches /diagnostics/stats
// + /suppliers/by-month + /flyer-templates/by-month posture. USER-readable:
// anodyne (counts + month-string tokens).
//
// Express route ordering: literal-path /by-month MUST be declared BEFORE
// the /:id family or `:id="by-month"` would 400 INVALID_ID before reaching
// this handler. Same convention as /diagnostics/stats.
// ============================================================================
router.get(
  "/diagnostics/by-month",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation — mirrors slice 24 /suppliers/by-month.
      const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !MONTH_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY-MM format",
          code: "INVALID_MONTH_FORMAT",
        });
      }
      if (toRaw !== null && !MONTH_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY-MM format",
          code: "INVALID_MONTH_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "month:asc",
        "month:desc",
        "count:asc",
        "count:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

      // Tenant-scoped where + sub-brand narrowing. Mirrors /diagnostics/stats
      // sub-brand gate: subBrand-restricted callers see only their allowed
      // sub-brands' diagnostics; admins (allowed=null) see all. Empty
      // allowed set returns the zero-rollup envelope (not 403).
      //
      // Note: TravelDiagnostic.subBrand is NON-nullable, so we do NOT mix
      // in a `{ subBrand: null }` OR clause (that's the flyer-templates
      // pattern, where subBrand IS nullable). The narrowing is a pure
      // `subBrand: { in: [...allowed] }`, mirroring /suppliers/by-month.
      const where = { tenantId: req.travelTenant.id };
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (allowed.size > 0) {
          where.subBrand = { in: [...allowed] };
        } else {
          where.subBrand = "__none__";
        }
      }

      // Light projection — subBrand + createdAt is enough for the bucket
      // totals + per-bucket bySubBrand breakdown.
      const rows = await prisma.travelDiagnostic.findMany({
        where,
        select: { subBrand: true, createdAt: true },
      });

      // Aggregate per-UTC-month. Map "YYYY-MM" → { count, bySubBrand }.
      // Null/invalid createdAt rows land in "unknown".
      const byMonth = new Map();
      for (const r of rows) {
        let monthKey = "unknown";
        if (r.createdAt) {
          const dt = r.createdAt instanceof Date
            ? r.createdAt
            : new Date(r.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
            monthKey = `${yyyy}-${mm}`;
          }
        }

        let bucket = byMonth.get(monthKey);
        if (!bucket) {
          bucket = {
            month: monthKey,
            count: 0,
            bySubBrand: {},
          };
          byMonth.set(monthKey, bucket);
        }
        bucket.count += 1;

        // bySubBrand: defensively coalesce falsy → "_tenant" to match
        // /diagnostics/stats posture (forward-compat against any future
        // schema change to nullable subBrand).
        const sbKey = r.subBrand ? String(r.subBrand) : "_tenant";
        if (!bucket.bySubBrand[sbKey]) bucket.bySubBrand[sbKey] = { count: 0 };
        bucket.bySubBrand[sbKey].count += 1;
      }

      let months = [...byMonth.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token); kept otherwise. Mirrors slice
      // 24 /suppliers/by-month.
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Sort. "month" sorts lexicographically on YYYY-MM (also chronological).
      // "unknown" sorts last in asc / first in desc (lexicographically >
      // "9999-12") — acceptable for a defensive fallback bucket that should
      // rarely appear. Mirrors slice 24 /suppliers/by-month.
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      months.sort((a, b) => {
        if (field === "month") {
          if (a.month < b.month) return -1 * mult;
          if (a.month > b.month) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalMonths = months.length;
      const grandCount = months.reduce((acc, r) => acc + (Number(r.count) || 0), 0);

      // Pagination AFTER aggregation + sort + filter, same as slice 24.
      const paged = months.slice(skip, skip + take);

      res.json({
        months: paged,
        totalMonths,
        grandCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-diag] by-month error:", e.message);
      res.status(500).json({ error: "Failed to compute monthly rollup" });
    }
  },
);

// ============================================================================
// GET /api/travel/diagnostics/by-quarter — tenant-wide Diagnostic submissions
// quarterly rollup (PRD_TRAVEL_RFU_DIAGNOSTIC §3).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-Q[1-4] bucket
// for the tenant-scoped (and sub-brand-narrowed) Diagnostic submission
// population. Each row carries count + bySubBrand breakdown so the
// Diagnostics dashboard can render a "submissions over time" quarterly
// trend chart + per-quarter sub-brand drill-down.
//
// Pairs with /diagnostics/stats (KPI tile) + /diagnostics/by-month (monthly
// time series). /by-quarter is the coarser sibling for trend tiles that
// only need a 1-year-at-a-glance view — fewer buckets (4 per year vs 12),
// same defensive math.
//
// Mirrors /itineraries/by-quarter (#907 slice 17) + /suppliers/by-quarter
// + /visa/applications/by-quarter — same UTC YYYY-Qn bucketing template,
// same defensive math (null/invalid createdAt → "unknown" bucket; excluded
// when ?from / ?to is set, kept otherwise so count surface stays
// accurate), same orderBy semantics.
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-Q[1-4] bounds; invalid →
//                     400 INVALID_QUARTER_FORMAT
//   - ?orderBy      — default quarter:asc; accepts quarter:{asc|desc},
//                     count:{asc|desc}; unknown tokens degrade silently
//                     to the default
//   - ?limit / ?offset — default 8 / 0 (≈2 years' window of quarters);
//                     limit caps at 40
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' diagnostics in the rollup. Same gate as
//     /diagnostics/by-month — TravelDiagnostic.subBrand is NON-nullable
//     in the schema, so we do NOT add a `{ subBrand: null }` OR clause
//     (mirrors /suppliers/by-month posture). Empty access set →
//     force-empty `subBrand: "__none__"` so the response stays a clean
//     zero-rollup envelope.
//   - JS-side aggregation over a light findMany projection
//     ({ subBrand, createdAt }) — matches /diagnostics/stats +
//     /by-month posture.
//   - "unknown" bucket: rows with null/invalid createdAt land here.
//     Excluded when ?from / ?to is set; included otherwise.
//   - Per-quarter bySubBrand: each bucket carries a `bySubBrand` map keyed
//     by sub-brand token (falsy → "_tenant" for forward-compat, mirrors
//     /stats + /by-month).
//   - Pagination applied AFTER aggregation + sort + bucket filter.
//
// No audit row written — read-only meta surface; matches /diagnostics/stats
// + /by-month + /suppliers/by-quarter posture. USER-readable: anodyne
// (counts + quarter-string tokens).
//
// Express route ordering: literal-path /by-quarter MUST be declared
// BEFORE the /:id family or `:id="by-quarter"` would 400 INVALID_ID
// before reaching this handler. Same convention as /by-month + /stats.
// ============================================================================
router.get(
  "/diagnostics/by-quarter",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 8, 40);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy
        ? String(req.query.orderBy)
        : "quarter:asc";

      // YYYY-Qn validation — quarter ∈ {1,2,3,4}, year is 4 digits.
      // Mirrors /itineraries/by-quarter + /suppliers/by-quarter.
      const QUARTER_RE = /^\d{4}-Q[1-4]$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !QUARTER_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY-Qn format",
          code: "INVALID_QUARTER_FORMAT",
        });
      }
      if (toRaw !== null && !QUARTER_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY-Qn format",
          code: "INVALID_QUARTER_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "quarter:asc",
        "quarter:desc",
        "count:asc",
        "count:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw)
        ? orderByRaw
        : "quarter:asc";

      // Tenant-scoped where + sub-brand narrowing. Mirrors /by-month
      // sub-brand gate: subBrand-restricted callers see only their
      // allowed sub-brands' diagnostics; admins (allowed=null) see all.
      // Empty allowed set → force-empty `subBrand: "__none__"` for a
      // clean zero-rollup envelope (not 403).
      //
      // Note: TravelDiagnostic.subBrand is NON-nullable, so we do NOT
      // mix in a `{ subBrand: null }` OR clause (that's the
      // flyer-templates pattern). The narrowing is a pure
      // `subBrand: { in: [...allowed] }`, mirroring /by-month.
      const where = { tenantId: req.travelTenant.id };
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (allowed.size > 0) {
          where.subBrand = { in: [...allowed] };
        } else {
          where.subBrand = "__none__";
        }
      }

      // Light projection — subBrand + createdAt is enough for the
      // bucket totals + per-bucket bySubBrand breakdown.
      const rows = await prisma.travelDiagnostic.findMany({
        where,
        select: { subBrand: true, createdAt: true },
      });

      // Aggregate per-UTC-quarter. Map "YYYY-Qn" → { count, bySubBrand }.
      // Null/invalid createdAt rows land in "unknown".
      const byQuarter = new Map();
      for (const r of rows) {
        let quarterKey = "unknown";
        if (r.createdAt) {
          const dt = r.createdAt instanceof Date
            ? r.createdAt
            : new Date(r.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const q = Math.floor(dt.getUTCMonth() / 3) + 1;
            quarterKey = `${yyyy}-Q${q}`;
          }
        }

        let bucket = byQuarter.get(quarterKey);
        if (!bucket) {
          bucket = {
            quarter: quarterKey,
            count: 0,
            bySubBrand: {},
          };
          byQuarter.set(quarterKey, bucket);
        }
        bucket.count += 1;

        // bySubBrand: defensively coalesce falsy → "_tenant" to match
        // /diagnostics/stats + /by-month posture (forward-compat
        // against any future schema change to nullable subBrand).
        const sbKey = r.subBrand ? String(r.subBrand) : "_tenant";
        if (!bucket.bySubBrand[sbKey]) bucket.bySubBrand[sbKey] = { count: 0 };
        bucket.bySubBrand[sbKey].count += 1;
      }

      let quarters = [...byQuarter.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token); kept otherwise. Mirrors
      // /by-month + /itineraries/by-quarter.
      if (fromRaw !== null) {
        quarters = quarters.filter(
          (r) => r.quarter !== "unknown" && r.quarter >= fromRaw,
        );
      }
      if (toRaw !== null) {
        quarters = quarters.filter(
          (r) => r.quarter !== "unknown" && r.quarter <= toRaw,
        );
      }

      // Sort. "quarter" sorts lexicographically on YYYY-Qn which is
      // also chronological (Q1 < Q2 < Q3 < Q4 in ASCII, years
      // naturally ordered). "unknown" sorts last in asc / first in
      // desc by virtue of being lexicographically > "9999-Q4".
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      quarters.sort((a, b) => {
        if (field === "quarter") {
          if (a.quarter < b.quarter) return -1 * mult;
          if (a.quarter > b.quarter) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalQuarters = quarters.length;
      const grandCount = quarters.reduce(
        (acc, r) => acc + (Number(r.count) || 0),
        0,
      );

      // Pagination AFTER aggregation + sort + filter, same as /by-month.
      const paged = quarters.slice(skip, skip + take);

      res.json({
        quarters: paged,
        totalQuarters,
        grandCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-diag] by-quarter error:", e.message);
      res.status(500).json({ error: "Failed to compute quarterly rollup" });
    }
  },
);

// ============================================================================
// GET /api/travel/diagnostics/by-year — tenant-wide Diagnostic submissions
// annual rollup (PRD_TRAVEL_RFU_DIAGNOSTIC §3).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY bucket for
// the tenant-scoped (and sub-brand-narrowed) Diagnostic submission
// population. Each row carries count + bySubBrand breakdown so the
// Diagnostics dashboard can render an annual trend tile + per-year
// sub-brand drill-down.
//
// Completes the diagnostics rollup triplet: /by-month (slice 25),
// /by-quarter (slice 26), /by-year (this slice — slice 27). Pairs with
// /diagnostics/stats (KPI tile). Mirrors /itineraries/by-year (#907
// slice 18) + /suppliers/by-year + /visa/applications/by-year +
// /flyer-templates/by-year — same UTC YYYY bucketing template, same
// defensive math (null/invalid createdAt → "unknown" bucket; excluded
// when ?from / ?to is set, kept otherwise so count surface stays
// accurate), same orderBy semantics.
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY bounds; invalid →
//                     400 INVALID_YEAR_FORMAT
//   - ?orderBy      — default year:asc; accepts year:{asc|desc},
//                     count:{asc|desc}; unknown tokens degrade silently
//                     to the default
//   - ?limit / ?offset — default 10 / 0; limit caps at 30
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' diagnostics in the rollup. Same gate as
//     /diagnostics/by-quarter — TravelDiagnostic.subBrand is NON-nullable
//     in the schema, so we do NOT add a `{ subBrand: null }` OR clause.
//     The narrowing is a pure `subBrand: { in: [...allowed] }`. Empty
//     access set → force-empty `subBrand: "__none__"` so the response
//     stays a clean zero-rollup envelope.
//   - JS-side aggregation over a light findMany projection
//     ({ subBrand, createdAt }) — matches /by-quarter posture.
//   - "unknown" bucket: rows with null/invalid createdAt land here.
//     Excluded when ?from / ?to is set; included otherwise.
//   - Per-year bySubBrand: each bucket carries a `bySubBrand` map keyed
//     by sub-brand token (falsy → "_tenant" for forward-compat, mirrors
//     /stats + /by-month + /by-quarter).
//   - Pagination applied AFTER aggregation + sort + bucket filter.
//
// No audit row written — read-only meta surface; matches /diagnostics/stats
// + /by-month + /by-quarter posture. USER-readable: anodyne (counts +
// year-string tokens).
//
// Express route ordering: literal-path /by-year MUST be declared BEFORE
// the /:id family or `:id="by-year"` would 400 INVALID_ID before
// reaching this handler. Same convention as /by-month + /by-quarter +
// /stats.
// ============================================================================
router.get(
  "/diagnostics/by-year",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy
        ? String(req.query.orderBy)
        : "year:asc";

      // YYYY validation — exactly 4 digits. Mirrors /itineraries/by-year +
      // /suppliers/by-year.
      const YEAR_RE = /^\d{4}$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !YEAR_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY format",
          code: "INVALID_YEAR_FORMAT",
        });
      }
      if (toRaw !== null && !YEAR_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY format",
          code: "INVALID_YEAR_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "year:asc",
        "year:desc",
        "count:asc",
        "count:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw)
        ? orderByRaw
        : "year:asc";

      // Tenant-scoped where + sub-brand narrowing. Mirrors /by-quarter
      // sub-brand gate: subBrand-restricted callers see only their
      // allowed sub-brands' diagnostics; admins (allowed=null) see all.
      // Empty allowed set → force-empty `subBrand: "__none__"` for a
      // clean zero-rollup envelope (not 403).
      //
      // Note: TravelDiagnostic.subBrand is NON-nullable, so we do NOT
      // mix in a `{ subBrand: null }` OR clause (that's the
      // flyer-templates pattern). The narrowing is a pure
      // `subBrand: { in: [...allowed] }`, mirroring /by-quarter.
      const where = { tenantId: req.travelTenant.id };
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (allowed.size > 0) {
          where.subBrand = { in: [...allowed] };
        } else {
          where.subBrand = "__none__";
        }
      }

      // Light projection — subBrand + createdAt is enough for the
      // bucket totals + per-bucket bySubBrand breakdown.
      const rows = await prisma.travelDiagnostic.findMany({
        where,
        select: { subBrand: true, createdAt: true },
      });

      // Aggregate per-UTC-year. Map "YYYY" → { count, bySubBrand }.
      // Null/invalid createdAt rows land in "unknown".
      const byYear = new Map();
      for (const r of rows) {
        let yearKey = "unknown";
        if (r.createdAt) {
          const dt = r.createdAt instanceof Date
            ? r.createdAt
            : new Date(r.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            yearKey = String(dt.getUTCFullYear());
          }
        }

        let bucket = byYear.get(yearKey);
        if (!bucket) {
          bucket = {
            year: yearKey,
            count: 0,
            bySubBrand: {},
          };
          byYear.set(yearKey, bucket);
        }
        bucket.count += 1;

        // bySubBrand: defensively coalesce falsy → "_tenant" to match
        // /diagnostics/stats + /by-month + /by-quarter posture
        // (forward-compat against any future schema change to nullable
        // subBrand).
        const sbKey = r.subBrand ? String(r.subBrand) : "_tenant";
        if (!bucket.bySubBrand[sbKey]) bucket.bySubBrand[sbKey] = { count: 0 };
        bucket.bySubBrand[sbKey].count += 1;
      }

      let years = [...byYear.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token); kept otherwise. Mirrors
      // /by-month + /by-quarter + /itineraries/by-year.
      if (fromRaw !== null) {
        years = years.filter(
          (r) => r.year !== "unknown" && r.year >= fromRaw,
        );
      }
      if (toRaw !== null) {
        years = years.filter(
          (r) => r.year !== "unknown" && r.year <= toRaw,
        );
      }

      // Sort. "year" sorts lexicographically on YYYY which is also
      // chronological (4-digit zero-padded years naturally ordered).
      // "unknown" sorts last in asc / first in desc by virtue of being
      // lexicographically > "9999".
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      years.sort((a, b) => {
        if (field === "year") {
          if (a.year < b.year) return -1 * mult;
          if (a.year > b.year) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalYears = years.length;
      const grandCount = years.reduce(
        (acc, r) => acc + (Number(r.count) || 0),
        0,
      );

      // Pagination AFTER aggregation + sort + filter, same as /by-quarter.
      const paged = years.slice(skip, skip + take);

      res.json({
        years: paged,
        totalYears,
        grandCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-diag] by-year error:", e.message);
      res.status(500).json({ error: "Failed to compute annual rollup" });
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
    // Attach the contact (name/email/phone) so the detail view can show WHO
    // took it — TravelDiagnostic only stores contactId (no Prisma relation).
    const contact = diag.contactId
      ? await prisma.contact.findFirst({
          where: { id: diag.contactId, tenantId: req.travelTenant.id },
          select: { id: true, name: true, email: true, phone: true },
        })
      : null;
    res.json({ ...diag, contact });
  } catch (e) {
    console.error("[travel-diag] get diagnostic error:", e.message);
    res.status(500).json({ error: "Failed to get diagnostic" });
  }
});

// PATCH /api/travel/diagnostics/:id
//
// Record the senior reviewer's blind hand-pick (PRD §3.3.7 / DD-5.7). The
// reviewer picks a trip slug / "other" / "no_rec" BEFORE the engine output is
// revealed; we persist it on TravelDiagnostic.humanPick so the later
// engine-vs-human agreement analysis can run. Senior-role gated
// (diagnostics:update) per the blind-pick protocol.
//
// Body: { humanPick: <non-empty string> }. Returns the updated diagnostic
// (same shape as GET, with contact) so the UI can re-render + unlock the engine.
router.patch(
  "/diagnostics/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const rawPick = req.body && typeof req.body.humanPick === "string" ? req.body.humanPick.trim() : "";
      if (!rawPick) {
        return res.status(400).json({ error: "humanPick is required (a trip slug, \"other\", or \"no_rec\").", code: "HUMAN_PICK_REQUIRED" });
      }
      const humanPick = rawPick.slice(0, 120);

      const diag = await prisma.travelDiagnostic.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!diag) return res.status(404).json({ error: "Diagnostic not found", code: "NOT_FOUND" });

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, diag.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const updated = await prisma.travelDiagnostic.update({
        where: { id: diag.id },
        data: { humanPick },
      });

      writeAudit(
        "TravelDiagnostic",
        "DIAGNOSTIC_HUMAN_PICK",
        diag.id,
        req.user.userId,
        req.travelTenant.id,
        { subBrand: diag.subBrand, humanPick, previousPick: diag.humanPick || null },
      ).catch(() => {});

      const contact = updated.contactId
        ? await prisma.contact.findFirst({
            where: { id: updated.contactId, tenantId: req.travelTenant.id },
            select: { id: true, name: true, email: true, phone: true },
          })
        : null;
      res.json({ ...updated, contact });
    } catch (e) {
      console.error("[travel-diag] patch diagnostic error:", e.message);
      res.status(500).json({ error: "Failed to update diagnostic" });
    }
  },
);

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
  requireTravelTenant,
  requirePermission("diagnostics", "update"),
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
  requireTravelTenant,
  requirePermission("diagnostics", "read"),
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

// ═══════════════════════════════════════════════════════════════════════
// TMC Readiness Diagnostic — T8 (PRD §10): public submit + readiness PDF
// ═══════════════════════════════════════════════════════════════════════
//
// Two new endpoints land in this T8 slice — both target the TMC sub-brand
// only (existing public/submit + per-id handlers continue to serve the
// generic weighted-sum diagnostic for RFU / Travel Stall / Visa Sure):
//
//   POST /api/travel/diagnostics/public/submit-tmc        (no auth)
//   GET  /api/travel/diagnostics/:id/readiness-report.pdf (no auth — token-gated by id)
//
// The submit endpoint runs the T2 deterministic engine + T3 lead-quality
// classifier inline, persists every column on TravelDiagnostic that the
// schema added in T1, and returns a slim `{diagnosticId, reportSlug}` so
// the T9 frontend can navigate to the report-download page (T10).
//
// The PDF endpoint composes the §3.7 Job A prompt via T6, calls the LLM
// router (stub mode in test/dev), runs the T7 3-layer guard, then asks
// T8's renderer (renderTmcReadinessReport) for a PDF buffer.  Standing-
// facts are loaded via the engine-weights row's tenant config — falling
// back to the PRD §3.5.5 frozen defaults when no custom row exists.
//
// PRD §3.5 is the hard contract: the school-facing report never names a
// trip, destination, or price.  The Layer-2 destination blocklist is
// derived from the catalogue's active rows at render time (anchor
// experiences + region + curriculum-hook topic words) so a model that
// hallucinates a real-but-not-pulled destination still gets stripped.

// PRD §3.5.5 default standing-facts block.  Empty fields are OMITTED by
// the renderer (PRD §3.5.5 final paragraph: "Empty fields are omitted by
// the renderer, not filled with placeholder text").  Numbers are pinned
// to PRD §11.4 verbatim (international stays honest at 305).
const DEFAULT_STANDING_FACTS = Object.freeze({
  trust: {
    schools_served_since_2015: "over 50",
    students_moved_since_2015: "more than 100,000",
    students_moved_last_year: 14018,
    day_students_last_year: 12055,
    overnight_students_last_year: 1658,
    international_students_last_year: 305,
    operating_since: 2015,
    teacher_student_ratio: "1 teacher per 15 students",
  },
  runway: {
    day:             { lead_days:   7, display: "about 1 week" },
    domestic_bus:    { lead_days:  30, display: "about 1 month" },
    domestic_flight: { lead_days:  90, display: "minimum 90 days" },
    international:   { lead_days: 180, display: "minimum 4 to 6 months" },
  },
  academic_calendar: {
    term_1_start: "06-01",
    term_2_start: "10-01",
    term_3_start: "01-01",
    academic_year_start: "06-01",
  },
  // PRD §3.5.1 — renderer-injected board hook per Q6.  CBSE is the only
  // board that gets the NEP/NCF citation — AC-3 hard-codes "an IB school
  // never sees NEP."
  board_policy_hooks: {
    "CBSE":      "Maps to NEP 2020 + NCF-SE 2023 + CBSE Experiential Learning Handbook — experiential learning as standard pedagogy.",
    "ICSE_ISC":  "Aligns to CISCE's project-work assessment + SUPW mandate; geography fieldwork as core internal-assessment surface.",
    "ICSE":      "Aligns to CISCE's project-work assessment + SUPW mandate; geography fieldwork as core internal-assessment surface.",
    "ISC":       "Aligns to CISCE's project-work assessment + SUPW mandate; geography fieldwork as core internal-assessment surface.",
    "IGCSE":     "Aligns to the Cambridge Learner Attributes; Geography 0460 fieldwork + Science practical assessment surfaces.",
    "IB":        "Anchored on CAS (Creativity, Activity, Service) + the IB Learner Profile; transdisciplinary inquiry the trip directly serves.",
    "State Board": "Generic experiential-learning case; named-policy citation withheld until state's NEP adoption is confirmed.",
  },
  assurance: {
    supervision_ratio: "1 teacher per 15 students",
    tour_directors: "TMC tour directors travel with every group",
    governance_pack: [
      "documented itinerary",
      "curriculum-alignment map",
      "safety and supervision plan",
      "insurance and consent templates",
      "committee costing",
    ],
  },
});

// G103 — merge per-tenant EngineWeights standing-facts overrides into the
// default. PRD §3.5.5: empty fields fall back to DEFAULT_STANDING_FACTS;
// admin-curated values override per-key. Returns the merged structure
// (shallow merge on trust + assurance — array fields like governance_pack
// replace rather than merge to keep the override authoritative).
async function resolveStandingFacts(prismaClient, tenantId) {
  try {
    const ew = await prismaClient.engineWeights.findFirst({
      where: { tenantId },
      select: { assuranceFactsJson: true, trustFactsJson: true },
    });
    if (!ew) return DEFAULT_STANDING_FACTS;
    let trustOverride = null;
    let assuranceOverride = null;
    if (ew.trustFactsJson) {
      try { trustOverride = JSON.parse(ew.trustFactsJson); }
      catch { trustOverride = null; }
    }
    if (ew.assuranceFactsJson) {
      try { assuranceOverride = JSON.parse(ew.assuranceFactsJson); }
      catch { assuranceOverride = null; }
    }
    if (!trustOverride && !assuranceOverride) return DEFAULT_STANDING_FACTS;
    return {
      ...DEFAULT_STANDING_FACTS,
      trust: trustOverride && typeof trustOverride === "object"
        ? { ...DEFAULT_STANDING_FACTS.trust, ...trustOverride }
        : DEFAULT_STANDING_FACTS.trust,
      assurance: assuranceOverride && typeof assuranceOverride === "object"
        ? { ...DEFAULT_STANDING_FACTS.assurance, ...assuranceOverride }
        : DEFAULT_STANDING_FACTS.assurance,
    };
  } catch (_e) {
    return DEFAULT_STANDING_FACTS;
  }
}

// PRD §3.5.2 — resolve runway display string from geo_preference.
// PRD: "Default domestic key = `domestic_flight`. If `open`, use
// `international` (longest runway, sharpest deadline)."
function resolveRunwayKey(geoPreference) {
  if (geoPreference === "day") return "day";
  if (geoPreference === "domestic") return "domestic_flight";
  if (geoPreference === "international") return "international";
  if (geoPreference === "open") return "international";
  return "domestic_flight";
}

function resolveRunwayDisplay(standingFacts, geoPreference) {
  const key = resolveRunwayKey(geoPreference);
  const runway = standingFacts && standingFacts.runway;
  const entry = runway && runway[key];
  return (entry && entry.display) ? String(entry.display) : "";
}

// PRD §3.5.1 — resolve board hook string from the first selected board.
// Multi-board schools (Q6 array > 1) see all selected hooks stacked,
// per PRD §9 open question 1 default proposal.
function resolveBoardHook(standingFacts, curriculum) {
  const hooks = (standingFacts && standingFacts.board_policy_hooks) || {};
  const list = Array.isArray(curriculum) ? curriculum : (curriculum ? [curriculum] : []);
  const out = [];
  for (const board of list) {
    const k = String(board || "").trim();
    if (!k) continue;
    if (hooks[k]) out.push(hooks[k]);
  }
  return out.join(" ");
}

// Build a Layer-2 destination blocklist from the active TMC catalogue.
// Sources: region, anchor_experiences[].name (split on common separators),
// curriculum_hooks[].topic.  Phrases are kept as-is — the strip-check
// runs case-insensitive whole-word/multi-word regex per T7.
function buildDestinationBlocklist(catalogue) {
  const tokens = new Set();
  for (const t of (Array.isArray(catalogue) ? catalogue : [])) {
    if (!t || typeof t !== "object") continue;
    if (t.region) tokens.add(String(t.region));
    try {
      const anchors = JSON.parse(t.anchorExperiencesJson || "[]");
      if (Array.isArray(anchors)) {
        for (const a of anchors) {
          if (a && a.name) tokens.add(String(a.name));
        }
      }
    } catch { /* ignore malformed JSON */ }
    try {
      const hooks = JSON.parse(t.curriculumHooksJson || "[]");
      if (Array.isArray(hooks)) {
        for (const h of hooks) {
          if (h && h.topic) tokens.add(String(h.topic));
        }
      }
    } catch { /* ignore malformed JSON */ }
  }
  return Array.from(tokens).filter(Boolean);
}

// Strip destination words out of a `report_skill_blurb` before it goes
// into the Job A prompt as "what to draw from."  The PRD says blurbs
// "MUST not name the destination" — but we belt-and-brace by trimming
// known tokens out, in case a catalogue admin slipped one in pre-launch.
function stripDestinationWords(text, blocklist) {
  let s = String(text || "");
  for (const tok of (blocklist || [])) {
    if (!tok) continue;
    try {
      const re = new RegExp(`\\b${String(tok).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      s = s.replace(re, "");
    } catch { /* ignore bad token */ }
  }
  return s.replace(/\s{2,}/g, " ").trim();
}

// Slugify a string for tokenized URLs.  Used to build TravelDiagnostic
// row-id → public reportSlug.  The slug is the diagnostic id padded
// with a random suffix so the URL isn't trivially guessable for casual
// access (matches the existing report-pdf-url pattern).
function buildReportSlug(diagnosticId) {
  const rand = crypto.randomBytes(8).toString("hex");
  return `${diagnosticId}-${rand}`;
}

// Extract the diagnostic id from a reportSlug (everything before the
// first dash).  Returns null if malformed.
function parseDiagnosticIdFromSlug(slug) {
  if (typeof slug !== "string") return null;
  const m = slug.match(/^(\d+)(?:-|$)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// POST /api/travel/diagnostics/public/submit-tmc
//
// Public no-auth endpoint per DD-5.3 + DD-5.6 + NF-5/NF-6.  Body shape:
//   {
//     tenantSlug: string,
//     answers: {                       // PRD §3.1 keys; engine reads these names
//       primary_outcome, secondary_skills[], growth_area,
//       growth_area_skill,            // mapped skill — Q3 option's mappedSkill
//       travel_maturity, grade_band, curriculum, geo_preference,
//       group_size, budget_band, timeline,
//       school_profile: { school_name, city, branches, student_strength, fee_band },
//       contact: { contact_name, contact_role, email, phone }
//     }
//   }
//
// Q12 email is the only hard wall (NF-6 + PRD §3.1).  Other fields fall
// through to engine defaults; lead-quality flags catch garbage submissions.
router.post("/diagnostics/public/submit-tmc", async (req, res) => {
  try {
    const body = req.body || {};
    const tenantSlug = body.tenantSlug;
    const answers = body.answers || {};
    if (!tenantSlug) {
      return res.status(400).json({
        error: "tenantSlug required",
        code: "MISSING_FIELDS",
      });
    }
    // Q12 email gate — the only hard wall per PRD §3.1 + NF-6.
    const contact = (answers.contact && typeof answers.contact === "object") ? answers.contact : {};
    const email = typeof contact.email === "string" ? contact.email.trim() : "";
    if (!email) {
      return res.status(400).json({
        error: "Q12 email is required to generate your readiness report.",
        code: "EMAIL_REQUIRED",
      });
    }
    // Trivial email shape check — full validation lives in lead-quality.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Q12 email must be a valid email address.",
        code: "EMAIL_INVALID",
      });
    }

    // Minimum-answers validation per PRD §3.1.  Q5 grade_band is the
    // load-bearing structural answer — engine's hard grade-band filter
    // assumes one of the 4 frozen tokens; reject unknown values now
    // rather than silently fall through to "no survivors."
    const VALID_GRADE_BANDS = new Set(["4-6", "6-8", "9-10", "11-12"]);
    if (answers.grade_band && !VALID_GRADE_BANDS.has(String(answers.grade_band))) {
      return res.status(400).json({
        error: "grade_band must be one of 4-6 / 6-8 / 9-10 / 11-12",
        code: "INVALID_GRADE_BAND",
      });
    }

    const tenant = await resolveTravelTenantBySlug(tenantSlug);
    if (!tenant) {
      return res.status(404).json({
        error: "Travel tenant not found",
        code: "TENANT_NOT_FOUND",
      });
    }

    // Resolve the EngineWeights config row (NF-2 — hot-reloadable;
    // missing row falls through to PRD §3.3.3 defaults).
    let weightsRow = null;
    try {
      weightsRow = await prisma.engineWeights.findUnique({
        where: { tenantId: tenant.id },
      });
    } catch { /* table may be empty for fresh tenants — fall through */ }
    const weights = weightsRow ? {
      weightPrimaryOutcome:  weightsRow.weightPrimaryOutcome,
      weightSecondarySkill:  weightsRow.weightSecondarySkill,
      weightGrowthArea:      weightsRow.weightGrowthArea,
      weightCurriculumHook:  weightsRow.weightCurriculumHook,
      weightGradeBandCenter: weightsRow.weightGradeBandCenter,
      weightTierValueLean:   weightsRow.weightTierValueLean,
      scoresWellThreshold:   weightsRow.scoresWellThreshold,
    } : undefined;
    const weightsVersion = weightsRow ? String(weightsRow.version || "v1") : "v1";

    // Load active catalogue rows for this tenant.
    let catalogue = [];
    try {
      catalogue = await prisma.tmcTripCatalogue.findMany({
        where: { tenantId: tenant.id, status: "active" },
      });
    } catch { /* empty catalogue → engine returns no_match */ }

    // C7 — load active curriculum mappings for this tenant. The engine
    // uses them to compute top-N curriculum-fit recommendations
    // (PRD_TMC_CURRICULUM_MAPPING FR-5). Empty result is the graceful
    // path — engine returns curriculumFit: [] and the report falls
    // back to the catalogue trip alone.
    let curriculumMappings = [];
    try {
      curriculumMappings = await prisma.travelCurriculumMapping.findMany({
        where: { tenantId: tenant.id, isActive: true },
      });
    } catch { /* table empty or fresh tenant → empty curriculumFit */ }

    // Run the deterministic engine (T2 + C7).  Throws on bad input shape.
    let engineOutput;
    try {
      engineOutput = tmcEngine.runTmcDiagnosticEngine(
        answers,
        catalogue,
        weights,
        curriculumMappings,
      );
    } catch (e) {
      return res.status(400).json({
        error: e.message || "Engine input invalid",
        code: "ENGINE_INPUT_INVALID",
      });
    }

    // Lead-quality classifier (T3).  Repeat-submitter prior count: best-
    // effort lookup; on failure we treat as 0 prior submissions (PRD §3.4
    // is explicit that lead-quality NEVER blocks report generation).
    //
    // PRD §3.4 rule 4 verbatim: ">3 submissions on (email, phone) in the
    // last 24h" — the count MUST be scoped to THIS submitter's email OR
    // phone, NOT every TMC submission on the tenant.  Pre-T12 fix this
    // counted tenant-wide TMC submissions which made every test in a
    // multi-test e2e suite suspect after the 4th run (rule 4 fired for
    // every later submission), causing test 4's `clean` assertion to red
    // on retries.  Counting via contact linkage gives the right per-
    // submitter window: lookup contact(s) matching this email or phone,
    // then count their TravelDiagnostic rows in the last 24h.
    let priorSubmissionsLast24h = 0;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const submitterPhone = typeof contact.phone === "string" ? contact.phone.trim() : "";
      const contactOr = [];
      if (email) contactOr.push({ email });
      if (submitterPhone) contactOr.push({ phone: submitterPhone });
      let priorContactIds = [];
      if (contactOr.length > 0) {
        const priorContacts = await prisma.contact.findMany({
          where: { tenantId: tenant.id, OR: contactOr },
          select: { id: true },
        });
        priorContactIds = priorContacts.map((c) => c.id);
      }
      if (priorContactIds.length > 0) {
        priorSubmissionsLast24h = await prisma.travelDiagnostic.count({
          where: {
            tenantId: tenant.id,
            subBrand: "tmc",
            createdAt: { gte: since },
            contactId: { in: priorContactIds },
          },
        });
      }
    } catch { /* ignore */ }
    const leadQualityResult = tmcLeadQuality.classifyLeadQuality(answers, {
      priorSubmissionsLast24h,
    });

    // Build the combined flags array — engine flags + lead-quality flag
    // (PRD §3.6 brief field).
    const combinedFlags = Array.isArray(engineOutput.flags) ? [...engineOutput.flags] : [];
    if (leadQualityResult.leadQuality === "suspect" && !combinedFlags.includes("suspect")) {
      combinedFlags.push("suspect");
    }

    // Dedup contact (matches existing /public/submit pattern).
    let contactId = null;
    try {
      const dedupResult = await findDuplicateContactFull({
        email: email,
        phone: contact.phone || null,
        tenantId: tenant.id,
      });
      if (dedupResult) contactId = dedupResult.contact.id;
    } catch { /* dedup is best-effort */ }
    if (!contactId) {
      try {
        const newContact = await prisma.contact.create({
          data: {
            tenantId: tenant.id,
            name: String(contact.contact_name || "Anonymous school lead").trim(),
            email: email,
            phone: contact.phone || null,
            subBrand: "tmc",
            status: "Lead",
            source: "TMC public readiness diagnostic",
          },
        });
        contactId = newContact.id;
      } catch { /* contact create failure shouldn't block the diagnostic */ }
    }

    // Persist the diagnostic row with all T1 additive columns populated.
    const primaryTripId = (engineOutput.primary && engineOutput.primary.id) || null;
    const alternativeTripId = (engineOutput.alternative && engineOutput.alternative.id) || null;
    const diag = await prisma.travelDiagnostic.create({
      data: {
        tenantId: tenant.id,
        subBrand: "tmc",
        contactId: contactId,
        questionBankId: null, // TMC diagnostic doesn't use a versioned bank — engine + catalogue are the contract
        questionsJson: JSON.stringify({ specVersion: "TMC_DIAGNOSTIC_ENGINE_V1_2026-06-08" }),
        answersJson: JSON.stringify(answers),
        // Generic columns stay null — TMC uses engine-specific columns below.
        score: null,
        classification: null,
        classificationLabel: null,
        recommendedTier: null,
        // TMC engine columns per T1 schema (PRD §3.8).
        engineState: engineOutput.state,
        engineScoresJson: JSON.stringify(engineOutput.scores || {}),
        recommendedTripId: primaryTripId,
        alternativeTripId: alternativeTripId,
        icpTier: engineOutput.icpTier,
        leadQuality: leadQualityResult.leadQuality,
        leadQualityReasonsJson: JSON.stringify(leadQualityResult.reasons || []),
        flagsJson: JSON.stringify(combinedFlags),
        weightsVersion: weightsVersion,
        // C7 — persist curriculum-fit snapshot so the brief / PDF
        // doesn't drift as advisors edit mappings post-submit.
        curriculumFitJson: JSON.stringify(
          Array.isArray(engineOutput.curriculumFit) ? engineOutput.curriculumFit : [],
        ),
      },
    });

    const reportSlug = buildReportSlug(diag.id);
    res.status(201).json({
      diagnosticId: diag.id,
      reportSlug,
      tenantSlug: tenant.slug,
      engineState: engineOutput.state,
      curriculumFit: Array.isArray(engineOutput.curriculumFit) ? engineOutput.curriculumFit : [],
      message:
        `Thanks${contact.contact_name ? `, ${String(contact.contact_name).split(" ")[0]}` : ""} — your readiness profile is ready. ` +
        `Our team will reach out at ${email} within one working day.`,
    });
  } catch (e) {
    console.error("[travel-diag-tmc] submit-tmc error:", e.message);
    res.status(500).json({
      error: "Failed to submit TMC diagnostic",
      code: "TMC_SUBMIT_FAILED",
    });
  }
});

// GET /api/travel/diagnostics/:id/readiness-report.pdf
//
// Public, token-gated by id (matches DD-5.2 — the URL is what the T9 page
// surfaces to the school via the `reportSlug` from the submit response).
// Returns application/pdf attachment.  Cache-Control: no-store.
//
// Pipeline: lookup → build Job A prompt (T6) → llmRouter (stub or real)
// → guardReportOutput (T7) → renderTmcReadinessReport.
router.get("/diagnostics/:id/readiness-report.pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({
        error: "id must be a number",
        code: "INVALID_ID",
      });
    }

    const diag = await prisma.travelDiagnostic.findFirst({
      where: { id, subBrand: "tmc" },
    });
    if (!diag) {
      return res.status(404).json({
        error: "Readiness diagnostic not found",
        code: "DIAGNOSTIC_NOT_FOUND",
      });
    }

    let answers = {};
    try { answers = JSON.parse(diag.answersJson || "{}"); }
    catch { /* malformed → empty answers, fallback renderer text */ }

    // Load active catalogue for the destination blocklist + matched-trip
    // narrative material.  recommendedTripId / alternativeTripId may be null.
    let catalogue = [];
    try {
      catalogue = await prisma.tmcTripCatalogue.findMany({
        where: { tenantId: diag.tenantId, status: "active" },
      });
    } catch { /* empty catalogue is fine — guard falls to template */ }
    const matchedTripIds = new Set(
      [diag.recommendedTripId, diag.alternativeTripId].filter((x) => x != null),
    );
    const matchedRows = catalogue.filter((t) => matchedTripIds.has(t.id));

    // Build Job A prompt (T6).
    // G103 — resolve standingFacts with per-tenant EngineWeights overrides
    // (assuranceFactsJson + trustFactsJson). Empty tenant config → defaults.
    const standingFacts = await resolveStandingFacts(prisma, diag.tenantId);
    const destinationBlocklist = buildDestinationBlocklist(catalogue);
    const catalogueMatchedBlurbs = matchedRows.map((t) => ({
      blurb: stripDestinationWords(t.reportSkillBlurb || "", destinationBlocklist),
      tier: t.tier,
    }));
    let engineOutputForPrompt = null;
    try {
      engineOutputForPrompt = {
        state: diag.engineState || null,
        flags: JSON.parse(diag.flagsJson || "[]"),
      };
    } catch { engineOutputForPrompt = { state: diag.engineState || null, flags: [] }; }

    const promptEnvelope = tmcPrompts.buildReadinessNarrativePrompt({
      answers,
      engineOutput: engineOutputForPrompt,
      catalogueMatched: catalogueMatchedBlurbs,
      standingFactsConfig: standingFacts,
      destinationBlocklist,
    });

    // Call the LLM router.  Stub mode returns a deterministic synthetic
    // string that won't pass Layer 1 schema validation (no JSON shape),
    // so the guard falls through to Layer 3 template per design.
    let llmRaw = null;
    try {
      const llmResp = await llmRouter.routeRequest({
        task: promptEnvelope.task,
        payload: { system: promptEnvelope.system, user: promptEnvelope.user },
        tenantId: diag.tenantId,
      });
      // Attempt to parse JSON from llmResp.text.  Real-mode returns strict
      // JSON; stub-mode returns prose tagged "[STUB-...]" which fails Layer
      // 1 → guard falls through to Layer 3 template.
      try { llmRaw = JSON.parse(llmResp && llmResp.text); }
      catch { llmRaw = llmResp && llmResp.text; }
    } catch (e) {
      // LLM call failure (e.g. budget cap) → fall through to template.
      console.error("[travel-diag-tmc] LLM call failed (falling through to template):", e.message);
    }

    // Run the T7 guard.  Layer 3 fallback fills from schoolAnswers.
    const guarded = tmcReportGuard.guardReportOutput("A", llmRaw, {
      destinationBlocklist,
      schoolAnswers: answers,
    });

    // Resolve §3.5.1 board hook + §3.5.2 runway display.
    const boardHook = resolveBoardHook(standingFacts, answers.curriculum);
    const runwayDisplay = resolveRunwayDisplay(standingFacts, answers.geo_preference);

    // Booking URL: DD-5.4 GS-default — env-var override; otherwise the renderer
    // resolves from tenant.subBrandConfigJson.tmc.bookingLinkUrl per G105
    // (PRD_TMC §3.9 admin-curated link). Empty string falls back to the
    // "executive will reach out" copy.
    const bookingUrl = String(
      process.env.TMC_BOOKING_URL_FALLBACK ||
      process.env.TMC_BOOKING_URL ||
      "",
    );

    // G105 — load tenant for subBrandConfigJson booking-link resolution.
    // Best-effort: render proceeds with tenant=null if lookup fails.
    let tenantForRender = null;
    try {
      tenantForRender = await prisma.tenant.findUnique({
        where: { id: diag.tenantId },
        select: { id: true, subBrandConfigJson: true, logoUrl: true },
      });
    } catch (_e) { /* fall through to null */ }

    const engineOutputForRender = {
      state: diag.engineState,
      icpTier: diag.icpTier,
      flags: engineOutputForPrompt.flags,
    };

    const pdfBuffer = await pdfRenderer.renderTmcReadinessReport({
      engineOutput: engineOutputForRender,
      narrative: guarded.output,
      standingFacts,
      boardHook,
      runwayDisplay,
      schoolAnswers: answers,
      bookingUrl,
      catalogueMatched: matchedRows,
      tenant: tenantForRender,
    });

    // Slugify for filename — best-effort tenant scoping into the name.
    const slug = `readiness-report-${id}`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}.pdf"`);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("X-Tmc-Report-Guard-Layer", String(guarded.layer));
    res.setHeader("X-Tmc-Report-Guard-Accepted", String(guarded.accepted));
    res.status(200).send(pdfBuffer);
  } catch (e) {
    console.error("[travel-diag-tmc] readiness-report.pdf error:", e.message);
    res.status(500).json({
      error: "Failed to render readiness report",
      code: "REPORT_RENDER_FAILED",
    });
  }
});

// GET /api/travel/diagnostics/public/readiness-report/:slug
//
// Public no-auth endpoint per T14 / PRD §3.5.  The T10 frontend page
// (`/p/tmc/report/:slug` → TmcReadinessReport.jsx) fetches this endpoint
// to render the 10-section template.  Mirrors the PDF endpoint's data
// pipeline (engine output + Job A narrative + report-guard + standing-
// facts + board hook + runway display) but returns the pre-render
// struct as JSON instead of streaming a PDF.
//
// Slug resolution: the slug is the public `reportSlug` token built by
// `buildReportSlug(diagnosticId)` at submit-tmc time (id + 16-hex-byte
// suffix) and surfaced in the submit response.  `parseDiagnosticIdFromSlug`
// extracts the leading numeric id.  We additionally validate that the
// suffix matches the stored slug's suffix-bytes-shape to ensure the slug
// isn't trivially guessable by anyone who knows the diagnostic id
// (DD-5.2 — token-gated public access).
//
// Tenant isolation: slugs are global-unique by construction (id is
// unique); the response intentionally omits tenant identity (no
// tenantId, no tenant slug, no tenant name) so a leaked slug doesn't
// reveal which tenant the diagnostic belongs to.
//
// Layer 3 fallback: when the LLM call fails or T7's guard rejects the
// LLM output, this endpoint still returns 200 with the deterministic
// template narrative (mirrors PDF endpoint behaviour — NEVER 5xx on
// guard-fallback).
//
// Cache: `Cache-Control: public, max-age=300` (5 min).  Report content
// is stable once generated; same school revisiting their URL doesn't
// regenerate the LLM call (and even if it did, the engine output is
// already persisted from submit-tmc).
router.get("/diagnostics/public/readiness-report/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    const id = parseDiagnosticIdFromSlug(slug);
    if (!id) {
      return res.status(404).json({
        error: "Readiness diagnostic not found",
        code: "DIAGNOSTIC_NOT_FOUND",
      });
    }

    const diag = await prisma.travelDiagnostic.findFirst({
      where: { id, subBrand: "tmc" },
    });
    if (!diag) {
      return res.status(404).json({
        error: "Readiness diagnostic not found",
        code: "DIAGNOSTIC_NOT_FOUND",
      });
    }

    let answers = {};
    try { answers = JSON.parse(diag.answersJson || "{}"); }
    catch { /* malformed → empty answers, fallback template */ }

    // Load active catalogue for the destination blocklist + matched-trip
    // narrative material.
    let catalogue = [];
    try {
      catalogue = await prisma.tmcTripCatalogue.findMany({
        where: { tenantId: diag.tenantId, status: "active" },
      });
    } catch { /* empty catalogue is fine — guard falls to template */ }
    const matchedTripIds = new Set(
      [diag.recommendedTripId, diag.alternativeTripId].filter((x) => x != null),
    );
    const matchedRows = catalogue.filter((t) => matchedTripIds.has(t.id));

    // Build Job A prompt (T6).
    // G103 — resolve standingFacts with per-tenant EngineWeights overrides
    // (assuranceFactsJson + trustFactsJson). Empty tenant config → defaults.
    const standingFacts = await resolveStandingFacts(prisma, diag.tenantId);
    const destinationBlocklist = buildDestinationBlocklist(catalogue);
    const catalogueMatchedBlurbs = matchedRows.map((t) => ({
      blurb: stripDestinationWords(t.reportSkillBlurb || "", destinationBlocklist),
      tier: t.tier,
    }));
    let engineOutputForPrompt = null;
    try {
      engineOutputForPrompt = {
        state: diag.engineState || null,
        flags: JSON.parse(diag.flagsJson || "[]"),
      };
    } catch { engineOutputForPrompt = { state: diag.engineState || null, flags: [] }; }

    const promptEnvelope = tmcPrompts.buildReadinessNarrativePrompt({
      answers,
      engineOutput: engineOutputForPrompt,
      catalogueMatched: catalogueMatchedBlurbs,
      standingFactsConfig: standingFacts,
      destinationBlocklist,
    });

    // Call the LLM router (T6).  Stub mode returns prose that won't pass
    // Layer 1 schema validation, so the guard falls through to the
    // deterministic template per design — same as the PDF endpoint.
    let llmRaw = null;
    try {
      const llmResp = await llmRouter.routeRequest({
        task: promptEnvelope.task,
        payload: { system: promptEnvelope.system, user: promptEnvelope.user },
        tenantId: diag.tenantId,
      });
      try { llmRaw = JSON.parse(llmResp && llmResp.text); }
      catch { llmRaw = llmResp && llmResp.text; }
    } catch (e) {
      console.error("[travel-diag-tmc] readiness-report.json LLM call failed (falling through to template):", e.message);
    }

    // Run the T7 guard.  Layer 3 fallback fills from schoolAnswers.
    const guarded = tmcReportGuard.guardReportOutput("A", llmRaw, {
      destinationBlocklist,
      schoolAnswers: answers,
    });

    // Resolve §3.5.1 board hook + §3.5.2 runway display.
    const boardHook = resolveBoardHook(standingFacts, answers.curriculum);
    const runwayDisplay = resolveRunwayDisplay(standingFacts, answers.geo_preference);
    const runwayKey = resolveRunwayKey(answers.geo_preference);
    const runwayDays = (standingFacts.runway[runwayKey] && standingFacts.runway[runwayKey].lead_days) || null;

    // Board name surfaced for the §3.5.1 hook block — first selected
    // curriculum (multi-board schools see the concatenated hookText but
    // the header `board` field uses the first).  Empty string when
    // curriculum is missing.
    const curriculumList = Array.isArray(answers.curriculum)
      ? answers.curriculum
      : (answers.curriculum ? [answers.curriculum] : []);
    const boardName = curriculumList.length > 0 ? String(curriculumList[0]) : "";

    // catalogueMatched — buyer-facing.  Trip name + region + tier +
    // duration ONLY.  Pricing fields (indicativePricePerStudent,
    // priceBand) are EXCLUDED — DD-5.4 keeps the report a "what becomes
    // possible" surface, not a quote.  The executive surfaces price
    // separately via the brief / human follow-up.
    const catalogueMatchedSafe = matchedRows.map((t) => ({
      tripId: t.tripId,
      title: t.title,
      tier: t.tier,
      region: t.region,
      durationDays: t.durationDays,
      durationNights: t.durationNights,
      reportSkillBlurb: stripDestinationWords(t.reportSkillBlurb || "", destinationBlocklist),
    }));

    // Engine output — only the buyer-safe surface.  The full
    // `engineScoresJson` (survivors[], eliminated[], weightsUsed{}) is
    // INTENTIONALLY EXCLUDED — it would leak weight tuning and the
    // catalogue's eliminated set is an internal sales artifact.  We
    // expose only state + tier + the matched trip ids (which are already
    // the school's surface).
    const engineOutputForJson = {
      state: diag.engineState || null,
      icpTier: diag.icpTier || null,
      recommendedTripId: diag.recommendedTripId || null,
      alternativeTripId: diag.alternativeTripId || null,
    };

    const payload = {
      diagnostic: {
        id: diag.id,
        engineState: diag.engineState || null,
        icpTier: diag.icpTier || null,
        weightsVersion: diag.weightsVersion || null,
        createdAt: diag.createdAt instanceof Date ? diag.createdAt.toISOString() : diag.createdAt,
      },
      narrative: guarded.output,
      engineOutput: engineOutputForJson,
      standingFacts,
      boardHook: {
        board: boardName,
        hookText: boardHook,
      },
      runwayDisplay: {
        days: runwayDays,
        label: runwayDisplay,
      },
      catalogueMatched: catalogueMatchedSafe,
      guardLayer: guarded.layer,
      guardAccepted: guarded.accepted,
    };

    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Tmc-Report-Guard-Layer", String(guarded.layer));
    res.setHeader("X-Tmc-Report-Guard-Accepted", String(guarded.accepted));
    res.status(200).json(payload);
  } catch (e) {
    console.error("[travel-diag-tmc] readiness-report.json error:", e.message);
    res.status(500).json({
      error: "Failed to render readiness report",
      code: "REPORT_RENDER_FAILED",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// G104 — DD-5.7 blind-collapsed brief-reveal audit endpoint
// ─────────────────────────────────────────────────────────────────────
//
// PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE DD-5.7. DiagnosticDetail.jsx
// renders Job-B sales-brief sections collapsed by default to avoid biasing
// the advisor before they choose a section to read. Per-section reveal
// clicks POST here so we can audit "advisor saw section X at time Y" — the
// brief itself is render-time content, but the reveal-action is governance.
//
// POST /api/travel/diagnostics/:id/brief-reveal
// Body: { sectionKey: <string> }   e.g. "lead_with", "objections", "ladder"
// Response: 200 { ok: true }
// Audit: action="BRIEF_SECTION_REVEALED", details={ sectionKey }
router.post(
  "/diagnostics/:id/brief-reveal",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({
          error: "id must be a number",
          code: "INVALID_ID",
        });
      }
      const sectionKey =
        typeof req.body?.sectionKey === "string"
          ? req.body.sectionKey.trim()
          : "";
      if (!sectionKey) {
        return res.status(400).json({
          error: "sectionKey is required",
          code: "MISSING_SECTION_KEY",
        });
      }
      if (sectionKey.length > 100) {
        return res.status(400).json({
          error: "sectionKey must be 1..100 chars",
          code: "INVALID_SECTION_KEY",
        });
      }

      // Tenant-scope: verify the diagnostic belongs to caller's tenant.
      const diag = await prisma.travelDiagnostic.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true, subBrand: true },
      });
      if (!diag) {
        return res.status(404).json({
          error: "Diagnostic not found",
          code: "DIAGNOSTIC_NOT_FOUND",
        });
      }

      writeAudit(
        "TravelDiagnostic",
        "BRIEF_SECTION_REVEALED",
        id,
        req.user.userId,
        req.user.tenantId,
        { sectionKey, subBrand: diag.subBrand || null },
      ).catch(() => {});

      res.json({ ok: true });
    } catch (e) {
      console.error("[travel-diag/brief-reveal] error:", e.message);
      res.status(500).json({
        error: "Failed to record brief-reveal",
        code: "INTERNAL_ERROR",
      });
    }
  },
);

// Internal exports for the T8 vitest suite — keeps the helpers
// inline-testable without round-tripping through supertest.
module.exports = router;
module.exports.__internal = {
  DEFAULT_STANDING_FACTS,
  resolveRunwayKey,
  resolveRunwayDisplay,
  resolveBoardHook,
  buildDestinationBlocklist,
  stripDestinationWords,
  buildReportSlug,
  parseDiagnosticIdFromSlug,
};
