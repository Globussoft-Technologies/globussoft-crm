// Public diagnostic-page payload resolver.
//
// Mirrors the landing-pages public JSON surface, but resolves the already
// published TravelDiagnosticPublicForm + active question bank. The standalone
// embed HTML can use this endpoint to discover the CRM-hosted public form URL
// for a sub-brand without duplicating the submit/scoring/RAG/PDF pipeline.

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { assertValidSubBrand } = require("../middleware/travelGuards");

// Both routes below are called directly (via fetch, not just iframed) from
// the standalone embed HTML sitting on a tenant's own external domain —
// see frontend/public/embed/diagnostic-page.html. The app's global CORS
// allowlist (server.js ALLOWED_ORIGINS) is a fixed list that would need a
// backend redeploy for every new client site, which defeats the point of a
// self-service embed. These two GET endpoints only ever return data that's
// already public by design — the same published form config + question
// text any anonymous visitor sees on the live form — so opening CORS wide
// for just this router carries no confidentiality risk. (Actually framing
// the form is a separate, tenant-scoped concern — see the
// /diagnostic-form/:tenantSlug CSP override in server.js.)
router.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
});

router.get("/public/featured-full", async (req, res) => {
  try {
    const subBrand = String(req.query.subBrand || "").trim();
    if (!subBrand) {
      return res.status(400).json({
        error: "subBrand is required",
        code: "MISSING_SUB_BRAND",
      });
    }
    assertValidSubBrand(subBrand);

    const tenantScope = await resolveTenantScope(req);
    if (tenantScope.error) return res.status(tenantScope.status).json(tenantScope.error);

    const form = await prisma.travelDiagnosticPublicForm.findFirst({
      where: {
        subBrand,
        isPublished: true,
        ...(tenantScope.where || {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      include: {
        tenant: { select: { id: true, slug: true, name: true, vertical: true, isActive: true } },
      },
    });

    if (!form || form.tenant?.vertical !== "travel" || form.tenant?.isActive === false) {
      return res.status(404).json({
        error: "No published diagnostic page is currently configured.",
        code: "NO_DIAGNOSTIC_PAGE_PUBLISHED",
      });
    }

    const payload = await buildDiagnosticPagePayload(form);
    return res.json(payload);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error("[DiagnosticPages] public/featured-full error:", err);
    return res.status(500).json({
      error: "Failed to resolve diagnostic page",
      code: "DIAGNOSTIC_PAGE_RESOLVE_FAILED",
    });
  }
});

router.get("/public/by-id/:id", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: "Diagnostic page id must be a positive integer",
        code: "INVALID_PAGE_ID",
      });
    }

    const form = await prisma.travelDiagnosticPublicForm.findFirst({
      where: { id, isPublished: true },
      include: {
        tenant: { select: { id: true, slug: true, name: true, vertical: true, isActive: true } },
      },
    });

    if (!form || form.tenant?.vertical !== "travel" || form.tenant?.isActive === false) {
      return res.status(404).json({
        error: "No diagnostic page is published",
        code: "NO_DIAGNOSTIC_PAGE_PUBLISHED",
      });
    }

    const payload = await buildDiagnosticPagePayload(form);
    return res.json(payload);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error("[DiagnosticPages] public/by-id error:", err);
    return res.status(500).json({
      error: "Failed to load diagnostic page payload",
      code: "DIAGNOSTIC_PAGE_LOAD_FAILED",
    });
  }
});

async function resolveTenantScope(req) {
  const rawCustomerId =
    typeof req.query.customerId === "string" && req.query.customerId.length > 0
      ? req.query.customerId
      : undefined;
  if (rawCustomerId) {
    const customerId = Number.parseInt(rawCustomerId, 10);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return {
        status: 400,
        error: {
          error: "customerId must be a positive integer",
          code: "INVALID_CUSTOMER_ID",
        },
      };
    }
    return { where: { tenantId: customerId } };
  }

  const tenantSlug =
    typeof req.query.tenantSlug === "string" && req.query.tenantSlug.trim()
      ? req.query.tenantSlug.trim()
      : null;
  if (!tenantSlug) return { where: { tenant: { vertical: "travel", isActive: true } } };

  const tenant = await prisma.tenant.findFirst({
    where: { slug: tenantSlug, vertical: "travel", isActive: true },
    select: { id: true },
  });
  if (!tenant) {
    return {
      status: 404,
      error: { error: "Travel tenant not found", code: "TENANT_NOT_FOUND" },
    };
  }
  return { where: { tenantId: tenant.id } };
}

async function buildDiagnosticPagePayload(form) {
  const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
    where: { tenantId: form.tenantId, subBrand: form.subBrand, isActive: true },
    orderBy: { version: "desc" },
  });
  if (!bank) {
    const err = new Error("No active question bank");
    err.status = 404;
    err.code = "BANK_NOT_FOUND";
    throw err;
  }

  const questions = parseQuestions(bank.questionsJson);
  const styling = parseStyling(form.stylingConfigJson);
  const brandKit = await loadBrandKit(form);
  const tenantSlug = form.tenant?.slug || "";
  const subBrand = form.subBrand;
  const publicUrl = `/diagnostic-form/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(subBrand)}`;
  const submitUrl = `/api/travel/diagnostics/public/form/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(subBrand)}/submit`;

  return {
    id: form.id,
    tenantId: form.tenantId,
    tenantSlug,
    tenantName: form.tenant?.name || null,
    subBrand,
    bankId: bank.id,
    version: bank.version,
    status: "PUBLISHED",
    title: form.title || null,
    publicUrl,
    submitUrl,
    form: stripForm(form, styling),
    brandKit,
    questions,
  };
}

function parseQuestions(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return (parsed?.questions || []).map((q) => ({
      id: q.id,
      text: q.text,
      type: q.type,
      options: (q.options || []).map((o) => ({ value: o.value, label: o.label })),
    }));
  } catch {
    const err = new Error("Published diagnostic page questions are not valid JSON");
    err.status = 500;
    err.code = "BANK_CORRUPTED";
    throw err;
  }
}

function parseStyling(raw) {
  if (!raw) return {};
  try {
    return typeof raw === "string" ? JSON.parse(raw) || {} : raw || {};
  } catch {
    const err = new Error("Published diagnostic page styling is not valid JSON");
    err.status = 500;
    err.code = "DIAGNOSTIC_PAGE_MALFORMED";
    throw err;
  }
}

async function loadBrandKit(form) {
  if (!form.brandKitId) return null;
  try {
    return await prisma.brandKit.findFirst({
      where: { id: form.brandKitId, tenantId: form.tenantId },
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
  } catch (err) {
    console.warn("[DiagnosticPages] brandKit load failed:", err.message);
    return null;
  }
}

function stripForm(form, styling) {
  return {
    id: form.id,
    subBrand: form.subBrand,
    brandKitId: form.brandKitId || null,
    title: form.title || null,
    subtitle: form.subtitle || null,
    headerHtml: form.headerHtml || null,
    footerHtml: form.footerHtml || null,
    thankYouMessage: form.thankYouMessage || null,
    primaryColor: form.primaryColor || null,
    bgColor: form.bgColor || null,
    textColor: form.textColor || null,
    fontFamily: form.fontFamily || null,
    logoUrl: form.logoUrl || null,
    logoPlacement: form.logoPlacement || "top-center",
    coverImageUrl: form.coverImageUrl || null,
    styling,
    includeName: form.includeName !== false,
    includeEmail: form.includeEmail !== false,
    includePhone: form.includePhone !== false,
    nameRequired: form.nameRequired !== false,
    emailRequired: form.emailRequired !== false,
    phoneRequired: form.phoneRequired === true,
    isPublished: true,
    updatedAt: form.updatedAt || null,
  };
}

module.exports = router;
