/**
 * phiReadGate — reusable PHI-read access gate factory.
 *
 * #920 slice S42 — wellness PHI list-endpoint slim projection.
 *
 * Why this module exists
 * ----------------------
 * The wellness clinical surface has carried a `phiReadGate` definition
 * INLINE inside [backend/routes/wellness.js](../routes/wellness.js) since
 * the #527 / #533 PHI-gate landing (CRIT-02 + HI-04). That inline gate is
 * the load-bearing access control on 25+ GET handlers in wellness.js:
 *
 *   GET /patients               GET /visits               GET /prescriptions
 *   GET /patients/:id           GET /visits/:id           GET /consents
 *   GET /patients/:id/visits    GET /visits/:id/photos    GET /treatment-plans
 *   GET /patients/:id/Rx        GET /visits/:id/consumes  GET /reports/visit
 *   GET /patients/:id/consents  …                         …
 *
 * The inline declaration works fine for wellness.js itself but is invisible
 * to NEW route files that want to gate a PHI read with the same policy.
 * Currently a new route author either (a) cross-imports the const from
 * wellness.js (circular-risk; wellness.js is a large module) or (b)
 * cargo-cults `verifyWellnessRole([...])` with their own subset that drifts
 * from the canonical PHI-read allowlist over time.
 *
 * This middleware module exposes a `makePhiReadGate()` factory that the
 * future routes can `require()` without touching wellness.js. The factory
 * mirrors the inline definition byte-for-byte (same allowed list, same
 * `anyOfPermissions` cluster, same `deny: ["helper"]` clause) so adopting
 * it gives a new route the IDENTICAL gate semantics. Once a critical mass
 * of routes opts in, a future slice can flip wellness.js to import from
 * here — but that's deferred (cross-cutting churn on 25+ handlers in a
 * single file is exactly what the audit-cross-cutting-spec-impact skill
 * warns against).
 *
 * This module is INTENTIONALLY a thin factory, NOT an instance. Each
 * adopting route should `const phiReadGate = makePhiReadGate()` at module
 * load and use `phiReadGate` in handler lists. Sharing a single instance
 * across modules works (verifyWellnessRole's returned async function has
 * no per-instance state) but the factory shape leaves room for future
 * per-route customisation (e.g. an `extraDeny: []` override for a tighter
 * surface) without breaking adopters.
 *
 * Why a thin module instead of "just import from routes/wellness.js"
 * ------------------------------------------------------------------
 * routes/wellness.js is ~10kloc and pulls in pdfRenderer + Twilio + multer
 * + the orchestrator-engine module — every dependency in the wellness
 * stack. A new admin/audit/external route that needs the gate would
 * indirectly drag all of that in, slowing module-load and tangling its
 * dependency graph. This middleware module deliberately stays narrow:
 * only `../middleware/wellnessRole` and (transitively) `../lib/prisma`.
 *
 * Why we do NOT extract the inline wellness.js declaration NOW
 * -----------------------------------------------------------
 * The inline `phiReadGate` const in wellness.js is referenced 25+ times in
 * that single file. Replacing it with an `require()` of this module would
 * be a single-character change (rename) per call-site, but the diff would
 * be a cross-cutting noise commit that the executing-cross-route-shape-
 * sweep skill specifically calls out as anti-pattern in a slice this size.
 * The cleanly-isolated wave to do that is its own slice — flagged as a
 * follow-up gap in the S42 return report. This slice just adds the
 * canonical surface so future routes don't have to invent their own.
 *
 * Audit-coordination contract (#920 slice S42)
 * --------------------------------------------
 * This module is the access-control layer only. It does NOT emit audit
 * rows on a 200 (the route handler does that via `writeAudit("Patient",
 * "PATIENT_LIST_READ", ...)`). Failed access attempts are emitted via
 * the standard 403 response envelope (`code: WELLNESS_ROLE_FORBIDDEN`)
 * which the existing audit-log capture in `server.js` already records via
 * the request-log middleware. Splitting "gate emits 403 audit" from
 * "route emits 200 PATIENT_LIST_READ audit" keeps the responsibilities
 * narrow — the gate doesn't need to know about the route's PHI shape;
 * the route doesn't need to know about the gate's denial path.
 */
const { verifyWellnessRole } = require("./wellnessRole");

/**
 * Build the canonical wellness PHI-read gate.
 *
 * The returned middleware enforces the EXACT policy the inline definition
 * in routes/wellness.js (line ~356) carries:
 *
 *   Allowed wellnessRole values:
 *     - "clinical"  — meta-token resolving against tenant's
 *                     WellnessRoleType catalog (any role with
 *                     canTakeVisits=true)
 *     - "doctor"    — literal-match short-circuit
 *     - "professional" — literal-match short-circuit
 *     - "telecaller" — needs PHI context to dispose junk leads
 *     - "admin" (ADMIN bypass)
 *     - "manager" (MANAGER bypass)
 *
 *   anyOfPermissions backdoor (RBAC permission-based access):
 *     - patients.read | appointments.read | my_appointments.read
 *     - waitlist.read | calendar.read | visits.read
 *     - prescriptions.read | consents.read
 *
 *   deny:
 *     - "helper" — non-clinical role; explicit deny so the
 *                  appointments.read backdoor (granted to helpers for
 *                  self-service) doesn't accidentally let helpers read
 *                  PHI through this gate.
 *
 * @returns {Function} async (req, res, next) => void — Express middleware
 */
function makePhiReadGate() {
  return verifyWellnessRole(
    ["clinical", "doctor", "professional", "telecaller", "admin", "manager"],
    {
      anyOfPermissions: [
        { module: "patients", action: "read" },
        { module: "appointments", action: "read" },
        { module: "my_appointments", action: "read" },
        { module: "waitlist", action: "read" },
        { module: "calendar", action: "read" },
        { module: "visits", action: "read" },
        { module: "prescriptions", action: "read" },
        { module: "consents", action: "read" },
      ],
      deny: ["helper"],
    },
  );
}

module.exports = { makePhiReadGate };
