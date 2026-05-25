/**
 * Shared sub-brand-scoping helpers for ApiKey-authenticated middlewares.
 *
 * Mounted by both voyagrAuth.js (consumer: voyagr leads endpoint at
 * /api/v1/voyagr/leads) and externalAuth.js (consumer: partner-API routes
 * at /api/v1/external/* — Callified.ai, Globus Phone, etc.). Both
 * middlewares populate req.apiKey from a database lookup, then call
 * installSubBrandHelpers(req, apiKey) to wire the sub-brand isolation
 * surface onto req for downstream route handlers.
 *
 * Per-sub-brand key scoping semantics (#899 Part A, shipped 2026-05-23
 * commit 84efe0f for voyagrAuth; ported to externalAuth in commit 23595ae
 * 2026-05-23; extracted to this shared helper per #930 to eliminate the
 * inline duplication):
 *
 *   ApiKey.subBrand is the additive nullable column scoping a key to ONE
 *   Travel sub-brand. null = tenant-wide key (legacy / generic); set =
 *   'tmc' | 'rfu' | 'travelstall' | 'visasure'.
 *
 *   After installing, req exposes:
 *
 *     - req.apiKeySubBrand: the key's resolved subBrand (null = tenant-wide).
 *
 *     - req.requireSubBrandMatch(target): throws on mismatch.
 *         null key → any target accepted (tenant-wide key)
 *         key.subBrand === target → accepted, returns true
 *         key.subBrand !== target → throws Error with code SUB_BRAND_MISMATCH,
 *                                    status 403, expected, actual
 *
 *     - req.requireSubBrandMatchOrSend(target, res): same semantics, but
 *       writes the 403 directly to the supplied res object and returns
 *       false instead of throwing. Returns true on match. Throws on any
 *       non-SUB_BRAND_MISMATCH error (defensive — should never happen
 *       given current implementation, but preserves the contract).
 *
 *   Route handlers that don't have a sub-brand concept (e.g. /me, /health)
 *   simply never call the helpers and pay no cost.
 */

/**
 * Install req.apiKeySubBrand + req.requireSubBrandMatch + req.requireSubBrandMatchOrSend
 * onto the supplied req object, scoped to the supplied apiKey row.
 *
 * @param {object} req - Express request object (mutated in place).
 * @param {object} apiKey - The ApiKey row loaded by the caller middleware.
 *                          Only the `subBrand` field is read (null tolerated).
 */
function installSubBrandHelpers(req, apiKey) {
  req.apiKeySubBrand = apiKey.subBrand || null;

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
}

module.exports = { installSubBrandHelpers };
