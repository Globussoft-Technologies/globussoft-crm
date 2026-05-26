/**
 * Shared sub-brand isolation guard for travel-vertical wrapper routes.
 *
 * Rule-of-3 promotion (tick #106): previously inlined byte-identically in
 * routes/ratehawk.js, routes/callified.js, routes/booking_expedia.js.
 * routes/adsgpt.js uses a structurally different inline variant (different
 * error message + direct variable assignment instead of envelope return)
 * and is deliberately NOT migrated this tick.
 *
 * Contract: if the caller authenticated via a sub-brand-scoped API key
 * (req.apiKeySubBrand set by externalAuth/voyagrAuth), force-pin the
 * effective sub-brand to that value AND reject any mismatching body-supplied
 * sub-brand with 403 SUB_BRAND_MISMATCH. Operator JWT auth (verifyToken-only)
 * leaves req.apiKeySubBrand undefined so cross-sub-brand operations are
 * allowed for operators.
 *
 * Pure function: no Prisma, no logger, no side effects. Returns either:
 *   { ok: true, effectiveSubBrand: <string | null> }
 *   { ok: false, status: 403, body: { error, code: "SUB_BRAND_MISMATCH" } }
 *
 * Callers either `const { resolveSubBrand } = require('../lib/subBrandResolve')`
 * OR `require('../lib/subBrandResolve').resolveSubBrand(...)` — both work
 * identically.
 *
 * @param {object} req - Express request (reads req.apiKeySubBrand)
 * @param {string|null|undefined} suppliedSubBrand - body-supplied sub-brand
 * @returns {{ok: true, effectiveSubBrand: string|null} | {ok: false, status: number, body: {error: string, code: string}}}
 */
function resolveSubBrand(req, suppliedSubBrand) {
  if (req.apiKeySubBrand !== undefined && req.apiKeySubBrand !== null) {
    if (suppliedSubBrand && suppliedSubBrand !== req.apiKeySubBrand) {
      return {
        ok: false,
        status: 403,
        body: {
          error: `API key scoped to '${req.apiKeySubBrand}' cannot operate on sub-brand '${suppliedSubBrand}'`,
          code: "SUB_BRAND_MISMATCH",
        },
      };
    }
    return { ok: true, effectiveSubBrand: req.apiKeySubBrand };
  }
  return { ok: true, effectiveSubBrand: suppliedSubBrand || null };
}

module.exports = { resolveSubBrand };
