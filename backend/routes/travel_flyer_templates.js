/**
 * /api/travel/flyer-templates — TravelFlyerTemplate CRUD
 * (PRD_TRAVEL_MARKETING_FLYER #908 slice 3).
 *
 * Sibling to /api/travel/commission-profiles + /api/travel/quotes. Stores
 * operator-composed flyer templates (palette + layout blocks + optional
 * asset URLs) consumed by lib/flyerTemplateValidator.js (slice 1 commit
 * 28146498). Replaces the frontend STUB in FlyerTemplates.jsx (slice 2
 * commit a64c1058) — the page hits these endpoints once server.js mount
 * lands in a subsequent wire-in slice.
 *
 * The validator returns { ok, errors[] } envelopes; this route surfaces
 * any errors as 400 INVALID_TEMPLATE with the errors array attached so
 * the editor UI can highlight the offending fields. JSON-parse failure
 * (palette / layout / assets columns are @db.Text storing JSON) is a
 * separate 400 INVALID_PALETTE_JSON / INVALID_LAYOUT_JSON / INVALID_ASSETS_JSON
 * so the editor can distinguish "your JSON didn't parse" from "your shape
 * doesn't validate."
 *
 * Endpoints:
 *   GET    /api/travel/flyer-templates                — list (tenant + sub-brand scoped)
 *   GET    /api/travel/flyer-templates/sub-brands     — USER+ per-sub-brand counts (slice 13)
 *   POST   /api/travel/flyer-templates/bulk-archive   — ADMIN/MANAGER batch archive (slice 15)
 *   POST   /api/travel/flyer-templates/bulk-unarchive — ADMIN/MANAGER batch restore (slice 16)
 *   GET    /api/travel/flyer-templates/:id            — fetch one
 *   POST   /api/travel/flyer-templates                — ADMIN/MANAGER create
 *   POST   /api/travel/flyer-templates/:id/duplicate  — ADMIN/MANAGER clone (slice 6)
 *   POST   /api/travel/flyer-templates/:id/archive    — ADMIN/MANAGER soft-archive (slice 14)
 *   POST   /api/travel/flyer-templates/:id/unarchive  — ADMIN/MANAGER restore (slice 14)
 *   POST   /api/travel/flyer-templates/:id/export     — ADMIN/MANAGER queue render (slice 10)
 *   GET    /api/travel/flyer-templates/:id/preview.pdf — USER+ inline PDF preview (slice 12)
 *   GET    /api/travel/flyer-templates/:id/usage-stats — USER+ per-template AuditLog rollup (slice 17)
 *   PUT    /api/travel/flyer-templates/:id            — ADMIN/MANAGER partial update
 *   DELETE /api/travel/flyer-templates/:id            — ADMIN-only hard delete
 *
 * Validation strictness (slice 3):
 *   - name required, non-empty trim                     → 400 MISSING_FIELDS
 *   - paletteJson + layoutJson required on POST         → 400 MISSING_FIELDS
 *   - paletteJson / layoutJson / assetsJson must JSON.parse
 *                                                       → 400 INVALID_PALETTE_JSON
 *                                                          INVALID_LAYOUT_JSON
 *                                                          INVALID_ASSETS_JSON
 *   - Parsed { palette, layout, assets } must pass
 *     flyerTemplateValidator.validateTemplate           → 400 INVALID_TEMPLATE
 *     (response includes the errors array verbatim so the editor UI can
 *      annotate the offending fields).
 *   - subBrand (if provided) must match assertValidSubBrand
 *                                                       → 400 INVALID_SUB_BRAND
 *
 * PUT re-validates iff palette/layout/assets is part of the diff. A name-
 * only or notes-only update does NOT re-run flyerTemplateValidator (the
 * stored shape is unchanged). This matches the editor's UX: renaming a
 * template shouldn't fail because the saved layout no longer passes a
 * tightened validator — that's a separate migration concern.
 *
 * Response envelope (slice 9): every row returned by list/get/create/
 * update/duplicate carries a virtual `templateHash` field — the
 * deterministic SHA-256 of the JSON-canonicalized { palette, layout,
 * assets } shape (lib/flyerExport.js, slice 8 commit 2390069b). The
 * field is computed on read, NOT stored on disk — Prisma schema is
 * unchanged. Two reasons it's read-time only:
 *   (1) Hash is a derivative of the stored columns; persisting it means
 *       keeping it in sync on every write, and an out-of-sync stale hash
 *       is worse than the recompute cost.
 *   (2) The hash function lives in flyerExport.js next to the cache-key
 *       builder; future changes to either side land as a single helper
 *       edit + a route response that just re-reads.
 * The frontend uses `templateHash` as a client-side cache-key for
 * preview thumbnails + the future MarketingFlyer.outputUrls cache lookup
 * (FR-3.4.5, AC-6.3). A row whose paletteJson or layoutJson is
 * unparseable falls back to the same hash as the empty `{}` shape — the
 * cache will simply miss + the renderer regenerates the asset, which is
 * the right degraded behaviour for a corrupted-stored-shape row.
 *
 * Sub-brand isolation: every list / get / write goes through
 * getSubBrandAccessSet + canAccessSubBrand. A MANAGER restricted to one
 * sub-brand cannot read or write templates attached to other sub-brands;
 * templates with NULL subBrand are tenant-wide and visible to everyone.
 *
 * Error codes (route-specific):
 *   INVALID_ID, MISSING_FIELDS, INVALID_TEMPLATE, INVALID_PALETTE_JSON,
 *   INVALID_LAYOUT_JSON, INVALID_ASSETS_JSON, INVALID_SUB_BRAND,
 *   TEMPLATE_NOT_FOUND, SUB_BRAND_DENIED, EMPTY_BODY.
 *
 * Mount in server.js is a SEPARATE slice (wire-in deferred).
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  VALID_SUB_BRANDS,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { validateTemplate } = require("../lib/flyerTemplateValidator");
const {
  hashTemplateShape,
  validateExportRequest,
  buildOutputCacheKey,
} = require("../lib/flyerExport");
const { renderFlyerPdf } = require("../lib/flyerPdfRender");

/**
 * Parse a `@db.Text` column expected to contain JSON. Accepts:
 *   - a string  → JSON.parse it, throw with `code` on parse failure
 *   - an object → return as-is (the caller stringifies for storage)
 *
 * Returns `{ parsed, stringified }`. `stringified` is the canonical
 * `@db.Text` payload to persist; `parsed` is the live JS value the
 * validator runs against.
 */
function parseJsonColumn(input, fieldName, code) {
  if (input == null || input === "") {
    const err = new Error(`${fieldName} is required`);
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  if (typeof input === "string") {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (_e) {
      const err = new Error(`${fieldName} must be valid JSON`);
      err.status = 400;
      err.code = code;
      throw err;
    }
    return { parsed, stringified: input };
  }
  if (typeof input === "object") {
    let stringified;
    try {
      stringified = JSON.stringify(input);
    } catch (_e) {
      const err = new Error(`${fieldName} must be JSON-serializable`);
      err.status = 400;
      err.code = code;
      throw err;
    }
    return { parsed: input, stringified };
  }
  const err = new Error(`${fieldName} must be a JSON object/array or string`);
  err.status = 400;
  err.code = code;
  throw err;
}

/**
 * Run flyerTemplateValidator.validateTemplate against parsed
 * { palette, layout, assets } values. Throws a tagged error the route
 * catch block converts to 400 INVALID_TEMPLATE with the errors array.
 */
function assertValidTemplateShape({ palette, layout, assets }) {
  const result = validateTemplate({ palette, layout, assets });
  if (!result.ok) {
    const err = new Error("Template failed shape validation");
    err.status = 400;
    err.code = "INVALID_TEMPLATE";
    err.errors = result.errors;
    throw err;
  }
}

/**
 * Decorate a TravelFlyerTemplate row with the virtual `templateHash`
 * field (slice 9). Computed at read-time from the row's stored JSON
 * columns; never persisted (see file header rationale).
 *
 * A row whose paletteJson / layoutJson / assetsJson is unparseable
 * folds into the same empty-envelope hash as `{}` — the renderer cache
 * will simply miss + regenerate, which is the right degraded behaviour
 * for a corrupted-stored-shape row.
 */
function withTemplateHash(row) {
  if (!row || typeof row !== "object") return row;
  let palette = null;
  let layout = null;
  let assets = null;
  if (row.paletteJson) {
    try { palette = JSON.parse(row.paletteJson); } catch (_e) { palette = null; }
  }
  if (row.layoutJson) {
    try { layout = JSON.parse(row.layoutJson); } catch (_e) { layout = null; }
  }
  if (row.assetsJson) {
    try { assets = JSON.parse(row.assetsJson); } catch (_e) { assets = null; }
  }
  return { ...row, templateHash: hashTemplateShape({ palette, layout, assets }) };
}

// GET /api/travel/flyer-templates
// Honors ?subBrand=tmc, ?isActive=true/false.
// Sub-brand-restricted callers see only their allowed sub-brands PLUS
// tenant-wide templates (subBrand IS NULL).
router.get(
  "/flyer-templates",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };

      if (req.query.subBrand) {
        assertValidSubBrand(String(req.query.subBrand));
        where.subBrand = String(req.query.subBrand);
      }
      if (req.query.isActive !== undefined) {
        const v = String(req.query.isActive);
        if (v === "true" || v === "1") where.isActive = true;
        else if (v === "false" || v === "0") where.isActive = false;
      }

      // Sub-brand narrowing — same pattern as travel_commission_profiles.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (where.subBrand !== undefined) {
          if (!canAccessSubBrand(allowed, where.subBrand)) {
            where.subBrand = "__none__"; // silent-empty
          }
        } else {
          where.OR = [
            { subBrand: { in: [...allowed] } },
            { subBrand: null },
          ];
        }
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;

      const [templates, total] = await Promise.all([
        prisma.travelFlyerTemplate.findMany({
          where,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take,
          skip,
        }),
        prisma.travelFlyerTemplate.count({ where }),
      ]);
      res.json({
        templates: templates.map(withTemplateHash),
        total,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] list error:", e.message);
      res.status(500).json({ error: "Failed to list flyer templates" });
    }
  },
);

// GET /api/travel/flyer-templates/sub-brands — per-sub-brand template counts
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 13).
//
// USER-readable meta endpoint that powers the flyer-library UI's sub-brand
// filter chips ("TMC (8) · RFU (6) · Travel Stall (12) · Tenant-wide (3)").
// Without this, the frontend has to page through every flyer just to
// populate the filter dropdown.
//
// PRD anchors:
//   - §3.7.1 — curated per-sub-brand template library (TMC / RFU /
//              Travel Stall / Visa Sure)
//   - §3.7.4 — template marketplace search + filter by sub-brand
//   - AC-6.6 — flyer library per sub-brand (cross-sub-brand leakage
//              blocked at API + UI levels)
//
// Behaviour:
//   - One bucket per VALID_SUB_BRANDS value the caller can see + a
//     synthetic "(tenant-wide)" bucket for rows with subBrand=NULL.
//   - Sub-brand-restricted callers (User.subBrandAccess narrows to a
//     subset) see ONLY their allowed sub-brand buckets PLUS the
//     tenant-wide bucket. The tenant-wide bucket is always visible —
//     same rule the list endpoint enforces (NULL subBrand rows are
//     visible to everyone).
//   - Optional ?isActive=true|false narrows the counts to active /
//     archived rows only. Default (no query) counts every row.
//   - Response shape is a stable array (not a map) so callers can sort
//     it for UI display. `subBrand: null` is the tenant-wide bucket;
//     `total` is the convenience sum of all bucket counts.
//
// Implementation note: uses findMany over groupBy intentionally — the
// total population (4 sub-brands + 1 tenant-wide) is bounded, the row
// shape stays mock-friendly for vitest, and the JS-side aggregation
// step is O(rows) on a per-tenant scale that maxes out in the low
// thousands. groupBy would add a second mock surface for marginal
// efficiency.
//
// No write side effects; no audit row (read-only meta, mirrors the
// rationale on /:id/preview.pdf).
router.get(
  "/flyer-templates/sub-brands",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };

      if (req.query.isActive !== undefined) {
        const v = String(req.query.isActive);
        if (v === "true" || v === "1") where.isActive = true;
        else if (v === "false" || v === "0") where.isActive = false;
      }

      // Sub-brand narrowing — same gate as the list endpoint above.
      // Sub-brand-restricted callers see their allowed sub-brands plus
      // the tenant-wide (NULL) rows.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      const rows = await prisma.travelFlyerTemplate.findMany({
        where,
        select: { subBrand: true },
      });

      // Initialise a zero-count bucket for every VALID sub-brand the
      // caller can see, PLUS the tenant-wide bucket. Pre-seeding with
      // zeros means the frontend always sees the full set of filter
      // chips (with zeros visually-distinct) rather than an unstable
      // shape that grows / shrinks as templates appear / disappear.
      const counts = new Map();
      counts.set(null, 0); // tenant-wide bucket
      for (const sb of VALID_SUB_BRANDS) {
        if (!allowed || allowed.has(sb)) counts.set(sb, 0);
      }

      for (const row of rows) {
        const key = row.subBrand ?? null;
        // Defensive: skip a sub-brand row the caller shouldn't see
        // (shouldn't happen given the where-clause narrowing above,
        // but the cost of being explicit is one .has() check).
        if (!counts.has(key)) continue;
        counts.set(key, counts.get(key) + 1);
      }

      // Stable order: tenant-wide first, then sub-brands alphabetically.
      const buckets = [];
      buckets.push({ subBrand: null, count: counts.get(null) });
      for (const sb of VALID_SUB_BRANDS) {
        if (counts.has(sb)) {
          buckets.push({ subBrand: sb, count: counts.get(sb) });
        }
      }

      const total = buckets.reduce((sum, b) => sum + b.count, 0);

      res.json({ buckets, total });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] sub-brands error:", e.message);
      res.status(500).json({ error: "Failed to summarise flyer templates by sub-brand" });
    }
  },
);

// POST /api/travel/flyer-templates/bulk-archive — ADMIN/MANAGER batch archive
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 15).
//
// Accepts `{ ids: [int, ...] }` and archives every matching template the
// caller can access. Per-id outcomes are bucketed into the response
// envelope so operators driving the library page's "select N rows →
// archive" affordance can render per-row feedback without N round-trips.
//
// Why a dedicated endpoint instead of looping POST /:id/archive on the
// frontend:
//   (1) One round-trip vs N (~5-50 templates is the realistic batch
//       size for a library-page selection).
//   (2) Atomic audit-batch — every successful archive shares the same
//       requesting user + same wall-clock, so audit reports can correlate
//       a bulk action as a single operator intent rather than N
//       indistinguishable singletons.
//   (3) Partial-success contract: a denied / not-found id inside the
//       batch does NOT roll back the rest. Operators get { archived,
//       alreadyArchived, notFound, denied } buckets in the response —
//       same shape the future bulk-export / bulk-tag endpoints will use.
//
// Express route ordering: this route MUST be declared BEFORE the
// `/flyer-templates/:id` family because `bulk-archive` would otherwise
// be captured as `:id="bulk-archive"` and 400-INVALID_ID before reaching
// the bulk handler. The literal-path-first convention is documented in
// the file header and pinned by the slice-15 unit tests.
//
// Body limits: `ids` must be a non-empty array of finite integers; max
// 100 ids per request (mirrors the bulk-tag / bulk-delete cap convention
// in other routes — protects against accidental "select all 10k rows"
// abuse and keeps the per-request prisma round-trips bounded).
//
// Per-id outcomes (returned in the response envelope):
//   - archived[]            — ids successfully flipped to isActive=false
//                             (one audit row each)
//   - alreadyArchived[]     — ids whose row was already isActive=false
//                             (no prisma.update, no audit — idempotent)
//   - notFound[]            — ids that don't exist or live on another
//                             tenant
//   - denied[]              — ids whose row's sub-brand is outside the
//                             caller's subBrandAccess
//
// Status: 200 even on partial success (the buckets carry the per-id
// outcome). 400 INVALID_IDS / EMPTY_IDS / TOO_MANY_IDS for malformed
// requests. 403 RBAC_DENIED via verifyRole if role !∈ {ADMIN, MANAGER}.
router.post(
  "/flyer-templates/bulk-archive",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { ids } = req.body || {};

      if (!Array.isArray(ids)) {
        return res.status(400).json({
          error: "ids must be an array of template ids",
          code: "INVALID_IDS",
        });
      }
      if (ids.length === 0) {
        return res.status(400).json({
          error: "ids must contain at least one template id",
          code: "EMPTY_IDS",
        });
      }
      if (ids.length > 100) {
        return res.status(400).json({
          error: "ids must contain at most 100 template ids per request",
          code: "TOO_MANY_IDS",
        });
      }

      // Normalise + de-dupe. Reject the whole batch if ANY id is not a
      // finite integer — silent-skip of non-numeric entries would mask
      // upstream UI bugs.
      const seen = new Set();
      const normalised = [];
      for (const raw of ids) {
        const n =
          typeof raw === "number" ? raw : parseInt(raw, 10);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          return res.status(400).json({
            error: "every id must be a finite integer",
            code: "INVALID_IDS",
          });
        }
        if (!seen.has(n)) {
          seen.add(n);
          normalised.push(n);
        }
      }

      // Pre-fetch sub-brand access once for the whole batch — avoids
      // N look-ups against the same User row.
      const allowed = await getSubBrandAccessSet(req.user.userId);

      const archived = [];
      const alreadyArchived = [];
      const notFound = [];
      const denied = [];

      // Per-id loop. Each id gets a tenant-scoped findFirst (mirrors
      // single-id archive), then bucketed into the response envelope.
      // The route deliberately does NOT short-circuit on first failure —
      // bulk callers want every row's outcome surfaced.
      for (const id of normalised) {
        const row = await prisma.travelFlyerTemplate.findFirst({
          where: { id, tenantId: req.travelTenant.id },
        });
        if (!row) {
          notFound.push(id);
          continue;
        }
        if (row.subBrand && !canAccessSubBrand(allowed, row.subBrand)) {
          denied.push(id);
          continue;
        }
        if (row.isActive === false) {
          alreadyArchived.push(id);
          continue;
        }
        await prisma.travelFlyerTemplate.update({
          where: { id },
          data: { isActive: false },
        });
        await writeAudit(
          "TravelFlyerTemplate",
          "TRAVEL_FLYER_TEMPLATE_ARCHIVED",
          id,
          req.user.userId,
          req.travelTenant.id,
          {
            name: row.name,
            subBrand: row.subBrand,
            bulk: true,
          },
        );
        archived.push(id);
      }

      res.status(200).json({
        archived,
        alreadyArchived,
        notFound,
        denied,
        total: normalised.length,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] bulk-archive error:", e.message);
      res.status(500).json({ error: "Failed to bulk-archive flyer templates" });
    }
  },
);

// POST /api/travel/flyer-templates/bulk-unarchive — ADMIN/MANAGER batch restore
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 16).
//
// Mirror of /bulk-archive (slice 15) — accepts `{ ids: [int, ...] }` and
// restores every matching archived template the caller can access. Per-id
// outcomes are bucketed into the response envelope so operators driving
// the library page's "filter=archived → select N → restore" affordance
// can render per-row feedback without N round-trips.
//
// Symmetry rationale (mirrors slice 15's "why a dedicated endpoint"):
//   (1) One round-trip vs N — operators reviewing the archived bucket
//       typically pick 3-20 to restore at once (post-spring-clean, season
//       reset, accidental over-archive recovery).
//   (2) Atomic audit-batch — every successful restore shares the same
//       requesting user + wall-clock, so reports can correlate a bulk
//       restore as a single operator intent.
//   (3) Partial-success contract: a denied / not-found id inside the
//       batch does NOT roll back the rest. Operators get { unarchived,
//       alreadyActive, notFound, denied } buckets in the response —
//       same shape family as bulk-archive (s/archived/unarchived,
//       s/alreadyArchived/alreadyActive) so the frontend can render
//       both endpoints' results through the same chrome.
//
// Express route ordering: this route MUST be declared BEFORE the
// `/flyer-templates/:id` family because `bulk-unarchive` would otherwise
// be captured as `:id="bulk-unarchive"` and 400-INVALID_ID before reaching
// the bulk handler. Pinned by the slice-16 ordering test.
//
// Body limits: `ids` must be a non-empty array of finite integers; max
// 100 ids per request — same cap as bulk-archive (mirrors the bulk-tag
// / bulk-delete convention across the route file family).
//
// Per-id outcomes (returned in the response envelope):
//   - unarchived[]    — ids successfully flipped to isActive=true
//                       (one audit row each, action
//                       TRAVEL_FLYER_TEMPLATE_UNARCHIVED with bulk:true)
//   - alreadyActive[] — ids whose row was already isActive=true
//                       (no prisma.update, no audit — idempotent)
//   - notFound[]      — ids that don't exist or live on another tenant
//   - denied[]        — ids whose row's sub-brand is outside the caller's
//                       subBrandAccess
//
// Status: 200 even on partial success (the buckets carry the per-id
// outcome). 400 INVALID_IDS / EMPTY_IDS / TOO_MANY_IDS for malformed
// requests. 403 RBAC_DENIED via verifyRole if role !∈ {ADMIN, MANAGER}.
router.post(
  "/flyer-templates/bulk-unarchive",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { ids } = req.body || {};

      if (!Array.isArray(ids)) {
        return res.status(400).json({
          error: "ids must be an array of template ids",
          code: "INVALID_IDS",
        });
      }
      if (ids.length === 0) {
        return res.status(400).json({
          error: "ids must contain at least one template id",
          code: "EMPTY_IDS",
        });
      }
      if (ids.length > 100) {
        return res.status(400).json({
          error: "ids must contain at most 100 template ids per request",
          code: "TOO_MANY_IDS",
        });
      }

      // Normalise + de-dupe. Reject the whole batch if ANY id is not a
      // finite integer — silent-skip of non-numeric entries would mask
      // upstream UI bugs (same gate as bulk-archive).
      const seen = new Set();
      const normalised = [];
      for (const raw of ids) {
        const n =
          typeof raw === "number" ? raw : parseInt(raw, 10);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          return res.status(400).json({
            error: "every id must be a finite integer",
            code: "INVALID_IDS",
          });
        }
        if (!seen.has(n)) {
          seen.add(n);
          normalised.push(n);
        }
      }

      // Pre-fetch sub-brand access once for the whole batch.
      const allowed = await getSubBrandAccessSet(req.user.userId);

      const unarchived = [];
      const alreadyActive = [];
      const notFound = [];
      const denied = [];

      for (const id of normalised) {
        const row = await prisma.travelFlyerTemplate.findFirst({
          where: { id, tenantId: req.travelTenant.id },
        });
        if (!row) {
          notFound.push(id);
          continue;
        }
        if (row.subBrand && !canAccessSubBrand(allowed, row.subBrand)) {
          denied.push(id);
          continue;
        }
        if (row.isActive === true) {
          alreadyActive.push(id);
          continue;
        }
        await prisma.travelFlyerTemplate.update({
          where: { id },
          data: { isActive: true },
        });
        await writeAudit(
          "TravelFlyerTemplate",
          "TRAVEL_FLYER_TEMPLATE_UNARCHIVED",
          id,
          req.user.userId,
          req.travelTenant.id,
          {
            name: row.name,
            subBrand: row.subBrand,
            bulk: true,
          },
        );
        unarchived.push(id);
      }

      res.status(200).json({
        unarchived,
        alreadyActive,
        notFound,
        denied,
        total: normalised.length,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] bulk-unarchive error:", e.message);
      res.status(500).json({ error: "Failed to bulk-unarchive flyer templates" });
    }
  },
);

// GET /api/travel/flyer-templates/:id
router.get(
  "/flyer-templates/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const template = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!template) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      // Sub-brand access — NULL subBrand is tenant-wide and visible to all.
      if (template.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, template.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }
      res.json(withTemplateHash(template));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] get error:", e.message);
      res.status(500).json({ error: "Failed to get flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates — ADMIN/MANAGER only.
// Required: name, paletteJson, layoutJson.
// Optional: assetsJson, subBrand, isActive (default true), notes.
router.post(
  "/flyer-templates",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        name, paletteJson, layoutJson, assetsJson,
        subBrand, isActive, notes,
      } = req.body || {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          error: "name required",
          code: "MISSING_FIELDS",
        });
      }

      // Parse + stringify each JSON column. Throws tagged errors that the
      // outer catch surfaces as 400 INVALID_*_JSON / MISSING_FIELDS.
      const palette = parseJsonColumn(paletteJson, "paletteJson", "INVALID_PALETTE_JSON");
      const layout = parseJsonColumn(layoutJson, "layoutJson", "INVALID_LAYOUT_JSON");
      let assets = null;
      if (assetsJson !== undefined && assetsJson !== null && assetsJson !== "") {
        assets = parseJsonColumn(assetsJson, "assetsJson", "INVALID_ASSETS_JSON");
      }

      // Deep-shape validation against the renderer contract.
      assertValidTemplateShape({
        palette: palette.parsed,
        layout: layout.parsed,
        assets: assets ? assets.parsed : undefined,
      });

      if (subBrand !== undefined && subBrand !== null && subBrand !== "") {
        assertValidSubBrand(subBrand);
        // Sub-brand isolation — same gate as commission-profiles. NULL
        // (tenant-wide) creates are allowed for any authorised caller.
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const created = await prisma.travelFlyerTemplate.create({
        data: {
          tenantId: req.travelTenant.id,
          name: name.trim(),
          paletteJson: palette.stringified,
          layoutJson: layout.stringified,
          assetsJson: assets ? assets.stringified : null,
          subBrand: subBrand ? String(subBrand) : null,
          isActive: isActive === false ? false : true,
          notes: notes ? String(notes) : null,
        },
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: created.name,
          subBrand: created.subBrand,
        },
      );

      res.status(201).json(withTemplateHash(created));
    } catch (e) {
      if (e.status) {
        const body = { error: e.message, code: e.code };
        if (e.errors) body.errors = e.errors;
        return res.status(e.status).json(body);
      }
      console.error("[travel-flyer-templates] create error:", e.message);
      res.status(500).json({ error: "Failed to create flyer template" });
    }
  },
);

// PUT /api/travel/flyer-templates/:id — ADMIN/MANAGER only.
// Partial update. Re-runs flyerTemplateValidator iff palette/layout/assets
// is part of the diff (see file header for the rationale — renaming a
// template should NOT fail because the saved shape no longer validates).
// Sub-brand reassignment requires access to both the existing AND target.
router.put(
  "/flyer-templates/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (existing.subBrand && !canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      const data = {};
      const {
        name, paletteJson, layoutJson, assetsJson,
        subBrand, isActive, notes,
      } = req.body || {};

      if (name !== undefined) {
        if (typeof name !== "string" || !name.trim()) {
          return res.status(400).json({
            error: "name must be non-empty",
            code: "MISSING_FIELDS",
          });
        }
        data.name = name.trim();
      }

      // Re-validate iff any of palette/layout/assets is in the diff.
      // Use the existing-stored shape for unsupplied pieces so the
      // validator sees a complete { palette, layout, assets } envelope.
      const reValidate =
        paletteJson !== undefined ||
        layoutJson !== undefined ||
        assetsJson !== undefined;

      let paletteForValidation;
      let layoutForValidation;
      let assetsForValidation;

      if (paletteJson !== undefined) {
        const parsed = parseJsonColumn(paletteJson, "paletteJson", "INVALID_PALETTE_JSON");
        data.paletteJson = parsed.stringified;
        paletteForValidation = parsed.parsed;
      }
      if (layoutJson !== undefined) {
        const parsed = parseJsonColumn(layoutJson, "layoutJson", "INVALID_LAYOUT_JSON");
        data.layoutJson = parsed.stringified;
        layoutForValidation = parsed.parsed;
      }
      if (assetsJson !== undefined) {
        if (assetsJson === null || assetsJson === "") {
          data.assetsJson = null;
          assetsForValidation = undefined;
        } else {
          const parsed = parseJsonColumn(assetsJson, "assetsJson", "INVALID_ASSETS_JSON");
          data.assetsJson = parsed.stringified;
          assetsForValidation = parsed.parsed;
        }
      }

      if (reValidate) {
        // Fall back to the row's existing stored shape for any piece the
        // PUT didn't touch — the validator needs a complete envelope.
        if (paletteForValidation === undefined) {
          try {
            paletteForValidation = JSON.parse(existing.paletteJson);
          } catch (_e) {
            paletteForValidation = null;
          }
        }
        if (layoutForValidation === undefined) {
          try {
            layoutForValidation = JSON.parse(existing.layoutJson);
          } catch (_e) {
            layoutForValidation = null;
          }
        }
        if (assetsForValidation === undefined && assetsJson === undefined && existing.assetsJson) {
          try {
            assetsForValidation = JSON.parse(existing.assetsJson);
          } catch (_e) {
            assetsForValidation = undefined;
          }
        }
        assertValidTemplateShape({
          palette: paletteForValidation,
          layout: layoutForValidation,
          assets: assetsForValidation,
        });
      }

      if (subBrand !== undefined) {
        if (subBrand === null || subBrand === "") {
          data.subBrand = null;
        } else {
          assertValidSubBrand(subBrand);
          if (!canAccessSubBrand(allowed, subBrand)) {
            return res.status(403).json({
              error: "Sub-brand access denied",
              code: "SUB_BRAND_DENIED",
            });
          }
          data.subBrand = String(subBrand);
        }
      }
      if (isActive !== undefined) data.isActive = Boolean(isActive);
      if (notes !== undefined) data.notes = notes ? String(notes) : null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({
          error: "no updatable fields provided",
          code: "EMPTY_BODY",
        });
      }

      const updated = await prisma.travelFlyerTemplate.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(withTemplateHash(updated));
    } catch (e) {
      if (e.status) {
        const body = { error: e.message, code: e.code };
        if (e.errors) body.errors = e.errors;
        return res.status(e.status).json(body);
      }
      console.error("[travel-flyer-templates] update error:", e.message);
      res.status(500).json({ error: "Failed to update flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates/:id/duplicate — ADMIN/MANAGER only.
//
// Clones an existing TravelFlyerTemplate row into a fresh row under the
// same tenant. Optional body fields { name, subBrand } let the operator
// override the copy's name + sub-brand assignment (e.g. cloning a TMC
// flyer across to RFU, or naming the variant "Diwali palette swap").
//
// Source row is looked up tenant-scoped + sub-brand-scoped (the same
// guard as GET/PUT/DELETE), so cross-tenant lookups yield 404 and
// cross-sub-brand reads yield 403. The duplicate inherits paletteJson /
// layoutJson / assetsJson / notes verbatim from the source — operators
// use duplicate as a starting point for variations (seasonal palette
// swap, A/B test variant), so the full shape comes with it. isActive
// is reset to true regardless of source state so the new copy enters
// the active list cleanly; source.isActive=false still duplicates fine
// (no INVALID_STATE gate — archiving a template should not block
// authoring a variant of it).
//
// Name suffix convention: when no `name` override is supplied, the
// copy is named `"<source.name> (copy)"`. Operators routinely duplicate
// then immediately rename in the editor, so the suffix is a hint not a
// commitment; pin the verbatim string here so consumers (tests, UI
// chrome) can rely on it.
router.post(
  "/flyer-templates/:id/duplicate",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const source = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (source.subBrand && !canAccessSubBrand(allowed, source.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      const { name: nameOverride, subBrand: subBrandOverride } = req.body || {};

      let targetSubBrand = source.subBrand;
      if (subBrandOverride !== undefined) {
        if (subBrandOverride === null || subBrandOverride === "") {
          targetSubBrand = null;
        } else {
          assertValidSubBrand(subBrandOverride);
          if (!canAccessSubBrand(allowed, subBrandOverride)) {
            return res.status(403).json({
              error: "Sub-brand access denied",
              code: "SUB_BRAND_DENIED",
            });
          }
          targetSubBrand = String(subBrandOverride);
        }
      }

      let targetName;
      if (nameOverride !== undefined && nameOverride !== null && nameOverride !== "") {
        if (typeof nameOverride !== "string" || !nameOverride.trim()) {
          return res.status(400).json({
            error: "name must be non-empty",
            code: "MISSING_FIELDS",
          });
        }
        targetName = nameOverride.trim();
      } else {
        targetName = `${source.name} (copy)`;
      }

      const created = await prisma.travelFlyerTemplate.create({
        data: {
          tenantId: req.travelTenant.id,
          name: targetName,
          paletteJson: source.paletteJson,
          layoutJson: source.layoutJson,
          assetsJson: source.assetsJson,
          subBrand: targetSubBrand,
          isActive: true,
          notes: source.notes,
        },
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "TRAVEL_FLYER_TEMPLATE_DUPLICATED",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          sourceId: source.id,
          newId: created.id,
          subBrand: created.subBrand,
        },
      );

      res.status(201).json(withTemplateHash(created));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] duplicate error:", e.message);
      res.status(500).json({ error: "Failed to duplicate flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates/:id/archive — ADMIN/MANAGER soft-archive
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 14).
//
// Dedicated lifecycle endpoint that flips `isActive` to false. Functionally
// equivalent to `PUT /:id { isActive: false }` but split off as a distinct
// route so:
//   (1) The audit row carries a SPECIFIC `TRAVEL_FLYER_TEMPLATE_ARCHIVED`
//       action rather than a generic UPDATE with `{ fields: ['isActive'] }`
//       — reports that segment "archive events" from "edit events" can read
//       the action verbatim without parsing the diff blob.
//   (2) The frontend's "Archive" button has a clean POST target rather than
//       building a PUT body. Less mistake surface; less JSON to send.
//   (3) Idempotent: archiving an already-archived row returns 200 + a
//       no-op envelope rather than mutating + writing a redundant audit
//       row (mirrors how the wellness portal's archive endpoints behave).
//
// Sub-brand isolation: same gate as the rest of the route — sub-branded
// templates require canAccessSubBrand; tenant-wide (NULL) templates are
// accessible to any tenant operator with ADMIN/MANAGER role.
//
// Hard-delete is intentionally NOT replaced by archive — operators who
// truly want a row gone still hit DELETE (ADMIN-only). Archive is the
// "remove from library, keep around for un-archive" surface.
router.post(
  "/flyer-templates/:id/archive",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (existing.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, existing.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Idempotency: already archived → 200 no-op envelope. No audit row
      // for no-op (otherwise the audit log accumulates noise from UI
      // double-clicks or refresh-loops).
      if (existing.isActive === false) {
        return res.status(200).json({
          ...withTemplateHash(existing),
          alreadyArchived: true,
        });
      }

      const updated = await prisma.travelFlyerTemplate.update({
        where: { id },
        data: { isActive: false },
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "TRAVEL_FLYER_TEMPLATE_ARCHIVED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: updated.name,
          subBrand: updated.subBrand,
        },
      );

      res.status(200).json(withTemplateHash(updated));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] archive error:", e.message);
      res.status(500).json({ error: "Failed to archive flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates/:id/unarchive — ADMIN/MANAGER restore
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 14).
//
// Inverse of /archive. Flips `isActive` back to true. Same idempotency
// + audit-row + sub-brand-isolation contract as the archive endpoint.
// Distinct audit action `TRAVEL_FLYER_TEMPLATE_UNARCHIVED` so reports
// can distinguish "operator restored an archived template" from "operator
// edited the row's isActive flag inline via PUT".
router.post(
  "/flyer-templates/:id/unarchive",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (existing.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, existing.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Idempotency: already active → 200 no-op envelope. No audit row.
      if (existing.isActive === true) {
        return res.status(200).json({
          ...withTemplateHash(existing),
          alreadyActive: true,
        });
      }

      const updated = await prisma.travelFlyerTemplate.update({
        where: { id },
        data: { isActive: true },
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "TRAVEL_FLYER_TEMPLATE_UNARCHIVED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: updated.name,
          subBrand: updated.subBrand,
        },
      );

      res.status(200).json(withTemplateHash(updated));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] unarchive error:", e.message);
      res.status(500).json({ error: "Failed to unarchive flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates/:id/export — ADMIN/MANAGER only.
//
// PRD_TRAVEL_MARKETING_FLYER §3 (AC-6.3 / AC-6.4 export contract).
//
// Slice 10 validation + cache-key plumbing (commit f7d8311d):
//   - Validates the export envelope via lib/flyerExport.validateExportRequest
//     (`{ format: 'pdf'|'png', aspect }`).
//   - Computes the deterministic content-addressed cache key via
//     lib/flyerExport.buildOutputCacheKey({ format, aspect, hash }) where
//     `hash` is hashTemplateShape over the source row's parsed JSON columns.
//
// Slice 11 PDF rendering (this commit):
//   - For format='pdf' AND ?inline=1, calls lib/flyerPdfRender.renderFlyerPdf
//     to materialise the template into a real pdfkit Buffer and streams it
//     back with `Content-Type: application/pdf` + 200 OK. No file
//     persistence — the inline-buffer path is the smaller slice that
//     unblocks operators previewing PDFs while file-persistence + the
//     cache plumbing land in a later slice.
//   - For format='pdf' WITHOUT ?inline=1, stays on the slice-10 contract
//     (202 queued + cacheKey) so the existing async polling surface keeps
//     working untouched. Future slice swaps this for a real cache-lookup
//     + a `url` field on cache hit.
//   - For format='png', stays fully STUBBED (202 queued) — Puppeteer
//     infrastructure is a separate blocker.
//
// Sub-brand isolation: the source row's sub-brand gate is enforced
// before any computation runs (cross-sub-brand operators cannot enqueue
// renders against templates they cannot read).
router.post(
  "/flyer-templates/:id/export",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Validate the export envelope BEFORE the DB lookup so callers
      // get the same 400 INVALID_EXPORT_REQUEST regardless of whether
      // the template id is real — the validator's error array is the
      // load-bearing surface the future renderer slice depends on.
      const { format, aspect } = req.body || {};
      const validation = validateExportRequest({ format, aspect });
      if (!validation.ok) {
        return res.status(400).json({
          error: "Invalid export request",
          code: "INVALID_EXPORT_REQUEST",
          errors: validation.errors,
        });
      }

      const source = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (source.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, source.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Compute the deterministic template-shape hash from the row's
      // stored JSON columns. Same canonicalization the GET responses
      // surface via the `templateHash` virtual field (slice 9) — pin
      // identity here so the cache key is end-to-end stable.
      let palette = null;
      let layout = null;
      let assets = null;
      if (source.paletteJson) {
        try { palette = JSON.parse(source.paletteJson); } catch (_e) { palette = null; }
      }
      if (source.layoutJson) {
        try { layout = JSON.parse(source.layoutJson); } catch (_e) { layout = null; }
      }
      if (source.assetsJson) {
        try { assets = JSON.parse(source.assetsJson); } catch (_e) { assets = null; }
      }
      const hash = hashTemplateShape({ palette, layout, assets });
      const cacheKey = buildOutputCacheKey({ format, aspect, hash });

      // Slice 11 inline-PDF path: when caller passes `?inline=1` AND
      // format='pdf', synchronously render the PDF via lib/flyerPdfRender
      // and stream the Buffer back as `application/pdf` with status 200.
      // PNG stays STUBBED (Puppeteer infra pending).
      const wantsInline =
        req.query &&
        (req.query.inline === "1" ||
          req.query.inline === 1 ||
          req.query.inline === "true");

      if (wantsInline && format === "pdf") {
        const buffer = await renderFlyerPdf(
          { palette, layout, assets },
          { aspect, hash },
        );

        await writeAudit(
          "TravelFlyerTemplate",
          "TRAVEL_FLYER_TEMPLATE_EXPORTED",
          source.id,
          req.user.userId,
          req.travelTenant.id,
          { format, aspect, cacheKey, inline: true, bytes: buffer.length },
        );

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="flyer-${source.id}-${aspect}.pdf"`,
        );
        res.setHeader("X-Flyer-Cache-Key", cacheKey);
        res.setHeader("X-Flyer-Template-Hash", hash);
        return res.status(200).send(buffer);
      }

      // STUB (PNG always, PDF without ?inline=1): rendering pipeline
      // pending headless-render infrastructure. Returns the slice-10
      // 202-queued envelope so existing async pollers stay unchanged.
      // STUB: Puppeteer rendering pending
      const queuedAt = new Date().toISOString();

      await writeAudit(
        "TravelFlyerTemplate",
        "TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED",
        source.id,
        req.user.userId,
        req.travelTenant.id,
        { format, aspect, cacheKey },
      );

      res.status(202).json({
        format,
        aspect,
        hash,
        cacheKey,
        status: "queued",
        queuedAt,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] export error:", e.message);
      res.status(500).json({ error: "Failed to queue flyer export" });
    }
  },
);

// GET /api/travel/flyer-templates/:id/preview.pdf — inline PDF preview
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 12).
//
// Read-only preview surface: any authenticated tenant user (USER /
// MANAGER / ADMIN) can fetch a rendered PDF preview of a flyer template
// they have sub-brand access to. Pairs with the FlyerTemplates list
// page's "Use as starting point" affordance — a marketer needs to see
// what a saved template actually looks like before picking it as a base
// for a new flyer.
//
// Distinction from POST /:id/export?inline=1 (slice 11):
//   - GET vs POST     — this is a true read; cacheable + bookmarkable +
//                       browser-previewable via a plain anchor tag.
//   - Roles           — opens up to USER as well as ADMIN/MANAGER. The
//                       export POST stays gated to ADMIN/MANAGER because
//                       export is operator-driven distribution; preview
//                       is a list-browsing aid.
//   - No audit row    — read-only preview, every list-page render would
//                       otherwise pollute the audit log.
//   - Query-driven    — aspect lives in ?aspect= rather than a JSON body
//                       (browsers can't POST a body from an <a href>).
//
// Sub-brand isolation: same gate as the rest of the route file — NULL
// subBrand rows are tenant-wide and visible to everyone; sub-branded
// rows enforce canAccessSubBrand. Cross-tenant lookups 404 cleanly.
//
// Aspect taxonomy reuses lib/flyerExport's PDF_PAPER_SIZES (a4 /
// us_letter); invalid aspect → 400 INVALID_ASPECT.
router.get(
  "/flyer-templates/:id/preview.pdf",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Aspect defaults to 'a4'. Reuses the canonical PDF_PAPER_SIZES
      // list rather than hardcoding so a future taxonomy widening
      // (e.g. 'tabloid', 'legal') automatically flows here.
      const aspect = (req.query && req.query.aspect) || "a4";
      const { PDF_PAPER_SIZES } = require("../lib/flyerExport");
      if (!PDF_PAPER_SIZES.includes(String(aspect))) {
        return res.status(400).json({
          error: `aspect must be one of: ${PDF_PAPER_SIZES.join(", ")}`,
          code: "INVALID_ASPECT",
        });
      }

      const source = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (source.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, source.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Parse the row's JSON columns into the live shape the renderer
      // consumes. Same defensive try/catch dance as POST /:id/export —
      // a corrupted-stored-row should still render a degraded placeholder
      // PDF rather than 500.
      let palette = null;
      let layout = null;
      let assets = null;
      if (source.paletteJson) {
        try { palette = JSON.parse(source.paletteJson); } catch (_e) { palette = null; }
      }
      if (source.layoutJson) {
        try { layout = JSON.parse(source.layoutJson); } catch (_e) { layout = null; }
      }
      if (source.assetsJson) {
        try { assets = JSON.parse(source.assetsJson); } catch (_e) { assets = null; }
      }

      const hash = hashTemplateShape({ palette, layout, assets });
      const buffer = await renderFlyerPdf(
        { palette, layout, assets },
        { aspect: String(aspect), hash },
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="flyer-${source.id}-preview-${aspect}.pdf"`,
      );
      res.setHeader("X-Flyer-Template-Hash", hash);
      // Short-cache so a list-page hover-preview doesn't re-render on
      // every mouse-over but template edits still propagate quickly.
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.status(200).send(buffer);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] preview error:", e.message);
      res.status(500).json({ error: "Failed to render flyer preview" });
    }
  },
);

// GET /api/travel/flyer-templates/:id/usage-stats — per-template usage rollup
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 17).
//
// Read-only AuditLog aggregation surface. Powers the FlyerTemplates library
// page's per-row meta strip ("Exports: 12 · Last exported 3h ago · Edited
// 2x · Archived 0x"). Without this endpoint the frontend has to either
// page the generic /api/audit feed and filter client-side (heavy + leaks
// other entities), or fire N separate audit reads per row (N round-trips
// just to render the library list).
//
// PRD anchors:
//   - §3.7.2 — per-template metadata (usage count) feeds the marketplace
//              list + future conversion-rate column
//   - §3.6.4 — performance hint engine consumes per-template impression /
//              export counts to surface optimisation suggestions
//   - FR-3.4.5 — output URLs cached per format/aspect; the export-count
//              rollup is the upstream signal for cache-hit analytics
//
// Behaviour:
//   - Tenant + sub-brand scoped — the template id is resolved first via
//     the same findFirst gate as GET /:id, returning 404 for cross-tenant
//     and 403 for cross-sub-brand BEFORE any AuditLog read fires. Stops a
//     fishing-rod attack that would otherwise leak the existence of a
//     template id via the audit-count surface.
//   - Counts every AuditLog row for this { tenantId, entity: 'TravelFlyerTemplate',
//     entityId } tuple, grouped by action. Returns:
//       { templateId, total, byAction, firstActionAt, lastActionAt,
//         exports, lastExportedAt }
//     Where `byAction` is a stable shape with one bucket per action verb
//     used by this route file (CREATE / UPDATE / DELETE /
//     TRAVEL_FLYER_TEMPLATE_DUPLICATED / TRAVEL_FLYER_TEMPLATE_ARCHIVED /
//     TRAVEL_FLYER_TEMPLATE_UNARCHIVED / TRAVEL_FLYER_TEMPLATE_EXPORTED /
//     TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED) zero-initialised so the
//     frontend always sees the full set rather than a shape that grows
//     as new action verbs first appear in a tenant's logs.
//   - `exports` is the convenience sum of EXPORTED + EXPORT_QUEUED — both
//     count as "an operator asked for a render" from the library-page
//     perspective regardless of whether the renderer ran inline (PDF
//     inline path, slice 11) or queued (PNG stub path, slice 10).
//   - `firstActionAt` / `lastActionAt` are the min/max createdAt timestamps
//     across all bucketed actions. `lastExportedAt` narrows to the export
//     buckets only (matches the UI affordance "last exported X ago").
//
// USER-readable: any tenant operator with sub-brand access to the template
// can fetch usage stats. The data is anodyne — counts + timestamps, no
// payload bodies — and the library page is a USER-facing surface, not
// admin-only. Matches the read-only-aid rationale on GET /:id/preview.pdf
// (slice 12).
//
// No audit row: read-only meta surface. Mirrors slice 12 / slice 13.
//
// Implementation note: findMany over groupBy intentionally — the per-row
// bucket-set is bounded (8 known action verbs), the rows themselves are
// per-template (low cardinality even for heavily-used templates), and
// the JS aggregation keeps the test surface mock-friendly without a
// second prisma method to stub. Same trade made on /sub-brands (slice 13).
router.get(
  "/flyer-templates/:id/usage-stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Resolve + gate the template first so cross-tenant / cross-sub-brand
      // callers can't enumerate audit-event existence via this surface.
      const template = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!template) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (template.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, template.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Stable bucket set — one entry per known action verb the route
      // file emits (incl. built-in CREATE/UPDATE/DELETE). Zero-init so
      // the frontend never sees a missing key.
      const KNOWN_ACTIONS = [
        "CREATE",
        "UPDATE",
        "DELETE",
        "TRAVEL_FLYER_TEMPLATE_DUPLICATED",
        "TRAVEL_FLYER_TEMPLATE_ARCHIVED",
        "TRAVEL_FLYER_TEMPLATE_UNARCHIVED",
        "TRAVEL_FLYER_TEMPLATE_EXPORTED",
        "TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED",
      ];
      const byAction = {};
      for (const a of KNOWN_ACTIONS) byAction[a] = 0;

      const rows = await prisma.auditLog.findMany({
        where: {
          tenantId: req.travelTenant.id,
          entity: "TravelFlyerTemplate",
          entityId: id,
        },
        select: { action: true, createdAt: true },
      });

      let firstActionAt = null;
      let lastActionAt = null;
      let lastExportedAt = null;

      for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(byAction, row.action)) {
          byAction[row.action] += 1;
        } else {
          // Unknown action — track in an `other` bucket so a future
          // verb addition surfaces in the count even if it's not yet
          // listed in KNOWN_ACTIONS.
          byAction.other = (byAction.other || 0) + 1;
        }
        const ts = row.createdAt instanceof Date
          ? row.createdAt
          : new Date(row.createdAt);
        if (!firstActionAt || ts < firstActionAt) firstActionAt = ts;
        if (!lastActionAt || ts > lastActionAt) lastActionAt = ts;
        if (
          row.action === "TRAVEL_FLYER_TEMPLATE_EXPORTED" ||
          row.action === "TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED"
        ) {
          if (!lastExportedAt || ts > lastExportedAt) lastExportedAt = ts;
        }
      }

      const exports =
        byAction.TRAVEL_FLYER_TEMPLATE_EXPORTED +
        byAction.TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED;

      res.json({
        templateId: id,
        total: rows.length,
        byAction,
        exports,
        firstActionAt: firstActionAt ? firstActionAt.toISOString() : null,
        lastActionAt: lastActionAt ? lastActionAt.toISOString() : null,
        lastExportedAt: lastExportedAt ? lastExportedAt.toISOString() : null,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] usage-stats error:", e.message);
      res.status(500).json({ error: "Failed to read flyer template usage stats" });
    }
  },
);

// DELETE /api/travel/flyer-templates/:id — ADMIN-only hard delete.
// Audit row written BEFORE the prisma.delete fires so the intent is
// captured even if the delete subsequently throws.
router.delete(
  "/flyer-templates/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (existing.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, existing.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      await writeAudit(
        "TravelFlyerTemplate",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          name: existing.name,
          subBrand: existing.subBrand,
        },
      );

      await prisma.travelFlyerTemplate.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete flyer template" });
    }
  },
);

module.exports = router;
