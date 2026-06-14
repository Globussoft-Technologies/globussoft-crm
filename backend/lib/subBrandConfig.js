// Travel CRM — per-sub-brand config resolver (Q9 / Q14 / Q21 cut-over plumbing).
//
// Reads tenant.subBrandConfigJson (set at TenantSetting / admin-curated)
// and returns the resolved config for a given sub-brand. JSON shape:
//   { tmc: { wabaId, phoneNumberId, legalEntityCode, gstin, driveRootFolderId },
//     rfu: { ... }, travelstall: { ... }, visasure: { ... } }
//
// All fields are optional within a sub-brand block. Missing config → return
// an empty object {} so call sites can defensively spread + reach for defaults.
// Malformed JSON → log a warning + return empty.
//
// Until Q9 / Q14 / Q21 creds land, this resolver typically returns {} for
// every sub-brand. The CALLER must therefore tolerate empty config and
// continue to dispatch to the stub. The point of wiring this in NOW is so
// Q9's cred-drop is a one-line admin POST → all 7 crons + 3 endpoints
// immediately route to the correct WABA without per-callsite edits.
//
// Exports:
//   resolveForSubBrand(tenant, subBrand) → { wabaId?, phoneNumberId?,
//     legalEntityCode?, gstin?, driveRootFolderId? }
//   parseConfig(jsonString) → { tmc: {...}, rfu: {...}, ... } — for tests
//
// PII-safety: returns ARE logged at trace level by call sites (wabaId is
// the only field commonly logged); never log gstin / legalEntityCode in
// any consumer (those leak tenant business identity).

const VALID_SUB_BRANDS = ["tmc", "rfu", "travelstall", "visasure"];
const RETURN_FIELDS = ["wabaId", "phoneNumberId", "legalEntityCode", "gstin", "driveRootFolderId"];

// G101 (Branding Wave 4 FR-3.3.e): outbound sender display name per sub-brand.
// SMS senderId + WhatsApp business profile name BOTH read from this map at
// dispatch time. Fall-back chain: tenant.subBrandConfigJson[brand].displayName
// → DEFAULT_DISPLAY_NAMES[brand] → null (caller uses provider-default sender).
//
// The DEFAULT map ships sensible placeholders so a tenant whose admin hasn't
// curated subBrandConfigJson yet still gets a recognisable sender. When Yasin
// (Q22) lands the brand pack, the admin endpoint writes the real legal names
// to subBrandConfigJson.<brand>.displayName and these defaults stop firing.
const DEFAULT_DISPLAY_NAMES = {
  tmc: "TMC",
  rfu: "RFU Umrah",
  travelstall: "Travel Stall",
  visasure: "Visa Sure",
};

function parseConfig(jsonString) {
  if (!jsonString || typeof jsonString !== "string") return {};
  try {
    const obj = JSON.parse(jsonString);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    return obj;
  } catch (e) {
    console.warn(`[subBrandConfig] parse error: ${e.message}`);
    return {};
  }
}

function resolveForSubBrand(tenant, subBrand) {
  if (!tenant || !subBrand || !VALID_SUB_BRANDS.includes(subBrand)) return {};
  const cfg = parseConfig(tenant.subBrandConfigJson);
  const brandBlock = cfg[subBrand];
  if (!brandBlock || typeof brandBlock !== "object" || Array.isArray(brandBlock)) return {};
  // Whitelist the return fields — don't leak arbitrary keys to callers.
  const out = {};
  for (const k of RETURN_FIELDS) {
    if (brandBlock[k] !== undefined && brandBlock[k] !== null && brandBlock[k] !== "") {
      out[k] = brandBlock[k];
    }
  }
  return out;
}

/**
 * G101 — resolve the outbound display name for SMS / WhatsApp dispatch.
 *
 * Resolution order:
 *   1. tenant.subBrandConfigJson[brand].displayName (admin-curated; Q22 cred)
 *   2. DEFAULT_DISPLAY_NAMES[brand] (placeholder string above)
 *   3. null (caller uses provider env-default sender)
 *
 * Reads the raw parsed JSON directly (not via resolveForSubBrand's
 * RETURN_FIELDS whitelist) — displayName is a chrome-only string and stays
 * orthogonal to the wabaId / phoneNumberId / etc. cred-routing whitelist
 * that resolveForSubBrand guards. Keeping the whitelist tight keeps the
 * cred-leak surface narrow.
 *
 * @param {object} tenant - Prisma Tenant row (only subBrandConfigJson is read)
 * @param {string} subBrand - tmc | rfu | travelstall | visasure (or any
 *   other string → returns null since not a valid Travel sub-brand)
 * @returns {string|null}
 */
function resolveDisplayName(tenant, subBrand) {
  if (!subBrand || !VALID_SUB_BRANDS.includes(subBrand)) return null;
  if (tenant && tenant.subBrandConfigJson) {
    const cfg = parseConfig(tenant.subBrandConfigJson);
    const block = cfg[subBrand];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      const v = block.displayName;
      if (v && typeof v === "string") return v;
    }
  }
  return DEFAULT_DISPLAY_NAMES[subBrand] || null;
}

module.exports = {
  resolveForSubBrand,
  resolveDisplayName,
  parseConfig,
  VALID_SUB_BRANDS,
  RETURN_FIELDS,
  DEFAULT_DISPLAY_NAMES,
};
