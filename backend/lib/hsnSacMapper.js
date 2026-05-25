// Travel CRM — SAC (Services Accounting Code) mapper for travel line types.
//
// Slice 5 of the #902 GST & Compliance module (PRD:
// docs/PRD_TRAVEL_GST_COMPLIANCE.md FR-3.4.3). Pure helper — no Prisma,
// no fetch, no IO. Maps travel-line types to GoI-canonical SAC codes
// and groups invoice lines into the HSN-summary buckets that GSTR-1
// JSON export requires.
//
// === Why SAC and not HSN ===
//
// HSN (Harmonized System of Nomenclature) classifies *goods*. SAC
// (Services Accounting Code) classifies *services*. Every travel line
// type in PRD §3 (hotel, flight, transport, visa, tour-package,
// per-pax, per-room, per-night, per-trip, addon, service) is a
// service deliverable, so they get SAC codes. The Govt's GSTR-1 HSN
// summary section accepts BOTH HSN and SAC under the same column
// (column name is "HSN" but the field tolerates 4-8 digit codes from
// either system) — so a downstream "HSN summary" call site is fine
// passing the SAC string through verbatim.
//
// === Canonical SAC codes (GoI Notification No. 11/2017-Central Tax (Rate)) ===
//
//   9963 — Accommodation services (hotels, lodging, B&B)
//   9964 — Passenger transport services (flights, road, rail)
//   9971 — Financial and related services (fx, remittance)
//   9982 — Legal and accounting services (visa, consulate paperwork)
//   9985 — Support services to travel & tourism (tour packages,
//          itinerary planning, generic travel service catch-all)
//   9991 — Other services (residual)
//
// === Line types that DO NOT get their own SAC row ===
//
//   tax  — already represented inside the parent line's gstPercent;
//          giving it a SAC row would double-count GST output.
//   fee  — same reasoning; piggybacks on the parent service line.
//   tcs  — Tax Collected at Source is a withholding under §206C(1G)
//          of the Income-tax Act, NOT a GST output. Reported on a
//          separate TCS return (Form 27EQ), never on GSTR-1.
//   tds  — same — withholding, not output.
//
// === Default semantics ===
//
// Unknown / missing / non-string lineType → '9985' (tour-package
// catch-all). Rationale: every travel CRM line that isn't explicitly
// hotel/flight/visa is some flavour of "support services to travel &
// tourism" by default; classifying the unknown bucket as 9985 keeps
// it inside the travel-tourism chapter so any auditor lookup lands in
// the right section instead of the residual 9991 ("Other services")
// that is broader than just travel.

const TRAVEL_SAC_CODES = {
  hotel: "9963",
  flight: "9964",
  transport: "9964",
  visa: "9982",
  tour_package: "9985",
  service: "9985",
  // PRD §3 line types that overlap with #901 TravelInvoiceLine.lineType:
  per_pax: "9985",
  per_room: "9963",
  per_night: "9963",
  per_trip: "9985",
  // Non-SAC-bearing line types (see header comment):
  tax: null,
  fee: null,
  addon: "9985",
  tcs: null,
  tds: null,
};

const SAC_DESCRIPTIONS = {
  "9963": "Accommodation services",
  "9964": "Passenger transport services",
  "9982": "Legal and accounting services",
  "9985": "Support services to travel & tourism",
  "9991": "Other services",
  "9971": "Financial and related services",
};

const DEFAULT_SAC = "9985"; // tour-package catch-all (see header)

/**
 * Map a travel-line type to its canonical SAC code.
 *
 * @param {string} lineType  one of: hotel|flight|transport|visa|
 *   tour_package|service|per_pax|per_room|per_night|per_trip|tax|
 *   fee|addon|tcs|tds|other
 * @returns {string|null}  4-digit SAC string, or `null` for line
 *   types that do not carry their own SAC (tax/fee/tcs/tds).
 *   Unknown / falsy / non-string inputs return DEFAULT_SAC.
 */
function sacForLineType(lineType) {
  if (!lineType || typeof lineType !== "string") return DEFAULT_SAC;
  if (Object.prototype.hasOwnProperty.call(TRAVEL_SAC_CODES, lineType)) {
    return TRAVEL_SAC_CODES[lineType];
  }
  return DEFAULT_SAC;
}

/**
 * Look up the human-readable description for a SAC code. Used by
 * GSTR-1 HSN-summary export + PDF render layers (slice 6+).
 *
 * @param {string} sacCode
 * @returns {string}  description from SAC_DESCRIPTIONS, or "Other
 *   services" fallback when the code isn't in the table.
 */
function descriptionForSac(sacCode) {
  return SAC_DESCRIPTIONS[sacCode] || "Other services";
}

/**
 * Group an array of invoice lines into HSN/SAC-summary buckets for
 * GSTR-1 export. One row per (sacCode, gstPercent) combination, with
 * summed taxableValue + line count. Lines whose lineType does not
 * carry a SAC (tax/fee/tcs/tds — `sacForLineType` returns `null`) are
 * skipped so they don't show up as their own HSN-summary row.
 *
 * Rounding: half-up to 2 decimal places via `Math.round(n * 100)/100`
 * — matches the `lib/gstCalculation.js` convention so taxable totals
 * reconcile exactly across the two helpers.
 *
 * Sort order: by sacCode ascending, then gstPercent ascending. Stable
 * order matters for the GSTR-1 JSON validator's diff-based reconciliation.
 *
 * @param {Array<{lineType: string, taxableValue: number|string,
 *   gstPercent: number|string}>} lines
 * @returns {Array<{sacCode: string, description: string,
 *   gstPercent: number, taxableValue: number, count: number}>}
 */
function groupLinesBySac(lines) {
  const groups = new Map();
  for (const line of lines || []) {
    if (!line) continue;
    const sac = sacForLineType(line.lineType);
    if (sac === null) continue; // tax/fee/tcs/tds — no own SAC row
    const gstPct = Number(line.gstPercent || 0);
    const taxable = Number(line.taxableValue || 0);
    const key = `${sac}:${gstPct}`;
    if (!groups.has(key)) {
      groups.set(key, {
        sacCode: sac,
        description: descriptionForSac(sac),
        gstPercent: gstPct,
        taxableValue: 0,
        count: 0,
      });
    }
    const g = groups.get(key);
    g.taxableValue = Math.round((g.taxableValue + taxable) * 100) / 100;
    g.count++;
  }
  return [...groups.values()].sort((a, b) =>
    a.sacCode === b.sacCode
      ? a.gstPercent - b.gstPercent
      : a.sacCode.localeCompare(b.sacCode)
  );
}

// === Keyword → SAC reverse-lookup (slice 15) ===
//
// Operator-facing reverse-lookup: type a service description ("hotel",
// "flight", "umrah package") and get the SAC code(s) that classify it.
// Drives the Finance > Compliance > "Help me pick a SAC" picker in the
// invoice-line edit form (FR-3.4.3 acceptance path).
//
// Match strategy:
//   1. EXACT match on TRAVEL_SAC_CODES key (case-insensitive) — when the
//      operator types one of our internal line-type names verbatim
//      ("hotel", "tour_package", "per_room") we return that one SAC
//      hit first. Highest confidence (this is what the lib's own
//      categoriser would have picked).
//   2. KEYWORD match: walk a curated keyword → SAC map. The map covers
//      operator-natural phrasings ("flight" / "airline" / "ticket" →
//      9964; "hotel" / "room" / "accommodation" → 9963; "visa" /
//      "consulate" → 9982; "umrah" / "package" / "tour" → 9985; etc.).
//      Multiple keyword hits collapse to one row per SAC; we surface
//      the deduplicated set sorted by sacCode ascending for determinism.
//   3. SUBSTRING match on SAC_DESCRIPTIONS values — covers operator
//      queries like "transport" / "financial" / "legal" that aren't in
//      the keyword table but appear in the description text. Same
//      dedup + sort.
//
// All three strategies feed the same output list; first match wins for
// any given SAC code so a query that hits both EXACT and KEYWORD stages
// doesn't double-list. Empty / whitespace / non-string queries return
// [] (the route layer 400s before calling this — defensive).
//
// Result row carries `matchType` ∈ {"EXACT", "KEYWORD", "DESCRIPTION"}
// so the operator UI can decorate (e.g. EXACT in bold, KEYWORD in
// regular, DESCRIPTION in italic). The route layer passes it through
// verbatim.

const KEYWORD_TO_SAC = {
  // 9963 — Accommodation
  hotel: "9963",
  hotels: "9963",
  room: "9963",
  rooms: "9963",
  accommodation: "9963",
  lodging: "9963",
  resort: "9963",
  homestay: "9963",
  hostel: "9963",
  // 9964 — Passenger transport
  flight: "9964",
  flights: "9964",
  airline: "9964",
  airfare: "9964",
  ticket: "9964",
  tickets: "9964",
  transport: "9964",
  transportation: "9964",
  bus: "9964",
  cab: "9964",
  taxi: "9964",
  rail: "9964",
  train: "9964",
  passenger: "9964",
  // 9971 — Financial / fx
  forex: "9971",
  fx: "9971",
  remittance: "9971",
  currency: "9971",
  exchange: "9971",
  // 9982 — Legal / visa
  visa: "9982",
  visas: "9982",
  consulate: "9982",
  passport: "9982",
  embassy: "9982",
  legal: "9982",
  paperwork: "9982",
  // 9985 — Tour / travel support catch-all
  tour: "9985",
  tours: "9985",
  package: "9985",
  packages: "9985",
  itinerary: "9985",
  travel: "9985",
  tourism: "9985",
  umrah: "9985",
  hajj: "9985",
  pilgrimage: "9985",
  trip: "9985",
  holiday: "9985",
  vacation: "9985",
  guide: "9985",
};

/**
 * Reverse-lookup SAC codes from an operator-supplied keyword string.
 * Returns deduplicated rows (one per SAC) sorted by sacCode ascending.
 *
 * @param {string} query  operator-supplied keyword (any casing,
 *   may include leading/trailing whitespace). The keyword may be a
 *   single word ("hotel") or a phrase ("luxury hotel room") — we
 *   tokenise on whitespace + try EXACT/KEYWORD lookup for each token,
 *   then fall back to a DESCRIPTION substring match on the joined query.
 * @returns {Array<{sacCode: string, description: string, matchType: "EXACT"|"KEYWORD"|"DESCRIPTION"}>}
 *   Empty array on empty / non-string / no-hit query (callers should
 *   surface a "no matches" UI state, not 404).
 */
function lookupSacByKeyword(query) {
  if (!query || typeof query !== "string") return [];
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return [];

  // sacCode → row (preserves first match — EXACT beats KEYWORD beats DESCRIPTION).
  const hits = new Map();

  const recordHit = (sacCode, matchType) => {
    if (!sacCode) return;
    if (hits.has(sacCode)) return; // first match wins
    hits.set(sacCode, {
      sacCode,
      description: descriptionForSac(sacCode),
      matchType,
    });
  };

  // Stage 1: EXACT — full query matches a TRAVEL_SAC_CODES key.
  // Tokens are checked too so "hotel room" finds the hotel key.
  const tokens = trimmed.split(/\s+/);
  const exactCandidates = [trimmed, ...tokens];
  for (const candidate of exactCandidates) {
    if (
      Object.prototype.hasOwnProperty.call(TRAVEL_SAC_CODES, candidate)
    ) {
      const sac = TRAVEL_SAC_CODES[candidate];
      if (sac !== null) recordHit(sac, "EXACT");
    }
  }

  // Stage 2: KEYWORD — any token matches a KEYWORD_TO_SAC entry.
  for (const token of tokens) {
    if (Object.prototype.hasOwnProperty.call(KEYWORD_TO_SAC, token)) {
      recordHit(KEYWORD_TO_SAC[token], "KEYWORD");
    }
  }

  // Stage 3: DESCRIPTION — the joined query appears in any description.
  for (const [sac, desc] of Object.entries(SAC_DESCRIPTIONS)) {
    if (desc.toLowerCase().includes(trimmed)) {
      recordHit(sac, "DESCRIPTION");
    }
  }

  return [...hits.values()].sort((a, b) => a.sacCode.localeCompare(b.sacCode));
}

module.exports = {
  TRAVEL_SAC_CODES,
  SAC_DESCRIPTIONS,
  DEFAULT_SAC,
  KEYWORD_TO_SAC,
  sacForLineType,
  descriptionForSac,
  groupLinesBySac,
  lookupSacByKeyword,
};
