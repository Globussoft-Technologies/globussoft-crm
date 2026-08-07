const VALID_DATA_SCOPES = Object.freeze(["OWN", "TEAM", "ALL"]);
const VALID_SUB_BRANDS = Object.freeze(["tmc", "rfu", "travelstall", "visasure"]);

function normalizeDataScope(value) {
  const scope = String(value || "").trim().toUpperCase();
  return VALID_DATA_SCOPES.includes(scope) ? scope : "ALL";
}

function parseJsonArray(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
  } catch {
    return null;
  }
}

function parseSubBrandScope(value) {
  const parsed = parseJsonArray(value);
  if (parsed === null) return null;
  return parsed.filter((item) => VALID_SUB_BRANDS.includes(item));
}

function serializeSubBrandScope(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) {
    const cleaned = value.filter((item) => typeof item === "string" && VALID_SUB_BRANDS.includes(item));
    return cleaned.length ? JSON.stringify(cleaned) : null;
  }
  const parsed = parseSubBrandScope(value);
  return parsed === null || parsed.length === 0 ? null : JSON.stringify(parsed);
}

function resolveRoleSubBrandAccess({ roles = [], legacySubBrandAccess = null, isAdmin = false } = {}) {
  if (isAdmin) return null;

  let sawExplicitRoleScope = false;
  const allowed = new Set();

  for (const role of roles) {
    if (!role) continue;
    const raw = role.subBrandScopeJson ?? role.subBrandScope ?? null;
    if (raw === null || raw === undefined || raw === "") {
      continue;
    }

    const parsed = parseSubBrandScope(raw);
    if (parsed === null || parsed.length === 0) {
      continue;
    }
    sawExplicitRoleScope = true;
    for (const subBrand of parsed) {
      allowed.add(subBrand);
    }
  }

  if (sawExplicitRoleScope) {
    return allowed;
  }

  const legacy = parseSubBrandScope(legacySubBrandAccess);
  if (legacy === null) return null;
  return new Set(legacy);
}

module.exports = {
  VALID_DATA_SCOPES,
  VALID_SUB_BRANDS,
  normalizeDataScope,
  parseSubBrandScope,
  serializeSubBrandScope,
  resolveRoleSubBrandAccess,
};
