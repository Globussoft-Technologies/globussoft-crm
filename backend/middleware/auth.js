const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

// JWT_SECRET should ALWAYS be set in production. Fallback retained for dev compat only.
if (!process.env.JWT_SECRET) {
  console.error("[FATAL][auth] JWT_SECRET environment variable is NOT set! Falling back to insecure dev secret. " +
    "Set JWT_SECRET in your .env immediately for any non-development environment.");
}
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(403).json({ error: "Access Denied" });

  const token = authHeader.split(" ")[1];
  try {
    const verified = jwt.verify(token, JWT_SECRET);

    // Block portal (patient) tokens from reaching staff endpoints.
    // Portal tokens carry `patientId` instead of `userId` — they must not
    // be accepted by this middleware even if signed with the same secret.
    // Guard both ways: presence of patientId, AND absence of userId.
    if (verified.patientId || !verified.userId) {
      return res.status(401).json({ error: "Invalid staff token (portal tokens are not allowed here)" });
    }

    // Backwards compat: tokens issued before multi-tenancy lack tenantId — default to 1 (Default Org)
    if (verified.tenantId === undefined || verified.tenantId === null) {
      verified.tenantId = 1;
    }
    // Block awaiting2FA temp tokens from accessing protected resources
    if (verified.awaiting2FA === true) {
      return res.status(401).json({ error: "Two-factor authentication required. Complete 2FA verification first." });
    }

    // Issue #180: token revocation. Tokens issued after this change carry a `jti`
    // claim. If the jti has been added to RevokedToken (logout, admin revoke,
    // password change), reject the request even though the JWT is still
    // cryptographically valid. Old tokens minted before the change have no jti
    // and stay valid until their natural 7-day expiry — no forced re-login.
    // No caching: a stale cache is a security hole.
    if (verified.jti) {
      try {
        const revoked = await prisma.revokedToken.findUnique({
          where: { jti: verified.jti },
          select: { id: true },
        });
        if (revoked) {
          return res.status(401).json({ error: "Session revoked. Please log in again." });
        }
      } catch (dbErr) {
        // If the lookup fails (DB blip, table not yet migrated), fail open so
        // we don't lock everyone out. This still hardens the common case.
        console.error("[auth] revoked-token lookup failed:", dbErr && dbErr.message);
      }
    }

    req.user = verified;
    next();
  } catch (err) {
    if (err && err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Session expired, please log in again" });
    }
    res.status(401).json({ error: "Invalid Authentication Token" });
  }
};

const verifyRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient Role Permissions. System Admin Required." });
    }
    next();
  };
};

module.exports = { verifyToken, verifyRole };
