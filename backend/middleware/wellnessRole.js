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
 * Allowed list accepts wellnessRole values plus two special tokens:
 *   - "admin"   → owner override; req.user.role === "ADMIN" always passes.
 *   - "manager" → req.user.role === "MANAGER" passes.
 * Everything else must literally match req.user.wellnessRole.
 *
 * Backwards-compat: tokens minted before the JWT carries `wellnessRole`
 * lack the claim entirely. They will fail any clinical/operational gate
 * unless the caller is ADMIN or MANAGER. That is the correct behavior —
 * a USER with no wellnessRole has no clinical mandate, so 403 is right.
 *
 * On reject we surface a stable code (`WELLNESS_ROLE_FORBIDDEN`) so the
 * frontend / tests can distinguish this from generic 403s.
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

function verifyWellnessRole(allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) {
    throw new Error("verifyWellnessRole(allowed): non-empty array required");
  }
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    // #325: tenant vertical gate. Wellness gated routes must reject
    // non-wellness tenants no matter how high their role is. Anything
    // other than "wellness" → 403. Unknown/null → fail closed.
    const vertical = await resolveTenantVertical(req);
    if (vertical !== "wellness") {
      return res.status(403).json({
        error: "Wellness vertical required",
        code: "WELLNESS_TENANT_REQUIRED",
      });
    }
    if (allowed.includes("admin") && req.user.role === "ADMIN") return next();
    if (allowed.includes("manager") && req.user.role === "MANAGER") return next();
    if (req.user.wellnessRole && allowed.includes(req.user.wellnessRole)) {
      return next();
    }
    return res.status(403).json({
      error: "Insufficient wellness role",
      code: "WELLNESS_ROLE_FORBIDDEN",
      allowed,
    });
  };
}

module.exports = { verifyWellnessRole };
