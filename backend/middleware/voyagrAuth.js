/**
 * voyagrAuth — API-key authentication for the voyagr (OJR) CMS lead-capture
 * endpoint mounted at /api/v1/voyagr.
 *
 * Mirrors backend/middleware/externalAuth.js (the canonical partner-API
 * auth pattern documented in CLAUDE.md). Differences from externalAuth:
 *
 *   - Sets `req.voyagrApiKey` (in addition to req.apiKey) so the route
 *     handler can attach the key's `name` to audit-log payloads for
 *     forensic attribution per F1 acceptance criteria.
 *
 *   - On 401 the response body uses the structured-error shape
 *     `{ error, code }` (UNAUTHORIZED) matching the rest of the v3.x
 *     route surface (channels-credentials-api, services-api, etc.).
 *
 * voyagr server-to-server flow:
 *   voyagr Next.js API route → POST /api/v1/voyagr/leads
 *   headers: { 'X-API-Key': 'glbs_<48-hex-chars>' }
 *
 * The voyagr browser NEVER sees the API key — it lives in voyagr's server
 * env vars only and is sent from voyagr's Next.js API route. This is why
 * the endpoint is API-key-auth, not CORS-public.
 *
 * Auth-model design decision LOCKED 2026-05-23 (commit 5de05a7) — see
 * docs/MANUAL_CODING_BACKLOG.md cluster F1 for the rationale (Option 1:
 * per-site API key minted by CRM admin; voyagr stores in env vars).
 *
 * Per-site key scoping (TODO follow-up): the ApiKey model has no `purpose`
 * column today (verified in backend/prisma/schema.prisma:771 — only id,
 * keySecret, name, createdAt, lastUsed, tenantId, userId). For F1 we
 * accept any valid ApiKey for the tenant; the F1+ scope refinement that
 * adds `purpose IN ('voyagr-lead-capture', 'all')` filtering needs an
 * additive nullable column on ApiKey + the admin-issuance UI to set it.
 * The voyagr endpoint is otherwise narrow enough (POST one row, public
 * payload, audit-logged) that mis-use of a non-voyagr key is low impact.
 */
const prisma = require("../lib/prisma");

module.exports = async function voyagrAuth(req, res, next) {
  try {
    const header = req.header("x-api-key") || req.header("X-API-Key") || "";
    const token = header.trim();

    if (!token) {
      return res
        .status(401)
        .json({ error: "Missing X-API-Key header", code: "MISSING_API_KEY" });
    }
    if (!/^glbs_[a-f0-9]{32,}$/i.test(token)) {
      return res
        .status(401)
        .json({ error: "Malformed API key", code: "MALFORMED_API_KEY" });
    }

    const apiKey = await prisma.apiKey.findUnique({
      where: { keySecret: token },
      include: { tenant: true },
    });

    if (!apiKey) {
      return res
        .status(401)
        .json({ error: "Invalid API key", code: "INVALID_API_KEY" });
    }
    if (!apiKey.tenant?.isActive) {
      return res
        .status(403)
        .json({ error: "Tenant is not active", code: "TENANT_INACTIVE" });
    }

    // Best-effort lastUsed update — don't block the request on this.
    prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsed: new Date() } })
      .catch(() => {});

    req.apiKey = apiKey;
    req.voyagrApiKey = apiKey; // alias for audit-log forensic attribution
    req.tenant = apiKey.tenant;
    req.tenantId = apiKey.tenantId;
    // Alias so route handlers written for internal JWT auth can reuse the
    // tenantWhere / req.user.tenantId pattern.
    req.user = {
      tenantId: apiKey.tenantId,
      userId: apiKey.userId,
      apiKeyId: apiKey.id,
    };

    next();
  } catch (err) {
    console.error("[voyagrAuth] error:", err.message);
    res
      .status(500)
      .json({ error: "Authentication failure", code: "AUTH_FAILURE" });
  }
};
