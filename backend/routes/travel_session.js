
// Travel CRM — sub-brand session scope (Q25 / WS-1).
//
// Two endpoints backing the sidebar sub-brand switcher:
//   POST /api/travel/session/switch-brand  { subBrand }  → validate the
//        requested sub-brand against the caller's subBrandAccess and echo it
//        back as the active scope. This is the AUTHORITATIVE server-side
//        gate: the sidebar dropdown (frontend/src/utils/subBrand.jsx) is only
//        a client-side convenience (sessionStorage), so this endpoint is what
//        guarantees a user can never activate a sub-brand they hold no grant
//        for.
//   GET  /api/travel/session/active-brand  → return the caller's allowed
//        sub-brand set (resolved from subBrandAccess) so the switcher can
//        render only the brands the user may pick.
//
// Stateless by design. The codebase already scopes sub-brand at request time
// (?subBrand= / body subBrand, narrowed by getSubBrandAccessSet on every data
// route — see middleware/travelGuards.js), and the active selection persists
// client-side in frontend/src/utils/subBrand.jsx. These endpoints add the
// missing SERVER-SIDE validation layer WITHOUT introducing a session store or
// altering any existing model. All sub-brand plumbing is reused verbatim from
// middleware/travelGuards.js — nothing here re-derives the access policy.

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  assertValidSubBrand,
  VALID_SUB_BRANDS,
} = require("../middleware/travelGuards");

// Resolve the caller's allowed sub-brand list. getSubBrandAccessSet returns:
//   null      → full access (admins / unset subBrandAccess) → expand to all 4
//   Set(...)  → the explicitly-granted ids
//   Set() []  → explicit deny-all (#976) → empty list
function resolveAllowed(accessSet) {
  if (accessSet === null) return [...VALID_SUB_BRANDS];
  return [...accessSet];
}

// GET /session/active-brand — the switcher's bootstrap call. Returns the
// brands the caller may activate. `fullAccess` lets the client distinguish
// "admin sees everything" from "explicitly granted these N".
router.get("/session/active-brand", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const accessSet = await getSubBrandAccessSet(req.user.userId);
    res.json({
      allowed: resolveAllowed(accessSet),
      fullAccess: accessSet === null,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-session] active-brand error:", e.message);
    res.status(500).json({ error: "Failed to resolve active sub-brand" });
  }
});

// POST /session/switch-brand { subBrand } — authoritative validation gate.
//   400 INVALID_SUB_BRAND   — subBrand missing or not one of the 4 canonical ids
//   403 SUB_BRAND_FORBIDDEN — valid id but not in the caller's grant set
//   200 { activeSubBrand, allowed } — caller may scope to this sub-brand
router.post("/session/switch-brand", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const requested = req.body?.subBrand;
    assertValidSubBrand(requested); // throws 400 INVALID_SUB_BRAND (handles missing too)

    const accessSet = await getSubBrandAccessSet(req.user.userId);
    if (accessSet !== null && !accessSet.has(requested)) {
      return res.status(403).json({
        error: `You do not have access to the ${requested} sub-brand`,
        code: "SUB_BRAND_FORBIDDEN",
      });
    }

    res.json({
      activeSubBrand: requested,
      allowed: resolveAllowed(accessSet),
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-session] switch-brand error:", e.message);
    res.status(500).json({ error: "Failed to switch sub-brand" });
  }
});

module.exports = router;
