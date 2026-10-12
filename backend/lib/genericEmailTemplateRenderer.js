// Generic CRM email merge rendering. Kept separate from the shared workflow
// renderer so Wellness and Travel templates retain their existing behavior.

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^a-z0-9]+/g, "");
}

function scalar(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const joined = parsed.map((item) => scalar(item)).filter(Boolean).join(", ");
          return joined || null;
        }
        if (parsed && typeof parsed === "object") return null;
      } catch (_error) {
        // A normal user-entered string that merely starts with punctuation.
      }
    }
    return value;
  }
  if (["number", "boolean"].includes(typeof value)) return String(value);
  return null;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function readPath(context, path) {
  let current = context;
  for (const part of String(path).split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

const SEMANTIC_GROUPS = [
  ["company", "companyname", "organization", "organizationname", "business", "businessname", "employer", "tenantname"],
  ["phone", "mobile", "telephone", "contactnumber"],
  ["email", "emailaddress", "contactemail"],
  ["product", "service", "offering"],
];

function semanticGroup(key) {
  const normalized = normalizeKey(key);
  return SEMANTIC_GROUPS.find((group) => group.includes(normalized));
}

function fieldCandidates(field) {
  return [field.key, field.label, ...(Array.isArray(field.aliases) ? field.aliases : [])].filter(Boolean);
}

function fallbackFor(path) {
  const key = normalizeKey(String(path).split(".").pop());
  const normalizedPath = normalizeKey(path);
  if (["sendername", "senderdisplayname"].includes(normalizedPath) || key === "sendername") return "our team";
  if (["senderemail", "senderemailaddress"].includes(normalizedPath) || key === "senderemail") return "your email address";
  if (["sendercompany", "sendercompanyname"].includes(normalizedPath) || key === "sendercompany") return "your company";
  if (["firstname", "first"].includes(key)) return "there";
  if (["companyname", "organizationname", "organization", "businessname", "tenantname", "company"].includes(key)) return "your company";
  if (["product", "productname", "service", "servicename", "offering"].includes(key)) return "your products or services";
  if (["phone", "mobile", "telephone", "contactnumber", "contactphone"].includes(key)) return "your phone number";
  if (["email", "emailaddress", "contactemail"].includes(key)) return "your email address";
  if (["address", "businessaddress", "companyaddress"].includes(key)) return "your business address";
  if (["title", "jobtitle", "role"].includes(key)) return "your role";
  return "the requested information";
}

function resolveValue(path, context) {
  const trimmed = String(path || "").trim();
  const direct = scalar(readPath(context, trimmed));
  if (direct !== null) return direct;
  const normalized = normalizeKey(trimmed.split(".").pop());
  if (["company", "companyname", "organizationname", "tenantname"].includes(normalized)) {
    const organizationName = scalar(readPath(context, "organization.name")) || scalar(readPath(context, "tenant.name"));
    if (organizationName !== null) return organizationName;
  }
  const fields = Array.isArray(context.customFields) ? context.customFields : [];
  const exact = fields.filter((field) => fieldCandidates(field)
    .some((candidate) => normalizeKey(candidate) === normalized));
  if (exact.length === 1) return scalar(exact[0].value);
  const group = semanticGroup(trimmed.split(".").pop());
  if (group) {
    const semantic = fields.filter((field) => fieldCandidates(field).some((candidate) => {
      const candidateKey = normalizeKey(candidate);
      return group.some((term) => candidateKey === term || candidateKey.startsWith(term) || candidateKey.endsWith(term));
    }));
    if (semantic.length === 1) return scalar(semantic[0].value);
  }
  return null;
}

function renderGenericTemplate(template, context = {}, options = {}) {
  if (template == null) return "";
  return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path) => {
    const value = resolveValue(path, context);
    const output = value === null ? fallbackFor(path) : value;
    return options.html ? escapeHtml(output) : output;
  });
}

module.exports = { normalizeKey, renderGenericTemplate, resolveValue, fallbackFor };
