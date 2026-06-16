// @ts-check
/**
 * Travel CRM — Quote Template Library CRUD + apply-to-quote.
 *
 * S31 slice (docs/TRAVEL_BIG_SCOPE_BACKLOG.md) — PRD_TRAVEL_QUOTE_BUILDER
 * §3.5 "Templates". Templates = saved pre-filled TravelQuoteLine shapes
 * that operators clone into a new quote at build-time (Umrah-7d /
 * Golden-Triangle-5d / Schengen-visa-checklist / etc.). Saves operator
 * typing on common itineraries.
 *
 * Mounted at /api/travel/quote-templates in server.js (follow-up wiring —
 * server.js is reserved for a separate slice per the S31 dispatch scope).
 *
 * Six endpoints:
 *   GET    /                list, paginated (limit clamped to [1, 200]),
 *                           tenant-scoped + sub-brand narrowing +
 *                           filter by ?category / ?subBrand / ?isActive
 *   POST   /                create (ADMIN+MANAGER) — name required;
 *                           linesJson must be a JSON array; currency
 *                           validated as 3-letter ISO when supplied
 *   GET    /:id             fetch one, tenant-scoped + sub-brand gate
 *   PATCH  /:id             update (ADMIN+MANAGER), tenant-scoped +
 *                           sub-brand gate, linesJson + currency
 *                           revalidated when supplied
 *   DELETE /:id             soft-delete via isActive=false (ADMIN only)
 *   POST   /:id/apply       apply template to a quote (ADMIN+MANAGER) —
 *                           copies template's lines into TravelQuoteLine
 *                           rows on { quoteId }. Idempotency strategy:
 *                           if the target quote already has lines,
 *                           return 409 ALREADY_HAS_LINES with the
 *                           existing line count. Operator must clear
 *                           existing lines explicitly before re-apply.
 *
 * Sub-brand semantics mirror travel_itinerary_templates.js — admins get
 * unrestricted access; non-admins with a non-empty subBrandAccess[] are
 * narrowed to that set. Rows with subBrand=null are tenant-wide and
 * visible to everyone in the tenant.
 *
 * Apply-to-quote idempotency: chose the 409-on-existing-lines pattern
 * over a sourceTemplateId link because (a) TravelQuoteLine doesn't
 * carry a sourceTemplateId column (would require schema change beyond
 * S31's allowed-files scope), (b) the operator UX intent is "this
 * builds the line set from scratch" — silent re-apply that duplicates
 * lines is a bigger footgun than the explicit conflict.
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require("../middleware/travelGuards");

// Whitelist of fields a caller may set on POST / PATCH. tenantId / id /
// createdAt / updatedAt are intentionally absent (stripDangerous middleware
// strips id/tenantId/userId/createdAt/updatedAt from req.body globally —
// belt + suspenders here).
const MUTABLE_FIELDS = [
  "name",
  "description",
  "subBrand",
  "category",
  "currency",
  "linesJson",
  "isActive",
];

const VALID_LINE_TYPES = [
  "hotel",
  "flight",
  "transport",
  "visa",
  "service",
  "other",
];

function pickMutable(body) {
  const out = {};
  for (const f of MUTABLE_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

function validateCurrency(currency) {
  if (currency == null) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    const err = new Error("currency must be a 3-letter ISO code (uppercase)");
    err.status = 400;
    err.code = "INVALID_CURRENCY";
    throw err;
  }
  return currency;
}

// linesJson must be a JSON-stringified array. Each element must be an
// object with at minimum a description; optional fields default at
// apply-time. Returns the (possibly re-stringified) JSON string for write,
// or throws err.status=400 on invalid shape.
function validateLinesJson(linesJson) {
  if (linesJson == null) return null;
  let parsed;
  if (typeof linesJson === "string") {
    try {
      parsed = JSON.parse(linesJson);
    } catch (_e) {
      const err = new Error("linesJson must be a valid JSON string");
      err.status = 400;
      err.code = "INVALID_LINES_JSON";
      throw err;
    }
  } else if (Array.isArray(linesJson)) {
    parsed = linesJson;
  } else {
    const err = new Error("linesJson must be a JSON array string or array");
    err.status = 400;
    err.code = "INVALID_LINES_JSON";
    throw err;
  }
  if (!Array.isArray(parsed)) {
    const err = new Error("linesJson must encode a JSON array");
    err.status = 400;
    err.code = "INVALID_LINES_JSON";
    throw err;
  }
  // Per-item shape: object with description; lineType (if present) must be
  // in the allowed set. Other fields aren't strictly required (we apply
  // sensible defaults at apply-time) but if supplied must be the right
  // primitive type.
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      const err = new Error(`linesJson[${i}] must be an object`);
      err.status = 400;
      err.code = "INVALID_LINES_JSON";
      throw err;
    }
    if (!item.description || typeof item.description !== "string") {
      const err = new Error(`linesJson[${i}].description is required`);
      err.status = 400;
      err.code = "INVALID_LINES_JSON";
      throw err;
    }
    if (item.lineType !== undefined && !VALID_LINE_TYPES.includes(item.lineType)) {
      const err = new Error(
        `linesJson[${i}].lineType must be one of: ${VALID_LINE_TYPES.join(", ")}`,
      );
      err.status = 400;
      err.code = "INVALID_LINES_JSON";
      throw err;
    }
  }
  return JSON.stringify(parsed);
}

// GET /api/travel/quote-templates — list
router.get("/", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };

    if (req.query.category) {
      where.category = String(req.query.category);
    }
    if (req.query.isActive !== undefined) {
      where.isActive = String(req.query.isActive) === "true";
    }

    // Clamp pagination: limit ∈ [1, 200]; offset ≥ 0.
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(
      Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1),
      200,
    );
    const offsetRaw = parseInt(req.query.offset, 10);
    const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

    // Sub-brand narrowing. TravelQuoteTemplate.subBrand is NULLABLE —
    // tenant-wide rows (subBrand=null) are visible to everyone; named-
    // subBrand rows are intersected with the caller's allowed set.
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({ items: [], total: 0, limit, offset });
    }
    if (allowed instanceof Set) {
      if (req.query.subBrand) {
        if (!canAccessSubBrand(allowed, String(req.query.subBrand))) {
          return res.status(403).json({
            error: "Forbidden sub-brand",
            code: "FORBIDDEN_SUB_BRAND",
          });
        }
        where.subBrand = String(req.query.subBrand);
      } else {
        where.OR = [
          { subBrand: null },
          { subBrand: { in: [...allowed] } },
        ];
      }
    } else if (req.query.subBrand) {
      where.subBrand = String(req.query.subBrand);
    }

    const [items, total] = await Promise.all([
      prisma.travelQuoteTemplate.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.travelQuoteTemplate.count({ where }),
    ]);
    res.json({ items, total, limit, offset });
  } catch (err) {
    console.error("[travel/quote-templates] List error:", err.message);
    res.status(500).json({
      error: "Failed to fetch quote template list",
      code: "QUOTE_TEMPLATE_LIST_FAILED",
    });
  }
});

// POST /api/travel/quote-templates — create (ADMIN + MANAGER)
router.post(
  "/",
  verifyToken,
  requirePermission("quote_templates", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const body = pickMutable(req.body || {});

      if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
        return res.status(400).json({
          error: "name is required",
          code: "MISSING_NAME",
        });
      }
      if (body.linesJson === undefined || body.linesJson === null) {
        return res.status(400).json({
          error: "linesJson is required",
          code: "MISSING_LINES_JSON",
        });
      }
      const linesJsonStr = validateLinesJson(body.linesJson);
      validateCurrency(body.currency);

      // Sub-brand gate: when subBrand is supplied, caller must have
      // access. Tenant-wide (subBrand=null/undefined) is always allowed.
      if (body.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, body.subBrand)) {
          return res.status(403).json({
            error: "Forbidden sub-brand",
            code: "FORBIDDEN_SUB_BRAND",
          });
        }
      }

      const created = await prisma.travelQuoteTemplate.create({
        data: {
          tenantId: req.travelTenant.id,
          name: body.name.trim(),
          description: body.description ?? null,
          subBrand: body.subBrand ?? null,
          category: body.category ?? null,
          currency: body.currency ?? "INR",
          linesJson: linesJsonStr,
          isActive: body.isActive === false ? false : true,
        },
      });
      res.status(201).json(created);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error("[travel/quote-templates] Create error:", err.message);
      res.status(500).json({
        error: "Failed to create quote template",
        code: "QUOTE_TEMPLATE_CREATE_FAILED",
      });
    }
  },
);

// GET /api/travel/quote-templates/:id
router.get("/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
    }
    const item = await prisma.travelQuoteTemplate.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!item) {
      return res.status(404).json({
        error: "Quote template not found",
        code: "QUOTE_TEMPLATE_NOT_FOUND",
      });
    }
    if (item.subBrand) {
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, item.subBrand)) {
        return res.status(403).json({
          error: "Forbidden sub-brand",
          code: "FORBIDDEN_SUB_BRAND",
        });
      }
    }
    res.json(item);
  } catch (err) {
    console.error("[travel/quote-templates] Get error:", err.message);
    res.status(500).json({
      error: "Failed to fetch quote template",
      code: "QUOTE_TEMPLATE_GET_FAILED",
    });
  }
});

// PATCH /api/travel/quote-templates/:id (ADMIN + MANAGER)
router.patch(
  "/:id",
  verifyToken,
  requirePermission("quote_templates", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
      }

      const existing = await prisma.travelQuoteTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Quote template not found",
          code: "QUOTE_TEMPLATE_NOT_FOUND",
        });
      }

      // Sub-brand gate against EXISTING row's subBrand.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (existing.subBrand && !canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({
          error: "Forbidden sub-brand",
          code: "FORBIDDEN_SUB_BRAND",
        });
      }

      const body = pickMutable(req.body || {});
      if (Object.keys(body).length === 0) {
        return res.status(400).json({
          error: "No updatable fields provided",
          code: "EMPTY_BODY",
        });
      }

      if (body.currency !== undefined) validateCurrency(body.currency);
      let linesJsonStr;
      if (body.linesJson !== undefined && body.linesJson !== null) {
        linesJsonStr = validateLinesJson(body.linesJson);
      }

      // If caller is moving this row to a different sub-brand, re-gate
      // against the new value.
      if (body.subBrand !== undefined && body.subBrand !== existing.subBrand) {
        if (body.subBrand && !canAccessSubBrand(allowed, body.subBrand)) {
          return res.status(403).json({
            error: "Forbidden sub-brand",
            code: "FORBIDDEN_SUB_BRAND",
          });
        }
      }

      const data = { ...body };
      if (linesJsonStr !== undefined) data.linesJson = linesJsonStr;
      if (data.name !== undefined && typeof data.name === "string") {
        data.name = data.name.trim();
      }

      const updated = await prisma.travelQuoteTemplate.update({
        where: { id },
        data,
      });
      res.json(updated);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error("[travel/quote-templates] Patch error:", err.message);
      res.status(500).json({
        error: "Failed to update quote template",
        code: "QUOTE_TEMPLATE_PATCH_FAILED",
      });
    }
  },
);

// DELETE /api/travel/quote-templates/:id (ADMIN only) — soft delete.
router.delete(
  "/:id",
  verifyToken,
  requirePermission("quote_templates", "delete"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
      }

      const existing = await prisma.travelQuoteTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Quote template not found",
          code: "QUOTE_TEMPLATE_NOT_FOUND",
        });
      }
      if (existing.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, existing.subBrand)) {
          return res.status(403).json({
            error: "Forbidden sub-brand",
            code: "FORBIDDEN_SUB_BRAND",
          });
        }
      }

      const updated = await prisma.travelQuoteTemplate.update({
        where: { id },
        data: { isActive: false },
      });
      res.json(updated);
    } catch (err) {
      console.error("[travel/quote-templates] Delete error:", err.message);
      res.status(500).json({
        error: "Failed to delete quote template",
        code: "QUOTE_TEMPLATE_DELETE_FAILED",
      });
    }
  },
);

// POST /api/travel/quote-templates/:id/apply — clone template lines into
// a target TravelQuote. ADMIN + MANAGER only.
//
// Body: { quoteId: <int> }
//
// Idempotency: 409 ALREADY_HAS_LINES if the target quote already has any
// TravelQuoteLine rows. Operator must clear existing lines explicitly
// before re-applying. Chose this over a sourceTemplateId link because
// TravelQuoteLine doesn't carry a sourceTemplateId column (would
// require a schema change beyond the S31 dispatch scope) and the
// operator UX intent is "this builds the line set from scratch".
//
// Permission model: caller must be able to access BOTH the template's
// sub-brand AND the target quote's sub-brand. Template lines are NOT
// recomputed for pricing — they are cloned verbatim from the template
// snapshot. Quote total is recomputed once after the bulk insert.
router.post(
  "/:id/apply",
  verifyToken,
  requirePermission("quotes", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const templateId = parseInt(req.params.id, 10);
      if (!Number.isInteger(templateId) || templateId < 1) {
        return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
      }
      const quoteIdRaw = req.body && req.body.quoteId;
      const quoteId = parseInt(quoteIdRaw, 10);
      if (!Number.isInteger(quoteId) || quoteId < 1) {
        return res.status(400).json({
          error: "quoteId is required (must be a positive integer)",
          code: "INVALID_QUOTE_ID",
        });
      }

      const tenantId = req.travelTenant.id;
      const template = await prisma.travelQuoteTemplate.findFirst({
        where: { id: templateId, tenantId },
      });
      if (!template) {
        return res.status(404).json({
          error: "Quote template not found",
          code: "QUOTE_TEMPLATE_NOT_FOUND",
        });
      }
      if (!template.isActive) {
        return res.status(400).json({
          error: "Quote template is inactive",
          code: "TEMPLATE_INACTIVE",
        });
      }

      const quote = await prisma.travelQuote.findFirst({
        where: { id: quoteId, tenantId },
      });
      if (!quote) {
        return res.status(404).json({
          error: "Target quote not found",
          code: "QUOTE_NOT_FOUND",
        });
      }

      // Sub-brand gates: both template (if scoped) and target quote.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (template.subBrand && !canAccessSubBrand(allowed, template.subBrand)) {
        return res.status(403).json({
          error: "Forbidden sub-brand (template)",
          code: "FORBIDDEN_SUB_BRAND",
        });
      }
      if (!canAccessSubBrand(allowed, quote.subBrand)) {
        return res.status(403).json({
          error: "Forbidden sub-brand (quote)",
          code: "FORBIDDEN_SUB_BRAND",
        });
      }

      // Idempotency: 409 if quote already has lines.
      const existingLineCount = await prisma.travelQuoteLine.count({
        where: { quoteId, tenantId },
      });
      if (existingLineCount > 0) {
        return res.status(409).json({
          error: "Target quote already has lines",
          code: "ALREADY_HAS_LINES",
          existingLineCount,
        });
      }

      // Parse template.linesJson. We already validated this on write, so
      // a parse failure here is data-integrity corruption — surface as
      // 500 not 400.
      let templateLines;
      try {
        templateLines = JSON.parse(template.linesJson);
      } catch (_e) {
        console.error(
          "[travel/quote-templates] Apply: linesJson parse failure id=",
          templateId,
        );
        return res.status(500).json({
          error: "Template linesJson is corrupt",
          code: "TEMPLATE_LINES_CORRUPT",
        });
      }
      if (!Array.isArray(templateLines) || templateLines.length === 0) {
        return res.status(400).json({
          error: "Template has no lines to apply",
          code: "TEMPLATE_EMPTY",
        });
      }

      // Build the bulk createMany payload. Defaults mirror the
      // travel_quotes.js /lines POST handler:
      //   - lineType defaults to "other"
      //   - quantity defaults to 1
      //   - unitPrice defaults to 0 (template may be price-less per PRD
      //     §3.5.1 — engine re-resolves at quote-build time)
      //   - amount = quantity * unitPrice
      //   - currency falls back to template.currency, then quote.currency
      const fallbackCurrency = template.currency || quote.currency || "INR";
      const createRows = templateLines.map((item, idx) => {
        const lineType = item.lineType && VALID_LINE_TYPES.includes(item.lineType)
          ? item.lineType
          : "other";
        const qty = Number.isFinite(parseInt(item.quantity, 10))
          ? Math.max(parseInt(item.quantity, 10), 1)
          : 1;
        const unit = Number.isFinite(Number(item.unitPrice))
          ? Math.max(Number(item.unitPrice), 0)
          : 0;
        const amount = qty * unit;
        const supplierId =
          item.supplierId != null && Number.isFinite(parseInt(item.supplierId, 10))
            ? parseInt(item.supplierId, 10)
            : null;
        const sortOrder = Number.isFinite(parseInt(item.sortOrder, 10))
          ? parseInt(item.sortOrder, 10)
          : idx;
        return {
          tenantId,
          quoteId,
          lineType,
          description: String(item.description),
          quantity: qty,
          unitPrice: unit,
          amount,
          currency: item.currency ? String(item.currency) : fallbackCurrency,
          supplierId,
          sortOrder,
          notes: item.notes ? String(item.notes) : null,
        };
      });

      await prisma.travelQuoteLine.createMany({ data: createRows });

      // Recompute the quote total. Mirrors recomputeQuoteTotal() in
      // travel_quotes.js (inlined here to avoid coupling on its module).
      const insertedLines = await prisma.travelQuoteLine.findMany({
        where: { quoteId, tenantId },
        select: { amount: true },
      });
      const total = insertedLines.reduce(
        (acc, l) => acc + Number(l.amount || 0),
        0,
      );
      await prisma.travelQuote.update({
        where: { id: quoteId },
        data: { totalAmount: total },
      });

      res.status(201).json({
        applied: createRows.length,
        templateId,
        quoteId,
        totalAmount: total,
      });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error("[travel/quote-templates] Apply error:", err.message);
      res.status(500).json({
        error: "Failed to apply quote template",
        code: "QUOTE_TEMPLATE_APPLY_FAILED",
      });
    }
  },
);

module.exports = router;
