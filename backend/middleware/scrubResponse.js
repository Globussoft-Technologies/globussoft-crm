// ─────────────────────────────────────────────────────────────────────────────
// scrubResponse — strip credential-shaped fields from every API response payload.
//
// Why this exists (#426): Contact.portalPasswordHash (bcrypt) was being leaked
// on every GET /api/contacts and GET /api/contacts/:id response, plus on every
// Contact-returning endpoint that uses raw findMany/findFirst without a select
// clause, plus on every nested `include: { contact: true }` across billing /
// communications / ai_scoring / booking_pages / etc. Fixing each route is
// whack-a-mole — a single new route that returns Contact rows without a select
// re-introduces the leak.
//
// The fix wraps res.json globally so the scrub runs at the response boundary,
// regardless of how the data was loaded. routes/portal.js still reads
// portalPasswordHash server-side for OTP/password verification (never echoed
// back) — those code paths are unaffected because the scrub only touches the
// JSON payload as it leaves Express.
//
// What gets stripped: any object key whose name is in FORBIDDEN_FIELDS,
// regardless of nesting depth. Walker descends into arrays + plain objects;
// Date and Buffer instances short-circuit (no useful keys, fast skip).
//
// What does NOT get stripped: the server-internal use of these fields (Prisma
// queries, bcrypt.compare calls, etc.) — those operate on objects before
// res.json is called.
//
// How to extend: add a key name to FORBIDDEN_FIELDS. The single source of
// truth is this file; do not duplicate the deny-list in route handlers.
// Candidates worth adding when the related routes get audited:
//   - User.password, User.twoFactorSecret (separate sweep — see #427 triage)
//   - PatientOtp.otp (currently plaintext; see schema docstring)
//   - SsoConfig.clientSecret (admin-only route already, but defense in depth)
// ─────────────────────────────────────────────────────────────────────────────

// Field names that must never appear in any API response payload.
// Order doesn't matter; lookup is O(1) via Set.
const FORBIDDEN_FIELDS = new Set([
  // Customer-portal bcrypt hash. Never useful on the wire — portal.js compares
  // server-side, all other routes had no business returning it.
  'portalPasswordHash',
]);

// Walk a JSON-shaped value, deleting any key in FORBIDDEN_FIELDS. Mutates
// in place because response payloads are throwaway by the time res.json runs.
//
// Type guards: skip primitives (return-as-is), skip Date / Buffer (no useful
// keys, walking them is wasted work). Arrays recurse into each element.
// Plain objects iterate keys.
function scrubValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) scrubValue(item);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      delete value[key];
      continue;
    }
    scrubValue(value[key]);
  }
  return value;
}

// Express middleware. Wraps res.json once per request so every json() call
// from any downstream route handler routes through the scrubber.
function scrubResponse(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function patchedJson(body) {
    return originalJson(scrubValue(body));
  };
  next();
}

module.exports = { scrubResponse, scrubValue, FORBIDDEN_FIELDS };
