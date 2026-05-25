/**
 * /api/travel/commission-profiles — TravelCommissionProfile CRUD
 * (PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 2).
 *
 * Sibling to /api/travel/quotes + /api/travel/suppliers. Stores named
 * commission profiles consumed by lib/agentCommissionCalculator.js
 * (slice 1, commit cb284098). Each row is one operator-facing pricing
 * shape — flat_percent | tiered | per_pax_flat | hybrid — stored as a
 * JSON String column so future calculator extensions don't require
 * schema migrations.
 *
 * Endpoints:
 *   GET    /api/travel/commission-profiles                — list (tenant + sub-brand scoped)
 *   GET    /api/travel/commission-profiles/:id            — fetch one
 *   POST   /api/travel/commission-profiles                — ADMIN/MANAGER create
 *   PUT    /api/travel/commission-profiles/:id            — ADMIN/MANAGER partial update
 *   DELETE /api/travel/commission-profiles/:id            — ADMIN-only hard delete
 *   POST   /api/travel/commission-profiles/:id/assign     — ADMIN/MANAGER bulk-assign to Contact rows (slice 6)
 *   POST   /api/travel/commission-profiles/:id/preview    — what-if commission preview (slice 7)
 *   GET    /api/travel/commission-profiles/:id/ledger     — operator-view commission ledger (slice 9)
 *   GET    /api/travel/commission-profiles/:id/ledger.csv — operator CSV export of ledger (slice 11)
 *
 * Validation strictness (slice 2):
 *   - name required, non-empty trim                       → 400 MISSING_FIELDS
 *   - profileType must match 4-item whitelist             → 400 INVALID_PROFILE_TYPE
 *   - profileJson must JSON.parse                         → 400 INVALID_PROFILE_JSON
 *   - subBrand (if provided) must match assertValidSubBrand → 400 INVALID_SUB_BRAND
 *   - DEEP-SHAPE validation of parsed profileJson against profileType is
 *     INTENTIONALLY DEFERRED. The calculator returns commission=0 with a
 *     'unknown profile type X' breakdown on malformed shape — so a misconfigured
 *     row surfaces as an operator-visible $0 commission row at use-time
 *     rather than a 500 throw at edit-time. Tightening to per-type
 *     shape-validation is a future slice when the profile editor UI lands
 *     (the operator-facing editor will pin shape via form fields anyway).
 *
 * Sub-brand isolation: every list / get / write goes through
 * getSubBrandAccessSet + canAccessSubBrand. A MANAGER restricted to one
 * sub-brand cannot read or write profiles attached to other sub-brands;
 * profiles with NULL subBrand are tenant-wide and visible to everyone.
 *
 * Error codes (route-specific):
 *   INVALID_ID, MISSING_FIELDS, INVALID_PROFILE_TYPE, INVALID_PROFILE_JSON,
 *   INVALID_SUB_BRAND, PROFILE_NOT_FOUND, SUB_BRAND_DENIED, EMPTY_BODY.
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
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { computeCommission } = require("../lib/agentCommissionCalculator");

const VALID_PROFILE_TYPES = ["flat_percent", "tiered", "per_pax_flat", "hybrid"];

function assertValidProfileType(t) {
  if (!VALID_PROFILE_TYPES.includes(t)) {
    const err = new Error(
      `profileType must be one of: ${VALID_PROFILE_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_PROFILE_TYPE";
    throw err;
  }
}

/**
 * Light JSON parse-only validation. Accepts already-stringified JSON
 * (the canonical shape; column is @db.Text) OR a live object/array (the
 * route stringifies it for storage). Throws INVALID_PROFILE_JSON on
 * anything unparseable. Returns the canonical stringified form ready
 * for the column.
 *
 * Deep-shape validation against profileType is deferred (see file header).
 */
function normalizeProfileJson(input) {
  if (input == null || input === "") {
    const err = new Error("profileJson is required");
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  if (typeof input === "string") {
    try {
      JSON.parse(input);
    } catch (_e) {
      const err = new Error("profileJson must be valid JSON");
      err.status = 400;
      err.code = "INVALID_PROFILE_JSON";
      throw err;
    }
    return input;
  }
  if (typeof input === "object") {
    try {
      return JSON.stringify(input);
    } catch (_e) {
      const err = new Error("profileJson must be JSON-serializable");
      err.status = 400;
      err.code = "INVALID_PROFILE_JSON";
      throw err;
    }
  }
  const err = new Error("profileJson must be a JSON object or string");
  err.status = 400;
  err.code = "INVALID_PROFILE_JSON";
  throw err;
}

// GET /api/travel/commission-profiles
// Honors ?subBrand=tmc, ?profileType=flat_percent, ?isActive=true/false.
// Sub-brand-restricted callers see only their allowed sub-brands PLUS
// tenant-wide profiles (subBrand IS NULL).
router.get(
  "/commission-profiles",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };

      if (req.query.subBrand) {
        assertValidSubBrand(String(req.query.subBrand));
        where.subBrand = String(req.query.subBrand);
      }
      if (req.query.profileType) {
        assertValidProfileType(String(req.query.profileType));
        where.profileType = String(req.query.profileType);
      }
      if (req.query.isActive !== undefined) {
        const v = String(req.query.isActive);
        if (v === "true" || v === "1") where.isActive = true;
        else if (v === "false" || v === "0") where.isActive = false;
      }

      // Sub-brand narrowing. Restricted callers see profiles whose
      // subBrand is in their allowed set OR is NULL (tenant-wide).
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (where.subBrand !== undefined) {
          if (!canAccessSubBrand(allowed, where.subBrand)) {
            where.subBrand = "__none__"; // silent-empty consistent with siblings
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

      const [profiles, total] = await Promise.all([
        prisma.travelCommissionProfile.findMany({
          where,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take,
          skip,
        }),
        prisma.travelCommissionProfile.count({ where }),
      ]);
      res.json({ profiles, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] list error:", e.message);
      res.status(500).json({ error: "Failed to list commission profiles" });
    }
  },
);

// GET /api/travel/commission-profiles/:id
router.get(
  "/commission-profiles/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand access — NULL subBrand is tenant-wide and visible to all.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }
      res.json(profile);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] get error:", e.message);
      res.status(500).json({ error: "Failed to get commission profile" });
    }
  },
);

// POST /api/travel/commission-profiles — ADMIN/MANAGER only.
// Required: name, profileType, profileJson.
// Optional: subBrand (null/omitted = tenant-wide), isActive (default true), notes.
router.post(
  "/commission-profiles",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        name, profileType, profileJson,
        subBrand, isActive, notes,
      } = req.body || {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          error: "name required",
          code: "MISSING_FIELDS",
        });
      }
      if (!profileType) {
        return res.status(400).json({
          error: "profileType required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidProfileType(profileType);
      const profileJsonString = normalizeProfileJson(profileJson);

      if (subBrand !== undefined && subBrand !== null && subBrand !== "") {
        assertValidSubBrand(subBrand);
        // Sub-brand isolation: reject create that targets a sub-brand
        // the caller can't access. Tenant-wide (null subBrand) creates
        // are allowed for any authorised caller — the gate is the
        // ADMIN/MANAGER role check above.
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const created = await prisma.travelCommissionProfile.create({
        data: {
          tenantId: req.travelTenant.id,
          name: name.trim(),
          profileType,
          profileJson: profileJsonString,
          subBrand: subBrand ? String(subBrand) : null,
          isActive: isActive === false ? false : true,
          notes: notes ? String(notes) : null,
        },
      });

      await writeAudit(
        "TravelCommissionProfile",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: created.name,
          profileType: created.profileType,
          subBrand: created.subBrand,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] create error:", e.message);
      res.status(500).json({ error: "Failed to create commission profile" });
    }
  },
);

// PUT /api/travel/commission-profiles/:id — ADMIN/MANAGER only.
// Partial update. Sub-brand reassignment requires access to both the
// existing AND the target sub-brand.
router.put(
  "/commission-profiles/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      // Caller must be able to access the existing sub-brand (NULL is
      // tenant-wide and accessible to any authorised role).
      if (existing.subBrand && !canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      const data = {};
      const {
        name, profileType, profileJson,
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
      if (profileType !== undefined) {
        assertValidProfileType(profileType);
        data.profileType = profileType;
      }
      if (profileJson !== undefined) {
        data.profileJson = normalizeProfileJson(profileJson);
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

      const updated = await prisma.travelCommissionProfile.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelCommissionProfile",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] update error:", e.message);
      res.status(500).json({ error: "Failed to update commission profile" });
    }
  },
);

// DELETE /api/travel/commission-profiles/:id — ADMIN-only hard delete.
// Audit row written BEFORE the prisma.delete fires so the intent is
// captured even if the delete subsequently throws.
router.delete(
  "/commission-profiles/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // ADMINs always have full sub-brand access (getSubBrandAccessSet
      // returns null for ADMIN role), so no additional sub-brand gate
      // is strictly needed here. Keeping the check defensive in case
      // the role/access semantics evolve.
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
        "TravelCommissionProfile",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          name: existing.name,
          profileType: existing.profileType,
          subBrand: existing.subBrand,
        },
      );

      await prisma.travelCommissionProfile.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete commission profile" });
    }
  },
);

// POST /api/travel/commission-profiles/:id/assign — ADMIN/MANAGER bulk-assign
// the profile to a list of Contact rows (B2B agents). Body: { contactIds: int[] }.
// Sub-brand-restricted callers must be able to access the profile's sub-brand.
//
// Partial-assignment semantics: when some of the requested contactIds don't
// belong to the tenant (cross-tenant probe, or already-deleted row), they're
// silently skipped — assignedCount < requestedCount surfaces the gap to the
// caller without throwing. This mirrors how prisma.updateMany naturally
// behaves with a tenant-scoped `where` clause: rows outside the tenant simply
// don't match, the call succeeds, and the count delta is the signal.
//
// Returns: { profileId, assignedCount, requestedCount }.
// Audit row: action='TRAVEL_COMMISSION_PROFILE_ASSIGNED' with the delta.
router.post(
  "/commission-profiles/:id/assign",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const { contactIds } = req.body || {};
      if (contactIds === undefined || contactIds === null) {
        return res.status(400).json({
          error: "contactIds required",
          code: "MISSING_FIELDS",
        });
      }
      if (!Array.isArray(contactIds)) {
        return res.status(400).json({
          error: "contactIds must be an array of integers",
          code: "INVALID_CONTACT_IDS",
        });
      }
      if (contactIds.length === 0) {
        return res.status(400).json({
          error: "contactIds must be non-empty",
          code: "MISSING_FIELDS",
        });
      }
      if (!contactIds.every((cid) => Number.isInteger(cid))) {
        return res.status(400).json({
          error: "contactIds entries must all be integers",
          code: "INVALID_CONTACT_IDS",
        });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate — NULL subBrand profiles are tenant-wide and
      // assignable by any authorised caller; sub-brand-scoped profiles
      // require the caller to have access to that sub-brand.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const updateResult = await prisma.contact.updateMany({
        where: {
          id: { in: contactIds },
          tenantId: req.travelTenant.id,
        },
        data: { commissionProfileId: id },
      });

      await writeAudit(
        "TravelCommissionProfile",
        "TRAVEL_COMMISSION_PROFILE_ASSIGNED",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          profileId: id,
          assignedCount: updateResult.count,
          requestedCount: contactIds.length,
        },
      );

      res.json({
        profileId: id,
        assignedCount: updateResult.count,
        requestedCount: contactIds.length,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] assign error:", e.message);
      res.status(500).json({ error: "Failed to assign commission profile" });
    }
  },
);

// POST /api/travel/commission-profiles/:id/preview — operator-facing what-if
// commission calculator. Given a profile id + sale amount (+ optional paxCount),
// parses the stored profileJson, calls lib/agentCommissionCalculator.js, and
// returns the commission that WOULD be paid out for this sale. Useful for UI
// preview before assigning a profile to a contact, or for ad-hoc finance
// sanity checks ("if I sell this Umrah package at ₹2.5L, what does the agent
// earn?"). No mutation — read-only. Any verified token; sub-brand-scoped.
//
// Body:
//   saleAmount  (required, positive number) — sale total in operator currency
//   paxCount    (optional, default 1)       — only matters for per_pax_flat
//
// Returns:
//   { profileId, profileName, profileType, saleAmount, paxCount,
//     commission, breakdown }
//
// Defensive behaviour: if the stored profileJson is malformed (parse throws,
// or parses to something the calculator can't interpret), the route still
// returns 200 with commission=0 and a breakdown string surfacing the issue.
// Same rationale as the deep-shape validation deferral at the file header —
// a misconfigured profile should be operator-visible at use-time, not a 500
// throw that the calling UI has to handle.
//
// Sub-brand gate: NULL subBrand profiles are tenant-wide and previewable by
// any authorised caller; sub-brand-scoped profiles require caller access to
// that sub-brand.
router.post(
  "/commission-profiles/:id/preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const { saleAmount, paxCount } = req.body || {};
      if (saleAmount === undefined || saleAmount === null) {
        return res.status(400).json({
          error: "saleAmount required",
          code: "MISSING_FIELDS",
        });
      }
      const saleNum = Number(saleAmount);
      if (!Number.isFinite(saleNum) || saleNum < 0) {
        return res.status(400).json({
          error: "saleAmount must be a non-negative number",
          code: "INVALID_SALE_AMOUNT",
        });
      }

      let paxNum = 1;
      if (paxCount !== undefined && paxCount !== null) {
        const p = Number(paxCount);
        if (!Number.isFinite(p) || p < 0 || !Number.isInteger(p)) {
          return res.status(400).json({
            error: "paxCount must be a non-negative integer",
            code: "INVALID_PAX_COUNT",
          });
        }
        paxNum = p;
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate — NULL subBrand profiles are tenant-wide.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Parse stored profileJson defensively. If parse throws (rare — POST/PUT
      // validators reject unparseable JSON at write time, but legacy / hand-
      // edited rows may slip through), surface as commission=0 with a
      // diagnostic breakdown rather than a 500 throw.
      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      let result;
      if (parseError) {
        result = {
          commission: 0,
          breakdown: `malformed profileJson: ${parseError}`,
          profileType: profile.profileType,
        };
      } else {
        result = computeCommission({
          saleAmount: saleNum,
          paxCount: paxNum,
          profile: parsedProfile,
        });
      }

      res.json({
        profileId: profile.id,
        profileName: profile.name,
        profileType: profile.profileType,
        saleAmount: saleNum,
        paxCount: paxNum,
        commission: result.commission,
        breakdown: result.breakdown,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] preview error:", e.message);
      res.status(500).json({ error: "Failed to preview commission" });
    }
  },
);

// GET /api/travel/commission-profiles/:id/ledger — operator-view commission
// ledger for one profile. Derives a per-Deal commission row for every Deal
// whose linked Contact carries this profile's id in commissionProfileId
// (slice 6's bulk-assign endpoint is what writes that link). For each Deal
// we run the same lib/agentCommissionCalculator.js logic the preview route
// uses (slice 7), so what an operator saw in "preview" becomes the same
// number that appears in the ledger row once the deal exists.
//
// Why this is "derived" not "stored": the dedicated SubAgentCommission table
// (PRD §3 FR-3.2.2) is Phase 1-3 work — multi-day, blocked on DD-5.3 (commission
// settlement timing) and the b2bCommissionEngine cron. Until that lands, the
// ledger is a pure read over Deal × Contact joined on commissionProfileId.
// Frontend can be built against this contract today; the storage swap
// (Phase 1 lands) is a backend-only change that keeps the response shape.
//
// Scope rules:
//   - Tenant-scoped via Contact.tenantId AND Deal.tenantId (defence in depth).
//   - Sub-brand-restricted callers must be able to access the profile's sub-brand
//     (NULL subBrand is tenant-wide, accessible to all authorised roles).
//   - Soft-deleted Deals (deletedAt != null) are excluded.
//   - Any verified token; no RBAC narrowing — the ledger is operator-readable
//     for any role allowed to see the profile. Read-only endpoint.
//
// Query string:
//   limit   default 50, max 200 (smaller default than list — ledger rows
//           are richer; keeps UI table snappy by default)
//   offset  default 0 — standard pagination
//   stage   optional Deal.stage filter (e.g. "won" for settled-only view)
//
// Response shape:
//   {
//     profileId, profileName, profileType,
//     entries: [
//       { dealId, dealTitle, dealStage, dealAmount, dealCurrency,
//         contactId, contactName, commission, breakdown, createdAt }
//     ],
//     totalEntries,
//     totalCommission,   // sum of commission across the FILTERED page
//     limit, offset
//   }
//
// Defensive behaviour: if the stored profileJson is malformed (parse throws,
// or yields an uninterpretable shape), every ledger row reports commission=0
// with a diagnostic breakdown — same posture as the preview route. Operators
// see the misconfig at use-time rather than a 500 crashing the page.
router.get(
  "/commission-profiles/:id/ledger",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate — NULL subBrand profiles are tenant-wide.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = parseInt(req.query.offset, 10) || 0;
      const stageFilter = req.query.stage ? String(req.query.stage) : null;

      // Build the where for Deals whose Contact carries this profileId.
      // Use Deal.contact -> Contact.commissionProfileId because that's where
      // slice 6's bulk-assign writes — Deal itself doesn't carry a direct
      // profile FK (intentional; profile assignment is on the Contact /
      // agent principal, not the individual deal).
      const dealWhere = {
        tenantId: req.travelTenant.id,
        deletedAt: null,
        contact: { commissionProfileId: id, tenantId: req.travelTenant.id },
      };
      if (stageFilter) dealWhere.stage = stageFilter;

      const [deals, totalEntries] = await Promise.all([
        prisma.deal.findMany({
          where: dealWhere,
          include: {
            contact: { select: { id: true, name: true } },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
          skip,
        }),
        prisma.deal.count({ where: dealWhere }),
      ]);

      // Parse stored profileJson once; reuse across all rows. Defensive:
      // malformed JSON → every row reports commission=0 with a diagnostic.
      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      const entries = deals.map((d) => {
        let result;
        if (parseError) {
          result = {
            commission: 0,
            breakdown: `malformed profileJson: ${parseError}`,
          };
        } else {
          result = computeCommission({
            saleAmount: Number(d.amount) || 0,
            paxCount: 1, // ledger does not carry per-deal paxCount yet
            profile: parsedProfile,
          });
        }
        return {
          dealId: d.id,
          dealTitle: d.title,
          dealStage: d.stage,
          dealAmount: d.amount,
          dealCurrency: d.currency,
          contactId: d.contact ? d.contact.id : null,
          contactName: d.contact ? d.contact.name : null,
          commission: result.commission,
          breakdown: result.breakdown,
          createdAt: d.createdAt,
        };
      });

      const totalCommission = entries.reduce(
        (acc, e) => acc + (Number(e.commission) || 0),
        0,
      );
      // Half-up round to 2dp — matches lib/agentCommissionCalculator's round2.
      const totalCommissionRounded =
        Math.round((totalCommission + Number.EPSILON) * 100) / 100;

      res.json({
        profileId: profile.id,
        profileName: profile.name,
        profileType: profile.profileType,
        entries,
        totalEntries,
        totalCommission: totalCommissionRounded,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] ledger error:", e.message);
      res.status(500).json({ error: "Failed to load commission ledger" });
    }
  },
);

// GET /api/travel/commission-profiles/:id/ledger.csv — CSV export of the same
// ledger payload the JSON endpoint (slice 9) emits, in operator-downloadable
// shape. Reuses the same Deal × Contact query + agentCommissionCalculator
// computation so a row visible in the JSON ledger has the identical
// commission/breakdown values in the CSV. Mirrors the GSTR-1 export precedent
// (#902 slice 10): UTF-8 with BOM + CRLF line endings + double-quote escaping
// for commas / quotes / newlines, so Excel auto-detects encoding and the
// blob round-trips through any spreadsheet tool without mojibake.
//
// Columns (in order):
//   Deal ID, Deal Title, Stage, Amount, Currency, Contact ID, Contact Name,
//   Commission, Breakdown, Created At
//
// Sub-brand gate + tenant scope + soft-delete filter are identical to slice 9.
// Optional ?stage=<deal stage> filter mirrors the JSON endpoint. Pagination
// query params are intentionally NOT honored — operators downloading a CSV
// want the full dataset for that profile, not a paginated slice. This is the
// same posture as the GSTR-1 export: filing exports are always full-period.
//
// Response:
//   200 text/csv; charset=utf-8 with Content-Disposition: attachment;
//   filename="commission-ledger-<profileId>-<profileSlug>.csv" on success.
//   Standard error envelopes (404 PROFILE_NOT_FOUND, 403 SUB_BRAND_DENIED,
//   400 INVALID_ID) match slice 9 for callers that probe before downloading.
router.get(
  "/commission-profiles/:id/ledger.csv",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate — NULL subBrand profiles are tenant-wide.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const stageFilter = req.query.stage ? String(req.query.stage) : null;

      const dealWhere = {
        tenantId: req.travelTenant.id,
        deletedAt: null,
        contact: { commissionProfileId: id, tenantId: req.travelTenant.id },
      };
      if (stageFilter) dealWhere.stage = stageFilter;

      const deals = await prisma.deal.findMany({
        where: dealWhere,
        include: { contact: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      // Local CSV escape — wrap in double-quotes when the cell carries a comma,
      // double-quote, or CR/LF. Mirrors travel_invoices.js#csvEscape so the
      // two export endpoints share the same escaping contract.
      const csvEscape = (s) => {
        if (s == null) return "";
        const str = String(s);
        if (/[",\r\n]/.test(str)) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const CRLF = "\r\n";
      const BOM = "﻿";

      const header = [
        "Deal ID",
        "Deal Title",
        "Stage",
        "Amount",
        "Currency",
        "Contact ID",
        "Contact Name",
        "Commission",
        "Breakdown",
        "Created At",
      ];

      const rows = [header.map(csvEscape).join(",")];
      for (const d of deals) {
        let result;
        if (parseError) {
          result = {
            commission: 0,
            breakdown: `malformed profileJson: ${parseError}`,
          };
        } else {
          result = computeCommission({
            saleAmount: Number(d.amount) || 0,
            paxCount: 1,
            profile: parsedProfile,
          });
        }
        rows.push(
          [
            d.id,
            d.title || "",
            d.stage || "",
            d.amount == null ? "" : Number(d.amount),
            d.currency || "",
            d.contact ? d.contact.id : "",
            d.contact && d.contact.name ? d.contact.name : "",
            result.commission,
            result.breakdown || "",
            d.createdAt ? new Date(d.createdAt).toISOString() : "",
          ]
            .map(csvEscape)
            .join(","),
        );
      }

      const csv = BOM + rows.join(CRLF) + CRLF;

      // Filename slug: profile name lowercased + spaces->hyphens, alpha-num only.
      const slug = (profile.name || `profile-${profile.id}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || `profile-${profile.id}`;
      const filename = `commission-ledger-${profile.id}-${slug}.csv`;

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      return res.status(200).send(csv);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] ledger.csv error:", e.message);
      res.status(500).json({ error: "Failed to export commission ledger CSV" });
    }
  },
);

module.exports = router;
