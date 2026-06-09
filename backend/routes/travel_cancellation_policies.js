/**
 * /api/travel/cancellation-policies — CancellationPolicy CRUD (S33 / #920).
 *
 * PRD_TRAVEL_BILLING FR-3.7.a: per-tenant policy table mapping
 *   "days before service start" → refund percent. Drives the auto-issuance
 *   of CR-NOTE rows when an invoice is voided (cancelled). The consumer
 *   side lives in backend/routes/travel_invoices.js — the /void handler
 *   calls into the schema-resolver helper at the bottom of this file
 *   indirectly via the existing TravelInvoice.cancellationPolicyId FK +
 *   sub-brand default lookup.
 *
 * Auth posture (mirrors travel_cost_master.js, slice 31 template surface):
 *   - GET list / GET :id  — verifyToken (any logged-in travel-tenant user)
 *   - POST / PATCH        — ADMIN + MANAGER
 *   - DELETE              — ADMIN only (policies are legal-contract terms;
 *                            destructive change needs the strongest gate)
 *
 * Body shape (tiersJson):
 *   tiersJson is a JSON string. Parsed shape:
 *     [
 *       { daysBeforeServiceStart: <int>, refundPercent: <0..100> },
 *       ...
 *     ]
 *   The route layer validates the structure on POST + PATCH; we store as
 *   text so other CRM tenants can later add custom keys without schema
 *   churn (e.g. fixed-fee + percent + currency override).
 *
 * Sub-brand scoping:
 *   - NULL subBrand = tenant-wide default (applies to any sub-brand
 *     without a sub-brand-specific policy).
 *   - Named subBrand (tmc | rfu | travelstall | visasure) scopes to that
 *     sub-brand. The cancel-time resolver in travel_invoices.js looks up
 *     sub-brand-specific FIRST, falls back to tenant-wide.
 *
 * Standing rules honored:
 *   - JWT user = req.user.userId (never req.user.id).
 *   - stripDangerous strips body.{id,userId,tenantId,createdAt,updatedAt} —
 *     handler never reads those off req.body.
 *   - tenantId scoped via req.travelTenant.id (verifyTravelTenant).
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
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");

// ---------------------------------------------------------------------------
// Helpers — tiersJson validator + canonical sort.
// ---------------------------------------------------------------------------

// Parse + validate a tiers payload. Accepts either a JS array or a JSON
// string of an array. Each tier must have integer daysBeforeServiceStart
// >= 0 and refundPercent in [0..100]. The array must contain >= 1 tier.
// Returns the canonicalised array (numeric, sorted DESC by
// daysBeforeServiceStart). Throws { status: 400, code: <CODE> } on error.
function assertValidTiers(tiers) {
  let arr = tiers;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch (e) {
      const err = new Error("tiersJson must be valid JSON");
      err.status = 400;
      err.code = "INVALID_TIERS_JSON";
      throw err;
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    const err = new Error("tiers must be a non-empty array");
    err.status = 400;
    err.code = "INVALID_TIERS";
    throw err;
  }
  const out = [];
  for (const t of arr) {
    if (!t || typeof t !== "object") {
      const err = new Error("each tier must be an object");
      err.status = 400;
      err.code = "INVALID_TIER_SHAPE";
      throw err;
    }
    const d = Number(t.daysBeforeServiceStart);
    const p = Number(t.refundPercent);
    if (!Number.isInteger(d) || d < 0) {
      const err = new Error(
        "daysBeforeServiceStart must be a non-negative integer",
      );
      err.status = 400;
      err.code = "INVALID_TIER_DAYS";
      throw err;
    }
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      const err = new Error("refundPercent must be a number in [0..100]");
      err.status = 400;
      err.code = "INVALID_TIER_PERCENT";
      throw err;
    }
    out.push({ daysBeforeServiceStart: d, refundPercent: p });
  }
  // Canonical sort: largest daysBeforeServiceStart first. The cancel-time
  // resolver walks this list top-down and picks the first tier whose
  // threshold is <= actual days-before-start.
  out.sort((a, b) => b.daysBeforeServiceStart - a.daysBeforeServiceStart);
  return out;
}

// ---------------------------------------------------------------------------
// GET /api/travel/cancellation-policies — list (filterable).
// Query params: ?subBrand=<sb> ?active=true|false ?limit=<n> ?offset=<n>
// USER-readable: operator UI needs to display the policy that applies to
// the invoice they're viewing, even on read-only roles.
// ---------------------------------------------------------------------------
router.get(
  "/cancellation-policies",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      if (req.query.subBrand) {
        const sb = String(req.query.subBrand);
        if (sb === "null" || sb === "_tenant") {
          where.subBrand = null;
        } else {
          assertValidSubBrand(sb);
          where.subBrand = sb;
        }
      }
      if (req.query.active === "true") where.isActive = true;
      if (req.query.active === "false") where.isActive = false;

      const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = parseInt(req.query.offset, 10) || 0;

      const [rows, total] = await Promise.all([
        prisma.cancellationPolicy.findMany({
          where,
          orderBy: [{ isActive: "desc" }, { name: "asc" }],
          take,
          skip,
        }),
        prisma.cancellationPolicy.count({ where }),
      ]);
      res.json({ policies: rows, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[cancellation-policies] list error:", e.message);
      res.status(500).json({ error: "Failed to list cancellation policies" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/travel/cancellation-policies/:id — fetch one.
// ---------------------------------------------------------------------------
router.get(
  "/cancellation-policies/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const row = await prisma.cancellationPolicy.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!row) {
        return res
          .status(404)
          .json({ error: "Policy not found", code: "NOT_FOUND" });
      }
      res.json(row);
    } catch (e) {
      console.error("[cancellation-policies] get error:", e.message);
      res.status(500).json({ error: "Failed to get cancellation policy" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/travel/cancellation-policies — ADMIN + MANAGER.
// Body: { name, subBrand?, description?, tiersJson (string or array),
//         isActive? }
// ---------------------------------------------------------------------------
router.post(
  "/cancellation-policies",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { name, subBrand, description, tiersJson, isActive } =
        req.body || {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          error: "name is required",
          code: "MISSING_FIELDS",
        });
      }
      if (tiersJson == null) {
        return res.status(400).json({
          error: "tiersJson is required",
          code: "MISSING_FIELDS",
        });
      }

      let normalizedSubBrand = null;
      if (subBrand !== undefined && subBrand !== null && subBrand !== "") {
        assertValidSubBrand(subBrand);
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
        normalizedSubBrand = subBrand;
      }

      // tiers validation (throws 400 on bad shape).
      const tiers = assertValidTiers(tiersJson);

      const created = await prisma.cancellationPolicy.create({
        data: {
          tenantId: req.travelTenant.id,
          name: name.trim(),
          subBrand: normalizedSubBrand,
          description: description ? String(description) : null,
          tiersJson: JSON.stringify(tiers),
          isActive: isActive !== false,
        },
      });

      await writeAudit(
        "CancellationPolicy",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: created.name,
          subBrand: created.subBrand,
          tierCount: tiers.length,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      // P2002: tenantId+name unique violation.
      if (e.code === "P2002") {
        return res.status(409).json({
          error: "A cancellation policy with this name already exists",
          code: "POLICY_NAME_TAKEN",
        });
      }
      console.error("[cancellation-policies] create error:", e.message);
      res.status(500).json({ error: "Failed to create cancellation policy" });
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/travel/cancellation-policies/:id — ADMIN + MANAGER.
// ---------------------------------------------------------------------------
router.patch(
  "/cancellation-policies/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.cancellationPolicy.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ error: "Policy not found", code: "NOT_FOUND" });
      }

      const data = {};
      const body = req.body || {};
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || !body.name.trim()) {
          return res.status(400).json({
            error: "name must be non-empty",
            code: "INVALID_NAME",
          });
        }
        data.name = body.name.trim();
      }
      if (body.subBrand !== undefined) {
        if (body.subBrand === null || body.subBrand === "") {
          data.subBrand = null;
        } else {
          assertValidSubBrand(body.subBrand);
          const allowed = await getSubBrandAccessSet(req.user.userId);
          if (!canAccessSubBrand(allowed, body.subBrand)) {
            return res.status(403).json({
              error: "Sub-brand access denied",
              code: "SUB_BRAND_DENIED",
            });
          }
          data.subBrand = body.subBrand;
        }
      }
      if (body.description !== undefined) {
        data.description = body.description === null ? null : String(body.description);
      }
      if (body.tiersJson !== undefined) {
        const tiers = assertValidTiers(body.tiersJson);
        data.tiersJson = JSON.stringify(tiers);
      }
      if (body.isActive !== undefined) data.isActive = !!body.isActive;

      if (Object.keys(data).length === 0) {
        return res
          .status(400)
          .json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.cancellationPolicy.update({
        where: { id },
        data,
      });

      await writeAudit(
        "CancellationPolicy",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      if (e.code === "P2002") {
        return res.status(409).json({
          error: "A cancellation policy with this name already exists",
          code: "POLICY_NAME_TAKEN",
        });
      }
      console.error("[cancellation-policies] patch error:", e.message);
      res.status(500).json({ error: "Failed to update cancellation policy" });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/travel/cancellation-policies/:id — ADMIN only.
// Returns 204 No Content on success (deploy gate's preferred DELETE shape).
// ---------------------------------------------------------------------------
router.delete(
  "/cancellation-policies/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.cancellationPolicy.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ error: "Policy not found", code: "NOT_FOUND" });
      }

      await writeAudit(
        "CancellationPolicy",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        { name: existing.name, subBrand: existing.subBrand },
      );

      await prisma.cancellationPolicy.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      console.error("[cancellation-policies] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete cancellation policy" });
    }
  },
);

module.exports = router;
// Re-exported for unit tests that want to exercise the tier validator
// without the express layer.
module.exports.assertValidTiers = assertValidTiers;
