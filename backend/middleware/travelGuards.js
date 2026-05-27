// Travel CRM — shared route guards + sub-brand access helpers.
//
// Extracted from the per-route inline duplicates that landed in Days 1,
// 3, 6, 7 (travel.js, travel_diagnostics.js, travel_itineraries.js,
// travel_trips.js — ~160 lines of copy-pasted guard logic). Centralising
// here means:
//   - one place to update the vertical-guard query if the Tenant model
//     ever changes
//   - one canonical list of valid sub-brands (no risk of one route
//     accepting "umrah" while another expects "rfu")
//   - one canonical sub-brand-access policy (admins full, non-admins
//     narrowed by User.subBrandAccess[])
//
// All four travel-route files are migrated in the same commit as this
// module's introduction so the lib + callsite are kept in sync — no
// straddling state.

const prisma = require("../lib/prisma");

const VALID_SUB_BRANDS = Object.freeze(["tmc", "rfu", "travelstall", "visasure"]);

/**
 * Express middleware — requires the caller's tenant to have
 * `vertical === "travel"`. Attaches `req.travelTenant` ({ id, vertical,
 * name, slug }) on success.
 *
 * Failure paths return:
 *   401 NO_TENANT           — no req.user.tenantId on the request
 *   404 TENANT_NOT_FOUND    — tenant row missing (deleted concurrently)
 *   403 WRONG_VERTICAL      — tenant exists but vertical != "travel"
 *   500 VERTICAL_GUARD_ERROR — DB query threw
 */
async function requireTravelTenant(req, res, next) {
  try {
    if (!req.user?.tenantId) {
      return res.status(401).json({ error: "Unauthenticated", code: "NO_TENANT" });
    }
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { id: true, vertical: true, name: true, slug: true },
    });
    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
    }
    if (tenant.vertical !== "travel") {
      return res.status(403).json({
        error: "Travel CRM features require a travel-vertical tenant",
        code: "WRONG_VERTICAL",
      });
    }
    req.travelTenant = tenant;
    next();
  } catch (e) {
    console.error("[travelGuards] requireTravelTenant error:", e.message);
    res.status(500).json({ error: "Vertical guard failure", code: "VERTICAL_GUARD_ERROR" });
  }
}

/**
 * Returns the set of sub-brand codes the user can act on, or `null` for
 * full access. Admins always get null (full access regardless of the
 * subBrandAccess column).
 *
 * Returns an empty Set on lookup failure (user row missing), on malformed
 * JSON in the subBrandAccess column, or on an explicit empty array `"[]"`
 * (the natural way to express "not-yet-onboarded — no sub-brand grants").
 * Callers should treat an empty Set as "deny everything" (the per-route
 * convention is to short-circuit to an all-zeros / no-op envelope so the
 * dashboard tile renders cleanly rather than 403'ing).
 *
 * Distinguishing the deny-all (`new Set()`) path from the full-access
 * (`null`) path matters because:
 *   - `null` from a missing/unset subBrandAccess column means "no scope
 *     restriction declared" → fall back to tenant-wide access (admin-like).
 *   - `new Set()` from an explicit `"[]"` means "scope declared and it's
 *     empty" → deny everything inside the tenant. (Per #976.)
 * Non-array JSON (e.g. `'{"tmc":true}'`) preserves the null/full-access
 * fallback because the shape is malformed-but-non-array — we can't tell
 * whether the operator intended deny-all or just typo'd a non-array
 * structure, so defaulting to null preserves backward-compatibility with
 * any historical bad rows.
 */
async function getSubBrandAccessSet(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subBrandAccess: true, role: true },
  });
  if (!user) return new Set();
  if (user.role === "ADMIN") return null;
  if (!user.subBrandAccess) return null;
  try {
    const arr = JSON.parse(user.subBrandAccess);
    if (!Array.isArray(arr)) return null; // malformed (non-array) → full access (preserved)
    if (arr.length === 0) return new Set(); // explicit "[]" → deny-all (#976)
    return new Set(arr.filter((s) => VALID_SUB_BRANDS.includes(s)));
  } catch (_e) {
    return new Set();
  }
}

/**
 * Returns true iff the caller (whose access set is `allowed`) can
 * touch the named sub-brand. `allowed === null` means full access
 * (admin or unset subBrandAccess).
 */
function canAccessSubBrand(allowed, subBrand) {
  if (allowed === null) return true;
  if (!(allowed instanceof Set)) return false;
  return allowed.has(subBrand);
}

/**
 * Throw a request-friendly error if `subBrand` isn't one of the
 * recognised values. Route handlers catch `e.status` / `e.code` and
 * 400 the response.
 */
function assertValidSubBrand(subBrand) {
  if (!VALID_SUB_BRANDS.includes(subBrand)) {
    const err = new Error(`subBrand must be one of: ${VALID_SUB_BRANDS.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_SUB_BRAND";
    throw err;
  }
}

/**
 * Helper: narrows a `where` clause's `subBrand` field per the caller's
 * access set. Mutates and returns the where for convenience. Pattern:
 *
 *   const where = { tenantId: req.travelTenant.id };
 *   if (req.query.subBrand) where.subBrand = req.query.subBrand;
 *   const allowed = await getSubBrandAccessSet(req.user.userId);
 *   narrowWhereBySubBrand(where, allowed);
 *
 * The narrow rule: if the caller has full access (allowed=null) no
 * change; otherwise we set/intersect `where.subBrand` to the allowed
 * set. When the query already filters on a specific subBrand and the
 * caller doesn't have access to it, we substitute "__none__" so the
 * query returns zero rows rather than 403'ing (consistent with the
 * existing fetchApi pattern of silently empty result-sets — the user
 * won't be able to see what they're not entitled to see).
 */
function narrowWhereBySubBrand(where, allowed) {
  if (allowed === null) return where;
  if (where.subBrand !== undefined) {
    if (!canAccessSubBrand(allowed, where.subBrand)) {
      where.subBrand = "__none__";
    }
    return where;
  }
  where.subBrand = { in: [...allowed] };
  return where;
}

/**
 * PRD §4.1 diagnostic-first guard.
 *
 * Throws a 403 DIAGNOSTIC_REQUIRED error if no TravelDiagnostic exists
 * for the given (tenantId, contactId, subBrand). The PRD requires that
 * "across all four brands, customers MUST take the diagnostic before
 * any package/price is shown" — concretely, the customer-facing
 * Itinerary creation rejects when the prerequisite isn't met.
 *
 * Intentionally permissive on `classification`: any TravelDiagnostic
 * row (even one with score=null because the bank scoring failed)
 * counts as "diagnostic taken." The hard requirement per the PRD is
 * "completed diagnostic," and we use row existence as the contract.
 * If a stricter completeness rule lands later (e.g. classification
 * must be set), tighten the where clause here.
 *
 * Throws a tagged error the route's catch block converts to:
 *   { status: 403, code: "DIAGNOSTIC_REQUIRED",
 *     error: "Contact has no completed diagnostic for this sub-brand" }
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} tenantId
 * @param {number} contactId
 * @param {string} subBrand
 */
async function assertCompletedDiagnostic(prisma, tenantId, contactId, subBrand) {
  const count = await prisma.travelDiagnostic.count({
    where: { tenantId, contactId, subBrand },
  });
  if (count === 0) {
    const err = new Error("Contact has no completed diagnostic for this sub-brand");
    err.status = 403;
    err.code = "DIAGNOSTIC_REQUIRED";
    throw err;
  }
}

module.exports = {
  VALID_SUB_BRANDS,
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  narrowWhereBySubBrand,
  assertCompletedDiagnostic,
};
