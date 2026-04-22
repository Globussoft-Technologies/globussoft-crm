/**
 * API-key authentication for the external partner API (/api/v1/external).
 *
 * Partner products (Callified.ai, Globus Phone, etc.) authenticate with:
 *   X-API-Key: glbs_<48-hex-chars>
 *
 * On success, req.apiKey, req.tenant, and req.tenantId are populated.
 * We deliberately do NOT populate req.user — this isn't a human session —
 * but `req.user` is aliased to `{ tenantId }` so existing tenantWhere helpers
 * continue to work unchanged when mounted under this middleware.
 */
const prisma = require("../lib/prisma");

module.exports = async function externalAuth(req, res, next) {
  try {
    const header = req.header("x-api-key") || req.header("X-API-Key") || "";
    const token = header.trim();

    if (!token) {
      return res.status(401).json({ error: "Missing X-API-Key header" });
    }
    if (!/^glbs_[a-f0-9]{32,}$/i.test(token)) {
      return res.status(401).json({ error: "Malformed API key" });
    }

    const apiKey = await prisma.apiKey.findUnique({
      where: { keySecret: token },
      include: { tenant: true },
    });

    if (!apiKey) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    if (!apiKey.tenant?.isActive) {
      return res.status(403).json({ error: "Tenant is not active" });
    }

    // Best-effort lastUsed update — don't block the request on this.
    prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsed: new Date() } })
      .catch(() => {});

    req.apiKey = apiKey;
    req.tenant = apiKey.tenant;
    req.tenantId = apiKey.tenantId;
    // Alias so route handlers written for internal JWT auth can reuse tenantWhere
    req.user = { tenantId: apiKey.tenantId, id: apiKey.userId, apiKeyId: apiKey.id };

    next();
  } catch (err) {
    console.error("[externalAuth] error:", err.message);
    res.status(500).json({ error: "Authentication failure" });
  }
};
