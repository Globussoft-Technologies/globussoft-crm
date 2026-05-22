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

module.exports = { resolveForSubBrand, parseConfig, VALID_SUB_BRANDS, RETURN_FIELDS };
