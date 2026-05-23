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
 * Per-sub-brand key scoping (#899 Part A, shipped 2026-05-23):
 *   ApiKey.subBrand is the additive nullable column scoping a key to ONE
 *   Travel sub-brand. null = tenant-wide key (legacy / generic); set =
 *   'tmc'|'rfu'|'travelstall'|'visasure'. This middleware exposes the
 *   resolved subBrand on `req.apiKeySubBrand` and installs a small helper
 *   `req.requireSubBrandMatch(targetSubBrand)` that route handlers call
 *   after parsing the body's subBrand to enforce isolation. A scoped key
 *   posting against a different sub-brand → 403 SUB_BRAND_MISMATCH; a
 *   tenant-wide key (subBrand=null) is accepted against any sub-brand
 *   so existing keys keep working (backward-compatible). Route handlers
 *   that don't have a sub-brand concept (e.g. /me, /health) simply never
 *   call the helper.
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
    // #899 Part A: expose the key's sub-brand scope (null = tenant-wide).
    req.apiKeySubBrand = apiKey.subBrand || null;
    // Install the sub-brand-match helper. Route handlers call this after
    // parsing the body's subBrand to reject cross-sub-brand misuse:
    //   - key.subBrand === null   → any target accepted (tenant-wide key)
    //   - key.subBrand === target → accepted
    //   - key.subBrand !== target → 403 SUB_BRAND_MISMATCH (throws here;
    //     caller catches via try/catch OR uses requireSubBrandMatchOrSend
    //     which writes the response directly). We expose both shapes so
    //     handlers can pick whichever is cleaner in context.
    req.requireSubBrandMatch = (target) => {
      if (req.apiKeySubBrand !== null && req.apiKeySubBrand !== target) {
        const err = new Error("API key sub-brand scope does not match request sub-brand");
        err.status = 403;
        err.code = "SUB_BRAND_MISMATCH";
        err.expected = req.apiKeySubBrand;
        err.actual = target;
        throw err;
      }
      return true;
    };
    req.requireSubBrandMatchOrSend = (target, res) => {
      try {
        return req.requireSubBrandMatch(target);
      } catch (e) {
        if (e.code === "SUB_BRAND_MISMATCH") {
          res.status(403).json({
            error: `API key scoped to '${e.expected}' cannot post for sub-brand '${e.actual}'`,
            code: "SUB_BRAND_MISMATCH",
          });
          return false;
        }
        throw e;
      }
    };
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
