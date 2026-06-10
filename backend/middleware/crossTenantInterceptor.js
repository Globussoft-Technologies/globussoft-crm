/**
 * backend/middleware/crossTenantInterceptor.js
 *
 * PRD_TRAVEL_SECURITY_ARCHITECTURE FR-3.7 (S5) — request-time defense
 * against IDOR / enumeration / cross-tenant data probing on `/:id`-bearing
 * routes.
 *
 * Why this middleware exists
 * ───────────────────────────
 * The Prisma tenant-where pattern is the canonical defense:
 *   prisma.contact.findUnique({ where: { id, tenantId: req.user.tenantId } })
 * — a row in tenant B is invisible to a request authenticated for tenant A.
 *
 * Two failure modes can subvert that:
 *   (1) A route handler reads `:id` and forgets to scope tenantId in WHERE.
 *       The S2 sweep + ESLint rule (FR-3.4) catches the static form; this
 *       middleware is the runtime backstop.
 *   (2) A handler that scopes tenantId correctly still lets the attacker
 *       PROBE which ids exist in other tenants — by timing, by response-body
 *       size differences, or by the difference between "row not found"
 *       (404 from Prisma's tenant-scoped findUnique) and "row exists but
 *       you don't own it" (which a naive handler might leak via 403).
 *
 * What this middleware does
 * ─────────────────────────
 * Routes opt in by attaching `interceptCrossTenant('<modelName>')` to a
 * `/:id` handler. Before the handler runs, we:
 *   - parse `req.params.id` as an integer (defer to validateNumericId for
 *     400 on garbage; if NaN here just call next() — the handler / param
 *     middleware will reject it),
 *   - skip if there's no authenticated user (public routes are exempt),
 *   - skip if the modelName is not a real Prisma delegate (defensive
 *     against typos — better to no-op than 500),
 *   - findUnique the row selecting only `tenantId`,
 *   - if the row is missing → call next() (the handler will 404 naturally),
 *   - if `row.tenantId !== req.user.tenantId` → write a SecurityIncident
 *     row of incidentType='cross-tenant-attempt' AND return 404 NOT_FOUND
 *     (we DO NOT confirm the row exists — that's the IDOR-probing oracle
 *     we're closing).
 *   - if tenantId matches → call next() and let the handler run normally.
 *
 * Why opt-in rather than auto-discovery
 * ──────────────────────────────────────
 * At middleware time we don't know which Prisma model the route is for
 * (URL prefix → model mapping is convention, not contract). Hard-coded
 * route→model lookup tables go stale. Opt-in via a one-line wrap at the
 * route definition is explicit at the point of risk, doesn't add latency
 * on routes that haven't opted in, and is searchable in the codebase for
 * audit ("which routes have cross-tenant defense?").
 *
 * Response envelope on intercept
 * ───────────────────────────────
 * 404 NOT_FOUND mirrors how a missing row would have been rendered by
 * the handler. The body is `{ error: 'NOT_FOUND' }` — neutral, no model
 * name leakage, no row-existence confirmation. This matches the
 * "minimize attacker oracle surface" intent of the PRD.
 *
 * Why SecurityIncident is best-effort
 * ────────────────────────────────────
 * The write is awaited (we need to know if it failed) but a thrown
 * Prisma error here is swallowed + logged — we still return 404 so the
 * caller can't tell whether the incident persistence side-effect
 * succeeded. Security telemetry must never block the user-facing
 * response.
 *
 * Test contract
 * ─────────────
 * backend/test/middleware/crossTenantInterceptor.test.js pins:
 *   1. same-tenant access → next() called, no incident write
 *   2. cross-tenant access → 404 returned + SecurityIncident persisted
 *   3. non-existent row → next() called (handler will 404)
 *   4. invalid id param → next() called (validateNumericId will 400)
 *   5. unauthenticated request → next() called (public route exempt)
 *   6. unknown model name → next() called (defensive no-op)
 */
const prisma = require("../lib/prisma");

/**
 * @param {string} modelName - Prisma delegate name, e.g. 'contact', 'deal'
 * @returns {import('express').RequestHandler}
 */
function interceptCrossTenant(modelName) {
  return async function crossTenantInterceptorMW(req, res, next) {
    const rawId = req.params && req.params.id;
    if (rawId === undefined || rawId === null || rawId === "") return next();
    const id = parseInt(rawId, 10);
    // NaN check is defensive — app-level validateNumericId already 400's
    // garbage, but a route that forgot to mount validateNumericId would
    // otherwise reach here with NaN and Prisma would throw on the WHERE.
    if (!Number.isFinite(id) || id <= 0) return next();

    // No authenticated user → public route, nothing to check against.
    if (!req.user || !req.user.tenantId) return next();

    const delegate = prisma[modelName];
    if (!delegate || typeof delegate.findUnique !== "function") {
      // Unknown model name — defensive no-op rather than 500. The route
      // definition is at fault but a typo shouldn't take the request down.
      return next();
    }

    let row;
    try {
      row = await delegate.findUnique({
        where: { id },
        select: { tenantId: true },
      });
    } catch (err) {
      // Prisma threw (schema mismatch, etc.). Don't fail the request;
      // let the handler attempt its own lookup. Telemetry log only.
      // eslint-disable-next-line no-console
      console.error(
        "[crossTenantInterceptor] lookup failed for",
        modelName,
        id,
        err && err.message,
      );
      return next();
    }

    if (!row) {
      // Row doesn't exist — handler will 404 naturally. Don't write an
      // incident: a 404 from a row-doesn't-exist case isn't an attack
      // signal (it could be a stale link, a deleted-then-undeleted row,
      // etc.). Only confirmed cross-tenant access counts as an incident.
      return next();
    }

    if (row.tenantId === req.user.tenantId) {
      // Same-tenant access — pass through.
      return next();
    }

    // Cross-tenant attempt confirmed. Persist + 404.
    try {
      await prisma.securityIncident.create({
        data: {
          tenantId: req.user.tenantId,
          incidentType: "cross-tenant-attempt",
          severity: "high",
          reportJson: JSON.stringify({
            attemptedModel: modelName,
            attemptedRowId: id,
            attemptedRowTenantId: row.tenantId,
            requestingUserId: req.user.userId || null,
            requestPath: req.originalUrl || req.url || null,
            requestMethod: req.method || null,
          }),
          ipAddress: req.ip || null,
          userAgent:
            (req.headers && req.headers["user-agent"]) || null,
          url: req.originalUrl || req.url || null,
        },
      });
    } catch (err) {
      // Telemetry-write failure must not block the response. Log + move on.
      // eslint-disable-next-line no-console
      console.error(
        "[crossTenantInterceptor] incident persist failed:",
        err && err.message,
      );
    }

    return res.status(404).json({ error: "NOT_FOUND" });
  };
}

module.exports = { interceptCrossTenant };
