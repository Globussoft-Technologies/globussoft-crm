/**
 * TMC diagnostic lead-quality classifier — implements PRD §3.4 verbatim.
 *
 * Pure function: `(answers, opts) → {leadQuality, reasons, flags}`.
 *
 * The TMC public diagnostic form (§3.1) is open to the internet — it draws
 * real principals, but also students, competitors, bots, and time-wasters.
 * This module classifies each submission as `clean` or `suspect` so the CRM
 * brief can drop suspect leads below ALL clean leads regardless of ICP tier
 * (DD-5.6) and the executive sees "Review before contact, low-confidence lead"
 * with reasons listed. Per the PRD, this classification **does not block
 * report generation** — a false positive on a real principal is cheaper than
 * a few minutes of review.
 *
 * The 5 suspect rules (PRD §3.4 verbatim):
 *
 *   1. free_domain_senior_role     — Email domain on the configured free-mail
 *      block list AND contact_role ∈ {Owner/Trustee, Principal}.
 *   2. profile_spend_contradiction — student_strength="under 500" AND
 *      fee_band="under 75k" AND budget_band="2l-plus". The exact 3-way
 *      contradiction; no fuzzy matching.
 *   3. junk_strings                — school_name OR contact_name fails any
 *      junk-string check (empty after trim / <2 chars / all digits / matches
 *      a configured test pattern / single char repeated 4+ times).
 *   4. repeat_submitter            — caller pre-counts prior submissions in
 *      the last 24h on (email, phone); >3 fires.
 *   5. indian_mobile_format_fail   — normalize first (strip spaces/hyphens,
 *      leading "+91" / "0"); require exactly 10 digits starting with 6-9.
 *
 * Block lists (free-mail domains, junk-string patterns) ship as config so TMC
 * can extend without redeploy — `opts.freeEmailDomains` / `opts.junkStringBlocklist`
 * override / extend the seeded defaults below.
 *
 * No DB reads. The repeat-submitter rule needs prior-24h counts, but those
 * are passed in via `opts.priorSubmissionsLast24h` — the caller (route
 * handler in T5/T8) does the DB query and passes the integer in. Keeps this
 * module pure and trivially testable.
 *
 * Persistence target shape (consumed by T5/T8 route handlers):
 *   - TravelDiagnostic.leadQuality            ← {leadQuality}
 *   - TravelDiagnostic.leadQualityReasonsJson ← JSON.stringify({reasons})
 *   - TravelDiagnostic.flagsJson              ← JSON.stringify({flags, ...})
 */

// Default free-mail domain block list (PRD §3.4 rule 1 verbatim — gmail.com,
// googlemail.com, yahoo.com/.in/.co.in, ymail.com, rediffmail.com, outlook.com,
// hotmail.com, live.com, msn.com, icloud.com, me.com, proton.me, protonmail.com,
// aol.com, zoho.com, gmx.com). All lowercased; we lowercase the input domain
// before comparison.
const DEFAULT_FREE_EMAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.in",
  "yahoo.co.in",
  "ymail.com",
  "rediffmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "zoho.com",
  "gmx.com",
];

// Senior-role values that, when paired with a free email, fire rule 1.
// PRD §3.4 names "Owner/Trustee, Principal"; we accept common variants
// (case-insensitive trim) so the form values can evolve without breaking
// the classifier. The role-set is intentionally NOT exposed via opts —
// extending it is a PRD change, not a config tweak.
const SENIOR_ROLE_VALUES = [
  "owner",
  "trustee",
  "owner/trustee",
  "owner / trustee",
  "principal",
];

// Default junk-string patterns. PRD §3.4 rule 3 names: empty after trim,
// <2 chars, all digits, obvious test patterns (test / asdf / qwerty / abc /
// xyz / none / na), single char repeated 4+ times. The exact-token list
// below covers the "obvious test patterns" set; the structural rules
// (empty, <2, all-digit, repeated-char) live in code below.
const DEFAULT_JUNK_STRING_BLOCKLIST = [
  "test",
  "test1",
  "test2",
  "test123",
  "testing",
  "asdf",
  "asdfgh",
  "qwerty",
  "abc",
  "abcd",
  "xyz",
  "none",
  "na",
  "n/a",
  "dummy",
  "sample",
  "demo",
  "foo",
  "bar",
  "baz",
];

// Repeat-submitter threshold per PRD §3.4 rule 4 ("> 3 submissions in 24h").
// Exposed as a constant for future tunability; not currently configurable
// via opts because the threshold is PRD-pinned.
const REPEAT_SUBMITTER_THRESHOLD = 3;

// Indian mobile regex per PRD §3.4 rule 5: exactly 10 digits, first digit
// in 6-9. Applied AFTER normalization (strip spaces/hyphens/dots, then
// strip a leading "+91" or "91" or "0" country/trunk prefix).
const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;

/**
 * Lowercase + trim a string answer. Returns "" for null/undefined/non-string
 * so callers don't have to null-guard every comparison.
 */
function norm(s) {
  if (typeof s !== "string") return "";
  return s.trim().toLowerCase();
}

/**
 * Extract the lowercased domain portion of an email. Returns "" if the
 * input isn't a string with a single "@".
 */
function emailDomain(email) {
  if (typeof email !== "string") return "";
  const at = email.lastIndexOf("@");
  if (at <= 0 || at >= email.length - 1) return "";
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * Extract the local-part (before "@") of an email, lowercased + trimmed.
 * Returns "" if no "@" or empty local.
 */
function emailLocalPart(email) {
  if (typeof email !== "string") return "";
  const at = email.indexOf("@");
  if (at <= 0) return "";
  return email.slice(0, at).trim().toLowerCase();
}

/**
 * Junk-string test per PRD §3.4 rule 3.
 * Returns true if the string is empty after trim / <2 chars / all digits /
 * matches a configured token / has a single char repeated 4+ times in a row.
 */
function looksLikeJunkString(raw, blocklist) {
  if (typeof raw !== "string") return true; // missing = junk
  const trimmed = raw.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 2) return true;
  if (/^\d+$/.test(trimmed)) return true; // all digits
  const lower = trimmed.toLowerCase();
  if (blocklist.includes(lower)) return true;
  // Single character repeated 4+ times in a row (case-insensitive).
  // Covers "aaaa", "....", "----", "    " (the trim above won't kill an
  // interior run of whitespace).
  if (/(.)\1{3,}/i.test(lower)) return true;
  return false;
}

/**
 * Indian-mobile validator per PRD §3.4 rule 5.
 * Normalize: strip spaces, hyphens, dots, parens; strip leading "+91", "91",
 * or "0"; then require exactly 10 digits with first in 6-9.
 * Returns true if VALID, false if it fails (so the rule fires on `false`).
 */
function isValidIndianMobile(phone) {
  if (typeof phone !== "string") return false;
  let normalized = phone.replace(/[\s\-.()]/g, "");
  if (normalized.startsWith("+91")) normalized = normalized.slice(3);
  else if (normalized.startsWith("91") && normalized.length === 12) normalized = normalized.slice(2);
  else if (normalized.startsWith("0") && normalized.length === 11) normalized = normalized.slice(1);
  return INDIAN_MOBILE_RE.test(normalized);
}

/**
 * Classify a TMC diagnostic submission as `clean` or `suspect` per PRD §3.4.
 *
 * @param {object} answers - The 12-question shape from PRD §3.1. Reads:
 *   - answers.budget_band       (Q9, e.g. "2l-plus" / "unknown" / ...)
 *   - answers.school_profile.student_strength (Q11)
 *   - answers.school_profile.fee_band         (Q11)
 *   - answers.school_profile.school_name      (Q11)
 *   - answers.contact.contact_name            (Q12)
 *   - answers.contact.contact_role            (Q12)
 *   - answers.contact.email                   (Q12)
 *   - answers.contact.phone                   (Q12)
 *   All fields are optional; missing fields are treated as "no firing" for
 *   most rules, EXCEPT the junk-strings rule treats missing school_name /
 *   contact_name as junk (PRD: "empty after trim" fires).
 *
 * @param {object} [opts]
 * @param {number} [opts.priorSubmissionsLast24h=0] - Caller-supplied count
 *   of prior submissions matching this email OR phone in the last 24h.
 *   Pre-counted so this function stays DB-free. Rule 4 fires when this
 *   value is STRICTLY GREATER THAN REPEAT_SUBMITTER_THRESHOLD (3).
 * @param {string[]} [opts.freeEmailDomains] - Extends the default free-mail
 *   block list. Lowercased before comparison.
 * @param {string[]} [opts.junkStringBlocklist] - Extends the default junk-string
 *   token list. Lowercased before comparison.
 *
 * @returns {{leadQuality: 'clean'|'suspect', reasons: string[], flags: object}}
 *   - leadQuality: 'suspect' if ANY of the 5 rules fired, else 'clean'.
 *   - reasons: ordered array of rule keys that fired (for telecaller triage UI).
 *   - flags: dictionary with one boolean per rule key. All 5 keys always
 *     present (even false) so downstream consumers can switch on shape
 *     without null-guarding.
 */
function classifyLeadQuality(answers, opts = {}) {
  const safeAnswers = answers && typeof answers === "object" ? answers : {};
  const schoolProfile = safeAnswers.school_profile && typeof safeAnswers.school_profile === "object"
    ? safeAnswers.school_profile : {};
  const contact = safeAnswers.contact && typeof safeAnswers.contact === "object"
    ? safeAnswers.contact : {};

  const priorCount = Number.isFinite(opts.priorSubmissionsLast24h)
    ? opts.priorSubmissionsLast24h : 0;

  // Merge caller extensions with defaults; lowercase + de-dup.
  const freeDomains = [
    ...DEFAULT_FREE_EMAIL_DOMAINS,
    ...(Array.isArray(opts.freeEmailDomains) ? opts.freeEmailDomains : []),
  ].map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  const junkTokens = [
    ...DEFAULT_JUNK_STRING_BLOCKLIST,
    ...(Array.isArray(opts.junkStringBlocklist) ? opts.junkStringBlocklist : []),
  ].map((t) => String(t).trim().toLowerCase()).filter(Boolean);

  const flags = {
    free_domain_senior_role: false,
    profile_spend_contradiction: false,
    junk_strings: false,
    repeat_submitter: false,
    indian_mobile_format_fail: false,
  };
  const reasons = [];

  // Rule 1: free_domain_senior_role
  const domain = emailDomain(contact.email);
  const roleNorm = norm(contact.contact_role);
  if (domain && freeDomains.includes(domain) && SENIOR_ROLE_VALUES.includes(roleNorm)) {
    flags.free_domain_senior_role = true;
    reasons.push("free_domain_senior_role");
  }

  // Rule 2: profile_spend_contradiction — exact 3-way per PRD §3.4 rule 2.
  // student_strength="under 500" AND fee_band="under 75k" AND budget_band="2l-plus".
  // String comparison is case-insensitive + whitespace-tolerant via norm().
  const ss = norm(schoolProfile.student_strength);
  const fb = norm(schoolProfile.fee_band);
  const bb = norm(safeAnswers.budget_band);
  if (ss === "under 500" && fb === "under 75k" && bb === "2l-plus") {
    flags.profile_spend_contradiction = true;
    reasons.push("profile_spend_contradiction");
  }

  // Rule 3: junk_strings — PRD calls out school_name + contact_name. We
  // ALSO check the email local-part because principal@test.com lands a
  // junk submission that rule 1 misses (test.com isn't on the free-mail
  // list) and the local "test"/"qwerty" patterns are the same family of
  // problem.
  const schoolName = schoolProfile.school_name;
  const contactName = contact.contact_name;
  const emailLocal = emailLocalPart(contact.email);
  const schoolJunk = looksLikeJunkString(schoolName, junkTokens);
  const contactJunk = looksLikeJunkString(contactName, junkTokens);
  // Email local: only fire if it's a NON-EMPTY junk token (don't treat a
  // missing email as a junk-strings fire; rule 5's phone/email-missing
  // surface is the wrong place to layer this).
  const localJunk = emailLocal.length > 0 && junkTokens.includes(emailLocal);
  if (schoolJunk || contactJunk || localJunk) {
    flags.junk_strings = true;
    reasons.push("junk_strings");
  }

  // Rule 4: repeat_submitter — strictly greater than the threshold.
  // The PRD says ">3" so 4+ fires, exactly 3 does NOT.
  if (priorCount > REPEAT_SUBMITTER_THRESHOLD) {
    flags.repeat_submitter = true;
    reasons.push("repeat_submitter");
  }

  // Rule 5: indian_mobile_format_fail. Skip if no phone at all — the form
  // requires phone (Q12), so a missing phone is a different class of
  // problem (validation error at submit time, not a suspect-classifier
  // signal). But: if there's SOMETHING in the phone field and it doesn't
  // validate, that's the rule-5 fire.
  const rawPhone = typeof contact.phone === "string" ? contact.phone.trim() : "";
  if (rawPhone.length > 0 && !isValidIndianMobile(contact.phone)) {
    flags.indian_mobile_format_fail = true;
    reasons.push("indian_mobile_format_fail");
  }

  return {
    leadQuality: reasons.length > 0 ? "suspect" : "clean",
    reasons,
    flags,
  };
}

module.exports = {
  classifyLeadQuality,
  // Constants exported for unit-test pinning + future config UI introspection.
  DEFAULT_FREE_EMAIL_DOMAINS,
  DEFAULT_JUNK_STRING_BLOCKLIST,
  SENIOR_ROLE_VALUES,
  REPEAT_SUBMITTER_THRESHOLD,
  // Internal helpers exported so tests can exercise edge cases without
  // having to construct a full answers payload for each.
  looksLikeJunkString,
  isValidIndianMobile,
  emailDomain,
  emailLocalPart,
};
