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
const { verifyToken } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");

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

module.exports = router;
