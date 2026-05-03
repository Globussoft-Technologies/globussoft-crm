// validateNumericId.js — guard against non-numeric `:id` (and similar named-id)
// path params that would otherwise crash Prisma with a NaN where-clause and
// surface as a 500 stack trace.
//
// Why this exists (issue #423):
//
//   GET /api/deals/abc  →  parseInt('abc', 10) === NaN
//                       →  prisma.deal.findFirst({ where: { id: NaN } })
//                       →  PrismaClientValidationError thrown
//                       →  Express default error handler returns 500
//                       →  log noise + Sentry noise + bad client UX
//
// At least 5 routes were confirmed (deals, tasks, tickets, email-threading,
// landing-pages) and the pattern `parseInt(req.params.id)` without an isNaN
// check repeats across ~30 route files / 158 occurrences. Patching every
// handler is a sweep; mounting one `app.param('id', ...)` callback covers
// all of them at once.
//
// All `:id` route params in this codebase are numeric (parseInt'd before
// hitting Prisma). Non-numeric path params use distinct names: `:slug`,
// `:token`, `:provider`, `:tenantSlug`, `:name`, `:jti`, etc. Named-id
// params like `:dealId`, `:contactId`, `:userId`, `:emailId`, `:threadId`,
// `:sessionId`, `:bookingId`, `:patientId`, `:articleId`, `:pageId`,
// `:formId`, `:stepId`, `:workflowId`, `:productId`, `:enrollmentId` are
// also numeric in this codebase — see `validateNumericNamedId` exported
// below for opt-in coverage of those if a future sweep wants it.
//
// Trade-off: 400 vs 404
//   We return 400 INVALID_ID (semantically: "your request was malformed —
//   the path id isn't an integer"). Some teams prefer 404 for id-bearing
//   endpoints to avoid id-enumeration hints (a 400 confirms "this resource
//   namespace exists, you just gave a bad id" while 404 stays neutral).
//   For an internal CRM with auth-guarded routes that already responded
//   with route-specific error shapes, 400 is more honest and matches the
//   pattern in the issue's recommended fix snippet. Revisit if the
//   security team raises enumeration-hardening as a concern.

/**
 * Express param-callback that validates the matched param value is a
 * positive base-10 integer. Returns 400 INVALID_ID otherwise.
 *
 * Mount via `app.param('id', validateNumericId)` at the app level — fires
 * for every route that defines a `:id` path param, before the route
 * handler runs (but after middleware in the matching chain, including
 * the global auth guard).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {string} value     The raw param string from the URL.
 * @param {string} name      The param name (always 'id' when mounted as above).
 */
function validateNumericId(req, res, next, value, name) {
  // Strict: only digits, no leading zeros (we don't want to accept
  // "01" as 1 silently — that's a separate sanity issue), no signs,
  // no whitespace, no decimals. parseInt('1abc') === 1 would otherwise
  // sneak through.
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    // Special-case: "0" is a valid integer but not a valid Prisma row id
    // (auto-increment starts at 1). Reject it the same way.
    return res.status(400).json({
      // Phrasing chosen to match pre-existing spec assertions like
      // /invalid id/i and /invalid (invoice|entity)? ?id/i. Keeping the
      // raw value out of the message to avoid log-injection / reflected
      // XSS via the error path.
      error: `Invalid ${name || "id"}: must be a positive integer`,
      code: "INVALID_ID",
    });
  }
  // The handler will call parseInt itself; we don't mutate req.params
  // because every existing handler already does `parseInt(req.params.id)`.
  // Mutating it to a Number would break that call (`parseInt(1)` works but
  // is a smell) and we don't need to — the validation alone is enough.
  next();
}

/**
 * Same validator, but parameterised so it can be mounted on named-id
 * params (`:dealId`, `:contactId`, `:userId`, `:emailId`, `:threadId`,
 * `:sessionId`, etc.) in a future sweep. Currently NOT wired in
 * server.js — left here so the next agent doesn't have to re-derive it.
 *
 * Usage (NOT wired today):
 *   app.param('dealId', validateNumericId);
 *   app.param('contactId', validateNumericId);
 *   ...
 *
 * Why deferred: each named-id param needs an audit to confirm it's
 * actually numeric (e.g. `:sessionId` could plausibly be a UUID in some
 * future route). The current sweep stops at `:id` to keep the blast
 * radius small and the rollback trivial.
 */
const validateNumericNamedId = validateNumericId;

module.exports = { validateNumericId, validateNumericNamedId };
