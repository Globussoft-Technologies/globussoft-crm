/**
 * PII masking helpers for list-view / export responses.
 *
 * Closes #679 (Locations) + #680 (Patient exports) + #681 (Unified Inbox
 * WhatsApp lead phones) + #682 (Staff list + Attendance + Telecaller Queue).
 *
 * Policy (wellness-vertical centric; generic tenants treat names + phones as
 * normal contact metadata, not PHI):
 *
 *   ADMIN / MANAGER        → see full PHI everywhere (operational ground truth).
 *   doctor / professional  → see full PHI on rows in their clinical scope; the
 *                            row-scope gates upstream (verifyWellnessRole +
 *                            wellnessOwnership) already enforce this, so by
 *                            the time the response handler runs, anything
 *                            they're returning is in-scope.
 *   telecaller / helper    → see masked PHI unless the row is in their queue /
 *                            disposition workflow (their queue route already
 *                            limits to assignedToId === req.user.userId, so
 *                            queue rows pass unmasked; everything else they
 *                            see in cross-cutting lists is masked).
 *   PORTAL (patient self)  → unaffected — patient owns their own data.
 *
 * The helpers themselves are pure / stateless; the call-site decides whether
 * to mask based on the viewer's role. See `shouldMaskForViewer(req)` for the
 * canonical "do we mask" predicate.
 *
 * Mask formats (chosen so the result is still useful for visual identification
 * — e.g. a telecaller scanning a doctor's patient list to find their own
 * follow-up — without exposing the full PII):
 *
 *   phone   '+919876543210'        → '+919****3210'   (keep country code + last 4)
 *   email   'rishu@enhanced.in'    → 'r****@enhanced.in'  (keep first char + domain)
 *   name    'Rishu Sharma'         → 'R. Sharma'      (first initial + last name)
 *   dob     '1995-04-12T00:00:00Z' → '****-04-12'     (drop year)
 *   userId  12345                  → '#345'           (last 3 digits only)
 *
 * Audit emission: every list endpoint that returns UNMASKED PII to a viewer
 * other than the record-subject MUST emit an audit row with action
 * 'PII_DISCLOSED' so reviewers can answer "who saw what unmasked?" without
 * grepping app logs. The helper does NOT emit audit rows — that's the route's
 * job (audit lib has tenant context). See `auditDisclosureDetails()` for the
 * canonical details-payload shape.
 */

// ────────────────────────────────────────────────────────────────────────
// Field-level mask primitives. All return the INPUT unchanged when it's
// null / undefined / not-a-string so callers can spread them across rows
// without null-guarding every field.
// ────────────────────────────────────────────────────────────────────────

function maskPhone(phone) {
  if (phone == null) return phone;
  if (typeof phone !== "string") return phone;
  // Normalise out spaces / dashes / parens but PRESERVE leading '+' so the
  // mask still looks like a phone number to the viewer.
  const trimmed = phone.replace(/[\s\-()]/g, "");
  if (trimmed.length < 7) return phone; // too short to mask meaningfully
  const hasPlus = trimmed.startsWith("+");
  const digits = hasPlus ? trimmed.slice(1) : trimmed;
  if (digits.length < 7) return phone;
  // Keep 3 leading digits (covers India 91 / US 1xx / EU prefixes) + 4 trailing.
  const head = digits.slice(0, 3);
  const tail = digits.slice(-4);
  return (hasPlus ? "+" : "") + head + "****" + tail;
}

function maskEmail(email) {
  if (email == null) return email;
  if (typeof email !== "string") return email;
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain) return email;
  // Keep 1 leading char of the local-part. Don't reveal length (no
  // proportional asterisks) — fixed-width mask reduces side-channel.
  return local[0] + "****@" + domain;
}

function maskName(name) {
  if (name == null) return name;
  if (typeof name !== "string") return name;
  const trimmed = name.trim();
  if (!trimmed) return name;
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    // Single-token name (no surname to show) — just show the first letter.
    return parts[0][0] + ".";
  }
  // First-initial + last-name keeps the row visually identifiable to
  // colleagues without leaking the full first name (which often carries
  // gender / regional cues).
  return parts[0][0] + ". " + parts.slice(1).join(" ");
}

function maskDOB(dob) {
  if (dob == null) return dob;
  // Accept either a Date or an ISO string; emit string in either case so the
  // JSON response has a stable shape across viewers.
  let d;
  if (dob instanceof Date) {
    d = dob;
  } else if (typeof dob === "string") {
    d = new Date(dob);
  } else {
    return dob;
  }
  if (isNaN(d.getTime())) return dob;
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return "****-" + mm + "-" + dd;
}

function maskUserId(id) {
  if (id == null) return id;
  const s = String(id);
  if (s.length <= 3) return "#" + s;
  return "#" + s.slice(-3);
}

// ────────────────────────────────────────────────────────────────────────
// Viewer policy. The canonical "should we mask for this viewer" check.
// Route call-sites use this to branch between full-row vs masked-row
// responses. The function does NOT depend on prisma — pure / unit-testable.
// ────────────────────────────────────────────────────────────────────────

/**
 * shouldMaskForViewer(req) — `true` iff the requesting user is a low-trust
 * viewer who must see masked PII on cross-cutting list views.
 *
 *   ADMIN / MANAGER                                  → never mask
 *   wellnessRole='doctor' / 'professional'          → never mask
 *                                                     (clinical scope already
 *                                                     gated upstream)
 *   wellnessRole='telecaller' / 'helper' / null      → mask
 *   no req.user                                      → mask (fail-closed)
 *
 * Returns a boolean. The route is responsible for honouring it.
 */
function shouldMaskForViewer(req) {
  if (!req || !req.user) return true; // fail-closed
  const role = req.user.role;
  if (role === "ADMIN" || role === "MANAGER") return false;
  const wRole = req.user.wellnessRole;
  if (wRole === "doctor" || wRole === "professional") return false;
  return true;
}

// ────────────────────────────────────────────────────────────────────────
// Row-shaped helpers. These accept a single row + a list of sensitive
// fields and return a SHALLOW-CLONED row with the named fields masked.
// Non-listed fields pass through verbatim. Original row is NEVER mutated.
// ────────────────────────────────────────────────────────────────────────

const FIELD_MASKERS = {
  phone: maskPhone,
  email: maskEmail,
  name: maskName,
  dob: maskDOB,
  userId: maskUserId,
};

/**
 * maskRow(row, fields) — return a shallow clone of `row` with each named
 * field replaced by its masked value.
 *
 *   maskRow({ id: 1, name: 'Rishu', phone: '+919876543210', email: 'r@x.com' },
 *           ['name', 'phone', 'email'])
 *   → { id: 1, name: 'R.', phone: '+919****3210', email: 'r****@x.com' }
 *
 * Unknown field names are looked up by type — if the field key isn't in
 * FIELD_MASKERS, the field is replaced with the literal string '****'.
 * This is the safe default for fields callers want to redact but don't have
 * a dedicated mask format for (e.g. address, idNumber). Callers can pass
 * `{ field: 'maskFn' }` entries instead of bare strings to override.
 */
function maskRow(row, fields) {
  if (!row || typeof row !== "object") return row;
  if (!Array.isArray(fields) || fields.length === 0) return row;
  const out = { ...row };
  for (const f of fields) {
    if (!(f in out)) continue;
    const masker = FIELD_MASKERS[f];
    if (masker) {
      out[f] = masker(out[f]);
    } else {
      // Unknown field — redact entirely. Don't leak length.
      out[f] = out[f] == null ? out[f] : "****";
    }
  }
  return out;
}

/**
 * maskRows(rows, fields) — apply maskRow to every row in an array.
 */
function maskRows(rows, fields) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => maskRow(r, fields));
}

// ────────────────────────────────────────────────────────────────────────
// Audit emission contract. The helper does NOT call writeAudit() itself
// (that requires prisma + tenant context that lives in routes/). Instead
// it returns the canonical details-payload shape so every route emits the
// same envelope. Call as:
//
//   await writeAudit('Patient', 'PII_DISCLOSED', null, req.user.userId,
//                    req.user.tenantId,
//                    auditDisclosureDetails(req, 'patient_list', rows));
// ────────────────────────────────────────────────────────────────────────

/**
 * auditDisclosureDetails(req, scope, rows, opts?) — canonical details payload
 * for a PII_DISCLOSED audit row.
 *
 *   scope       string identifier of the disclosure surface
 *               ('patient_list', 'location_list', 'staff_list', etc.)
 *   rows        array of disclosed rows. Only IDs + COUNT are recorded
 *               (never PII values — that would defeat the audit).
 *   opts.fields fields that were disclosed unmasked (informational only).
 *
 * Returns a JSON-safe object the audit lib will stringify.
 */
function auditDisclosureDetails(req, scope, rows, opts) {
  const o = opts || {};
  const recordIds = Array.isArray(rows)
    ? rows.slice(0, 200).map((r) => (r && r.id != null ? r.id : null)).filter((x) => x != null)
    : [];
  return {
    scope,
    viewerRole: req && req.user ? req.user.role : null,
    viewerWellnessRole: req && req.user ? req.user.wellnessRole || null : null,
    recordCount: Array.isArray(rows) ? rows.length : 0,
    recordIds,
    disclosedFields: Array.isArray(o.fields) ? o.fields : [],
  };
}

module.exports = {
  // primitives
  maskPhone,
  maskEmail,
  maskName,
  maskDOB,
  maskUserId,
  // policy
  shouldMaskForViewer,
  // row helpers
  maskRow,
  maskRows,
  // audit
  auditDisclosureDetails,
};
