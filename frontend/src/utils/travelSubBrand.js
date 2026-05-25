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
