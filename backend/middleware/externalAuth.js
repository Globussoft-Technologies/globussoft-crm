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
 *
 * Per-sub-brand key scoping (#899 follow-up, tick #20 — ported from
 * backend/middleware/voyagrAuth.js so partner-API keys ALSO get sub-brand
 * isolation when posting to subBrand-aware endpoints):
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
 *
 * NOTE: this helper is intentionally duplicated between voyagrAuth.js and
 * externalAuth.js (both middlewares benefit from the same scoping logic).
 * Future cleanup will extract to backend/lib/apiKeyAuth.js so both import
 * from a single canonical source — see follow-up GH issue filed at the
 * time of this commit.
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
    // #899 follow-up (tick #20): expose the key's sub-brand scope
    // (null = tenant-wide). Mirror of the voyagrAuth.js helper — see file
    // header for the dual-middleware-duplication note + planned extraction
    // to backend/lib/apiKeyAuth.js.
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

    next();
  } catch (err) {
    console.error("[externalAuth] error:", err.message);
    res.status(500).json({ error: "Authentication failure" });
  }
};
