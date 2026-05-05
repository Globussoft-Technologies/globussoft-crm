// Shared sanitization toolkit for JSON-blob writes.
//
// Why this lives in lib/ (not in any one route file):
//   The helpers were originally local to backend/routes/sequences.js (closing
//   #398 + the v3.4.9 carry-over #1 + #447). The v3.4.10 audit found 4 more
//   routes writing JSON-blob columns (String? @db.Text storing JSON) without
//   sanitization — same #398-class XSS surface:
//     - routes/lead_routing.js POST + PUT (LeadRoutingRule.conditions)
//     - routes/ab_tests.js POST (AbTest.variantA / variantB)
//     - routes/marketing.js Campaign POST (Campaign.scheduleFilters)
//     - routes/report_schedules.js POST (ReportSchedule.metrics, recipients)
//   Promoting the helpers to lib/ lets every route adopt them via a single
//   import line, AND pins the canonical contract via the existing vitest at
//   backend/test/utils/sanitize-json.test.js.
//
// What's exported:
//   - sanitizeText(input) — strips ALL HTML/JS markup from a string,
//     preserves merge-tags ({{firstName}}) and the literal characters
//     `& < > " '` that sanitize-html re-encodes by default. Returns the
//     trimmed string. Pass-through for non-string input.
//
//   - sanitizeJson(input) — shape-preserving recursive sanitiser. Walks
//     objects/arrays, sanitises every string value via sanitizeText.
//     Returns the SAME shape the caller passed (object-in → object-out,
//     primitive-in → primitive-out, JSON-string-in → JSON-string-out).
//     Use this when storing into a JSON-typed Prisma column (`Json`).
//
//   - sanitizeJsonForStringColumn(input) — wraps sanitizeJson for the
//     common case where the storage column is `String? @db.Text` storing
//     JSON. Stringifies the walked output so Prisma accepts the write.
//     Use this for SequenceStep.conditionJson, LeadRoutingRule.conditions,
//     Campaign.scheduleFilters, etc.
//
// Why two helpers (sanitizeJson + sanitizeJsonForStringColumn):
//   The v3.4.9 unit test pinned shape-preservation as the contract for
//   sanitizeJson. Other future callers (a route that stores sanitized JSON
//   into a real Json column rather than String? @db.Text) need the helper
//   to leave the shape intact. The String-column constraint is a property
//   of the call site, not the helper.
//
// History:
//   - #398 (v3.4.7) — sanitizeText for Sequence.name + ReactFlow node labels
//   - v3.4.9 carry-over #1 (commit bb116b0) — sanitizeJson for SequenceStep.smsBody + conditionJson
//   - v3.4.10 940b4f0 — sanitizeJsonForStringColumn wrapper after the
//     fd8ad67 always-stringify regression broke 16 unit tests pinning
//     shape-preservation
//   - v3.4.11 (this commit) — promoted to backend/lib/ for reuse across 5 routes

const sanitizeHtml = require("sanitize-html");

// sanitize-html's default text serialiser HTML-encodes `&` → `&amp;`,
// which corrupted "Q3 Plan & Brief" into "Q3 Plan &amp; Brief" (#187).
// Override the textFilter to undo the entities the library re-encodes —
// storage stays raw, render-time encoding is React's job.
const ENTITY_DECODE_RE = /&(amp|lt|gt|quot|#x27|#39);/g;
const ENTITY_DECODE_MAP = {
  amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'",
};

function sanitizeText(input) {
  if (typeof input !== "string") return input;
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (text) => text.replace(ENTITY_DECODE_RE, (_, e) => ENTITY_DECODE_MAP[e] || _),
  }).trim();
}

// Internal recursive walker. Strings → sanitizeText; arrays + objects
// → recurse; primitives + null → pass through.
function _walkSanitize(value) {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(_walkSanitize);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = _walkSanitize(v);
    }
    return out;
  }
  return value;
}

// Shape-preserving sanitizer:
//   null      → null
//   undefined → undefined
//   number / boolean → returned as-is
//   object / array → walked recursively, returned with same shape
//   string-containing-JSON → parsed → walked → re-stringified (string-in/out)
//   string-non-JSON → sanitizeText (HTML-stripped, merge-tags preserved)
function sanitizeJson(input) {
  if (input == null) return input;
  if (typeof input !== "object" && typeof input !== "string") return input;
  if (typeof input === "string") {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (_e) {
      return sanitizeText(input);
    }
    return JSON.stringify(_walkSanitize(parsed));
  }
  return _walkSanitize(input);
}

// For routes storing into a `String? @db.Text` column that holds JSON.
// sanitizeJson alone would hand back an object when given an object input
// (correct per shape-preservation); this wrapper stringifies so Prisma
// accepts the write.
function sanitizeJsonForStringColumn(input) {
  if (input == null) return null;
  const cleaned = sanitizeJson(input);
  if (cleaned == null) return null;
  return typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned);
}

module.exports = {
  sanitizeText,
  sanitizeJson,
  sanitizeJsonForStringColumn,
};
