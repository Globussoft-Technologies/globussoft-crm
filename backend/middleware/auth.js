const jwt = require("jsonwebtoken");

// JWT_SECRET should ALWAYS be set in production. Fallback retained for dev compat only.
if (!process.env.JWT_SECRET) {
  console.error("[FATAL][auth] JWT_SECRET environment variable is NOT set! Falling back to insecure dev secret. " +
    "Set JWT_SECRET in your .env immediately for any non-development environment.");
}
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(403).json({ error: "Access Denied" });

  const token = authHeader.split(" ")[1];
  try {
    const verified = jwt.verify(token, JWT_SECRET);
    // Backwards compat: tokens issued before multi-tenancy lack tenantId — default to 1 (Default Org)
    if (verified.tenantId === undefined || verified.tenantId === null) {
      verified.tenantId = 1;
    }
    // Block awaiting2FA temp tokens from accessing protected resources
    if (verified.awaiting2FA === true) {
      return res.status(401).json({ error: "Two-factor authentication required. Complete 2FA verification first." });
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
