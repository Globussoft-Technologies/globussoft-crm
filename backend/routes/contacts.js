const express = require('express');
const { verifyToken, verifyRole, RBAC_DENIED_MESSAGE, RBAC_DENIED_CODE } = require('../middleware/auth');
const router = express.Router();
const prisma = require("../lib/prisma");
const audienceController = require("../controllers/audienceController");
const { ensureEmail, ensureNumberInRange, ensureEnum, ensureStringLength, ensureGst, ensureDateInRange, httpFromPrismaError } = require("../lib/validators");
const { writeAudit, diffFields } = require("../lib/audit");
const { markFirstResponseIfNeeded } = require("../lib/leadSla");
const { normalizePhone, computeDuplicateGroupKey, findDuplicateContactFull } = require("../utils/deduplication");
const { notify } = require('../lib/notificationService');
const { notifyAdminsOfNewLead } = require('../lib/leadNotifications');
const { getSetting, KEYS } = require('../lib/tenantSettings');
const { evaluateAutoCampaignRules } = require('../lib/callifiedAutoCampaignRules');
const callifiedClient = require("../services/callifiedClient");
const { CALL_STATUS, normalizeLeadStatus } = require("../lib/callifiedLeadStatus");
const { sanitizeText } = require("../lib/sanitizeJson");
const { normalizePhoneValue } = require("../lib/phoneFormatting");
// #464: field-level permission enforcement. The fieldFilter middleware
// existed but was never called from any route; rules saved via the
// FieldPermissions UI had zero effect on read/write payloads. Default
// (no rule in DB) is full access.
const { filterReadFields, filterWriteFields } = require("../middleware/fieldFilter");

const CONTACT_TAG_LIMIT = 50;
const CONTACT_TAG_MAX_LENGTH = 80;
// eslint-disable-next-line no-control-regex
const CONTACT_TAG_CONTROL_RE = /[\x00-\x1F\x7F]/;

// #167: soft-delete helper. Aggregations / reports / merge / internal joins
// (e.g. activities, deals, sequenceEnrollments) are NOT yet filtered by
// deletedAt — that is a follow-up audit (see #167 follow-up note in TODOS).
function applyDeletedAtFilter(where, includeDeleted) {
  if (includeDeleted) return where;
  where.deletedAt = null;
  return where;
}

function parseContactTags(tagsJson) {
  if (!tagsJson) return [];
  try {
    const parsed = typeof tagsJson === "string" ? JSON.parse(tagsJson) : tagsJson;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
      .filter(Boolean);
  } catch (_e) {
    return [];
  }
}

function normalizeContactPhone(contact) {
  if (!contact || typeof contact !== "object") return contact;
  if (contact.phone === null || contact.phone === undefined || String(contact.phone).trim() === "") {
    return contact;
  }
  const normalizedPhone = normalizePhoneValue(contact.phone);
  return normalizedPhone === contact.phone ? contact : { ...contact, phone: normalizedPhone };
}

/**
 * Build the payload a contact.* workflow rule sees.
 *
 * `previous` is the prior-value snapshot the changed / changed_to /
 * changed_from condition operators read. Without it a rule can only test the
 * post-update state, which makes "status moved off Lead" or "owner was
 * reassigned" impossible to express. Optional so the create path — where
 * there is no prior state — simply omits it.
 */
function workflowContactPayload(contact, userId, changedFields = [], previous = null) {
  const callifiedStatus = String(contact.callifiedLeadStatus || "").toLowerCase();
  const isJunk = contact.status === "Junk" || callifiedStatus === "junk";
  const isQualified = ["Prospect", "Customer"].includes(contact.status) || callifiedStatus === "qualified";
  const externalId = contact.externalId || null;
  return {
    contactId: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone ? normalizePhoneValue(contact.phone) : contact.phone,
    company: contact.company,
    title: contact.title,
    status: contact.status,
    source: contact.source,
    tags: parseContactTags(contact.tagsJson),
    aiScore: contact.aiScore,
    assignedToId: contact.assignedToId,
    firstTouchSource: contact.firstTouchSource,
    lastTouchSource: contact.lastTouchSource,
    callifiedLeadStatus: contact.callifiedLeadStatus,
    callifiedLeadStatusReason: contact.callifiedLeadStatusReason,
    externalId,
    metaLeadgenId: typeof externalId === "string" && externalId.startsWith("meta:") ? externalId.slice(5) : null,
    metaSignal: isJunk ? "junk" : isQualified ? "qualified" : null,
    metaIsJunk: isJunk,
    metaIsQualified: isQualified,
    changedFields,
    ...(previous ? { previous } : {}),
    userId,
    tenantId: contact.tenantId,
  };
}

function serializeContactTags(contact) {
  if (!contact || typeof contact !== "object") return contact;
  const { tagsJson, ...rest } = normalizeContactPhone(contact);
  return { ...rest, tags: parseContactTags(tagsJson) };
}

function serializeContactTagsBatch(contacts) {
  if (!Array.isArray(contacts)) return contacts;
  return contacts.map(serializeContactTags);
}

function normalizeContactTagValue(raw) {
  return sanitizeText(String(raw || "")).trim();
}

function normalizeContactTagsInput(raw) {
  if (raw === undefined) return { hasValue: false, tags: [] };
  if (raw === null || raw === "") return { hasValue: true, tags: [] };

  let values = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { hasValue: true, tags: [] };
    try {
      values = JSON.parse(trimmed);
    } catch (_e) {
      values = trimmed.split(",");
    }
  }

  if (!Array.isArray(values)) {
    return {
      error: { status: 400, error: "tags must be an array of strings", code: "INVALID_TAGS" },
    };
  }
  if (values.length > CONTACT_TAG_LIMIT) {
    return {
      error: {
        status: 400,
        error: `A contact can have at most ${CONTACT_TAG_LIMIT} tags`,
        code: "TOO_MANY_TAGS",
      },
    };
  }

  const seen = new Set();
  const tags = [];
  for (const value of values) {
    if (typeof value !== "string") {
      return {
        error: { status: 400, error: "tags must be an array of strings", code: "INVALID_TAGS" },
      };
    }
    const tag = sanitizeText(value);
    if (!tag) continue;
    if (CONTACT_TAG_CONTROL_RE.test(tag)) {
      return {
        error: { status: 400, error: "tags contain invalid control characters", code: "INVALID_TAGS" },
      };
    }
    if (tag.length > CONTACT_TAG_MAX_LENGTH) {
      return {
        error: {
          status: 400,
          error: `Each tag must be ${CONTACT_TAG_MAX_LENGTH} characters or less`,
          code: "TAG_TOO_LONG",
        },
      };
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return { hasValue: true, tags };
}

// #160 #166 #168: shared validator for create + update payloads on Contact.
function validateContactInput(body, { isUpdate = false } = {}) {
  // Email — required on create, optional on update; if present, must parse.
  const emailErr = ensureEmail(body.email, { required: !isUpdate });
  if (emailErr) return emailErr;
  // Name — string length cap, prevents Prisma column-overflow 500s (#165).
  // #337: name is a required field on create AND must contain non-whitespace
  // content. The `ensureStringLength` helper trims before the empty-check by
  // default, so "   " is rejected with NAME_REQUIRED. Stays optional on
  // update so a PATCH that doesn't touch name still validates.
  const nameErr = ensureStringLength(body.name, { max: 200, field: "name", required: !isUpdate });
  if (nameErr) return nameErr;
  // aiScore — bounded 0–100; UI renders "X/100" so anything else is broken (#166).
  if (body.aiScore !== undefined && body.aiScore !== null) {
    const scoreErr = ensureNumberInRange(body.aiScore, { min: 0, max: 100, field: "aiScore", code: "INVALID_AISCORE" });
    if (scoreErr) return scoreErr;
  }
  // status — keep open enum but reject obvious junk like "C" (importer #154 already does this).
  if (body.status !== undefined && body.status !== null && body.status !== "") {
    const stErr = ensureEnum(body.status, ["Lead", "Prospect", "Customer", "Churned", "Junk"], { field: "status" });
    if (stErr) return stErr;
  }
  // #600 — wellness extras. Optional in both verticals (the Lead form gates
  // them by tenant.vertical; this validator stays vertical-agnostic so a
  // generic CRM contact can still receive a treatmentOfInterest from a
  // future tooling integration without surprising 400s). Length-cap mirrors
  // the existing 191-char Contact column convention.
  if (body.treatmentOfInterest !== undefined && body.treatmentOfInterest !== null && body.treatmentOfInterest !== "") {
    const tErr = ensureStringLength(body.treatmentOfInterest, { max: 191, field: "treatmentOfInterest" });
    if (tErr) return tErr;
  }
  for (const idField of ["preferredLocationId", "preferredPractitionerId", "callifiedCampaignId"]) {
    if (body[idField] !== undefined && body[idField] !== null && body[idField] !== "") {
      const v = Number(body[idField]);
      if (!Number.isInteger(v) || v <= 0) {
        return { status: 400, error: `${idField} must be a positive integer`, code: "INVALID_ID" };
      }
    }
  }
  // PRD Gap §1.1c — GST validation. Optional + 15-char India GSTIN format
  // gate. Invalid input returns 400 INVALID_GST instead of falling through
  // to a Prisma column-overflow 500 (gst column has no max-length cap, so
  // the validator IS the only gate against bogus input).
  if (body.gst !== undefined && body.gst !== null && body.gst !== "") {
    const gstErr = ensureGst(body.gst);
    if (gstErr) return gstErr;
  }
  // PRD_TRAVEL_GST_COMPLIANCE FR-3.5.2 (G034) + slice-3 stateCode shape —
  // ISO-3166-2-style state codes, max 10 chars. Both columns share the
  // same format pattern (e.g. "IN-MH"). We don't enforce the IN- prefix
  // here (format-agnostic per gstStateCodeResolver.js docs) — the
  // resolver returns whatever the DB stores. Length-cap is the only
  // gate against Prisma column-overflow.
  for (const sc of ["stateCode", "billingStateCode"]) {
    if (body[sc] !== undefined && body[sc] !== null && body[sc] !== "") {
      const scErr = ensureStringLength(body[sc], { max: 10, field: sc });
      if (scErr) return scErr;
    }
  }
  // PRD Gap §1.1a / §1.1d — anniversary + birthDate. Both optional, both
  // validated as bounded dates (≥1900, ≤+1y from now). The +1y upper
  // bound on anniversary catches "anniversary in 2099" data-entry typos
  // while still allowing a near-future "next anniversary" scheduling
  // pattern. birthDate uses the same bounds as Patient.dob (no future
  // dates allowed) via ensureDob.
  if (body.birthDate !== undefined && body.birthDate !== null && body.birthDate !== "") {
    const bdErr = ensureDateInRange(body.birthDate, {
      minYear: 1900,
      maxYear: new Date().getUTCFullYear(),
      field: "birthDate",
      code: "INVALID_BIRTHDATE",
    });
    if (bdErr) return bdErr;
    const d = new Date(body.birthDate);
    if (d.getTime() > Date.now()) {
      return { status: 400, error: "birthDate cannot be in the future", code: "INVALID_BIRTHDATE" };
    }
  }
  if (body.anniversary !== undefined && body.anniversary !== null && body.anniversary !== "") {
    const annErr = ensureDateInRange(body.anniversary, {
      minYear: 1900,
      maxYear: new Date().getUTCFullYear() + 1,
      field: "anniversary",
      code: "INVALID_ANNIVERSARY",
    });
    if (annErr) return annErr;
  }
  return null;
}

function canViewAllLeads(req) {
  if (!req || !req.user) return false;
  const vertical = req.user.vertical || 'generic';
  // Travel keeps the stricter rule: only ADMIN can see the full tenant.
  // Other verticals preserve the pre-existing ADMIN/MANAGER behavior.
  if (vertical === 'travel') {
    return req.user.role === 'ADMIN';
  }
  return ['ADMIN', 'MANAGER'].includes(req.user.role);
}

function canReassignLead(req, contact) {
  if (!req || !req.user || !contact) return false;
  if (req.user.role === 'ADMIN') return true;
  const vertical = req.user.vertical || 'generic';
  return vertical === 'travel' && Number(contact.assignedToId) === Number(req.user.userId);
}

// Freshsales-style "Filter by" panel — field allowlist. Each entry maps a
// UI-facing field key to a real Contact column (or the two joined columns,
// owner/territory, which resolve to a User/Territory row for their label).
// `kind: "text"` fields support contains/does not contain/is empty/is not
// empty. `kind: "id"` fields (owner, territory) are equality-only against a
// resolved id, since "contains" has no meaning on a foreign key — the UI
// still presents them as a checkbox list of distinct values, just sourced
// from the User/Territory table instead of DISTINCT on Contact.
// `required: true` marks the one column (Contact.status) that is a
// non-nullable `String` in the schema — Prisma rejects `{ not: null }` on a
// required-string field ("Argument `not` is missing", since `null` isn't a
// valid value for that field's type at all), so the /filter-fields
// has-any-data presence check below only checks "not empty string" for it,
// skipping the not-null half other (nullable) fields need.
//
// `verticals: [...]` restricts a field to specific Tenant.vertical values
// (see the `vertical` column on Tenant — "generic" | "wellness" | "travel").
// Two fields on Contact are travel-specific per their own schema.prisma
// comments — `subBrand` ("Travel vertical sub-brand tag... nullable so
// generic + wellness Contacts ignore it") and `kycStatus` ("Travel CRM —
// customer-portal DigiLocker / Aadhaar verification... nullable so
// non-travel + non-customer Contacts ignore them"). The has-data presence
// check alone isn't enough to keep these off a generic tenant's picker:
// `kycStatus` has a schema `@default("unverified")` that Prisma writes to
// EVERY new Contact regardless of vertical — so has-data is trivially true
// everywhere, even though no generic tenant ever intentionally sets it —
// and `subBrand` can leak in from a single stray/seed/imported row even on
// a tenant that has never used the travel feature. A field with no
// `verticals` key is available to every vertical (the common case).
// SOURCE OF TRUTH: this list is deliberately kept in lockstep with
// BUILTIN_COLUMNS in table_column_preferences.js ("Customize table") — the
// same union of Leads + Contacts built-in columns (name, email, phone,
// company, aiScore, source, status, assignedTo, createdAt), mapped to
// their real Contact column + comparison kind. Two lists existed briefly
// during development (this one grew to ~30 fields including title,
// linkedin, gst, birthDate, callifiedCampaignId, etc.) and drifted out of
// sync with what "Customize table" actually shows as columns — a field a
// user could filter by but never see rendered anywhere. Reusing the same
// authoritative set both UIs already agree on avoids that drift by
// construction. Territory (territoryId) is the one addition beyond
// BUILTIN_COLUMNS — it has no visible table column today, but is kept
// because it's a real, already-shipped Freshsales-parity filter (see the
// original screenshots this feature was built from) with its own User/
// Territory-backed value resolution, not a hand-added guess.
//
// `kind` drives BOTH the operator set the value-panel offers per field AND
// how buildFilterClause turns a checkbox selection into a Prisma clause:
//   "text"   — contains/not_contains via substring `contains` match.
//   "id"     — contains/not_contains via `in`/`notIn` on a parsed int,
//              values resolved against a local table (User/Territory) for
//              a human label.
//   "number" — contains/not_contains via `in`/`notIn` on a parsed float.
//   "date"   — contains/not_contains via `in`/`notIn` matching the exact
//              calendar day (values are day-boundary ranges under the
//              hood — see buildFilterClause).
//   "range"  — a bounded numeric column offered as fixed BUCKETS rather
//              than one checkbox per distinct value. Lead Score is 0-100,
//              so a DISTINCT scan lists every individual score a tenant
//              happens to have (5, 36, 49, 64, 66, 68, 72, ...) — useless
//              to pick from and unbounded as data grows. The buckets
//              mirror the Lead Score dropdown Contacts.jsx already ships
//              (SCORE_BUCKETS), so both surfaces offer the same choices.
const FILTERABLE_FIELDS = {
  name: { column: 'name', kind: 'text', label: 'Name', required: true },
  email: { column: 'email', kind: 'text', label: 'Email' },
  phone: { column: 'phone', kind: 'text', label: 'Phone' },
  company: { column: 'company', kind: 'text', label: 'Company' },
  status: { column: 'status', kind: 'text', label: 'Status', required: true },
  source: { column: 'source', kind: 'text', label: 'Source' },
  callifiedCampaignId: { column: 'callifiedCampaignId', kind: 'id', label: 'Callified Campaign' },
  callifiedLeadStatus: { column: 'callifiedLeadStatus', kind: 'text', label: 'Call Status' },
  tags: { column: 'tagsJson', kind: 'text', label: 'Tags' },
  kycStatus: { column: 'kycStatus', kind: 'text', label: 'KYC Status', verticals: ['travel'] },
  subBrand: { column: 'subBrand', kind: 'text', label: 'Sub-brand', verticals: ['travel'] },
  aiScore: {
    column: 'aiScore',
    kind: 'range',
    label: 'Lead Score',
    required: true,
    // Mirrors SCORE_BUCKETS in frontend/src/pages/Contacts.jsx.
    buckets: [
      { value: '0-25', label: '0 - 25', min: 0, max: 25 },
      { value: '26-50', label: '26 - 50', min: 26, max: 50 },
      { value: '51-75', label: '51 - 75', min: 51, max: 75 },
      { value: '76-100', label: '76 - 100', min: 76, max: 100 },
    ],
  },
  createdAt: { column: 'createdAt', kind: 'date', label: 'Created', required: true },
  assignedToId: { column: 'assignedToId', kind: 'id', label: 'Sales Owner' },
};

const CALL_STATUS_LABELS = {
  [CALL_STATUS.YET_TO_CALL]: 'Yet to Call',
  [CALL_STATUS.CONNECTED]: 'Connected',
  [CALL_STATUS.DNP]: 'DNP',
  [CALL_STATUS.QUALIFIED]: 'Qualified',
  [CALL_STATUS.JUNK]: 'Junk',
};

// `between` is date-only: it takes [from, to] (either side omittable for an
// open-ended range) and is what a date field offers instead of the
// checkbox-of-every-stored-day list the other kinds use.
const FILTER_OPERATORS = ['contains', 'not_contains', 'is_empty', 'is_not_empty', 'between'];

// NOTE: there is deliberately NO "has-data" gate on the field list.
//
// A field is offered because the ORG HAS IT — i.e. it's one of the
// Leads/Contacts table columns (BUILTIN_COLUMNS) or a custom field an
// admin created in Settings > Lead Fields. Whether any row has a value
// yet is irrelevant to whether the field exists: a freshly-added "UTM
// Source" custom field with zero values filled in is still a field this
// org has, and hiding it from the picker just makes the panel look broken
// next to a table that clearly renders that column.
//
// Earlier revisions gated on row counts (≥1, then ≥2) to suppress
// "First Touch Source", which appeared off the back of a single
// system-generated Sample row. That was the wrong lever — firstTouchSource
// is not a table column or a custom field, so it simply doesn't belong in
// FILTERABLE_FIELDS at all, and removing it there fixed the real problem.
//
// "Show only what exists" still applies one level down, to VALUES: each
// field's checkbox list is a DISTINCT scan of values actually present, so
// an empty field just yields an empty value list.

// Admin-defined Lead custom fields (Settings > Lead Fields,
// LeadCustomFieldDefinition/LeadCustomFieldValue) are dynamic per tenant —
// unlike FILTERABLE_FIELDS above they can't be a static allowlist. The
// panel addresses them as "custom_<definitionId>" and this always resolves
// against `valueText`: every fieldType stores its display value there
// too (dropdown/radio store the selected option string, multiselect a JSON
// array string, checkbox "true"/"false" — see the model comment in
// schema.prisma), so a single `contains`-style match works uniformly
// without needing per-type clause branches.
const CUSTOM_FIELD_PREFIX = 'custom_';

// Maps a LeadCustomFieldDefinition.fieldType to the filter `kind` that
// drives its operator set and value UI. Mirrors the typed-column split in
// LeadCustomFieldValue: date → valueDate, number → valueNumber, checkbox →
// valueBool, and everything else → valueText. Types not listed fall back to
// "text" (textarea / url / dropdown / radio / multiselect all live in
// valueText and are matched as strings).
const CUSTOM_FIELD_TYPE_TO_KIND = {
  date: 'date',
  number: 'number',
  checkbox: 'boolean',
};

function isCustomField(field) {
  return typeof field === 'string' && field.startsWith(CUSTOM_FIELD_PREFIX);
}

function customFieldDefIdFromKey(field) {
  const id = parseInt(field.slice(CUSTOM_FIELD_PREFIX.length), 10);
  return Number.isNaN(id) ? null : id;
}

// Builds a single Prisma where-clause fragment for one filter field.
// `values` is always an array (checkbox multi-select) — for `kind: "text"`
// with "contains"/"not_contains" this becomes an OR/AND-NOT of `contains`
// matches; `kind: "id"` uses `in`/`notIn` on the raw id since exact-match
// is the only sensible comparison for a foreign key.
//
// Converts a "YYYY-MM-DD" (or any Date-parseable) checkbox value into a
// [start-of-day, start-of-next-day) range — the DISTINCT scan in
// /filter-values/:field returns whole calendar days for date-kind fields
// (see that route), so a "contains" match here means "occurred on this
// day", not an exact-to-the-millisecond DateTime equality that would never
// match a real timestamp.
function dayRange(value) {
  const start = new Date(value);
  if (Number.isNaN(start.getTime())) return null;
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { gte: start, lt: end };
}

// [from, to] "YYYY-MM-DD" pair → an inclusive-of-both-days Prisma range.
// `to` becomes the START of the following day and is compared with `lt`, so
// a stored timestamp anywhere inside the end day still matches — comparing
// `lte` against the end day's midnight would drop everything after 00:00 on
// that day. Either side may be blank for an open-ended range; both blank
// (or both unparseable) yields null so the caller drops the clause.
function betweenRange(fromValue, toValue) {
  const range = {};
  if (fromValue) {
    const from = new Date(fromValue);
    if (!Number.isNaN(from.getTime())) {
      from.setUTCHours(0, 0, 0, 0);
      range.gte = from;
    }
  }
  if (toValue) {
    const to = new Date(toValue);
    if (!Number.isNaN(to.getTime())) {
      to.setUTCHours(0, 0, 0, 0);
      to.setUTCDate(to.getUTCDate() + 1);
      range.lt = to;
    }
  }
  return Object.keys(range).length ? range : null;
}

// is_empty/is_not_empty on a `required` (non-nullable) column — Contact.
// name/status/aiScore/createdAt today — must NOT reference `{ not: null }`
// / `{ [column]: null }` at all: Prisma rejects null as a value for a
// required field's comparison ("Argument `not` must not be null" /
// equivalent), since null can never legally appear in that column. A
// required TEXT field's "empty" can only mean the empty string; a required
// NUMBER/DATE field (aiScore, createdAt) has no such "empty" representation
// at all — every row always has a value — so is_empty matches nothing and
// is_not_empty matches everything for those two kinds.
function buildFilterClause(fieldDef, operator, values) {
  const { column, kind, required } = fieldDef;
  // A DateTime / Int column has no empty-string state, and Prisma rejects
  // '' as a value for one outright ("Invalid value for argument: Expected
  // ISO-8601 DateTime"). Only NULL means empty for these.
  const nonTextual = kind === 'number' || kind === 'date' || kind === 'range';
  if (operator === 'is_empty') {
    if (kind === 'id' || kind === 'external') return { [column]: null };
    if (required && nonTextual) return { id: { in: [] } }; // matches nothing — see comment above
    if (nonTextual) return { [column]: null };
    return required ? { [column]: '' } : { OR: [{ [column]: null }, { [column]: '' }] };
  }
  if (operator === 'is_not_empty') {
    if (kind === 'id' || kind === 'external') return { [column]: { not: null } };
    if (required && nonTextual) return {}; // matches everything — see comment above
    if (nonTextual) return { [column]: { not: null } };
    return required
      ? { [column]: { not: '' } }
      : { AND: [{ [column]: { not: null } }, { [column]: { not: '' } }] };
  }
  // Handled before the empty-string strip below: `between` carries
  // [from, to] positionally, and either end may legitimately be blank for
  // an open-ended range — compacting the array would shift `to` into `from`.
  if (operator === 'between') {
    if (kind !== 'date') return null;
    const range = betweenRange((values || [])[0], (values || [])[1]);
    return range ? { [column]: range } : null;
  }
  const list = (values || []).filter((v) => v !== undefined && v !== null && v !== '');
  if (list.length === 0) return null;
  if (kind === 'id' || kind === 'external') {
    const ids = list.map((v) => parseInt(v, 10)).filter((n) => !Number.isNaN(n));
    if (ids.length === 0) return null;
    return operator === 'not_contains' ? { [column]: { notIn: ids } } : { [column]: { in: ids } };
  }
  if (kind === 'number') {
    const nums = list.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return null;
    return operator === 'not_contains' ? { [column]: { notIn: nums } } : { [column]: { in: nums } };
  }
  if (kind === 'range') {
    // Values are bucket keys ("26-50"), resolved back to their {min,max}
    // via the field's own `buckets` definition rather than parsed from the
    // string — an unknown key is dropped instead of being coerced into a
    // bogus range.
    const picked = list
      .map((v) => (fieldDef.buckets || []).find((b) => b.value === String(v)))
      .filter(Boolean);
    if (picked.length === 0) return null;
    return operator === 'not_contains'
      ? { AND: picked.map((b) => ({ NOT: { [column]: { gte: b.min, lte: b.max } } })) }
      : { OR: picked.map((b) => ({ [column]: { gte: b.min, lte: b.max } })) };
  }
  if (kind === 'date') {
    const ranges = list.map(dayRange).filter(Boolean);
    if (ranges.length === 0) return null;
    return operator === 'not_contains'
      ? { AND: ranges.map((r) => ({ NOT: { [column]: r } })) }
      : { OR: ranges.map((r) => ({ [column]: r })) };
  }
  if (operator === 'not_contains') {
    return { AND: list.map((v) => ({ [column]: { not: { contains: String(v) } } })) };
  }
  return { OR: list.map((v) => ({ [column]: { contains: String(v) } })) };
}

// Same operator semantics as buildFilterClause, but against the related
// LeadCustomFieldValue rows for one definition id (via
// Contact.leadCustomFieldValues — see the relation field of that name on
// both Contact and LeadCustomFieldDefinition in schema.prisma). is_empty
// means "no LeadCustomFieldValue row for this field at all, OR a row
// exists with an empty valueText" — an admin can add a field after leads
// already exist, leaving old rows with no value row for it.
function buildCustomFieldClause(defId, operator, values, kind = 'text') {
  // Which typed column on LeadCustomFieldValue actually holds this field's
  // data — see CUSTOM_FIELD_TYPE_TO_KIND. A Date-picker field's values live
  // in valueDate and are always NULL in valueText, so probing valueText for
  // one returns nothing no matter what the user picked.
  const isDate = kind === 'date';
  if (operator === 'is_empty') {
    if (isDate) {
      return { OR: [
        { leadCustomFieldValues: { none: { fieldId: defId } } },
        { leadCustomFieldValues: { some: { fieldId: defId, valueDate: null } } },
      ] };
    }
    return { OR: [
      { leadCustomFieldValues: { none: { fieldId: defId } } },
      { leadCustomFieldValues: { some: { fieldId: defId, OR: [{ valueText: null }, { valueText: '' }] } } },
    ] };
  }
  if (operator === 'is_not_empty') {
    if (isDate) {
      return { leadCustomFieldValues: { some: { fieldId: defId, valueDate: { not: null } } } };
    }
    return { leadCustomFieldValues: { some: { fieldId: defId, valueText: { not: null }, NOT: { valueText: '' } } } };
  }
  // See buildFilterClause: handled before the empty-string strip so an
  // open-ended [from, ""] range keeps its positions.
  if (operator === 'between') {
    if (!isDate) return null;
    const range = betweenRange((values || [])[0], (values || [])[1]);
    return range ? { leadCustomFieldValues: { some: { fieldId: defId, valueDate: range } } } : null;
  }
  const list = (values || []).filter((v) => v !== undefined && v !== null && v !== '');
  if (list.length === 0) return null;
  if (operator === 'not_contains') {
    return { NOT: { leadCustomFieldValues: { some: { fieldId: defId, OR: list.map((v) => ({ valueText: { contains: String(v) } })) } } } };
  }
  return { leadCustomFieldValues: { some: { fieldId: defId, OR: list.map((v) => ({ valueText: { contains: String(v) } })) } } };
}

function canAccessLead(req, contact) {
  if (!req || !req.user || !contact) return false;
  if (canViewAllLeads(req)) return true;
  return Number(contact.assignedToId) === Number(req.user.userId);
}

// PRD Gap §1.1e — walletBalance is a read-only computed surface. We strip
// it from any incoming body BEFORE Prisma write so a caller can't poison
// the denorm column out of band. Wave 11 FF Wallet remains the source of
// truth; the column on Contact stays null at rest until a future
// Wallet-on-Contact relation lands and a denorm hook is added.
function stripWalletBalanceWrite(body) {
  if (body && typeof body === "object" && "walletBalance" in body) {
    const { walletBalance: _drop, ...rest } = body;
    return rest;
  }
  return body;
}

// PRD Gap §1.1e — surface a computed walletBalance for a single Contact
// when the contact has a linked Patient with a wallet. Best-effort: any
// Prisma error here MUST NOT break the GET (the wallet is a wellness-only
// surface; generic-tenant rows simply return null).
async function attachComputedWalletBalance(contact, tenantId) {
  if (!contact || typeof contact !== "object") return contact;
  try {
    // Find a Patient row linked to this contact (Patient.contactId == Contact.id).
    const patient = await prisma.patient.findFirst({
      where: { tenantId, contactId: contact.id, deletedAt: null },
      select: { id: true },
    });
    if (!patient) {
      return { ...contact, walletBalance: null };
    }
    const wallet = await prisma.wallet.findFirst({
      where: { tenantId, patientId: patient.id },
      select: { balance: true },
    });
    return { ...contact, walletBalance: wallet ? wallet.balance : 0 };
  } catch (_e) {
    // Defensive: a stale Prisma client (no Wallet model yet) or tenant
    // without the wellness vertical schema simply yields null. Do NOT
    // surface a 500 — Wallet is optional for generic-CRM contacts.
    return { ...contact, walletBalance: null };
  }
}

// TRAVEL-ONLY contact-timeline enrichment.
//
// Per PRD_TRAVEL_QUOTE_BUILDER FR-3.7.1 the contact timeline is a UNIFIED
// customer feed (it even attaches sent-quote PDFs), and FR-3.1.1 makes the
// pipeline `Deal` FK OPTIONAL — so a travel customer whose relationship is
// bookings + invoices but no Deal gets an EMPTY timeline when it's fed by Deal
// activities alone (the reported bug). We merge synthetic timeline entries for
// the contact's Itineraries (bookings) + TravelInvoices into `activities` at
// READ time, so existing records surface immediately with no data backfill.
// Deals stay (the PRD keeps them — FR-3.7.4 quote-accept → Deal "Booked"/"Won");
// this only ADDS the travel entities. No-op for generic/wellness tenants.
// Best-effort: any failure returns the contact unchanged — never breaks the GET.
async function attachTravelRelationshipTimeline(contact, tenantId) {
  if (!contact || typeof contact !== "object" || !contact.id) return contact;
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: true },
    });
    if (!tenant || tenant.vertical !== "travel") return contact;

    const [itineraries, invoices] = await Promise.all([
      prisma.itinerary
        .findMany({
          where: { tenantId, contactId: contact.id },
          select: { id: true, destination: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 100,
        })
        .catch(() => []),
      prisma.travelInvoice
        .findMany({
          where: { tenantId, contactId: contact.id },
          select: { id: true, invoiceNum: true, totalAmount: true, currency: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 100,
        })
        .catch(() => []),
    ]);

    const synthetic = [];
    for (const it of itineraries) {
      synthetic.push({
        id: `itin-${it.id}`,
        type: "Booking",
        description: `Booking: ${it.destination || "trip"}${it.status ? ` — ${it.status}` : ""}`,
        createdAt: it.createdAt,
      });
    }
    for (const inv of invoices) {
      const amt = inv.totalAmount != null
        ? `${inv.currency || "INR"} ${Number(inv.totalAmount).toLocaleString("en-IN")}`
        : null;
      synthetic.push({
        id: `inv-${inv.id}`,
        type: "Invoice",
        description: `Invoice ${inv.invoiceNum}${amt ? ` — ${amt}` : ""}${inv.status ? ` (${inv.status})` : ""}`,
        createdAt: inv.createdAt,
      });
    }
    if (synthetic.length === 0) return contact;

    const existing = Array.isArray(contact.activities) ? contact.activities : [];
    const merged = [...existing, ...synthetic].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return { ...contact, activities: merged };
  } catch (_e) {
    return contact; // best-effort — the timeline merge must never break the GET
  }
}

// GENERIC-VERTICAL-ONLY Lead custom fields — see Settings > Lead Fields
// (routes/lead_custom_fields.js). Admin-defined fields + their per-lead
// values, kept deliberately separate from the CustomEntity/CustomField/
// CustomValue EAV system (routes/custom_objects.js). Best-effort — a
// failure here must never break the surrounding Contact request. No
// vertical check is needed: for wellness/travel tenants no
// LeadCustomFieldDefinition rows exist (the admin UI that creates them is
// gated to the generic vertical), so this is naturally a no-op there.
async function attachLeadCustomFields(contact, tenantId) {
  if (!contact || typeof contact !== "object" || !contact.id) return contact;
  try {
    const [definitions, values] = await Promise.all([
      prisma.leadCustomFieldDefinition.findMany({ where: { tenantId } }),
      prisma.leadCustomFieldValue.findMany({ where: { tenantId, contactId: contact.id } }),
    ]);
    return { ...contact, customFields: buildCustomFieldsObject(definitions, values) };
  } catch (_e) {
    return { ...contact, customFields: {} };
  }
}

// Batch sibling of attachLeadCustomFields — for LIST endpoints (GET /) so a
// page of N contacts costs 2 extra queries total, not 2N. Every contact in
// the list gets a `customFields` object keyed by EVERY field this tenant has
// defined (not just the ones it has a value for) — so a lead created before
// a field existed shows that field as null rather than the key being absent
// entirely, matching how the create/edit forms always render every defined
// field. Best-effort: a failure here returns the contacts unchanged rather
// than breaking the list.
async function attachLeadCustomFieldsBatch(contacts, tenantId) {
  if (!Array.isArray(contacts) || !contacts.length) return contacts;
  try {
    const definitions = await prisma.leadCustomFieldDefinition.findMany({ where: { tenantId } });
    if (!definitions.length) return contacts.map((c) => ({ ...c, customFields: {} }));
    const contactIds = contacts.map((c) => c.id).filter((id) => id != null);
    const values = await prisma.leadCustomFieldValue.findMany({
      where: { tenantId, contactId: { in: contactIds } },
    });
    const valuesByContact = new Map();
    for (const v of values) {
      if (!valuesByContact.has(v.contactId)) valuesByContact.set(v.contactId, []);
      valuesByContact.get(v.contactId).push(v);
    }
    return contacts.map((c) => ({
      ...c,
      customFields: buildCustomFieldsObject(definitions, valuesByContact.get(c.id) || []),
    }));
  } catch (_e) {
    return contacts.map((c) => ({ ...c, customFields: {} }));
  }
}

// Shared projection: every field DEFINITION becomes a key (null when this
// contact has no stored value for it — covers leads created before the
// field existed), overlaid with whatever VALUES actually exist.
function buildCustomFieldsObject(definitions, values) {
  const customFields = {};
  for (const def of definitions) {
    customFields[def.fieldKey] = null;
  }
  const byFieldId = new Map(definitions.map((d) => [d.id, d]));
  for (const v of values) {
    const def = byFieldId.get(v.fieldId);
    if (!def) continue;
    let raw;
    if (def.fieldType === "number") raw = v.valueNumber;
    else if (def.fieldType === "date") raw = v.valueDate;
    else if (def.fieldType === "checkbox") raw = v.valueBool;
    else if (def.fieldType === "multiselect") {
      try {
        raw = v.valueText ? JSON.parse(v.valueText) : null;
      } catch (_e) {
        raw = v.valueText;
      }
    } else {
      // text, textarea, dropdown, radio, url
      raw = v.valueText;
    }
    customFields[def.fieldKey] = raw;
  }
  return customFields;
}

// Simple URL validator — allows http(s):// and mailto: schemes. Returns
// false for obvious non-URLs; intentionally permissive so users can store
// internal links or domain-only strings if they choose.
function isValidUrl(str) {
  try {
    const url = new URL(str);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch (_e) {
    return false;
  }
}

// Coerce a raw incoming value into the correct typed column(s) for a
// LeadCustomFieldDefinition. Returns null when the value should be cleared
// (null/undefined/empty array/empty string). Does NOT throw — invalid input
// is best-effort dropped so the surrounding Contact request stays intact.
function coerceCustomFieldValue(def, raw) {
  if (raw === null || raw === undefined || raw === "") return null;

  if (def.fieldType === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? { valueNumber: n } : null;
  }
  if (def.fieldType === "date") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : { valueDate: d };
  }
  if (def.fieldType === "checkbox") {
    return { valueBool: Boolean(raw) };
  }
  if (def.fieldType === "multiselect") {
    const arr = Array.isArray(raw) ? raw : [raw];
    const clean = arr.map((o) => String(o).trim()).filter(Boolean);
    return clean.length ? { valueText: JSON.stringify(clean) } : null;
  }
  if (def.fieldType === "radio") {
    const s = String(raw).trim();
    return s ? { valueText: s } : null;
  }
  if (def.fieldType === "url") {
    const s = String(raw).trim();
    return s && isValidUrl(s) ? { valueText: s } : null;
  }
  // text, textarea, dropdown
  const s = String(raw).trim();
  return s ? { valueText: s.slice(0, 2000) } : null;
}

// Persists req.body.customFields (a { fieldKey: value } object) as
// LeadCustomFieldValue rows for the given contact, validating each key
// against this tenant's LeadCustomFieldDefinition rows first. Unknown keys
// (no matching definition) are silently ignored rather than erroring — the
// admin may have deleted a field after a stale form was left open in
// another tab. Best-effort: a failure here must never block the Contact
// create/update it's attached to (the primary contact write already
// succeeded by the time this runs).
async function writeLeadCustomFieldValues(contactId, tenantId, customFields) {
  if (!customFields || typeof customFields !== "object") return;
  const keys = Object.keys(customFields);
  if (!keys.length) return;
  try {
    const definitions = await prisma.leadCustomFieldDefinition.findMany({
      where: { tenantId, fieldKey: { in: keys } },
    });
    const byKey = new Map(definitions.map((d) => [d.fieldKey, d]));
    for (const key of keys) {
      const def = byKey.get(key);
      if (!def) continue; // unknown/stale field key — ignore rather than error
      const raw = customFields[key];
      const clearData = { valueText: null, valueNumber: null, valueDate: null, valueBool: null };
      const typed = raw === null || raw === undefined || raw === ""
        ? null
        : coerceCustomFieldValue(def, raw);
      if (!typed) {
        // Explicit clear — upsert with all-null value columns so a previously-
        // set value can be cleared from the UI.
        await prisma.leadCustomFieldValue.upsert({
          where: { contactId_fieldId: { contactId, fieldId: def.id } },
          create: { contactId, fieldId: def.id, tenantId, ...clearData },
          update: clearData,
        });
      } else {
        await prisma.leadCustomFieldValue.upsert({
          where: { contactId_fieldId: { contactId, fieldId: def.id } },
          create: { contactId, fieldId: def.id, tenantId, ...clearData, ...typed },
          update: typed,
        });
      }
    }
  } catch (e) {
    console.error("[contacts] writeLeadCustomFieldValues failed (non-fatal):", e && e.message);
  }
}

// Protect all contact routes
router.use(verifyToken);
router.get("/by-status", audienceController.getContactsByStatus)


router.get('/', async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.assignedToId) where.assignedToId = parseInt(req.query.assignedToId);
    if (req.query.unassigned === 'true') where.assignedToId = null;
    // Arc 2 #904 slice 8 — ?source=<prefix> server-side filter. Replaces the
    // STUB client-side `source.startsWith('inbound:')` filter in
    // InboundLeads.jsx (slice 7, 56f549f7) which was bounded by the
    // ?limit=100 page-size + scanned the entire result. Server-side prefix
    // match pushes the predicate into Prisma so the 500-row hard cap (#172)
    // is no longer a coverage hole. Absent param = unfiltered (existing
    // behaviour preserved).
    if (req.query.source !== undefined) {
      const prefix = typeof req.query.source === 'string' ? req.query.source : '';
      if (prefix.length < 1 || prefix.length > 128) {
        return res.status(400).json({
          error: 'source must be a non-empty string ≤128 chars',
          code: 'INVALID_SOURCE',
          field: 'source',
        });
      }
      where.source = { startsWith: prefix };
    }
    // Freshsales-style "Filter by" panel — ?filters=<JSON array>, each entry
    // {field, operator, values}. `field` is either a FILTERABLE_FIELDS key
    // (never trust a raw column name from the client into a Prisma
    // where-clause) or "custom_<id>" for an admin-defined Lead custom field
    // (Settings > Lead Fields — dynamic per tenant, so it can't be a static
    // allowlist like FILTERABLE_FIELDS). operator must be one of
    // FILTER_OPERATORS. Invalid entries are skipped rather than erroring —
    // the panel only ever sends known field/operator pairs, so a mismatch
    // here means stale client cache, not attacker input.
    if (req.query.filters) {
      let parsed;
      try {
        parsed = JSON.parse(req.query.filters);
      } catch {
        return res.status(400).json({ error: 'filters must be a JSON array', code: 'INVALID_FILTERS' });
      }
      if (!Array.isArray(parsed)) {
        return res.status(400).json({ error: 'filters must be a JSON array', code: 'INVALID_FILTERS' });
      }
      // Custom-field entries need their definition id checked against this
      // tenant before it's trusted in a query — otherwise a crafted
      // "custom_<id>" from another tenant's field would leak whether a
      // row exists there. Fetched once, only when the payload actually
      // references one, to avoid an extra round-trip on the common case.
      let tenantCustomFieldIds = null;
      let tenantCustomFieldKinds = null;
      if (parsed.some((f) => f && isCustomField(f.field))) {
        const defs = await prisma.leadCustomFieldDefinition.findMany({
          where: { tenantId: req.user.tenantId },
          select: { id: true, fieldType: true },
        });
        tenantCustomFieldIds = new Set(defs.map((d) => d.id));
        // fieldType decides WHICH typed column on LeadCustomFieldValue holds
        // the data (valueDate for a Date-picker field, valueText otherwise),
        // so buildCustomFieldClause needs it to probe the right one. Without
        // it every custom field was treated as text and a date `between`
        // silently produced no clause at all — the filter then returned the
        // whole unfiltered list rather than the matching rows.
        tenantCustomFieldKinds = new Map(
          defs.map((d) => [d.id, CUSTOM_FIELD_TYPE_TO_KIND[d.fieldType] || 'text']),
        );
      }
      // Vertical gate — same rule as /filter-fields and /filter-values (see
      // the big comment above FILTERABLE_FIELDS): a field restricted to
      // e.g. `verticals: ['travel']` must be rejected here too, not just
      // hidden from the picker, or a crafted request could still filter a
      // generic tenant's contacts by a travel-only column. Only resolved
      // when the payload actually references a `verticals`-gated field, to
      // avoid the extra round-trip on the common (ungated-fields-only) case.
      let vertical = null;
      if (parsed.some((f) => f && FILTERABLE_FIELDS[f.field]?.verticals)) {
        const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { vertical: true } });
        vertical = tenant?.vertical || 'generic';
      }
      const clauses = [];
      for (const f of parsed) {
        if (!f || typeof f !== 'object' || !FILTER_OPERATORS.includes(f.operator)) continue;
        const rawValues = Array.isArray(f.values) ? f.values : [];
        if (isCustomField(f.field)) {
          const defId = customFieldDefIdFromKey(f.field);
          if (defId === null || !tenantCustomFieldIds.has(defId)) continue;
          const clause = buildCustomFieldClause(defId, f.operator, rawValues, tenantCustomFieldKinds.get(defId) || 'text');
          if (clause) clauses.push(clause);
          continue;
        }
        const fieldDef = FILTERABLE_FIELDS[f.field];
        if (!fieldDef) continue;
        if (fieldDef.verticals && !fieldDef.verticals.includes(vertical)) continue;
        const clause = buildFilterClause(fieldDef, f.operator, rawValues);
        if (clause) clauses.push(clause);
      }
      if (clauses.length > 0) where.AND = [...(where.AND || []), ...clauses];
    }
    // #167: hide soft-deleted rows by default; admin views can opt in.
    applyDeletedAtFilter(where, req.query.includeDeleted === 'true');
    // #588: non-admin callers see only contacts assigned to them. Travel
    // tightens this further so only ADMIN can view the full tenant; an
    // explicit ?assignedToId from a restricted caller is overridden by their
    // own userId — a rep cannot probe a colleague's book of business by URL.
    // Total Contacts KPI on /dashboard now reflects own-book size for sales reps.
    if (!canViewAllLeads(req)) where.assignedToId = req.user.userId;
    // ?count=1 — sidebar badge polls: return { total } only, skip full fetch.
    if (req.query.count === '1') {
      const total = await prisma.contact.count({ where });
      return res.json({ total });
    }
    // #172: honor limit / offset query params with sensible defaults + a hard cap.
    // Pre-fix the API silently returned the entire dataset, breaking pagination
    // and exposing a perf/DoS surface.
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    // #920 slice 1 — PII reduction via opt-in slim shape. When the caller
    // passes ?fields=summary, the response drops the heavy nested includes
    // (activities/tasks/assignedTo) AND the sensitive flat fields
    // (phone/walletBalance/gst/birthDate/anniversary/address) by switching
    // to an explicit Prisma `select`. ADDITIVE — when ?fields is absent
    // or any other value, the existing full-shape `include` is preserved
    // so no existing consumer (Contacts page, Billing.jsx, CommandPalette,
    // etc.) needs to change. filterReadFields() still applies on the slim
    // shape (no-op for fields not present, full-effect for fields it
    // recognises) so the #464 field-permission layer keeps composing.
    const isSummary = req.query.fields === 'summary';
    const findManyArgs = {
      where, take: limit, skip: offset,
      orderBy: { id: 'desc' },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        name: true,
        email: true,
        status: true,
        assignedToId: true,
        tenantId: true,
        createdAt: true,
      };
    } else {
      findManyArgs.include = { activities: true, tasks: true, assignedTo: { select: { id: true, name: true, email: true } } };
    }
    const contacts = await prisma.contact.findMany(findManyArgs);
    // #464: strip read-restricted fields per the caller's role.
    const filtered = await filterReadFields(contacts, req.user.role, "Contact", req.user.tenantId);
    // Generic-vertical-only: attach { fieldKey: value|null } to every row
    // (no-op elsewhere — see attachLeadCustomFieldsBatch). Skipped for the
    // ?fields=summary slim shape, which is an explicit "give me the minimal
    // projection" opt-in.
    const withTags = serializeContactTagsBatch(filtered);
    const withCustomFields = isSummary ? withTags : await attachLeadCustomFieldsBatch(withTags, req.user.tenantId);
    res.json(withCustomFields);
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// GET /api/contacts/filter-fields — the field list a "Filter by" panel
// offers, mirroring Freshsales' field picker. Merges the static
// FILTERABLE_FIELDS allowlist (kept in lockstep with BUILTIN_COLUMNS in
// table_column_preferences.js — the same columns "Customize table" shows)
// with this tenant's admin-defined Lead custom fields (Settings > Lead
// Fields), so a field an admin adds today shows up in the filter panel
// immediately with no code change. Every field the org HAS is listed;
// there is no has-data gate (see the NOTE above FILTERABLE_FIELDS for why
// row-count gating was removed). The frontend renders these as the
// left-hand field-picker list, then calls /filter-values/:field once a
// field is chosen.
//
// Optional ?status=<value> scopes the VALUE lists (via /filter-values) to
// the same subset the calling page filters over — Leads.jsx passes
// ?status=Lead (leads ARE Contact rows with status="Lead"; there is no
// separate Lead model), Contacts.jsx passes nothing and sees every status.
// It's accepted here too so both endpoints take the same query shape.
//
// Registered BEFORE /:id — Express matches in order, so a literal path
// must precede the /:id param route or it would be read as :id.
router.get('/filter-fields', async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    // Vertical gate — see the comment above FILTERABLE_FIELDS. Travel-only
    // columns (subBrand, kycStatus) never reach a generic/wellness tenant's
    // picker, regardless of what stray or schema-default data exists.
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
    const vertical = tenant?.vertical || 'generic';
    const staticFields = Object.entries(FILTERABLE_FIELDS)
      .filter(([, def]) => !def.verticals || def.verticals.includes(vertical))
      .map(([key, def]) => ({
        field: key,
        label: def.label,
        kind: def.kind,
      }));
    const customDefs = await prisma.leadCustomFieldDefinition.findMany({
      where: { tenantId },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, label: true, fieldType: true },
    });
    // A custom field's admin-chosen fieldType decides how it can be
    // filtered, exactly as it decides which typed column stores its values
    // (valueText / valueNumber / valueDate / valueBool — see
    // attachLeadCustomFieldsBatch). Handing every custom field back as
    // "text" made a Date-picker field offer a substring match over a list
    // of stored days instead of a calendar.
    const customFields = customDefs.map((d) => ({
      field: `${CUSTOM_FIELD_PREFIX}${d.id}`,
      label: d.label,
      kind: CUSTOM_FIELD_TYPE_TO_KIND[d.fieldType] || 'text',
      custom: true,
      fieldType: d.fieldType,
    }));
    res.json({ fields: [...staticFields, ...customFields] });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch filter fields' });
  }
});

// GET /api/contacts/filter-values/:field — distinct values for one field,
// scoped to the caller's tenant, for the panel's checkbox list. `id`-kind
// fields (owner/territory) resolve against User/Territory rows rather than
// DISTINCT Contact.assignedToId, since the panel needs a human label
// ("Jane Doe"), not a bare foreign-key integer. "custom_<id>" fields with a
// fixed choice list (dropdown/radio/multiselect) return the field
// definition's own `options` — this is deliberately NOT a DISTINCT scan
// over stored values, so a choice nobody has picked yet still appears as a
// filterable option (mirrors how the Lead create/edit form itself sources
// its dropdown). Free-text custom field types (text/textarea/url/number/
// date/checkbox) fall back to a DISTINCT scan since there's no fixed list.
router.get('/filter-values/:field', async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    // Same ?status scoping as /filter-fields (see that route's comment) —
    // Leads.jsx passes ?status=Lead so the value list only shows values
    // that actually occur among Lead-status rows, matching what /filter-
    // fields already gated the field's very presence on. Without this, a
    // field could correctly appear in the Leads picker (gated on Lead-scoped
    // presence) but its value list would still include values that only
    // ever occur on Customer/Prospect rows — same mismatch, one level down.
    const statusScope = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
    const scopeWhere = statusScope ? { status: statusScope } : {};
    if (isCustomField(req.params.field)) {
      const defId = customFieldDefIdFromKey(req.params.field);
      if (defId === null) return res.status(404).json({ error: 'Unknown filter field', code: 'UNKNOWN_FIELD' });
      const def = await prisma.leadCustomFieldDefinition.findFirst({ where: { id: defId, tenantId } });
      if (!def) return res.status(404).json({ error: 'Unknown filter field', code: 'UNKNOWN_FIELD' });
      if (['dropdown', 'radio', 'multiselect'].includes(def.fieldType) && def.options) {
        const options = JSON.parse(def.options);
        return res.json({ values: options.map((o) => ({ value: o, label: o })) });
      }
      // Custom field values live on LeadCustomFieldValue, joined via its
      // `contact` relation — status scoping has to filter through that
      // relation since the value row itself has no status column.
      const rows = await prisma.leadCustomFieldValue.findMany({
        where: {
          fieldId: defId,
          tenantId,
          valueText: { not: null },
          ...(statusScope ? { contact: { status: statusScope, deletedAt: null } } : {}),
        },
        select: { valueText: true },
        distinct: ['valueText'],
        orderBy: { valueText: 'asc' },
        take: 200,
      });
      const values = rows
        .map((r) => r.valueText)
        .filter((v) => v !== null && v !== '')
        .map((v) => ({ value: v, label: v }));
      return res.json({ values });
    }
    const fieldDef = FILTERABLE_FIELDS[req.params.field];
    if (!fieldDef) return res.status(404).json({ error: 'Unknown filter field', code: 'UNKNOWN_FIELD' });
    // Vertical gate — mirrors /filter-fields' eligibility check (see the
    // big comment above FILTERABLE_FIELDS). A vertical-restricted field
    // (subBrand, kycStatus) is rejected here too, not just hidden from the
    // picker — otherwise a stale client-side filter chip, or someone
    // hitting this endpoint directly, could still pull values for a
    // feature this tenant's vertical doesn't have.
    if (fieldDef.verticals) {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
      const vertical = tenant?.vertical || 'generic';
      if (!fieldDef.verticals.includes(vertical)) {
        return res.status(404).json({ error: 'Unknown filter field', code: 'UNKNOWN_FIELD' });
      }
    }
    if (req.params.field === 'assignedToId') {
      const users = await prisma.user.findMany({
        where: { tenantId },
        select: { id: true, name: true, email: true },
        orderBy: { name: 'asc' },
      });
      return res.json({ values: users.map((u) => ({ value: String(u.id), label: u.name || u.email })) });
    }
    if (req.params.field === 'callifiedCampaignId') {
      const campaigns = await callifiedClient.listCampaigns(tenantId).catch(() => []);
      const values = (Array.isArray(campaigns) ? campaigns : [])
        .filter((campaign) => campaign && campaign.id != null)
        .map((campaign) => ({
          value: String(campaign.id),
          label: campaign.name || campaign.label || campaign.title || `Campaign ${campaign.id}`,
        }));
      if (values.length > 0) {
        return res.json({ values });
      }
      const rows = await prisma.contact.findMany({
        where: {
          tenantId,
          deletedAt: null,
          callifiedCampaignId: { not: null },
        },
        select: { callifiedCampaignId: true },
        distinct: ['callifiedCampaignId'],
        orderBy: { callifiedCampaignId: 'asc' },
        take: 200,
      });
      return res.json({
        values: rows
          .map((row) => row.callifiedCampaignId)
          .filter((value) => value !== null && value !== undefined)
          .map((value) => ({
            value: String(value),
            label: `Campaign ${value}`,
          })),
      });
    }
    if (req.params.field === 'callifiedLeadStatus') {
      const rows = await prisma.contact.findMany({
        where: {
          tenantId,
          deletedAt: null,
          AND: [scopeWhere, { callifiedLeadStatus: { not: null } }],
        },
        select: { callifiedLeadStatus: true },
        distinct: ['callifiedLeadStatus'],
        orderBy: { callifiedLeadStatus: 'asc' },
        take: 200,
      });
      const seen = new Set();
      const values = [];
      for (const row of rows) {
        if (row.callifiedLeadStatus == null || row.callifiedLeadStatus === "") continue;
        const normalized = normalizeLeadStatus(row.callifiedLeadStatus);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        values.push({
          value: normalized,
          label: CALL_STATUS_LABELS[normalized] || normalized,
        });
      }
      return res.json({ values });
    }
    if (req.params.field === 'territoryId') {
      const territories = await prisma.territory.findMany({
        where: { tenantId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      return res.json({ values: territories.map((t) => ({ value: String(t.id), label: t.name })) });
    }
    if (req.params.field === 'tags') {
      const rows = await prisma.contact.findMany({
        where: {
          tenantId,
          deletedAt: null,
          AND: [scopeWhere, { tagsJson: { not: null } }, { tagsJson: { not: '' } }],
        },
        select: { tagsJson: true },
        take: 1000,
      });
      const seen = new Set();
      const values = [];
      for (const row of rows) {
        for (const tag of parseContactTags(row.tagsJson)) {
          const key = tag.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          values.push({ value: tag, label: tag });
        }
      }
      values.sort((a, b) => a.label.localeCompare(b.label));
      return res.json({ values });
    }
    // range-kind fields offer their fixed buckets, not a DISTINCT scan of
    // every individual value present (see the "range" note above
    // FILTERABLE_FIELDS — Lead Score would otherwise list 5, 36, 49, 64…).
    if (fieldDef.kind === 'range') {
      return res.json({ values: (fieldDef.buckets || []).map((b) => ({ value: b.value, label: b.label })) });
    }
    // `required` (non-nullable) columns — Contact.name/status/aiScore/
    // createdAt — can't be filtered with `{ not: null }`; Prisma rejects
    // null as a comparison value for a field whose type never permits it.
    // Text ones only need the empty-string exclusion; number/date ones
    // have no "empty" representation at all (every row has a real value),
    // so no not-null/not-empty filter is needed on the DISTINCT scan itself.
    let notNullFilter;
    if (fieldDef.required && (fieldDef.kind === 'number' || fieldDef.kind === 'date')) {
      notNullFilter = undefined;
    } else if (fieldDef.required) {
      notNullFilter = { not: '' };
    } else {
      notNullFilter = { not: null };
    }
    // Same status/column key-collision risk as /filter-fields' presence
    // check above (querying /filter-values/status?status=Lead would spread
    // `status: 'Lead'` then `status: {not: ''}`, silently dropping one) —
    // AND-combine instead of a flat spread so both always apply.
    const columnPredicate = notNullFilter ? { [fieldDef.column]: notNullFilter } : {};
    const rows = await prisma.contact.findMany({
      where: { tenantId, deletedAt: null, AND: [scopeWhere, columnPredicate] },
      select: { [fieldDef.column]: true },
      distinct: [fieldDef.column],
      orderBy: { [fieldDef.column]: 'asc' },
      take: 200,
    });
    // date-kind values are DateTime objects — normalize to a "YYYY-MM-DD"
    // day label both for the checkbox list's display AND as the `value`
    // sent back in ?filters=, since buildFilterClause's dayRange() parses
    // that same string into a [start, end) range. Time-of-day is dropped
    // deliberately — the panel filters by "occurred on this day", matching
    // how a human reads a date column in a table, not exact timestamps.
    if (fieldDef.kind === 'date') {
      const days = [...new Set(
        rows
          .map((r) => r[fieldDef.column])
          .filter((v) => v !== null)
          .map((v) => new Date(v).toISOString().slice(0, 10)),
      )].sort();
      return res.json({ values: days.map((d) => ({ value: d, label: d })) });
    }
    const values = rows
      .map((r) => r[fieldDef.column])
      .filter((v) => v !== null && v !== '')
      .map((v) => ({ value: String(v), label: String(v) }));
    res.json({ values });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch filter values' });
  }
});

router.delete('/tags', async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const tag = normalizeContactTagValue(req.body?.tag);
    if (!tag) {
      return res.status(400).json({ error: 'Tag is required', code: 'TAG_REQUIRED' });
    }
    if (CONTACT_TAG_CONTROL_RE.test(tag)) {
      return res.status(400).json({ error: 'Tag contains invalid control characters', code: 'INVALID_TAG' });
    }
    if (tag.length > CONTACT_TAG_MAX_LENGTH) {
      return res.status(400).json({
        error: `Each tag must be ${CONTACT_TAG_MAX_LENGTH} characters or less`,
        code: 'TAG_TOO_LONG',
      });
    }
    const statusScope = typeof req.body?.status === 'string' && req.body.status.trim()
      ? req.body.status.trim()
      : 'Lead';
    const tagKey = tag.toLowerCase();
    const rows = await prisma.contact.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: statusScope,
        tagsJson: { not: null },
      },
      select: { id: true, tagsJson: true },
    });
    let updatedContacts = 0;
    for (const row of rows) {
      const currentTags = parseContactTags(row.tagsJson);
      const nextTags = currentTags.filter((current) => current.toLowerCase() !== tagKey);
      if (nextTags.length === currentTags.length) continue;
      await prisma.contact.update({
        where: { id: row.id },
        data: { tagsJson: nextTags.length > 0 ? JSON.stringify(nextTags) : null },
      });
      updatedContacts += 1;
    }
    return res.json({ deletedTag: tag, status: statusScope, updatedContacts });
  } catch (_err) {
    return res.status(500).json({ error: 'Failed to delete tag' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid contact ID' });
    const includeDeleted = req.query.includeDeleted === 'true';
    const contact = await prisma.contact.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { activities: { orderBy: { createdAt: 'desc' } }, tasks: true, deals: true, assignedTo: { select: { id: true, name: true, email: true } } }
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!canAccessLead(req, contact)) return res.status(404).json({ error: 'Contact not found' });
    // #167: 404 soft-deleted rows unless caller opts in.
    if (contact.deletedAt && !includeDeleted) return res.status(404).json({ error: 'Contact not found' });
    // #464: strip read-restricted fields per the caller's role.
    const filtered = await filterReadFields(contact, req.user.role, "Contact", req.user.tenantId);
    // PRD Gap §1.1e — surface computed walletBalance from the linked Patient's
    // Wallet (if any). Best-effort; falls back to null on any error.
    const withWallet = await attachComputedWalletBalance(filtered, req.user.tenantId);
    // Travel-only: merge the contact's bookings (Itineraries) + invoices into
    // the activity timeline so booking-only customers aren't shown empty.
    const withTimeline = await attachTravelRelationshipTimeline(withWallet, req.user.tenantId);
    // Generic-vertical-only: attach { fieldKey: value } from this tenant's
    // Lead custom field definitions/values (no-op elsewhere — see helper).
    const withCustomFields = await attachLeadCustomFields(withTimeline, req.user.tenantId);
    res.json(serializeContactTags(withCustomFields));
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

router.post('/', async (req, res) => {
  try {
    // #464: strip write-restricted fields BEFORE validation so a USER who has
    // canWrite=false on Contact.email can't push a value through. Validation
    // then runs on the filtered body — if email was stripped, the !isUpdate
    // path will surface EMAIL_REQUIRED instead of silently storing the
    // forbidden value.
    req.body = await filterWriteFields(req.body, req.user.role, "Contact", req.user.tenantId);
    // PRD Gap §1.1e — strip walletBalance from writes (read-only computed surface).
    req.body = stripWalletBalanceWrite(req.body);
    // Generic-vertical-only Lead custom fields (Settings > Lead Fields) —
    // customFields is NOT a real Contact column, so it must never reach
    // prisma.contact.create's spread below. Captured here, written to
    // LeadCustomFieldValue AFTER the contact create succeeds (see below).
    const customFields = req.body.customFields;
    delete req.body.customFields;
    const tagsInput = Object.prototype.hasOwnProperty.call(req.body, "tags")
      ? req.body.tags
      : undefined;
    delete req.body.tags;
    delete req.body.tagsJson;
    const tagsResult = normalizeContactTagsInput(tagsInput);
    if (tagsResult.error) return res.status(tagsResult.error.status).json(tagsResult.error);
    const skipInitialAssignee = req.body.skipInitialAssignee === true;
    delete req.body.skipInitialAssignee;
    // #600 / #557 follow-up: the Leads form sends wellness-only optional fields
    // as empty strings even in the generic vertical. Prisma Int? / DateTime? /
    // String? columns reject "" where they expect null / a valid shape, so
    // normalize empty strings to null before validation. This keeps the route
    // resilient to any frontend/client that sends "" for optional fields.
    for (const key of ["preferredLocationId", "preferredPractitionerId", "birthDate", "anniversary", "treatmentOfInterest", "gst", "stateCode", "billingStateCode", "callifiedCampaignId"]) {
      if (req.body[key] === "") req.body[key] = null;
    }
    // #160 #166: validate before hitting Prisma so bad inputs return 400 with a
    // clear code instead of a 500 from the DB layer.
    const inputErr = validateContactInput(req.body, { isUpdate: false });
    if (inputErr) return res.status(inputErr.status).json(inputErr);
    // #337: persist the trimmed name so we don't leak the user's accidental
    // leading/trailing whitespace into search indexes, exports, etc. The
    // validator already verified there's at least one non-whitespace char.
    const normalised = { ...req.body, name: typeof req.body.name === "string" ? req.body.name.trim() : req.body.name };
    if (tagsResult.hasValue) {
      normalised.tagsJson = tagsResult.tags.length ? JSON.stringify(tagsResult.tags) : null;
    }
    // PRD Gap §1.1a/§1.1d — date fields come in as ISO strings; Prisma
    // rejects strings on DateTime columns with PrismaClientValidationError.
    // Coerce to Date objects after validation.
    if (typeof normalised.anniversary === "string" && normalised.anniversary !== "") {
      normalised.anniversary = new Date(normalised.anniversary);
    }
    if (typeof normalised.birthDate === "string" && normalised.birthDate !== "") {
      normalised.birthDate = new Date(normalised.birthDate);
    }
    // Generic CRM Callified leads stay unassigned until the call produces a real status.
    // Explicit assignedToId still wins, and non-generic contact creation keeps the existing creator default.
    const isGenericLeadAwaitingCall =
      (req.user.vertical || 'generic') === 'generic' &&
      normalised.status === 'Lead' &&
      (!normalised.callifiedLeadStatus || normalised.callifiedLeadStatus === 'yet_to_call');
    const shouldSkipInitialAssignee = isGenericLeadAwaitingCall || (skipInitialAssignee && normalised.status === 'Lead');
    if (normalised.assignedToId == null && !shouldSkipInitialAssignee) {
      normalised.assignedToId = req.user.userId;
    }

    // Auto-assign new Leads to a matching Callified campaign based on the
    // tenant's rule configuration when no campaign was supplied explicitly.
    // Rules are evaluated in order; the first matching column+value wins.
    // Covers manual create, import, extension capture, and webhooks.
    if (normalised.status === "Lead" && normalised.callifiedCampaignId == null) {
      try {
        const matchedCampaignId = await evaluateAutoCampaignRules(req.user.tenantId, normalised, customFields);
        if (matchedCampaignId) {
          normalised.callifiedCampaignId = matchedCampaignId;
        }
      } catch (e) {
        console.error("[contacts] auto-campaign rule evaluation failed:", e.message);
      }
    }

    // PRD §4.5 — Phase 2 dedup preflight. Before letting Prisma's
    // @@unique([email, tenantId]) throw a P2002, run the richer
    // findDuplicateContactFull helper so the route can surface a
    // friendly 409 DUPLICATE_CONTACT with `{ existingContactId,
    // matchedBy, contact: {...projection} }` — frontend renders this
    // as the "merge or keep both" pop-up (same shape as the RFU
    // passport-collision modal). Phone match is fuzzy (normalised),
    // so this catches "+91 98765 43210" vs "919876543210" duplicates
    // that the bare email-only unique constraint misses entirely.
    //
    // Bypass with ?force=true for the rare legitimate "yes, I know
    // there's a similar contact, create anyway" case (CSV bulk import
    // already has its own merge flow). The P2002 catch in the outer
    // try block stays as defense-in-depth against the race window
    // between preflight and create.
    const force = req.query.force === "true" || req.query.force === "1";
    if (!force) {
      try {
        const dup = await findDuplicateContactFull({
          email: normalised.email || null,
          phone: normalised.phone || null,
          tenantId: req.user.tenantId,
        });
        if (dup) {
          const c = dup.contact;
          return res.status(409).json({
            error: "A contact with this email or phone already exists in your CRM",
            code: "DUPLICATE_CONTACT",
            matchedBy: dup.matchedBy,
            existingContactId: c.id,
            contact: {
              id: c.id,
              name: c.name,
              email: c.email,
              phone: c.phone ? normalizePhoneValue(c.phone) : c.phone,
              company: c.company,
              status: c.status,
              subBrand: c.subBrand,
            },
          });
        }
      } catch (e) {
        // Helper failure is non-fatal — log + fall through to the
        // normal create path so a transient dedup outage doesn't block
        // contact creation. P2002 still catches genuine email collisions.
        console.error("[contacts] dedup preflight error:", e.message);
      }
    }

    let restoredSoftDeletedContact = false;
    let contact = null;
    if (normalised.email) {
      const deletedContact = await prisma.contact.findUnique({
        where: { email_tenantId: { email: normalised.email, tenantId: req.user.tenantId } },
      });
      if (deletedContact?.deletedAt) {
        contact = await prisma.contact.update({
          where: { id: deletedContact.id },
          data: { ...normalised, tenantId: req.user.tenantId, status: normalised.status || "Lead", deletedAt: null },
        });
        restoredSoftDeletedContact = true;
      }
    }
    if (!contact) {
      contact = await prisma.contact.create({ data: { ...normalised, tenantId: req.user.tenantId } });
    }
    // Generic-vertical-only Lead custom fields — best-effort, after the
    // primary create/restore already succeeded (see writeLeadCustomFieldValues).
    await writeLeadCustomFieldValues(contact.id, req.user.tenantId, customFields);
    try {
      const { emitEvent } = require('../lib/eventBus');
      await emitEvent('contact.created', workflowContactPayload(contact, req.user.userId), req.user.tenantId, req.io);
    } catch (_e) { /* event bus optional */ }
    // [GP-CRM integration] Fire lead.new to registered webhooks (e.g. GlobusPhone)
    // when a Lead contact is created. Carries the id/name/phone/email shape the
    // partner expects (the emitEvent above uses a workflow-rule payload keyed on
    // contactId). Fire-and-forget — a webhook failure must never block the 201.
    if (contact.status === "Lead") {
      try {
        const { deliverWebhooks } = require('../lib/webhookDelivery');
        await deliverWebhooks("lead.new", {
          id: contact.id,
          name: contact.name,
          phone: contact.phone ? normalizePhoneValue(contact.phone) : contact.phone,
          email: contact.email,
          status: contact.status,
          assignedToId: contact.assignedToId,
          tenantId: req.user.tenantId,
        }, req.user.tenantId);
      } catch (_e) { /* webhook delivery is fire-and-forget */ }
      await notifyAdminsOfNewLead({ tenantId: req.user.tenantId, contact, io: req.io });
    }
    // #179: audit row for new/restored contact.
    await writeAudit('Contact', restoredSoftDeletedContact ? 'RESTORE' : 'CREATE', contact.id, req.user.userId, req.user.tenantId, { name: contact.name, email: contact.email });

    // Auto-dial newly-created Leads that have a Callified campaign + phone,
    // but only when the tenant has enabled auto-dial for new leads.
    // Fire-and-forget: never block the create response on an outbound call.
    if (contact.status === 'Lead' && contact.callifiedCampaignId && contact.phone) {
      try {
        const autoDialEnabled = await getSetting(contact.tenantId, KEYS.CALLIFIED_AUTO_DIAL_NEW_LEADS_ENABLED, {
          coerce: (v) => String(v).toLowerCase() !== 'false',
        });
        if (autoDialEnabled) {
          const { enqueue } = require('../lib/callifiedAutoDialQueue');
          enqueue({
            tenantId: contact.tenantId,
            contactId: contact.id,
            campaignId: contact.callifiedCampaignId,
            userId: req.user.userId,
          });
        }
      } catch (_e) {
        console.error('[contacts] auto-dial enqueue failed:', _e && _e.message);
      }
    }

    res
      .status(restoredSoftDeletedContact ? 200 : 201)
      .json(
        restoredSoftDeletedContact
          ? { ...serializeContactTags(contact), restored: true }
          : serializeContactTags(contact),
      );
  } catch (err) {
    // #178: duplicate email should be 409 Conflict, not 500.
    // #165: validation-class Prisma errors (string-too-long, FK miss, …) are
    //       4xx, not 5xx. Only genuine surprises fall through to 500.
    const mapped = httpFromPrismaError(err);
    if (mapped) return res.status(mapped.status).json(mapped);
    console.error('[contacts] create error:', err && err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// Bulk assign agent to multiple contacts (must be before /:id routes)
// Restricted to ADMIN only — only admins may reassign leads between staff.
router.put('/bulk-assign', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const { contactIds, assignedToId } = req.body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'No contact IDs provided' });
    }
    const ids = contactIds.map(id => parseInt(id)).filter(Number.isFinite);
    const nextAssignedToId = assignedToId ? parseInt(assignedToId) : null;
    const rows = await prisma.contact.findMany({
      where: { id: { in: ids }, tenantId: req.user.tenantId },
      select: { id: true, name: true, subBrand: true, assignedToId: true },
    });

    let assignableRows = rows;
    let skippedRows = [];
    if (nextAssignedToId) {
      const { getSubBrandAccessSet, canAccessSubBrand } = require('../middleware/travelGuards');
      const allowed = await getSubBrandAccessSet(nextAssignedToId);
      assignableRows = rows.filter((r) => !r.subBrand || canAccessSubBrand(allowed, r.subBrand));
      skippedRows = rows.filter((r) => r.subBrand && !canAccessSubBrand(allowed, r.subBrand));
    }

    const assignableIds = assignableRows.map((r) => r.id);
    if (assignableIds.length > 0) {
      await prisma.contact.updateMany({
        where: { id: { in: assignableIds }, tenantId: req.user.tenantId },
        data: { assignedToId: nextAssignedToId },
      });
    }

    if (nextAssignedToId) {
      const actorName = req.user?.name || req.user?.email || 'Admin';
      for (const row of assignableRows) {
        if (nextAssignedToId === row.assignedToId) continue;
        try {
          const leadName = row.name || ('#' + row.id);
          await notify({
            userId: nextAssignedToId,
            tenantId: req.user.tenantId,
            title: 'New lead assigned',
            message: actorName + ' has assigned lead "' + leadName + '" to you. Please look into it.',
            type: 'info',
            category: 'lead',
            entityType: 'lead',
            entityId: row.id,
            link: '/contacts/' + row.id,
            io: req.io,
          });
        } catch (notifyErr) {
          console.error('[contacts] bulk lead assignment notify failed:', notifyErr && notifyErr.message);
        }
      }
    }

    res.json({
      updated: assignableIds.length,
      skipped: skippedRows.length,
      assignedToId: assignedToId || null,
      skippedDetails: skippedRows.map((r) => ({
        id: r.id,
        name: r.name,
        subBrand: r.subBrand,
        reason: 'ASSIGNEE_SUB_BRAND_ACCESS_MISMATCH',
      })),
    });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to bulk assign agent' });
  }
});

router.put('/bulk-assign-campaign', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const { contactIds, callifiedCampaignId } = req.body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'No contact IDs provided' });
    }
    const ids = contactIds.map((id) => parseInt(id)).filter(Number.isFinite);
    const nextCampaignId = callifiedCampaignId ? parseInt(callifiedCampaignId) : null;

    if (nextCampaignId !== null && (!Number.isInteger(nextCampaignId) || nextCampaignId <= 0)) {
      return res.status(400).json({ error: 'Invalid campaign ID', code: 'INVALID_CAMPAIGN_ID' });
    }

    const { count } = await prisma.contact.updateMany({
      where: { id: { in: ids }, tenantId: req.user.tenantId },
      data: { callifiedCampaignId: nextCampaignId },
    });

    res.json({ updated: count });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to bulk assign campaign' });
  }
});

// Bulk soft-delete multiple contacts (must stay before /:id routes).
router.delete('/bulk-delete', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const { contactIds } = req.body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: 'No contact IDs provided' });
    }

    const ids = [...new Set(contactIds.map((id) => parseInt(id)).filter(Number.isFinite))];
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No valid contact IDs provided', code: 'INVALID_CONTACT_IDS' });
    }

    const { count } = await prisma.contact.updateMany({
      where: { id: { in: ids }, tenantId: req.user.tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    res.json({ deleted: count });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to bulk delete contacts' });
  }
});

router.post('/:id/activities', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!canAccessLead(req, contact)) return res.status(404).json({ error: 'Contact not found' });
    const { type, description } = req.body;
    const activity = await prisma.activity.create({
      data: { type, description, contactId: contact.id, userId: req.user ? req.user.userId : null, tenantId: req.user.tenantId }
    });
    // PRD §6.4: lead-side SLA — first activity logged against a Lead stamps
    // firstResponseAt, stopping the SLA clock. Best-effort: any failure
    // here MUST NOT break the activity write.
    try { await markFirstResponseIfNeeded({ contactId: contact.id }); } catch (_e) { /* ignore */ }
    res.status(201).json(activity);
  } catch (_err) {
    res.status(500).json({ error: 'Failed to create activity' });
  }
});

// "Summarize" (2026-07-07) — on-demand full-history AI narrative. Re-reads
// EVERY WhatsApp message linked to this contact and REPLACES Contact.description
// with one flowing narrative + a current lead-stage line. Independent of the
// incremental "Sync Lead" action on the WhatsApp thread view.
router.post('/:id/summarize-chat', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid contact ID' });
    const existing = await prisma.contact.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    if (!canAccessLead(req, existing)) return res.status(404).json({ error: 'Contact not found' });
    const leadConversationSummary = require('../lib/leadConversationSummary');
    const result = await leadConversationSummary.narrativeSummarizeContact({
      tenantId: req.user.tenantId,
      contactId: id,
    });
    if (result.skipped === 'contact-not-found') {
      return res.status(404).json({ error: 'Contact not found' });
    }
    if (result.skipped === 'no-messages') {
      return res.status(409).json({ error: 'No WhatsApp messages found for this contact yet.', code: 'NO_WHATSAPP_HISTORY' });
    }
    res.json(result);
  } catch (e) {
    console.error('[contacts] summarize-chat error:', e.message);
    res.status(500).json({ error: 'Failed to summarize chat', code: 'SUMMARIZE_CHAT_FAILED' });
  }
});

// "Summarize again" (2026-07-09) — on-demand consolidation for browser-
// extension-sourced leads (gmail / whatsapp-extension). These sources have
// no raw message log to re-read (unlike /summarize-chat's WhatsAppMessage
// rows) — each capture already wrote a one-time dated block straight into
// Contact.description (routes/leads_extension_capture.js). This reads
// whatever dated blocks have piled up from repeat captures and REPLACES
// description with one consolidated AI narrative, same replace-outright
// semantics as /summarize-chat, just fed the description text itself.
router.post('/:id/resummarize-capture', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid contact ID' });
    const leadConversationSummary = require('../lib/leadConversationSummary');
    const result = await leadConversationSummary.consolidateCaptureContact({
      tenantId: req.user.tenantId,
      contactId: id,
    });
    if (result.skipped === 'contact-not-found') {
      return res.status(404).json({ error: 'Contact not found' });
    }
    if (result.skipped === 'no-description') {
      return res.status(409).json({ error: 'No captured history found for this contact yet.', code: 'NO_CAPTURE_HISTORY' });
    }
    res.json(result);
  } catch (e) {
    console.error('[contacts] resummarize-capture error:', e.message);
    res.status(500).json({ error: 'Failed to consolidate summary', code: 'RESUMMARIZE_CAPTURE_FAILED' });
  }
});

// #367 follow-up: /converted-leads reverts a converted contact with
// PATCH /api/contacts/:id, but only PUT was ever registered here, so every
// revert 404'd with "Endpoint not found". The body has always been treated as a
// partial update (validateContactInput isUpdate:true + Prisma spread), so PUT
// and PATCH share this one handler — both are registered right below it.
const updateContactById = async (req, res) => {
  try {
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    if (!canAccessLead(req, existing)) return res.status(404).json({ error: 'Contact not found' });
    // #464: strip write-restricted fields per the caller's role BEFORE
    // validation so blocked-field updates can't slip through.
    req.body = await filterWriteFields(req.body, req.user.role, "Contact", req.user.tenantId);
    // PRD Gap §1.1e — strip walletBalance from writes (read-only computed surface).
    req.body = stripWalletBalanceWrite(req.body);
    // Generic-vertical-only Lead custom fields — see the POST handler above
    // for why this must be stripped before the Prisma spread.
    const customFields = req.body.customFields;
    delete req.body.customFields;
    const tagsInput = Object.prototype.hasOwnProperty.call(req.body, "tags")
      ? req.body.tags
      : undefined;
    delete req.body.tags;
    delete req.body.tagsJson;
    const tagsResult = normalizeContactTagsInput(tagsInput);
    if (tagsResult.error) return res.status(tagsResult.error.status).json(tagsResult.error);
    // Normalize empty-string optional ids to null (mirrors POST handler).
    if (req.body.callifiedCampaignId === "") req.body.callifiedCampaignId = null;
    // #168: same input checks as create so PUT can't bypass POST validation.
    const inputErr = validateContactInput(req.body, { isUpdate: true });
    if (inputErr) return res.status(inputErr.status).json(inputErr);
    // PRD Gap §1.1a/§1.1d — coerce date strings to Date objects (mirrors POST handler).
    const updateData = { ...req.body };
    if (tagsResult.hasValue) {
      updateData.tagsJson = tagsResult.tags.length ? JSON.stringify(tagsResult.tags) : null;
    }
    if (typeof updateData.anniversary === "string" && updateData.anniversary !== "") {
      updateData.anniversary = new Date(updateData.anniversary);
    }
    if (typeof updateData.birthDate === "string" && updateData.birthDate !== "") {
      updateData.birthDate = new Date(updateData.birthDate);
    }
    const contact = await prisma.contact.update({ where: { id: existing.id }, data: updateData });
    // Generic-vertical-only Lead custom fields — best-effort, after the
    // primary update already succeeded.
    await writeLeadCustomFieldValues(contact.id, req.user.tenantId, customFields);

    // #179: audit only the keys that actually changed (skip unchanged + DB internals).
    const changes = diffFields(existing, contact, Object.keys(req.body || {}));
    if (Object.keys(changes).length > 0) {
      await writeAudit('Contact', 'UPDATE', contact.id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }

    // gap #17: emit contact.updated for workflow rules. Always-safe fields exposed
    // for rule conditions. Failure here must NEVER fail the update.
    try {
      require("../lib/eventBus").emitEvent(
        "contact.updated",
        workflowContactPayload(contact, req.user.userId, Object.keys(req.body || {}), {
          status: existing.status,
          source: existing.source,
          assignedToId: existing.assignedToId,
          email: existing.email,
          phone: existing.phone,
          company: existing.company,
          aiScore: existing.aiScore,
          tags: parseContactTags(existing.tagsJson),
          callifiedLeadStatus: existing.callifiedLeadStatus,
        }),
        req.user.tenantId,
        req.io
      ).catch((error) => console.error("[contacts] contact.updated workflow failed:", error.message));
    } catch (_e) {}

    // [GP-CRM integration] Push a partner-shaped contact.updated (and, when the
    // status changed, lead.stage_changed) to registered webhooks. The emitEvent
    // above carries a workflow-rule payload keyed on contactId; GlobusPhone needs
    // id/name/phone/email, so we deliver a second, partner-shaped event here.
    // Both are fire-and-forget — a delivery failure must never block the update.
    try {
      const { deliverWebhooks } = require('../lib/webhookDelivery');
      await deliverWebhooks("contact.updated", {
        id: contact.id,
        name: contact.name,
        phone: contact.phone ? normalizePhoneValue(contact.phone) : contact.phone,
        email: contact.email,
        status: contact.status,
        assignedToId: contact.assignedToId,
        tenantId: req.user.tenantId,
      }, req.user.tenantId);
      if (existing.status !== contact.status) {
        await deliverWebhooks("lead.stage_changed", {
          id: contact.id,
          status: contact.status,
          previousStatus: existing.status,
          assignedToId: contact.assignedToId,
          tenantId: req.user.tenantId,
        }, req.user.tenantId);
      }
    } catch (_e) { /* webhook delivery is fire-and-forget */ }

    // gap #17: lead.converted — fires when a Contact's status flips from "Lead"
    // to "Customer" or "Prospect". Separate trigger from contact.updated so a
    // rule author can subscribe specifically to conversion events.
    try {
      if (
        existing.status === "Lead" &&
        (contact.status === "Customer" || contact.status === "Prospect") &&
        existing.status !== contact.status
      ) {
        require("../lib/eventBus").emitEvent(
          "lead.converted",
          {
            contactId: contact.id,
            fromStatus: existing.status,
            toStatus: contact.status,
            assignedToId: contact.assignedToId,
          },
          req.user.tenantId,
          req.io
        );
      }
    } catch (_e) {}

    // Bug #283 [wellness]: when a contact transitions into Customer on a
    // wellness tenant, the downstream wellness app needs a Patient row to
    // hang visits / Rx / consents off. Without this row the customer is a
    // dead-end in the wellness UI. Idempotent: dedupe on contactId, then on
    // phone (normalized last-10-digit match) so we never double-create.
    // Best-effort: any failure here MUST NOT fail the contact update itself.
    try {
      if (
        existing.status !== "Customer" &&
        contact.status === "Customer"
      ) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: req.user.tenantId },
          select: { vertical: true },
        });
        if (tenant && tenant.vertical === "wellness") {
          let patient = await prisma.patient.findFirst({
            where: { tenantId: req.user.tenantId, contactId: contact.id },
          });
          if (!patient && contact.phone) {
            const normalizedContactPhone = normalizePhone(contact.phone);
            const last10 = normalizedContactPhone ? normalizedContactPhone.slice(-10) : "";
            if (last10.length === 10) {
              patient = await prisma.patient.findFirst({
                where: { tenantId: req.user.tenantId, phone: { contains: last10 } },
              });
              // Backfill the contactId link if we matched by phone but the
              // Patient was never linked to this CRM Contact.
              if (patient && !patient.contactId) {
                await prisma.patient.update({
                  where: { id: patient.id },
                  data: { contactId: contact.id },
                });
              }
            }
          }
          if (!patient) {
            const normalizedPhone = contact.phone
              ? (normalizePhone(contact.phone) || contact.phone)
              : null;
            const created = await prisma.patient.create({
              data: {
                name: contact.name || contact.email || "Unnamed patient",
                email: contact.email || null,
                phone: normalizedPhone,
                source: contact.source || "lead-conversion",
                contactId: contact.id,
                tenantId: req.user.tenantId,
              },
            });
            await writeAudit(
              "Patient",
              "CREATE",
              created.id,
              req.user.userId,
              req.user.tenantId,
              { from: "lead-conversion", contactId: contact.id }
            );
          }
        }
      }
    } catch (e) {
      // Patient backfill is non-blocking; log and continue.
      console.error("[contacts PUT] wellness Patient backfill failed:", e && e.message);
    }

    res.json(serializeContactTags(contact));
  } catch (err) {
    // #168 #165: PUT used to leak 500s on bad email / out-of-range values
    // because the Prisma validation error fell through unhandled. Map the
    // full validation-class set to 400 + INVALID_INPUT so the UI shows the
    // real reason instead of "Failed to update contact".
    const mapped = httpFromPrismaError(err);
    if (mapped) return res.status(mapped.status).json(mapped);
    console.error('[contacts] update error:', err && err.message);
    res.status(500).json({ error: 'Failed to update contact' });
  }
};

router.put('/:id', updateContactById);
router.patch('/:id', updateContactById);

// CSV Import — accepts pre-parsed rows
// #154: validation hardening
//   - reject rows with missing/invalid email
//   - reject rows whose status is not in the allowed set
//   - sanitize CSV-injection prefixes (=, +, -, @) on name/company so the row
//     can't execute as a formula if the data is later re-exported and opened in Excel
//   - cap max rows at 5000 to prevent DoS via huge uploads
const ALLOWED_STATUSES = new Set(["Lead", "Prospect", "Customer", "Churned", "Junk"]);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const FORMULA_INJECTION_RE = /^[=+\-@\t\r]/;
const MAX_IMPORT_ROWS = 5000;

function sanitizeCellForExport(v) {
  if (typeof v !== "string" || v.length === 0) return v;
  // Prefix with single quote so spreadsheet apps treat it as text. Doing this
  // on import (rather than only on export) means stored data is also safe if
  // exported via any other path.
  return FORMULA_INJECTION_RE.test(v) ? `'${v}` : v;
}

function getSpreadsheetValue(row, aliases) {
  if (!row || typeof row !== "object") return "";
  const lookup = new Map(Object.entries(row).map(([key, value]) => [String(key).toLowerCase(), value]));
  for (const alias of aliases) {
    const value = lookup.get(String(alias).toLowerCase());
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
}

router.post('/import-csv', async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'No contacts provided' });
    }
    if (contacts.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({ error: `Too many rows. Max ${MAX_IMPORT_ROWS} per import.`, code: "TOO_MANY_ROWS" });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < contacts.length; i++) {
      const row = contacts[i];
      const rowNum = i + 1; // human-friendly (1-based, matches CSV preview)
      try {
        const email = String(row.email || "").trim();
        if (!email) {
          errors.push(`Row ${rowNum}: missing email`);
          continue;
        }
        if (!EMAIL_RE.test(email)) {
          errors.push(`Row ${rowNum}: invalid email (${email})`);
          continue;
        }
        const status = String(row.status || "Lead").trim();
        if (!ALLOWED_STATUSES.has(status)) {
          errors.push(`Row ${rowNum}: invalid status "${status}" (allowed: ${[...ALLOWED_STATUSES].join(", ")})`);
          continue;
        }

        // email is globally unique, so any tenant collision skips
        const existing = await prisma.contact.findFirst({ where: { email } });
        if (existing) {
          skipped++;
          continue;
        }
        await prisma.contact.create({
          data: {
            name: sanitizeCellForExport(String(row.name || "").trim()),
            email,
            phone: normalizePhoneValue(
              getSpreadsheetValue(row, ["phone", "phone_number", "phoneNumber", "sms_number", "smsNumber"]),
            ) || null,
            company: sanitizeCellForExport(String(row.company || "").trim()),
            title: String(row.title || "").trim(),
            status,
            tenantId: req.user.tenantId,
          }
        });
        imported++;
      } catch (rowErr) {
        errors.push(`Row ${rowNum} (${row.email || "no email"}): ${rowErr.message}`);
      }
    }

    // #179: audit the bulk import. entityId is null because this affects many rows.
    await writeAudit('Contact', 'CSV_IMPORT', null, req.user.userId, req.user.tenantId, {
      rowCount: contacts.length,
      imported,
      skipped,
      errorCount: errors.length,
      source: 'csv',
    });
    res.json({ imported, skipped, errors });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

// Assign agent to a contact.
// - ADMIN: can reassign any lead in the tenant.
// - travel non-admins: can reassign only the lead assigned to them.
// The dropdowns on the travel pages are filtered to non-admin staff, and
// this route keeps the validation in place so a forged request can't assign
// a lead to an admin.
router.put('/:id/assign', async (req, res) => {
  try {
    const { assignedToId } = req.body;
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    if (!canReassignLead(req, existing)) {
      if ((req.user?.vertical || 'generic') !== 'travel' || req.user?.role === 'ADMIN') {
        return res.status(403).json({ error: RBAC_DENIED_MESSAGE, code: RBAC_DENIED_CODE });
      }
      return res.status(404).json({ error: 'Contact not found' });
    }
    const nextAssignedToId = assignedToId ? parseInt(assignedToId, 10) : null;
    if (assignedToId && !Number.isInteger(nextAssignedToId)) {
      return res.status(400).json({ error: 'Invalid staff member', code: 'INVALID_ASSIGNEE' });
    }
    const targetUser = nextAssignedToId !== null
      ? await prisma.user.findFirst({
          where: { id: nextAssignedToId, tenantId: req.user.tenantId },
          select: { id: true, role: true, userType: true },
        })
      : null;
    if (nextAssignedToId !== null && !targetUser) {
      return res.status(404).json({ error: 'Staff member not found', code: 'ASSIGNEE_NOT_FOUND' });
    }
    if ((req.user?.vertical || 'generic') === 'travel' && req.user?.role !== 'ADMIN' && targetUser?.role === 'ADMIN') {
      return res.status(403).json({
        error: "Travel agents can't assign leads to admins",
        code: 'ASSIGNEE_ADMIN_FORBIDDEN',
      });
    }
    // Travel security guard — a brand-tagged lead can only be assigned to staff
    // who have access to that sub-brand. Contacts with no subBrand (generic /
    // wellness) skip this entirely, so their behaviour is unchanged.
    if (existing.subBrand && nextAssignedToId) {
      const { getSubBrandAccessSet, canAccessSubBrand } = require('../middleware/travelGuards');
      const allowed = await getSubBrandAccessSet(nextAssignedToId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "That staff member doesn't have access to this lead's sub-brand", code: 'SUB_BRAND_ASSIGN_DENIED' });
      }
    }
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { assignedToId: nextAssignedToId },
      include: { assignedTo: { select: { id: true, name: true, email: true } } }
    });
    if (nextAssignedToId && nextAssignedToId !== existing.assignedToId) {
      try {
        const actorName = req.user?.name || req.user?.email || 'Admin';
        const leadName = contact.name || ('#' + contact.id);
        await notify({
          userId: nextAssignedToId,
          tenantId: req.user.tenantId,
          title: 'New lead assigned',
          message: actorName + ' has assigned lead "' + leadName + '" to you. Please look into it.',
          type: 'info',
          category: 'lead',
          entityType: 'lead',
          entityId: contact.id,
          link: '/contacts/' + contact.id,
          io: req.io,
        });
      } catch (notifyErr) {
        console.error('[contacts] lead assignment notify failed:', notifyErr && notifyErr.message);
      }
    }
    // [GP-CRM integration] Notify registered webhooks (e.g. GlobusPhone) that
    // this contact/lead was re-assigned to a different agent. Fire-and-forget.
    try {
      const { deliverWebhooks } = require('../lib/webhookDelivery');
      await deliverWebhooks("lead.assigned", {
        id: contact.id,
        name: contact.name,
        phone: contact.phone ? normalizePhoneValue(contact.phone) : contact.phone,
        status: contact.status,
        assignedToId: contact.assignedToId,
        tenantId: req.user.tenantId,
      }, req.user.tenantId);
    } catch (_e) { /* webhook delivery is fire-and-forget */ }
    res.json(serializeContactTags(contact));
  } catch (_err) {
    res.status(500).json({ error: 'Failed to assign agent' });
  }
});

// ── Find duplicate contacts ───────────────────────────────────────
// #592 — Detector now (a) skips soft-deleted contacts (deletedAt!=null) so a
// merged-secondary doesn't keep showing up, and (b) filters out groups whose
// stable group-key matches a row in DismissedDuplicateGroup so dismissed
// pairs stop resurfacing on every refresh. Group key derivation is sorted
// id-list → SHA-256 (see backend/utils/deduplication.js#computeDuplicateGroupKey).
router.get('/duplicates/find', async (req, res) => {
  try {
    const contacts = await prisma.contact.findMany({
      where: { tenantId: req.user.tenantId, deletedAt: null },
      select: { id: true, name: true, email: true, phone: true, company: true, status: true, aiScore: true, createdAt: true }
    });
    const normalizedContacts = contacts.map(normalizeContactPhone);
    const dupes = [];
    const seen = new Map();

    for (const c of normalizedContacts) {
      // Match by email domain + name similarity, or exact phone
      const key = c.email.toLowerCase();
      if (seen.has(key)) {
        const existing = seen.get(key);
        if (!dupes.find(d => d.primary.id === existing.id)) {
          dupes.push({ primary: existing, duplicates: [c], reason: 'Same email' });
        } else {
          dupes.find(d => d.primary.id === existing.id).duplicates.push(c);
        }
      } else {
        seen.set(key, c);
      }

      // Phone match
      if (c.phone) {
        const phoneKey = normalizePhone(c.phone);
        const phoneDigits = phoneKey ? phoneKey.slice(-10) : "";
        if (phoneDigits.length >= 10) {
          for (const [, other] of seen) {
            if (other.id !== c.id && other.phone) {
              const otherPhoneKey = normalizePhone(other.phone);
              const otherPhone = otherPhoneKey ? otherPhoneKey.slice(-10) : "";
              if (phoneDigits === otherPhone && !dupes.find(d => (d.primary.id === other.id && d.duplicates.some(dd => dd.id === c.id)))) {
                const existing = dupes.find(d => d.primary.id === other.id);
                if (existing) { existing.duplicates.push(c); }
                else { dupes.push({ primary: other, duplicates: [c], reason: 'Same phone' }); }
              }
            }
          }
        }
      }

      // Name + Company match
      if (c.name && c.company) {
        const nameCompanyKey = `${c.name.toLowerCase().trim()}|${c.company.toLowerCase().trim()}`;
        for (const [, other] of seen) {
          if (other.id !== c.id && other.name && other.company) {
            const otherKey = `${other.name.toLowerCase().trim()}|${other.company.toLowerCase().trim()}`;
            if (nameCompanyKey === otherKey && !dupes.find(d => (d.primary.id === other.id && d.duplicates.some(dd => dd.id === c.id)))) {
              const existing = dupes.find(d => d.primary.id === other.id);
              if (existing) { existing.duplicates.push(c); }
              else { dupes.push({ primary: other, duplicates: [c], reason: 'Same name + company' }); }
            }
          }
        }
      }
    }

    // Stamp every group with its stable groupKey so the UI can reference it
    // when dismissing. Filter out any group the operator has already
    // dismissed for this tenant.
    let dismissedKeys = new Set();
    try {
      const rows = await prisma.dismissedDuplicateGroup.findMany({
        where: { tenantId: req.user.tenantId },
        select: { groupKey: true }
      });
      dismissedKeys = new Set(rows.map(r => r.groupKey));
    } catch (_e) {
      // Table may not exist yet on a stale Prisma client; degrade to "no
      // groups dismissed" so the detector still works.
    }

    const annotated = dupes
      .map(g => ({ ...g, groupKey: computeDuplicateGroupKey(g.primary.id, g.duplicates.map(d => d.id)) }))
      .filter(g => g.groupKey && !dismissedKeys.has(g.groupKey));

    res.json(annotated);
  } catch (err) {
    console.error('[Contacts] Duplicate find error:', err);
    res.status(500).json({ error: 'Failed to find duplicates' });
  }
});

// #592 — Merge contacts (transactional, soft-delete, full FK fold).
//
//   Body: { primaryId: number, secondaryIds: number[] }
//
// Reassigns every contactId-bearing FK from each secondary onto the primary,
// then soft-deletes the secondary (deletedAt = now()). Soft-delete preserves
// audit trail + restore path; the existing GET /:id 404s soft-deleted rows
// unless ?includeDeleted=true is passed.
//
// FK relations folded onto the primary (every model with a contactId column
// in schema.prisma — sweep verified 2026-05-08):
//   Activity, Deal, EmailMessage, CallLog, Task, Invoice, Expense, Contract,
//   Estimate, SmsMessage, WhatsAppMessage, Touchpoint, Project,
//   ContactAttachment, MarketplaceLead, ChatbotConversation, Booking,
//   SurveyResponse, ScheduledEmail, SocialMention, CalendarEvent,
//   VoiceSession, WebVisitor, EmailTracking, PushSubscription, Patient
//   (wellness link), DataExportRequest.
//
// SequenceEnrollment + ConsentRecord are intentionally NOT reassigned:
//   - SequenceEnrollment is per-contact step state; folding two enrollments
//     onto one contact violates the @@unique([sequenceId, contactId])
//     constraint and "you sent the welcome sequence to this person twice"
//     is the wrong fold semantics anyway. We delete the secondary's
//     enrollments instead.
//   - ConsentRecord is a legal artefact attesting that a *specific row* gave
//     consent. Reassigning would falsify the record.
//
// Audit: writeAudit('Contact', 'MERGE', primaryId, ...) + a Note activity on
// the primary documenting each fold.
//
// Wrapped in prisma.$transaction so a partial failure rolls back cleanly.
router.post('/merge', async (req, res) => {
  try {
    const { primaryId, secondaryIds } = req.body;
    if (!primaryId || !Array.isArray(secondaryIds) || secondaryIds.length === 0) {
      return res.status(400).json({ error: 'primaryId and secondaryIds required' });
    }
    const tenantId = req.user.tenantId;
    const userId = req.user?.userId || null;
    const pid = parseInt(primaryId);
    if (!Number.isFinite(pid)) return res.status(400).json({ error: 'Invalid primaryId' });

    const primary = await prisma.contact.findFirst({ where: { id: pid, tenantId, deletedAt: null } });
    if (!primary) return res.status(404).json({ error: 'Primary contact not found' });

    // Resolve every secondary up-front + tenant-scope guard. A secondary that
    // belongs to another tenant or that is already soft-deleted is skipped
    // (not error) — keeps the operation idempotent on retry.
    const sids = secondaryIds.map(Number).filter((n) => Number.isFinite(n) && n !== pid);
    const secondaries = await prisma.contact.findMany({
      where: { id: { in: sids }, tenantId, deletedAt: null },
      select: { id: true, name: true, email: true, phone: true, company: true, title: true, aiScore: true }
    });
    if (secondaries.length === 0) return res.status(404).json({ error: 'No mergeable secondaries' });

    const folded = {};
    const validSecIds = secondaries.map(s => s.id);

    await prisma.$transaction(async (tx) => {
      // Reassign FKs in bulk across all secondaries at once. updateMany returns
      // {count} per call which we accumulate per relation for the audit row.
      const reassign = async (model, label) => {
        try {
          const r = await tx[model].updateMany({
            where: { contactId: { in: validSecIds } },
            data: { contactId: primary.id }
          });
          folded[label] = (folded[label] || 0) + r.count;
        } catch (_e) {
          // Some relations (e.g. wellness Patient on a generic-vertical
          // tenant) may not have any rows; an updateMany on a non-existent
          // contactId column would throw at the Prisma level, but every
          // model in this list does declare contactId in schema.prisma.
        }
      };
      await reassign('activity', 'activities');
      await reassign('deal', 'deals');
      await reassign('emailMessage', 'emails');
      await reassign('callLog', 'callLogs');
      await reassign('task', 'tasks');
      await reassign('invoice', 'invoices');
      await reassign('expense', 'expenses');
      await reassign('contract', 'contracts');
      await reassign('estimate', 'estimates');
      await reassign('smsMessage', 'smsMessages');
      await reassign('whatsAppMessage', 'whatsappMessages');
      await reassign('touchpoint', 'touchpoints');
      await reassign('project', 'projects');
      await reassign('contactAttachment', 'attachments');
      await reassign('marketplaceLead', 'marketplaceLeads');
      await reassign('chatbotConversation', 'chatbotConversations');
      await reassign('booking', 'bookings');
      await reassign('surveyResponse', 'surveyResponses');
      await reassign('scheduledEmail', 'scheduledEmails');
      await reassign('socialMention', 'socialMentions');
      await reassign('calendarEvent', 'calendarEvents');
      await reassign('voiceSession', 'voiceSessions');
      await reassign('webVisitor', 'webVisitors');
      await reassign('emailTracking', 'emailTrackings');
      await reassign('pushSubscription', 'pushSubscriptions');
      await reassign('patient', 'patients');
      await reassign('dataExportRequest', 'dataExportRequests');

      // Drop the secondaries' SequenceEnrollment rows (folding would violate
      // the per-contact-per-sequence unique constraint). ConsentRecord is
      // left alone — re-pointing it would falsify the legal artefact.
      await tx.sequenceEnrollment.deleteMany({ where: { contactId: { in: validSecIds } } });

      // Backfill missing fields on primary from the most-complete secondary.
      // Take the first non-null per field (deterministic by id order).
      const updates = {};
      for (const sec of secondaries) {
        if (!primary.phone && !updates.phone && sec.phone) updates.phone = sec.phone;
        if (!primary.company && !updates.company && sec.company) updates.company = sec.company;
        if (!primary.title && !updates.title && sec.title) updates.title = sec.title;
        if ((sec.aiScore || 0) > (primary.aiScore || 0)) updates.aiScore = sec.aiScore;
      }
      if (Object.keys(updates).length > 0) {
        await tx.contact.update({ where: { id: primary.id }, data: updates });
      }

      // Document each fold as a Note activity on the primary (operator-visible
      // in the contact-detail timeline).
      for (const sec of secondaries) {
        await tx.activity.create({
          data: {
            type: 'Note',
            description: `Merged contact "${sec.name}" (${sec.email}) into this record`,
            contactId: primary.id,
            userId,
            tenantId,
          }
        });
      }

      // Soft-delete the secondaries. Contact.deletedAt exists (#167); this
      // preserves the audit trail and lets ADMIN restore via the existing
      // POST /:id/restore endpoint.
      await tx.contact.updateMany({
        where: { id: { in: validSecIds }, tenantId },
        data: { deletedAt: new Date() }
      });
    });

    // Audit row outside the transaction — writeAudit is best-effort and
    // already wrapped in its own try/catch (lib/audit.js).
    await writeAudit('Contact', 'MERGE', primary.id, userId, tenantId, {
      mergedIds: validSecIds,
      count: validSecIds.length,
      folded,
      strategy: 'soft-delete',
    });

    res.json({
      success: true,
      merged: validSecIds.length,
      primaryId: primary.id,
      mergedIds: validSecIds,
      folded,
      strategy: 'soft-delete',
    });
  } catch (err) {
    console.error('[Contacts] Merge error:', err);
    res.status(500).json({ error: 'Failed to merge contacts' });
  }
});

// #592 — Dismiss a duplicate group ("not actually duplicates").
//
//   Body: one of —
//     { groupKey: "<sha256-hex>" }                                 OR
//     { primaryId: number, secondaryIds: number[] }   (server derives the key)
//     { contactIds: number[] }                        (server derives the key)
//
// Idempotent: a re-dismiss of an already-dismissed group returns 200 with
// {idempotent: true}. Per-tenant scoped — every contact id is verified to
// belong to req.user.tenantId before we hash and persist the key (otherwise
// a caller could lock down another tenant's groups via guessed ids).
router.post('/duplicates/dismiss', async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user?.userId || null;
    let { groupKey, primaryId, secondaryIds, contactIds, reason } = req.body || {};

    let ids = [];
    if (Array.isArray(contactIds) && contactIds.length > 0) {
      ids = contactIds.map(Number).filter(Number.isFinite);
    } else if (primaryId && Array.isArray(secondaryIds)) {
      ids = [Number(primaryId), ...secondaryIds.map(Number)].filter(Number.isFinite);
    }

    // If the caller passed ids, derive + verify-tenant. If only groupKey was
    // passed we trust the caller (the key was minted by /duplicates/find,
    // which itself filters by tenant).
    if (ids.length > 0) {
      const found = await prisma.contact.findMany({
        where: { id: { in: ids }, tenantId },
        select: { id: true }
      });
      if (found.length !== ids.length) {
        return res.status(404).json({ error: 'One or more contacts not found in tenant' });
      }
      groupKey = computeDuplicateGroupKey(ids[0], ids.slice(1));
    }
    if (!groupKey || typeof groupKey !== 'string' || groupKey.length < 8) {
      return res.status(400).json({ error: 'groupKey or contactIds required' });
    }

    // Upsert keeps the first-dismissed-by/createdAt audit-true and makes the
    // operation idempotent on retry.
    const existing = await prisma.dismissedDuplicateGroup.findUnique({
      where: { tenantId_groupKey: { tenantId, groupKey } }
    });
    if (existing) {
      return res.json({ success: true, idempotent: true, groupKey, dismissedAt: existing.createdAt });
    }
    const row = await prisma.dismissedDuplicateGroup.create({
      data: {
        groupKey,
        contactIds: ids.length > 0 ? ids.slice().sort((a, b) => a - b).join(',') : '',
        reason: reason && typeof reason === 'string' ? reason.slice(0, 500) : null,
        dismissedBy: userId,
        tenantId,
      }
    });

    await writeAudit('Contact', 'DUPLICATE_DISMISS', null, userId, tenantId, { groupKey, contactIds: ids });

    res.json({ success: true, groupKey, dismissedAt: row.createdAt });
  } catch (err) {
    console.error('[Contacts] Duplicate dismiss error:', err);
    res.status(500).json({ error: 'Failed to dismiss duplicate group' });
  }
});

// ── Contact Attachments ───────────────────────────────────────────
router.get('/:id/attachments', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!canAccessLead(req, contact)) return res.status(404).json({ error: 'Contact not found' });
    res.json(await prisma.contactAttachment.findMany({ where: { contactId: contact.id, tenantId: req.user.tenantId }, orderBy: { createdAt: 'desc' } }));
  } catch (_err) { res.status(500).json({ error: 'Failed to fetch attachments' }); }
});

// #176: JSON-only contract — UI sends {filename, fileUrl}. Multipart isn't wired
// (no multer in this router) and is not supported here; document the contract
// rather than crash with a generic 500.
router.post('/:id/attachments', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    if (!Number.isFinite(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id', code: 'INVALID_ID', field: 'id' });
    }
    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Reject multipart up front — no multer wired here, so req.body would be empty.
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (ctype.startsWith('multipart/form-data')) {
      return res.status(400).json({
        error: 'Multipart upload not supported on this endpoint. POST application/json with {filename, fileUrl}.',
        code: 'UNSUPPORTED_CONTENT_TYPE',
        field: 'Content-Type'
      });
    }

    const body = req.body || {};
    const { filename, fileUrl, fileSize, mimeType } = body;

    if (!filename || typeof filename !== 'string' || !filename.trim()) {
      return res.status(400).json({ error: 'filename is required', code: 'MISSING_FILENAME', field: 'filename' });
    }
    if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.trim()) {
      return res.status(400).json({ error: 'fileUrl is required', code: 'MISSING_FILEURL', field: 'fileUrl' });
    }
    if (!/^https?:\/\//i.test(fileUrl.trim())) {
      return res.status(400).json({ error: 'fileUrl must be an http(s) URL', code: 'INVALID_FILEURL', field: 'fileUrl' });
    }

    const sizeNum = (fileSize === undefined || fileSize === null || fileSize === '')
      ? null
      : Number.parseInt(fileSize, 10);
    if (sizeNum !== null && !Number.isFinite(sizeNum)) {
      return res.status(400).json({ error: 'fileSize must be an integer', code: 'INVALID_FILESIZE', field: 'fileSize' });
    }

    const attachment = await prisma.contactAttachment.create({
      data: {
        filename: filename.trim().slice(0, 255),
        fileUrl: fileUrl.trim(),
        fileSize: sizeNum,
        mimeType: (mimeType && typeof mimeType === 'string') ? mimeType.trim().slice(0, 120) : null,
        contactId: contact.id,
        tenantId: req.user.tenantId,
      }
    });
    // #179: audit the attachment add — useful for tracking what files have been
    // uploaded against a contact (and by whom).
    await writeAudit('ContactAttachment', 'CREATE', attachment.id, req.user.userId, req.user.tenantId, {
      contactId: contact.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
    });
    res.status(201).json(attachment);
  } catch (err) {
    console.error('POST /contacts/:id/attachments failed:', err);
    res.status(500).json({ error: 'Failed to add attachment' });
  }
});

router.delete('/attachments/:attachId', async (req, res) => {
  try {
    const existing = await prisma.contactAttachment.findFirst({ where: { id: parseInt(req.params.attachId), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Attachment not found' });
    await prisma.contactAttachment.delete({ where: { id: existing.id } });
    // #179: audit the destructive delete (attachments are hard-deleted).
    await writeAudit('ContactAttachment', 'DELETE', existing.id, req.user.userId, req.user.tenantId, {
      contactId: existing.contactId,
      filename: existing.filename,
    });
    res.json({ success: true });
  } catch (_err) { res.status(500).json({ error: 'Failed to delete attachment' }); }
});

// #167: soft-delete — flips deletedAt instead of hard-removing the row.
// Audit row is written first. Idempotent: a second DELETE returns 200 with
// {idempotent: true, softDeleted: true}. Cascade behavior on relations is
// unchanged because we no longer call prisma.contact.delete here.
router.delete('/:id', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    if (existing.deletedAt) {
      return res.json({ ...serializeContactTags(existing), idempotent: true, softDeleted: true });
    }
    try {
      await prisma.auditLog.create({
        data: { action: 'SOFT_DELETE', entity: 'Contact', entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ name: existing.name, email: existing.email }) }
      });
    } catch (_) { /* audit failures must not block the soft-delete */ }
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() }
    });
    // [GP-CRM integration] CRM has no contact.deleted event (soft-delete only).
    // Signal the deletion via contact.updated with a non-null deletedAt so a
    // partner (e.g. GlobusPhone) evicts its caller-ID cache for this number.
    // Fire-and-forget — never block the soft-delete response.
    try {
      const { deliverWebhooks } = require('../lib/webhookDelivery');
      await deliverWebhooks("contact.updated", {
        id: contact.id,
        name: contact.name,
        phone: contact.phone ? normalizePhoneValue(contact.phone) : contact.phone,
        email: contact.email,
        status: contact.status,
        assignedToId: contact.assignedToId,
        deletedAt: contact.deletedAt,
        tenantId: req.user.tenantId,
      }, req.user.tenantId);
    } catch (_e) { /* webhook delivery is fire-and-forget */ }
    res.json({ ...serializeContactTags(contact), softDeleted: true });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// #167: restore a soft-deleted contact. ADMIN only. Idempotent on already-live rows.
router.post('/:id/restore', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const existing = await prisma.contact.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    if (!existing.deletedAt) {
      return res.json({ ...serializeContactTags(existing), idempotent: true, restored: false });
    }
    try {
      await prisma.auditLog.create({
        data: { action: 'RESTORE', entity: 'Contact', entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ name: existing.name }) }
      });
    } catch (_) { /* non-critical */ }
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: { deletedAt: null }
    });
    // [GP-CRM integration] Signal restoration via contact.updated with
    // deletedAt: null so a partner (e.g. GlobusPhone) re-populates caller ID
    // for this number. Fire-and-forget.
    try {
      const { deliverWebhooks } = require('../lib/webhookDelivery');
      await deliverWebhooks("contact.updated", {
        id: contact.id,
        name: contact.name,
        phone: contact.phone ? normalizePhoneValue(contact.phone) : contact.phone,
        email: contact.email,
        status: contact.status,
        assignedToId: contact.assignedToId,
        deletedAt: contact.deletedAt,
        tenantId: req.user.tenantId,
      }, req.user.tenantId);
    } catch (_e) { /* webhook delivery is fire-and-forget */ }
    res.json({ ...serializeContactTags(contact), restored: true });
  } catch (_err) {
    res.status(500).json({ error: 'Failed to restore contact' });
  }
});


module.exports = router;
