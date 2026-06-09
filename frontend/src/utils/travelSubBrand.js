/**
 * Travel-vertical sub-brand helpers.
 *
 * Rule-of-3 promotion 2026-05-24 (tick #99): SuppliersAdmin + QuotesAdmin +
 * InvoicesAdmin all carried byte-identical inline copies of SUB_BRAND_BG.
 * Promoted to this shared util so future callers (RfuCustomerProfile,
 * upcoming travel sub-brand admin pages, marketing flyer studio, etc.) can
 * import + reuse rather than re-clone.
 *
 * Origin: SuppliersAdmin.jsx commit 08ebe5e (2026-05-24 tick #96 Agent C).
 *
 * Per the resolved DECISIONS_TRACKER fork-vs-extend decision (DD-5.1), all
 * travel-vertical admin surfaces share the same 4 sub-brand identifiers
 * (tmc / rfu / travelstall / visasure) — Q25 sub-brand isolation. The color
 * palette below is the placeholder palette pending Yasin's Q22 brand pack
 * (which will replace these with the real per-sub-brand brand colors).
 *
 * Shape note: the inline copies stored a flat string-valued map
 * `{ key: "rgba(...)" }` used as `SUB_BRAND_BG[row.subBrand]` in a row
 * background style. We preserve that shape exactly so the 3 retrofitted
 * callers don't need any logic change beyond the import swap. A richer
 * `{bg, fg}` object form would be the right move when Yasin's brand pack
 * lands and we need a separate foreground per sub-brand — at that point
 * the map can be reshaped here in ONE place and the callers updated to
 * destructure `.bg` / `.fg`.
 */

// Background color for sub-brand pill rendering on travel admin tables.
// Hex/rgba values align with the placeholder palette in frontend/src/theme/travel.css.
// When Yasin's Q22 brand pack lands, this map is the single replace-point.
export const SUB_BRAND_BG = {
  tmc: "rgba(18, 38, 71, 0.18)",        // travel-navy tint
  rfu: "rgba(38, 88, 85, 0.18)",        // teal-ish (RFU pilgrim)
  travelstall: "rgba(200, 154, 78, 0.18)", // warm gold
  visasure: "rgba(99, 102, 241, 0.18)",  // indigo
};

// Human-readable sub-brand labels for tooltips + dropdowns. Not yet
// consumed by SuppliersAdmin/QuotesAdmin/InvoicesAdmin (they print the
// raw subBrand identifier in the badge cell), but exported for future
// callers (RfuCustomerProfile microsite header, marketing flyer studio,
// reports tooltips) that want a friendlier label.
export const SUB_BRAND_LABEL = {
  tmc: "TMC (School trips)",
  rfu: "RFU (Umrah)",
  travelstall: "Travel Stall (Family)",
  visasure: "Visa Sure",
};

// Sub-brand identifiers ordered for consistent dropdown rendering.
// Matches the VALID_SUB_BRANDS Set in frontend/src/utils/subBrand.jsx —
// keep these two in sync if the canonical id set ever changes.
export const SUB_BRAND_IDS = ["tmc", "rfu", "travelstall", "visasure"];

// Fallback background for unknown / null sub-brand. Matches the literal
// fallback the 3 callsites used inline (`|| "rgba(255,255,255,0.08)"`).
export const SUB_BRAND_BG_FALLBACK = "rgba(255,255,255,0.08)";

// Convenience accessor: background for a given subBrand identifier, with
// the fallback applied. Callers that already pass `subBrand` directly into
// `SUB_BRAND_BG[subBrand] || SUB_BRAND_BG_FALLBACK` can switch to this for
// a slightly tighter inline expression — both forms are valid.
export function subBrandBackground(subBrand) {
  return SUB_BRAND_BG[subBrand] || SUB_BRAND_BG_FALLBACK;
}

// Pretty-print a sub-brand label, falling back to the raw id when present
// (e.g. "(unknown-id)") or an em-dash when null/empty.
export function subBrandLabel(subBrand) {
  if (!subBrand) return "—";
  return SUB_BRAND_LABEL[subBrand] || `(${subBrand})`;
}

// Short label for compact dropdowns / chips (no parenthetical descriptor).
const SHORT_LABEL = {
  tmc: "TMC",
  rfu: "RFU",
  travelstall: "Travel Stall",
  visasure: "Visa Sure",
};
export function subBrandShortLabel(subBrand) {
  if (!subBrand) return "—";
  return SHORT_LABEL[subBrand] || subBrand;
}

// Which sub-brands a user may ACT ON in create/assign forms. Mirrors the
// backend getSubBrandAccessSet (middleware/travelGuards.js) + the Sidebar's
// subBrandAccess parser so the UI and server agree:
//   - ADMIN                              → all 4 (full access)
//   - unset / empty / malformed access   → all 4 (no restriction declared)
//   - explicit granted subset            → just those ids
// Returns an ordered array of sub-brand ids (subset of SUB_BRAND_IDS).
export function accessibleSubBrands(user) {
  if (user?.role === "ADMIN") return [...SUB_BRAND_IDS];
  const raw = user?.subBrandAccess;
  if (!raw) return [...SUB_BRAND_IDS];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length === 0) return [...SUB_BRAND_IDS];
    const filtered = SUB_BRAND_IDS.filter((id) => arr.includes(id));
    return filtered.length ? filtered : [...SUB_BRAND_IDS];
  } catch {
    return [...SUB_BRAND_IDS];
  }
}

// Resolve the sub-brand a create form should DEFAULT to, given the user's
// access + the currently-active sidebar sub-brand. Precedence:
//   1. Single-brand user → pinned to their one brand.
//   2. Active sidebar sub-brand, when the user can access it.
//   3. `preferred` (the page's own sensible default, e.g. "rfu" for an
//      RFU-centric surface), when the user can access it.
//   4. The user's first accessible brand.
// `preferred` is optional — pages that have no special default omit it and
// fall through to the first accessible brand.
export function defaultSubBrandFor(user, activeSubBrand, preferred) {
  const brands = accessibleSubBrands(user);
  if (brands.length === 1) return brands[0];
  if (activeSubBrand && brands.includes(activeSubBrand)) return activeSubBrand;
  if (preferred && brands.includes(preferred)) return preferred;
  return brands[0];
}
