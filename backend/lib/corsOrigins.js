const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "https://crm.globusdemos.com",
  "https://globuscrm.com",
  "http://localhost:5173",
  "http://tmc.localhost:5173",
  "http://localhost:5000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5000",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "https://empcloud.com",
  "https://www.empcloud.com",
  "https://app.empcloud.com",
  "https://themodernclassroom.in",
  "https://www.themodernclassroom.in",
  "https://app.themodernclassroom.in",
  "https://drenhance.com",
  "https://www.drenhance.com",
  "https://enhancewellness.globusdemos.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.origin.toLowerCase();
  } catch (_error) {
    return null;
  }
}

function parseConfiguredOrigins(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  const raw = String(value).trim();
  if (!raw) return [];

  // Accept both the documented CSV form and JSON-array values commonly used
  // by container/secret managers, e.g. ["https://crm.example.com"].
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (_error) {
      // Fall through to CSV parsing so one malformed value does not disable
      // every other configured origin.
    }
  }

  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function buildAllowedOrigins() {
  const configured = [
    process.env.FRONTEND_URL,
    ...parseConfiguredOrigins(process.env.CORS_ALLOWED_ORIGINS),
  ];
  const origins = [...DEFAULT_ALLOWED_ORIGINS, ...configured]
    .map(normalizeOrigin)
    .filter(Boolean);
  return Array.from(new Set(origins));
}

function isAllowedOrigin(value, allowlist = buildAllowedOrigins()) {
  const normalized = normalizeOrigin(value);
  return Boolean(normalized && allowlist.includes(normalized));
}

module.exports = {
  DEFAULT_ALLOWED_ORIGINS,
  normalizeOrigin,
  parseConfiguredOrigins,
  buildAllowedOrigins,
  isAllowedOrigin,
};
