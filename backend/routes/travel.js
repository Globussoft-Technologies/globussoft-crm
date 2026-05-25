// Travel CRM vertical — root route file.
//
// Day 1: ships the health endpoint so the SPA can probe the vertical is
// reachable + Phase 1 work has somewhere to land. Sub-route files
// (travel_diagnostics.js, travel_itineraries.js, travel_trips.js,
// travel_visa.js, travel_suppliers.js) will mount under this prefix as
// they ship per PRD §6.1. Mounted at /api/travel in server.js.
//
// All endpoints scope to req.user.tenantId (multi-tenant invariant) and
// reject when tenant.vertical !== "travel" via the requireTravelTenant
// middleware — generic + wellness tenants get 403 to keep cross-vertical
// surface tight.
//
// See docs/TRAVEL_CRM_PRD.md for the Phase 1 contract.

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const {
  validateGstinFormat,
  normaliseGstin,
  stateNameFromCode,
} = require("../lib/gstinValidator");

// ─── GET /api/travel/health ────────────────────────────────────────────
//
// Day 1 sanity probe. Returns the tenant's vertical + slug so the SPA
// can confirm the travel module is wired correctly end-to-end.
router.get("/health", verifyToken, requireTravelTenant, (req, res) => {
  res.json({
    status: "healthy",
    vertical: "travel",
    tenantId: req.travelTenant.id,
    tenantSlug: req.travelTenant.slug,
    tenantName: req.travelTenant.name,
    phase: "1-day-1-scaffolding",
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /api/travel/utils/validate-gstin ──────────────────────────────
//
// Slice 14 of the #902 GST & Compliance arc (PRD:
// docs/PRD_TRAVEL_GST_COMPLIANCE.md §3).  Operator-facing lookup endpoint
// wrapping the slice-13 `backend/lib/gstinValidator.js` pure validator.
// No write side effects; ADMIN+MANAGER gate (low-cost format/state/checksum
// lookup used by the supplier / contact / vendor forms before submit).
//
// Query: `?gstin=<raw>`
//
// Response shape (200 on both valid and invalid inputs — the route's job is
// to REPORT validity, not to gate on it):
//   { gstin:     <normalised uppercase>,
//     valid:     <bool>,
//     stateName: <string|null>,
//     stateCode: <string|null>,
//     errors:    [<INVALID_FORMAT|INVALID_STATE_CODE|INVALID_CHECKSUM>] }
//
// Error envelope (400) only when the `gstin` query parameter is missing /
// non-string / empty — that's a malformed request rather than a "valid but
// failed" GSTIN.  The validator's own EMPTY / NOT_STRING / BAD_LENGTH
// reasons map to a single normalised INVALID_FORMAT entry in the errors
// array so the consumer doesn't need to know about the per-stage reason
// taxonomy.
//
// Multi-error semantics: the underlying validator short-circuits on first
// failure (format → state code → checksum).  We surface ONE error code
// per call; future expansion to multi-error (e.g. simultaneous-checksum-
// and-state failures) keeps the same array shape, just adds entries.
router.get(
  "/utils/validate-gstin",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  (req, res) => {
    const raw = req.query.gstin;
    if (raw == null || typeof raw !== "string" || raw.trim() === "") {
      return res.status(400).json({
        error: "Query parameter `gstin` is required",
        code: "MISSING_GSTIN",
      });
    }
    const normalised = normaliseGstin(raw);
    const result = validateGstinFormat(raw);
    if (result.valid) {
      const stateCode = normalised.slice(0, 2);
      return res.json({
        gstin: normalised,
        valid: true,
        stateName: stateNameFromCode(stateCode),
        stateCode,
        errors: [],
      });
    }
    // Map the validator's stage-specific reasons to the externally-stable
    // error taxonomy ({ INVALID_FORMAT, INVALID_STATE_CODE, INVALID_CHECKSUM }).
    // EMPTY / NOT_STRING / BAD_LENGTH all collapse to INVALID_FORMAT since the
    // operator's mental model is "this string isn't a GSTIN."
    let code;
    switch (result.reason) {
      case "INVALID_STATE_CODE":
        code = "INVALID_STATE_CODE";
        break;
      case "INVALID_CHECKSUM":
        code = "INVALID_CHECKSUM";
        break;
      default:
        code = "INVALID_FORMAT";
        break;
    }
    // For invalid GSTINs the state code is only meaningful when the format
    // passed and the state-code lookup failed (or we got past it).  For
    // INVALID_FORMAT we cannot trust slice(0,2) — return null.  For
    // INVALID_STATE_CODE the user submitted real-looking digits but they
    // don't map; still echo back the prefix so the operator can see what
    // they typed.  For INVALID_CHECKSUM the leading 2 digits ARE a valid
    // state code (otherwise the validator would have short-circuited
    // earlier) → safe to surface name + code.
    let stateCode = null;
    let stateName = null;
    if (code === "INVALID_CHECKSUM" || code === "INVALID_STATE_CODE") {
      stateCode = normalised ? normalised.slice(0, 2) : null;
      stateName = code === "INVALID_CHECKSUM" ? stateNameFromCode(stateCode) : null;
    }
    return res.json({
      gstin: normalised,
      valid: false,
      stateName,
      stateCode,
      errors: [code],
    });
  }
);

module.exports = router;
