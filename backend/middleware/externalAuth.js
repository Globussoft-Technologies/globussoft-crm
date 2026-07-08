/**
 * API-key authentication for the external partner API (/api/v1/external).
 *
 * Partner products (Callified.ai, Globus Phone, etc.) authenticate with:
 *   X-API-Key: glbs_<hex> (CRM-generated, 48-96 hex chars after the prefix)
 *
 * The glbs_ prefix is REQUIRED. Every key ever minted into the ApiKey table
 * is glbs_-prefixed (routes/developer.js, scripts/mint-api-key.js and
 * prisma/seed-wellness.js are the only insert sites), so a bare-hex value
 * can never match a row. f9cfd96f briefly accepted raw 48-96 hex
 * "external-generated" keys, but that leniency only deferred the failure to
 * a misleading "Invalid API key": partners have twice pasted the per-tenant
 * webhook signing secret (bare 64 hex, routes/settings.js, shown once on the
 * Settings page) into the X-API-Key field. That shape now gets a specific
 * 401 pointing at Developer → API Keys instead.
 *
 * On success, req.apiKey, req.tenant, and req.tenantId are populated.
 * We deliberately do NOT populate req.user — this isn't a human session —
 * but `req.user` is aliased to `{ tenantId }` so existing tenantWhere helpers
 * continue to work unchanged when mounted under this middleware.
 *
 * Per-sub-brand key scoping (#899 follow-up, tick #20, commit 23595ae —
 * ported from backend/middleware/voyagrAuth.js so partner-API keys ALSO
 * get sub-brand isolation when posting to subBrand-aware endpoints;
 * helper extracted to backend/lib/apiKeyAuth.js per #930 on 2026-05-23):
 *   ApiKey.subBrand is the additive nullable column scoping a key to ONE
 *   Travel sub-brand. null = tenant-wide key (legacy / generic); set =
 *   'tmc'|'rfu'|'travelstall'|'visasure'. installSubBrandHelpers() wires
 *   `req.apiKeySubBrand` plus `req.requireSubBrandMatch(target)` /
 *   `req.requireSubBrandMatchOrSend(target, res)` onto the request so
 *   route handlers can enforce isolation after parsing the body's
 *   subBrand. A scoped key posting against a different sub-brand → 403
 *   SUB_BRAND_MISMATCH; a tenant-wide key (subBrand=null) is accepted
 *   against any sub-brand so existing keys keep working
 *   (backward-compatible). Route handlers that don't have a sub-brand
 *   concept (e.g. /me, /health) simply never call the helpers.
 */
const prisma = require("../lib/prisma");
const { installSubBrandHelpers } = require("../lib/apiKeyAuth");

module.exports = async function externalAuth(req, res, next) {
  try {
    const header = req.header("x-api-key") || req.header("X-API-Key") || "";
    const token = header.trim();

    if (!token) {
      return res.status(401).json({ error: "Missing X-API-Key header" });
    }
    // The glbs_ prefix is required — see header. Bare 64-hex is the exact
    // shape of the per-tenant webhook signing secret (routes/settings.js,
    // shown once on the Settings page); name that mistake specifically
    // instead of failing with a generic 401 later.
    if (!/^glbs_[a-f0-9]{48,96}$/i.test(token)) {
      if (/^[a-f0-9]{64}$/i.test(token)) {
        return res.status(401).json({
          error:
            "This looks like a webhook signing secret, not an API key. API keys start with glbs_ — generate one from Developer → API Keys.",
        });
      }
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
    // #899 follow-up (tick #20, commit 23595ae): install req.apiKeySubBrand
    // + req.requireSubBrandMatch + req.requireSubBrandMatchOrSend (extracted
    // to backend/lib/apiKeyAuth.js per #930 — see that file's header for
    // full semantics).
    installSubBrandHelpers(req, apiKey);

    next();
  } catch (err) {
    console.error("[externalAuth] error:", err.message);
    res.status(500).json({ error: "Authentication failure" });
  }
};
