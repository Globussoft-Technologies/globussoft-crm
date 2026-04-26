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
function verifyWellnessRole(allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) {
    throw new Error("verifyWellnessRole(allowed): non-empty array required");
  }
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
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
