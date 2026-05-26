/**
 * verifyWellnessRole — orthogonal to verifyRole.
 *
 * Wellness users carry both the standard RBAC `role` field
 * (ADMIN/MANAGER/USER) and a `wellnessRole` (doctor / professional /
 * telecaller / helper). The standard verifyRole() middleware is blind to
 * wellnessRole, so a `role=USER, wellnessRole=doctor` doctor would have
 * passed Owner-Dashboard / financial / org-wide endpoints. This middleware
 * fixes that — use it AFTER verifyToken on wellness routes that need a
 * narrower clinical/operational gate.
 *
 * Allowed list accepts wellnessRole values plus three special tokens:
 *   - "admin"    → owner override; req.user.role === "ADMIN" always passes.
 *   - "manager"  → req.user.role === "MANAGER" passes.
 *   - "clinical" → ANY wellnessRole present in the tenant's
 *                  WellnessRoleType catalog with `canTakeVisits = true`
 *                  passes. Lets admins add a new clinical role (e.g.
 *                  "nurse", "physiotherapist") in Settings → Wellness
 *                  Role Types and have it flow through every clinical
 *                  route automatically with NO code edits.
 * Everything else must literally match req.user.wellnessRole.
 *
 * Optional second argument `{ anyOfPermissions: [{module, action}, ...] }`
 * lets a route ALSO accept RBAC-permission-based access — any user
 * whose effective permissions include AT LEAST ONE of the listed
 * grants passes the gate, even without a matching wellnessRole. This
 * is what makes a brand-new custom role (e.g. "Receptionist") created
 * in the Roles & Permissions admin UI immediately usable: the admin
 * grants `appointments.read` to the role and the user gains access to
 * every route whose `anyOfPermissions` lists that grant — with NO
 * code changes anywhere.
 *
 * Backwards-compat: tokens minted before the JWT carries `wellnessRole`
 * lack the claim entirely. They will fail any clinical/operational gate
 * unless the caller is ADMIN or MANAGER. That is the correct behavior —
 * a USER with no wellnessRole has no clinical mandate, so 403 is right.
 *
 * On reject we surface a stable code so the frontend / tests can
 * distinguish role denials from generic 403s. As of #590 / #591, the
 * human-facing `error` is the SAME neutral copy emitted by verifyRole's
 * RBAC_DENIED envelope (no role-taxonomy leakage in the toast string).
 * Two stable codes remain to differentiate WHY the denial fired so SDKs
 * / specs / audit trails can branch on intent without parsing the
 * user-facing text:
 *   - `WELLNESS_TENANT_REQUIRED` — caller is on a non-wellness tenant
 *   - `WELLNESS_ROLE_FORBIDDEN`  — caller's wellnessRole isn't in the
 *                                  allowed list for this route
 * The `allowed` array continues to ship in the WELLNESS_ROLE_FORBIDDEN
 * envelope (per #274's structured-403 contract pinned by services-api).
 * That's technical metadata for the frontend toast mapper, NOT a
 * user-visible string.
 */
// #325: tenant.vertical gate. Pre-this-fix, an ADMIN from the GENERIC
// tenant (admin@globussoft.com) could call /api/wellness/dashboard
// because the middleware passed any role==="ADMIN" through without
// checking the tenant vertical. Now we refuse anyone whose tenant is
// not wellness, regardless of role.
//
// Tokens issued post-#325 carry `vertical` in the JWT payload. Older
// tokens don't, so we fall back to a single Tenant lookup keyed by the
// tenantId already on the JWT. The lookup is cached on req.user for
// the lifetime of the request to avoid repeat hits when the same
// request flows through multiple gated middlewares.
const prisma = require("../lib/prisma");
// #590 / #591: share the canonical RBAC denial copy so wellness role
// denials surface the same neutral string as generic verifyRole denials.
// We keep the granular `code` (WELLNESS_TENANT_REQUIRED /
// WELLNESS_ROLE_FORBIDDEN) so SDKs / specs can branch on intent.
const { RBAC_DENIED_MESSAGE } = require("./auth");
// Whole-module require (NOT destructured) so unit tests can swap out
// `requirePermissionModule.getUserPermissions` with a deterministic fake
// without losing the reference — destructuring at require-time would
// freeze the original function in a const that test re-assignment can't
// affect.
const requirePermissionModule = require("./requirePermission");

async function resolveTenantVertical(req) {
  if (req.user?.vertical) return req.user.vertical;
  if (!req.user?.tenantId) return null;
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { vertical: true },
    });
    const vertical = tenant?.vertical || "generic";
    req.user.vertical = vertical; // memoize on the request
    return vertical;
  } catch (_e) {
    return null;
  }
}

// Per-request memoized lookup: is the given wellnessRole key marked as
// a clinical role (canTakeVisits = true) in the tenant's
// WellnessRoleType catalog? Returns false on missing key, inactive row,
// or any DB error — callers degrade to "literal-match only" semantics,
// preserving the pre-catalog behaviour as the safety net.
async function isCatalogClinical(req, key) {
  if (!key || !req.user?.tenantId) return false;
  if (!req._wellnessRoleCatalog) {
    try {
      const rows = await prisma.wellnessRoleType.findMany({
        where: { tenantId: req.user.tenantId, isActive: true },
        select: { key: true, canTakeVisits: true },
      });
      const map = new Map();
      for (const r of rows) map.set(r.key, !!r.canTakeVisits);
      req._wellnessRoleCatalog = map;
    } catch (_e) {
      req._wellnessRoleCatalog = new Map();
    }
  }
  return req._wellnessRoleCatalog.get(key) === true;
}

function verifyWellnessRole(allowed, opts = {}) {
  if (!Array.isArray(allowed) || allowed.length === 0) {
    throw new Error("verifyWellnessRole(allowed): non-empty array required");
  }
  const anyOfPermissions = Array.isArray(opts.anyOfPermissions)
    ? opts.anyOfPermissions.filter((p) => p && p.module && p.action)
    : [];
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    // #325: tenant vertical gate. Wellness gated routes must reject
    // non-wellness tenants no matter how high their role is. Anything
    // other than "wellness" → 403. Unknown/null → fail closed.
    //
    // #590 / #591: human-facing `error` message is the canonical neutral
    // RBAC copy (no taxonomy leakage). `code` is still the granular
    // identifier so SDKs / specs can branch on the precise reason.
    const vertical = await resolveTenantVertical(req);
    if (vertical !== "wellness") {
      return res.status(403).json({
        error: RBAC_DENIED_MESSAGE,
        code: "WELLNESS_TENANT_REQUIRED",
      });
    }
    if (allowed.includes("admin") && req.user.role === "ADMIN") return next();
    if (allowed.includes("manager") && req.user.role === "MANAGER") return next();
    if (req.user.wellnessRole && allowed.includes(req.user.wellnessRole)) {
      return next();
    }
    // "clinical" meta-token: passes any wellnessRole the tenant's
    // WellnessRoleType catalog marks as `canTakeVisits = true`. This
    // means an admin can add a new clinical role (nurse,
    // physiotherapist, etc.) from Settings → Wellness Role Types and it
    // immediately becomes accepted by every clinical-gated route — no
    // code change required.
    if (allowed.includes("clinical") && (await isCatalogClinical(req, req.user.wellnessRole))) {
      return next();
    }
    // RBAC-permission fallback: pass if the user's effective
    // permissions (merged from every UserRole assignment) include AT
    // LEAST ONE of the route's `anyOfPermissions` grants. Lets an
    // admin spin up a brand-new custom role like "Receptionist" in
    // Roles & Permissions, grant `appointments.read`, and have the
    // assignee immediately use the appointments UI — without needing
    // to also pick a wellnessRole or edit any code.
    if (anyOfPermissions.length > 0 && req.user.tenantId && req.user.userId) {
      try {
        const userPerms = await requirePermissionModule.getUserPermissions(
          req.user.tenantId,
          req.user.userId,
        );
        for (const { module, action } of anyOfPermissions) {
          if (userPerms.has(`${module}.${action}`)) {
            return next();
          }
        }
      } catch (_e) {
        // Fail-closed: if the permission lookup throws, fall through
        // to 403 — never accidentally grant access on a DB hiccup.
      }
    }
    // `allowed` stays in the envelope to honour the #274 contract
    // (services-api spec pins it; frontend toast mapper keys off the
    // structured 403 shape). #591's concern is the human-facing
    // `error` MESSAGE — that's neutral now. The `allowed` array is
    // technical metadata, not user-visible toast copy.
    return res.status(403).json({
      error: RBAC_DENIED_MESSAGE,
      code: "WELLNESS_ROLE_FORBIDDEN",
      allowed,
    });
  };
}

module.exports = { verifyWellnessRole };
