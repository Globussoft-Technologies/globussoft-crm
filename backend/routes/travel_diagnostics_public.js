// Travel CRM — Public diagnostic form routes (additive, v3.9.4).
//
// These endpoints power a tenant-branded, no-auth public diagnostic form
// that advisors can publish per sub-brand. Submissions reuse the existing
// weighted-sum scorer + RAG + PDF pipeline so the public flow produces the
// same score/readiness/PDF as the advisor-facing customer portal flow.
//
// Admin routes (authed, travel-tenant scoped):
//   GET    /api/travel/diagnostic-public-forms                list
//   POST   /api/travel/diagnostic-public-forms                upsert by subBrand
//   GET    /api/travel/diagnostic-public-forms/:subBrand       get one
//   POST   /api/travel/diagnostic-public-forms/:subBrand/toggle publish
//
// Public routes (no auth):
//   GET  /api/travel/diagnostics/public/form/:tenantSlug/:subBrand
//   POST /api/travel/diagnostics/public/form/:tenantSlug/:subBrand/submit
//   GET  /api/travel/diagnostics/public/report/:slug
//   POST /api/travel/diagnostics/public/report/:slug/interests

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const prisma = require("../lib/prisma");
const { parseBank, scoreDiagnostic } = require("../lib/travelDiagnosticScoring");
const { findDuplicateContactFull } = require("../utils/deduplication");
const { generateDiagnosticPdfBestEffort } = require("../lib/travelDiagnosticPdf");
const {
  buildCurriculumFitForDiagnostic,
  extractLearningProfile,
} = require("../lib/travelDiagnosticCurriculumFit");
const curriculumRag = require("../lib/curriculumRag");
const travelRag = require("../lib/travelRag");
const diagnosticChosenInterests = require("../lib/diagnosticChosenInterests");
const { resolveCancellationPolicyForForm } = require("../lib/travelDiagnosticCancellationPolicy");
const diagnosticNotifications = require("../lib/diagnosticNotifications");

const {
  getReadinessLevel,
  readinessLevelFromScore,
  READINESS_LEVELS,
} = require("../lib/travelDiagnosticScoring");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { verifyToken } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const { sanitizeText } = require("../lib/sanitizeJson");

const VALID_LOGO_PLACEMENTS = new Set([
  "top-center",
  "top-left",
  "top-right",
  "inline",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Admin: list forms for the current travel tenant
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/diagnostic-public-forms",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const allowed = await getSubBrandAccessSet(req.user.userId);
      const where = { tenantId: req.travelTenant.id };
      if (allowed) {
        where.subBrand = { in: allowed.size ? [...allowed] : ["__none__"] };
      }
      const forms = await prisma.travelDiagnosticPublicForm.findMany({
        where,
        orderBy: [{ subBrand: "asc" }],
      });
      res.json({ forms });
    } catch (e) {
      console.error("[diag-public-forms] list error:", e.message);
      res.status(500).json({ error: "Failed to list public forms" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Admin: upsert a public form config for a sub-brand
// Body: { subBrand, title?, subtitle?, brandKitId?, primaryColor?, bgColor?,
//         textColor?, fontFamily?, logoUrl?, logoPlacement?, coverImageUrl?,
//         headerHtml?, footerHtml?, thankYouMessage?, stylingConfigJson?,
//         includeName?, includeEmail?, includePhone?, nameRequired?,
//         emailRequired?, phoneRequired? }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/diagnostic-public-forms",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const data = req.body || {};
      const subBrand = String(data.subBrand || "").trim();
      if (!subBrand) {
        return res
          .status(400)
          .json({ error: "subBrand is required", code: "MISSING_SUB_BRAND" });
      }
      assertValidSubBrand(subBrand);

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Find the current active bank for this sub-brand to snapshot bankId.
      const activeBank = await prisma.travelDiagnosticQuestionBank.findFirst({
        where: { tenantId: req.travelTenant.id, subBrand, isActive: true },
        orderBy: { version: "desc" },
      });

      const payload = buildFormPayload(data, activeBank?.id ?? null);
      payload.tenantId = req.travelTenant.id;
      payload.subBrand = subBrand;

      const existing = await prisma.travelDiagnosticPublicForm.findUnique({
        where: { tenantId_subBrand: { tenantId: req.travelTenant.id, subBrand } },
      });

      const form = existing
        ? await prisma.travelDiagnosticPublicForm.update({
            where: { id: existing.id },
            data: payload,
          })
        : await prisma.travelDiagnosticPublicForm.create({ data: payload });

      res.status(existing ? 200 : 201).json({ form });
    } catch (e) {
      if (e.status)
        return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[diag-public-forms] upsert error:", e.message);
      res.status(500).json({ error: "Failed to save public form" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Admin: get form by sub-brand
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/diagnostic-public-forms/:subBrand",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const subBrand = String(req.params.subBrand || "");
      assertValidSubBrand(subBrand);
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }
      const form = await prisma.travelDiagnosticPublicForm.findUnique({
        where: { tenantId_subBrand: { tenantId: req.travelTenant.id, subBrand } },
      });
      if (!form) {
        return res
          .status(404)
          .json({ error: "Public form not found", code: "NOT_FOUND" });
      }
      res.json({ form });
    } catch (e) {
      if (e.status)
        return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[diag-public-forms] get error:", e.message);
      res.status(500).json({ error: "Failed to get public form" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Admin: publish / unpublish toggle
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/diagnostic-public-forms/:subBrand/toggle",
  verifyToken,
  requireTravelTenant,
  requirePermission("diagnostics", "write"),
  async (req, res) => {
    try {
      const subBrand = String(req.params.subBrand || "");
      assertValidSubBrand(subBrand);
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const existing = await prisma.travelDiagnosticPublicForm.findUnique({
        where: { tenantId_subBrand: { tenantId: req.travelTenant.id, subBrand } },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ error: "Public form not found", code: "NOT_FOUND" });
      }

      const nextPublished = !existing.isPublished;
      const update = { isPublished: nextPublished };
      if (nextPublished) {
        // Snapshot current active bank on publish.
        const activeBank = await prisma.travelDiagnosticQuestionBank.findFirst({
          where: { tenantId: req.travelTenant.id, subBrand, isActive: true },
          orderBy: { version: "desc" },
        });
        if (activeBank) update.bankId = activeBank.id;
      }

      const form = await prisma.travelDiagnosticPublicForm.update({
        where: { id: existing.id },
        data: update,
      });
      res.json({ form, isPublished: form.isPublished });
    } catch (e) {
      if (e.status)
        return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[diag-public-forms] toggle error:", e.message);
      res.status(500).json({ error: "Failed to toggle publish state" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Public: fetch published form config + active bank questions
// ─────────────────────────────────────────────────────────────────────────────
router.get("/diagnostics/public/form/:tenantSlug/:subBrand", async (req, res) => {
  try {
    const tenantSlug = String(req.params.tenantSlug || "").trim();
    const subBrand = String(req.params.subBrand || "").trim();
    if (!tenantSlug || !subBrand) {
      return res
        .status(400)
        .json({ error: "tenantSlug and subBrand required", code: "MISSING_PARAMS" });
    }
    assertValidSubBrand(subBrand);

    const tenant = await resolveTravelTenantBySlug(tenantSlug);
    if (!tenant) {
      return res
        .status(404)
        .json({ error: "Travel tenant not found", code: "TENANT_NOT_FOUND" });
    }

    const form = await prisma.travelDiagnosticPublicForm.findUnique({
      where: { tenantId_subBrand: { tenantId: tenant.id, subBrand } },
    });
    if (!form || !form.isPublished) {
      return res
        .status(404)
        .json({ error: "Public form not found", code: "FORM_NOT_FOUND" });
    }

    const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
      where: { tenantId: tenant.id, subBrand, isActive: true },
      orderBy: { version: "desc" },
    });
    if (!bank) {
      return res
        .status(404)
        .json({ error: "No active question bank", code: "BANK_NOT_FOUND" });
    }

    let questions;
    try {
      const parsed = JSON.parse(bank.questionsJson);
      questions = (parsed.questions || []).map((q) => ({
        id: q.id,
        text: q.text,
        type: q.type,
        options: (q.options || []).map((o) => ({ value: o.value, label: o.label })),
      }));
    } catch {
      return res
        .status(500)
        .json({ error: "Bank questions unparseable", code: "BANK_CORRUPTED" });
    }

    // Load brand kit if linked.
    let brandKit = null;
    if (form.brandKitId) {
      try {
        brandKit = await prisma.brandKit.findFirst({
          where: { id: form.brandKitId, tenantId: tenant.id },
          select: {
            id: true,
            logoUrl: true,
            logoDarkUrl: true,
            wordmarkUrl: true,
            heroUrl: true,
            headerImageUrl: true,
            faviconUrl: true,
            primaryColor: true,
            secondaryColor: true,
            accentColor: true,
            bgColor: true,
            textColor: true,
            fontFamily: true,
            headingFontFamily: true,
            bodyFontFamily: true,
            tagline: true,
            supportEmail: true,
            supportPhone: true,
          },
        });
      } catch (e) {
        console.warn("[diag-public-form] brandKit load failed:", e.message);
      }
    }

    res.json({
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      subBrand: bank.subBrand,
      bankId: bank.id,
      version: bank.version,
      questions,
      form: stripInternalFormFields(form),
      brandKit,
    });
  } catch (e) {
    if (e.status)
      return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[diag-public-form] get form error:", e.message);
    res.status(500).json({ error: "Failed to load public form" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Public: submit a published diagnostic form
// Body: { answers: { [qid]: value }, name, email, phone }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/diagnostics/public/form/:tenantSlug/:subBrand/submit",
  async (req, res) => {
    try {
      const tenantSlug = String(req.params.tenantSlug || "").trim();
      const subBrand = String(req.params.subBrand || "").trim();
      if (!tenantSlug || !subBrand) {
        return res.status(400).json({
          error: "tenantSlug and subBrand required",
          code: "MISSING_PARAMS",
        });
      }
      assertValidSubBrand(subBrand);

      const { answers, name, email, phone } = req.body || {};

      const tenant = await resolveTravelTenantBySlug(tenantSlug);
      if (!tenant) {
        return res
          .status(404)
          .json({ error: "Travel tenant not found", code: "TENANT_NOT_FOUND" });
      }

      const form = await prisma.travelDiagnosticPublicForm.findUnique({
        where: { tenantId_subBrand: { tenantId: tenant.id, subBrand } },
      });
      if (!form || !form.isPublished) {
        return res
          .status(404)
          .json({ error: "Public form not found", code: "FORM_NOT_FOUND" });
      }

      const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
        where: { tenantId: tenant.id, subBrand, isActive: true },
        orderBy: { version: "desc" },
      });
      if (!bank) {
        return res
          .status(404)
          .json({ error: "No active question bank", code: "BANK_NOT_FOUND" });
      }

      // Validate identity fields against form config.
      const cleanName = sanitizeText(String(name || "").trim());
      const cleanEmail = sanitizeText(String(email || "").trim());
      const cleanPhone = sanitizeText(String(phone || "").trim());
      if (form.includeName && form.nameRequired && !cleanName) {
        return res
          .status(400)
          .json({ error: "Name is required", code: "NAME_REQUIRED" });
      }
      if (form.includeEmail && form.emailRequired && !cleanEmail) {
        return res
          .status(400)
          .json({ error: "Email is required", code: "EMAIL_REQUIRED" });
      }
      if (form.includeEmail && form.emailRequired && !isValidEmail(cleanEmail)) {
        return res
          .status(400)
          .json({ error: "Email is invalid", code: "EMAIL_INVALID" });
      }
      if (form.includePhone && form.phoneRequired && !cleanPhone) {
        return res
          .status(400)
          .json({ error: "Phone is required", code: "PHONE_REQUIRED" });
      }

      const { bank: parsed, warnings: parseWarnings } = parseBank(
        bank.questionsJson,
        bank.scoringRulesJson,
      );
      if (!parsed) {
        return res.status(500).json({
          error: "Bank JSON unparseable",
          code: "BANK_CORRUPTED",
          warnings: parseWarnings,
        });
      }

      const safeAnswers = normalizeAnswers(answers, parsed.questions);

      const missingRequired = findUnansweredRequiredQuestion(parsed.questions, safeAnswers);
      if (missingRequired) {
        return res.status(400).json({
          error: `"${missingRequired.text}" is required.`,
          code: "REQUIRED_QUESTION_MISSING",
          questionId: missingRequired.id,
        });
      }

      const result = scoreDiagnostic(parsed, safeAnswers);
      let curriculumFit = null;
      // AI curriculum-to-itinerary matching (2026-08-24) — tried FIRST, but
      // it self-selects out (returns null) whenever the tenant hasn't
      // uploaded any curriculum PDFs yet for this sub-brand, so tenants who
      // still rely solely on the admin-curated TravelCurriculumMapping table
      // below see IDENTICAL behavior to before this feature existed.
      try {
        const profile = extractLearningProfile(safeAnswers, parsed.questions);
        curriculumFit = await curriculumRag.matchCurriculumForDiagnostic({
          tenantId: tenant.id,
          subBrand,
          profile,
        });
      } catch (e) {
        console.warn("[diag-public-form] AI curriculum matching failed (non-fatal):", e.message);
      }
      if (!curriculumFit) {
        try {
          curriculumFit = await buildCurriculumFitForDiagnostic({
            tenantId: tenant.id,
            subBrand,
            answers: safeAnswers,
            questions: parsed.questions,
          });
        } catch (e) {
          console.warn("[diag-public-form] curriculum mapping failed (non-fatal):", e.message);
        }
      }
      if (!curriculumFit && String(subBrand || "").toLowerCase() === "tmc") {
        try {
          curriculumFit = await buildPublicCurriculumFitFallback({
            tenantId: tenant.id,
            answers: safeAnswers,
            questions: parsed.questions,
          });
        } catch (e) {
          console.warn("[diag-public-form] curriculum fallback failed (non-fatal):", e.message);
        }
      }

      // Dedup or create contact.
      let contactId = null;
      try {
        const dedup = await findDuplicateContactFull({
          email: cleanEmail || null,
          phone: cleanPhone || null,
          tenantId: tenant.id,
        });
        if (dedup) {
          contactId = dedup.contact.id;
        }
      } catch (e) {
        console.warn("[diag-public-form] dedup failed:", e.message);
      }
      if (!contactId && (cleanName || cleanEmail || cleanPhone)) {
        try {
          const newContact = await prisma.contact.create({
            data: {
              tenantId: tenant.id,
              name: cleanName || "Anonymous lead",
              email:
                cleanEmail ||
                `public-diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@public.local`,
              phone: cleanPhone || null,
              subBrand,
              status: "Lead",
              source: `Public diagnostic form (${subBrand})`,
            },
          });
          contactId = newContact.id;
        } catch (e) {
          console.warn("[diag-public-form] contact create failed:", e.message);
        }
      }

      const snapshot = JSON.stringify({
        bankId: bank.id,
        bankVersion: bank.version,
        questionsJson: bank.questionsJson,
        scoringRulesJson: bank.scoringRulesJson,
        scoringWarnings: result.warnings,
      });

      const reportSlugToken = crypto.randomBytes(8).toString("hex");

      const diag = await prisma.travelDiagnostic.create({
        data: {
          tenantId: tenant.id,
          subBrand,
          contactId,
          questionBankId: bank.id,
          questionsJson: snapshot,
          answersJson: JSON.stringify(safeAnswers),
          score: result.score,
          classification: result.classification,
          classificationLabel: result.classificationLabel,
          recommendedTier: result.recommendedTier,
          curriculumFitJson: curriculumFit ? JSON.stringify(curriculumFit) : null,
          source: "public_form",
          reportSlugToken,
        },
      });

      // Notify whoever the admin configured in the Notifications tab (db /
      // email / WhatsApp, per person) — falls back to every ADMIN/MANAGER,
      // in-app only, when nothing's configured yet (see
      // diagnosticNotifications.js for the zero-config fallback).
      try {
        await diagnosticNotifications.notifyDiagnosticSubmitted({
          tenantId: tenant.id,
          subBrand,
          diagnosticId: diag.id,
          contactLabel: cleanName || cleanEmail || `Diagnostic #${diag.id}`,
          score: result.score,
          classificationLabel: result.classificationLabel,
          recommendedTier: result.recommendedTier,
        });
      } catch (notifyErr) {
        console.warn("[diag-public-form] notification failed (non-fatal):", notifyErr.message);
      }

      // RAG + PDF best-effort, never blocks submission.
      let ragResult = null;
      try {
        ragResult = await travelRag.runRagForDiagnostic({
          tenantId: tenant.id,
          diagnosticId: diag.id,
          subBrand,
          answers: safeAnswers,
          bank: parsed,
        });
      } catch (e) {
        console.warn("[diag-public-form] RAG failed (non-fatal):", e.message);
      }

      const cancellationPolicy = await resolveCancellationPolicyForForm({
        tenantId: tenant.id,
        subBrand,
      });

      const reportPdfUrl = await generateDiagnosticPdfBestEffort(diag, bank, {
        ragResult,
        cancellationPolicy,
      }).catch((e) => {
        console.warn("[diag-public-form] PDF failed (non-fatal):", e.message);
        return null;
      });

      const reportSlug = buildReportSlug(diag.id, reportSlugToken);
      res.status(201).json({
        diagnosticId: diag.id,
        reportSlug,
        tenantSlug: tenant.slug,
        subBrand,
        score: result.score,
        classification: result.classification,
        classificationLabel: result.classificationLabel,
        recommendedTier: result.recommendedTier,
        curriculumFit,
        cancellationPolicy,
        reportPdfUrl,
        message:
          cleanName
            ? `Thanks ${cleanName.split(" ")[0]}, your diagnostic has been submitted.`
            : "Thanks, your diagnostic has been submitted.",
      });
    } catch (e) {
      if (e.status)
        return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[diag-public-form] submit error:", e.message);
      res.status(500).json({ error: "Failed to submit diagnostic" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Public: fetch report payload for a diagnostic slug
// ─────────────────────────────────────────────────────────────────────────────
router.get("/diagnostics/public/report/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const parsed = parseReportSlug(slug);
    if (!parsed) {
      return res
        .status(400)
        .json({ error: "Invalid report slug", code: "INVALID_SLUG" });
    }

    const diag = await prisma.travelDiagnostic.findFirst({
      where: { id: parsed.diagnosticId },
    });
    // A diagnostic id alone must never be enough to read the report — the
    // slug's token has to match the one minted at submit time, otherwise
    // sequential ids would let anyone enumerate every submitter's report.
    if (!diag || !reportSlugTokenMatches(diag.reportSlugToken, parsed.token)) {
      return res
        .status(404)
        .json({ error: "Report not found", code: "NOT_FOUND" });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: diag.tenantId },
      select: { id: true, slug: true, name: true },
    });

    let answers = {};
    try {
      answers = JSON.parse(diag.answersJson || "{}");
    } catch {
      answers = {};
    }

    let ragResult = null;
    try {
      ragResult = await travelRag.getRagResultForDiagnostic(diag.id);
    } catch (e) {
      console.warn("[diag-public-report] RAG fetch failed:", e.message);
    }

    const contact = diag.contactId
      ? await prisma.contact.findUnique({
          where: { id: diag.contactId },
          select: { id: true, name: true, email: true, phone: true },
        })
      : null;

    // Resolve the customer-facing 1-4 readiness level for the report.
    let readinessLevel = null;
    let readinessName = null;
    const ragRecs = ragResult?.recommendations || {};
    if (Number.isFinite(ragRecs.readinessLevel) && ragRecs.readinessLevel >= 1 && ragRecs.readinessLevel <= 4) {
      readinessLevel = Math.round(ragRecs.readinessLevel);
      readinessName = ragRecs.readinessName || READINESS_LEVELS[readinessLevel] || null;
    } else if (diag.classification) {
      const derived = getReadinessLevel(diag.classification);
      if (derived) {
        readinessLevel = derived.level;
        readinessName = derived.name;
      }
    } else if (Number.isFinite(diag.score)) {
      const derived = readinessLevelFromScore(diag.score);
      if (derived) {
        readinessLevel = derived.level;
        readinessName = derived.name;
      }
    }

    const cancellationPolicy = await resolveCancellationPolicyForForm({
      tenantId: diag.tenantId,
      subBrand: diag.subBrand,
    });

    // Previously-submitted "chosen interests" (2026-08-27), if any — lets a
    // refreshed report page show the prior selection instead of a blank
    // checklist. Never throws (see diagnosticChosenInterests.js).
    const chosenInterests = await diagnosticChosenInterests.getChosenInterests({
      tenantId: diag.tenantId,
      diagnosticId: diag.id,
    });

    res.json({
      diagnosticId: diag.id,
      tenantSlug: tenant?.slug || null,
      tenantName: tenant?.name || null,
      subBrand: diag.subBrand,
      score: diag.score,
      classification: diag.classification,
      cancellationPolicy,
      classificationLabel: diag.classificationLabel,
      recommendedTier: diag.recommendedTier,
      readinessLevel,
      readinessName,
      reportPdfUrl: diag.reportPdfUrl,
      answers,
      contact,
      ragResult,
      curriculumFit: parseJsonOrNull(diag.curriculumFitJson),
      chosenInterests,
      createdAt: diag.createdAt,
    });
  } catch (e) {
    if (e.status)
      return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[diag-public-report] error:", e.message);
    res.status(500).json({ error: "Failed to load report" });
  }
});

// POST /api/travel/diagnostics/public/report/:slug/interests
//
// A school checks off which of its recommended trips it's actually
// interested in on the report page, then clicks "Submit chosen interests".
// Reuses the exact same slug + token auth as the GET report above (no new
// auth pattern) — the report slug itself is the credential. Resubmitting
// simply overwrites the prior selection (see diagnosticChosenInterests.js).
router.post("/diagnostics/public/report/:slug/interests", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const parsed = parseReportSlug(slug);
    if (!parsed) {
      return res
        .status(400)
        .json({ error: "Invalid report slug", code: "INVALID_SLUG" });
    }

    const diag = await prisma.travelDiagnostic.findFirst({
      where: { id: parsed.diagnosticId },
    });
    if (!diag || !reportSlugTokenMatches(diag.reportSlugToken, parsed.token)) {
      return res
        .status(404)
        .json({ error: "Report not found", code: "NOT_FOUND" });
    }

    const interests = Array.isArray(req.body?.interests) ? req.body.interests : [];
    const saved = await diagnosticChosenInterests.saveChosenInterests({
      tenantId: diag.tenantId,
      diagnosticId: diag.id,
      interests,
    });

    res.json({ ok: true, ...saved });
  } catch (e) {
    if (e.status)
      return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[diag-public-report] save interests error:", e.message);
    res.status(500).json({ error: "Failed to save chosen interests" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveTravelTenantBySlug(slug) {
  if (!slug) return null;
  return prisma.tenant.findFirst({
    where: { slug: String(slug), vertical: "travel", isActive: true },
    select: { id: true, slug: true, name: true },
  });
}

function buildFormPayload(data, bankId) {
  const payload = {
    bankId: bankId ?? null,
    brandKitId: numberOrNull(data.brandKitId),
    isActive: Boolean(data.isActive ?? true),
    title: sanitizeText(String(data.title || "").trim()) || null,
    subtitle: sanitizeText(String(data.subtitle || "").trim()) || null,
    headerHtml: sanitizeText(String(data.headerHtml || "").trim()) || null,
    footerHtml: sanitizeText(String(data.footerHtml || "").trim()) || null,
    thankYouMessage:
      sanitizeText(String(data.thankYouMessage || "").trim()) || null,
    primaryColor: hexOrNull(data.primaryColor),
    bgColor: hexOrNull(data.bgColor),
    textColor: hexOrNull(data.textColor),
    fontFamily: stringOrNull(data.fontFamily),
    logoUrl: stringOrNull(data.logoUrl),
    logoPlacement: VALID_LOGO_PLACEMENTS.has(String(data.logoPlacement || ""))
      ? String(data.logoPlacement)
      : "top-center",
    coverImageUrl: stringOrNull(data.coverImageUrl),
    stylingConfigJson:
      typeof data.stylingConfigJson === "string" &&
      data.stylingConfigJson.trim().length > 0
        ? data.stylingConfigJson
        : null,
    includeName: data.includeName !== false,
    includeEmail: data.includeEmail !== false,
    includePhone: data.includePhone !== false,
    nameRequired: data.nameRequired !== false,
    emailRequired: data.emailRequired !== false,
    phoneRequired: data.phoneRequired === true,
  };
  return payload;
}

function stripInternalFormFields(form) {
  const out = { ...form };
  // Internal fields are fine to leak (no keys), but keep the payload tidy.
  return out;
}

function parseJsonOrNull(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function buildPublicCurriculumFitFallback({ tenantId, answers, questions }) {
  const profile = extractPublicLearningProfile(answers, questions);
  if (!profile.curriculum || !profile.grade) return null;
  const where = {
    tenantId,
    isActive: true,
    curriculum: profile.curriculum,
    grade: profile.grade,
  };
  if (profile.subject) where.subject = profile.subject;
  const rows = await prisma.travelCurriculumMapping.findMany({
    where,
    orderBy: { fitScore: "desc" },
    take: 100,
  });
  if (!rows.length) return { ...profile, recommendations: [] };
  const byDestination = new Map();
  for (const row of rows) {
    const destination =
      row.destinationLabel ||
      (row.destinationId != null ? `Trip #${row.destinationId}` : "Unspecified destination");
    if (!byDestination.has(destination)) {
      byDestination.set(destination, {
        destination,
        scores: [],
        reasons: [],
        mappingIds: [],
        brochurePdfUrls: [],
      });
    }
    const bucket = byDestination.get(destination);
    if (typeof row.fitScore === "number") bucket.scores.push(row.fitScore);
    bucket.mappingIds.push(row.id);
    if (row.brochurePdfUrl) bucket.brochurePdfUrls.push(row.brochurePdfUrl);
    bucket.reasons.push({
      subject: row.subject || null,
      learningOutcome: row.learningOutcome || null,
      rationale: row.fitRationale || null,
    });
  }
  return {
    ...profile,
    recommendations: [...byDestination.values()]
      .map((bucket) => ({
        destination: bucket.destination,
        fitScore: bucket.scores.length
          ? Math.round(bucket.scores.reduce((sum, score) => sum + score, 0) / bucket.scores.length)
          : null,
        mappingIds: bucket.mappingIds.slice(0, 10),
        brochurePdfUrl: bucket.brochurePdfUrls[0] || null,
        reasons: bucket.reasons.slice(0, 4),
      }))
      .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
      .slice(0, 10),
  };
}

function extractPublicLearningProfile(answers, questions) {
  const profile = { curriculum: null, grade: null, subject: null };
  for (const question of questions || []) {
    const answer = resolvePublicAnswerLabel(question, answers?.[question.id]);
    if (!answer) continue;
    const text = `${question.id || ""} ${question.text || ""} ${question.label || ""}`.toLowerCase();
    if (!profile.curriculum && /\b(curriculum|board)\b/.test(text)) profile.curriculum = answer;
    if (!profile.grade && /\b(grade|class|standard|year group)\b/.test(text)) profile.grade = answer;
    if (!profile.subject && /\b(subject|discipline)\b/.test(text)) profile.subject = answer;
  }
  return {
    curriculum: trimProfileValue(profile.curriculum),
    grade: trimProfileValue(profile.grade),
    subject: trimProfileValue(profile.subject),
  };
}

function resolvePublicAnswerLabel(question, value) {
  if (value == null) return "";
  const values = Array.isArray(value) ? value : [value];
  const options = Array.isArray(question?.options) ? question.options : [];
  return values
    .map((item) => {
      const raw = String(item || "").trim();
      const option = options.find((candidate) => String(candidate.value || "").trim() === raw);
      return String(option?.label || raw).trim();
    })
    .filter(Boolean)
    .join(", ");
}

function trimProfileValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.length > 120 ? raw.slice(0, 120) : raw;
}

// Server-side mirror of the client-side required-question check in
// TravelDiagnosticPublicForm.jsx — the client blocks submission first, but
// this is the actual enforcement point since the public submit endpoint can
// be called directly. Returns the first unanswered required question, or
// null when all required questions are answered.
function findUnansweredRequiredQuestion(questions, safeAnswers) {
  for (const q of questions || []) {
    if (!q?.required) continue;
    const v = safeAnswers[q.id];
    const empty = v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "string" && v.trim() === "");
    if (empty) return q;
  }
  return null;
}

function normalizeAnswers(raw, questions) {
  const answers = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const q of questions || []) {
    const v = answers[q.id];
    if (v == null) continue;
    if (q.type === "multi-select") {
      out[q.id] = Array.isArray(v)
        ? v.filter((x) => typeof x === "string")
        : [String(v)];
    } else {
      out[q.id] = String(v);
    }
  }
  return out;
}

function buildReportSlug(diagnosticId, token) {
  return `${diagnosticId}-${token}`;
}

// Report slugs are `<id>-<16-hex-char token>`. Both halves are required —
// the id alone is guessable/enumerable, so the token half must be present
// and match the value stored on the row (see reportSlugTokenMatches).
function parseReportSlug(slug) {
  if (typeof slug !== "string") return null;
  const m = slug.match(/^(\d+)-([0-9a-f]{16})$/i);
  if (!m) return null;
  const diagnosticId = parseInt(m[1], 10);
  if (!Number.isFinite(diagnosticId)) return null;
  return { diagnosticId, token: m[2].toLowerCase() };
}

function reportSlugTokenMatches(storedToken, suppliedToken) {
  if (!storedToken || !suppliedToken) return false;
  const stored = Buffer.from(String(storedToken).toLowerCase(), "utf8");
  const supplied = Buffer.from(String(suppliedToken).toLowerCase(), "utf8");
  if (stored.length !== supplied.length) return false;
  return crypto.timingSafeEqual(stored, supplied);
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function numberOrNull(v) {
  const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stringOrNull(v) {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function hexOrNull(v) {
  const s = String(v || "").trim();
  return /^#([0-9A-Fa-f]{3}){1,2}$/.test(s) ? s : null;
}

module.exports = router;
