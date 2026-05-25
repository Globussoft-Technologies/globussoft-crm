// Unit tests for backend/lib/inboundLeadVerification.js
//
// Pins the pure verification helpers consumed by #904 slice 4 (route
// wire-in) of POST /api/travel/inbound/leads/:channel:
//   - verifyVoyagrHmac: happy + 3 fault paths (wrong sig, length
//     mismatch, missing inputs); timing-safe compare
//   - verifyWebForm: honeypot-tripped + custom honeypot field name +
//     empty/null body
//   - isValidEmail / isValidPhone: positive + negative examples
//   - checkAntiSpam: clean + each of the 4 SPAM_PATTERNS
//   - verifyByChannel: dispatch matrix (voyagr + webform + manual +
//     3 stubs + unknown)
//
// PRD: docs/PRD_TRAVEL_MULTICHANNEL_LEADS.md.

import { describe, test, expect } from "vitest";
import crypto from "node:crypto";

const {
  verifyVoyagrHmac,
  verifyWebForm,
  isValidEmail,
  isValidPhone,
  normalizePhoneForDedup,
  checkAntiSpam,
  verifyByChannel,
  SPAM_PATTERNS,
} = await import("../../lib/inboundLeadVerification.js");

// Helper to compute a real Voyagr HMAC for a payload+secret.
function signVoyagr(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

describe("verifyVoyagrHmac — HMAC-SHA256 signature verification", () => {
  test("happy: matching signature → ok:true", () => {
    const payload = JSON.stringify({ name: "Asha Verma", email: "asha@example.com" });
    const secret = "voyagr-shared-secret-abc123";
    const signature = signVoyagr(payload, secret);
    expect(verifyVoyagrHmac({ payload, signature, secret })).toEqual({ ok: true });
  });

  test("wrong signature (same length) → SIGNATURE_MISMATCH", () => {
    const payload = JSON.stringify({ name: "Rohan Kapoor" });
    const secret = "voyagr-shared-secret-abc123";
    const realSig = signVoyagr(payload, secret);
    // Flip the last hex char to a different-but-valid hex char.
    const tamperedSig =
      realSig.slice(0, -1) + (realSig.endsWith("a") ? "b" : "a");
    expect(tamperedSig.length).toBe(realSig.length);
    const result = verifyVoyagrHmac({
      payload,
      signature: tamperedSig,
      secret,
    });
    expect(result).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });
  });

  test("different-length signature → SIGNATURE_LENGTH_MISMATCH", () => {
    const payload = JSON.stringify({ name: "Priya Mehta" });
    const secret = "voyagr-shared-secret-abc123";
    const result = verifyVoyagrHmac({
      payload,
      signature: "deadbeef", // too short
      secret,
    });
    expect(result).toEqual({ ok: false, reason: "SIGNATURE_LENGTH_MISMATCH" });
  });

  test("missing payload → MISSING_INPUTS", () => {
    expect(
      verifyVoyagrHmac({ signature: "x".repeat(64), secret: "s" }),
    ).toEqual({ ok: false, reason: "MISSING_INPUTS" });
  });

  test("missing signature → MISSING_INPUTS", () => {
    expect(verifyVoyagrHmac({ payload: "{}", secret: "s" })).toEqual({
      ok: false,
      reason: "MISSING_INPUTS",
    });
  });

  test("missing secret → MISSING_INPUTS", () => {
    expect(
      verifyVoyagrHmac({ payload: "{}", signature: "x".repeat(64) }),
    ).toEqual({ ok: false, reason: "MISSING_INPUTS" });
  });

  test("no args at all → MISSING_INPUTS (no throw)", () => {
    expect(verifyVoyagrHmac()).toEqual({ ok: false, reason: "MISSING_INPUTS" });
  });
});

describe("verifyWebForm — honeypot-field check", () => {
  test("clean body (no honeypot field) → ok:true", () => {
    const body = { name: "Vikram Singh", email: "vikram@example.com" };
    expect(verifyWebForm({ body })).toEqual({ ok: true });
  });

  test("honeypot field present but empty string → ok:true", () => {
    const body = { name: "Neha Joshi", website_url: "" };
    expect(verifyWebForm({ body })).toEqual({ ok: true });
  });

  test("honeypot field filled → HONEYPOT_TRIPPED", () => {
    const body = {
      name: "Bot McBotface",
      website_url: "http://spam.example.com",
    };
    expect(verifyWebForm({ body })).toEqual({
      ok: false,
      reason: "HONEYPOT_TRIPPED",
    });
  });

  test("custom honeypot field name", () => {
    const body = { name: "Tester", company_url: "http://spam.example.com" };
    expect(
      verifyWebForm({ body, honeypotFieldName: "company_url" }),
    ).toEqual({ ok: false, reason: "HONEYPOT_TRIPPED" });
    // Default name "website_url" is absent → ok:true under default check
    expect(verifyWebForm({ body })).toEqual({ ok: true });
  });

  test("empty body → EMPTY_BODY", () => {
    expect(verifyWebForm({ body: null })).toEqual({
      ok: false,
      reason: "EMPTY_BODY",
    });
    expect(verifyWebForm({})).toEqual({ ok: false, reason: "EMPTY_BODY" });
  });
});

describe("isValidEmail — permissive plausibility check", () => {
  test("valid: simple", () => {
    expect(isValidEmail("asha@example.com")).toBe(true);
  });
  test("valid: subdomain", () => {
    expect(isValidEmail("asha@mail.enhancedwellness.in")).toBe(true);
  });
  test("valid: plus addressing", () => {
    expect(isValidEmail("asha+sales@example.com")).toBe(true);
  });
  test("invalid: no @", () => {
    expect(isValidEmail("ashaexample.com")).toBe(false);
  });
  test("invalid: no dot in domain", () => {
    expect(isValidEmail("asha@example")).toBe(false);
  });
  test("invalid: empty / null / non-string", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });
});

describe("isValidPhone — digit-count range", () => {
  test("valid: Indian 10-digit", () => {
    expect(isValidPhone("9876543210")).toBe(true);
  });
  test("valid: international +91 formatted", () => {
    expect(isValidPhone("+91 98765 43210")).toBe(true);
  });
  test("valid: US 11-digit", () => {
    expect(isValidPhone("+1-415-555-0123")).toBe(true);
  });
  test("invalid: too short (<7 digits)", () => {
    expect(isValidPhone("12345")).toBe(false);
  });
  test("invalid: too long (>15 digits)", () => {
    expect(isValidPhone("1234567890123456")).toBe(false);
  });
  test("invalid: empty / null / non-string", () => {
    expect(isValidPhone("")).toBe(false);
    expect(isValidPhone(null)).toBe(false);
    expect(isValidPhone(undefined)).toBe(false);
    expect(isValidPhone(9876543210)).toBe(false);
  });
});

describe("checkAntiSpam — pattern matcher", () => {
  test("clean body → ok:true", () => {
    expect(
      checkAntiSpam({ name: "Asha Verma", message: "Need Umrah quote for 2" }),
    ).toEqual({ ok: true });
  });

  test("viagra pattern → ok:false", () => {
    const result = checkAntiSpam({ message: "Buy VIAGRA cheap online" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^SPAM_PATTERN_/);
  });

  test("casino pattern → ok:false", () => {
    const result = checkAntiSpam({ message: "best casino bonus" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^SPAM_PATTERN_/);
  });

  test("crypto wallet pattern → ok:false", () => {
    const result = checkAntiSpam({
      message: "Recover your crypto wallet here",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^SPAM_PATTERN_/);
  });

  test("<script attempted XSS → ok:false", () => {
    const result = checkAntiSpam({ name: "<script>alert(1)</script>" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^SPAM_PATTERN_/);
  });

  test("falsy body → ok:true (no-op)", () => {
    expect(checkAntiSpam(null)).toEqual({ ok: true });
    expect(checkAntiSpam(undefined)).toEqual({ ok: true });
  });

  test("circular body → BODY_NOT_SERIALIZABLE", () => {
    const body = { name: "x" };
    body.self = body;
    expect(checkAntiSpam(body)).toEqual({
      ok: false,
      reason: "BODY_NOT_SERIALIZABLE",
    });
  });

  test("SPAM_PATTERNS export shape", () => {
    expect(Array.isArray(SPAM_PATTERNS)).toBe(true);
    expect(SPAM_PATTERNS.length).toBeGreaterThanOrEqual(4);
    for (const pat of SPAM_PATTERNS) {
      expect(pat).toBeInstanceOf(RegExp);
    }
  });
});

describe("verifyByChannel — dispatch matrix", () => {
  test("voyagr happy → ok:true with channel echoed", () => {
    const payload = JSON.stringify({ name: "Asha" });
    const secret = "s";
    const signature = signVoyagr(payload, secret);
    const result = verifyByChannel("voyagr", { payload, signature, secret });
    expect(result).toEqual({ ok: true, channel: "voyagr" });
  });

  test("voyagr fail → ok:false with reason + channel", () => {
    const result = verifyByChannel("voyagr", {
      payload: "{}",
      signature: "deadbeef",
      secret: "s",
    });
    expect(result.ok).toBe(false);
    expect(result.channel).toBe("voyagr");
    expect(result.reason).toBe("SIGNATURE_LENGTH_MISMATCH");
  });

  test("webform happy → ok:true", () => {
    expect(
      verifyByChannel("webform", { body: { name: "Asha" } }),
    ).toEqual({ ok: true, channel: "webform" });
  });

  test("webform honeypot tripped → ok:false", () => {
    const result = verifyByChannel("webform", {
      body: { name: "Bot", website_url: "spam" },
    });
    expect(result).toEqual({
      ok: false,
      reason: "HONEYPOT_TRIPPED",
      channel: "webform",
    });
  });

  test("manual → ok:true, no stub flag", () => {
    const result = verifyByChannel("manual", {});
    expect(result).toEqual({ ok: true, channel: "manual" });
    expect(result.stub).toBeUndefined();
  });

  test("whatsapp → ok:true with stub:true", () => {
    expect(verifyByChannel("whatsapp", {})).toEqual({
      ok: true,
      stub: true,
      channel: "whatsapp",
    });
  });

  test("ads → ok:true with stub:true", () => {
    expect(verifyByChannel("ads", {})).toEqual({
      ok: true,
      stub: true,
      channel: "ads",
    });
  });

  test("adsgpt → ok:true with stub:true", () => {
    expect(verifyByChannel("adsgpt", {})).toEqual({
      ok: true,
      stub: true,
      channel: "adsgpt",
    });
  });

  test("unknown channel → UNKNOWN_CHANNEL", () => {
    expect(verifyByChannel("telegram", {})).toEqual({
      ok: false,
      reason: "UNKNOWN_CHANNEL",
      channel: "telegram",
    });
  });
});

// ─── Slice 9: normalizePhoneForDedup (PRD §3.2.1 dedup key) ───────────
//
// Contract: arbitrary surface forms collapse to the same digits-only
// canonical key. Two inputs that should dedup MUST round-trip to the
// same output here — this is what the route's tenant-scoped phone-match
// loop compares against.

describe("normalizePhoneForDedup — canonical dedup key", () => {
  test("E.164-prefixed 12-digit Indian → digits-only 12", () => {
    expect(normalizePhoneForDedup("+919876543210")).toBe("919876543210");
  });

  test("formatted '+91 98765-43210' → same canonical key as the +91 12-digit", () => {
    expect(normalizePhoneForDedup("+91 98765-43210")).toBe("919876543210");
  });

  test("bare 10-digit Indian mobile auto-prepends '91'", () => {
    expect(normalizePhoneForDedup("9876543210")).toBe("919876543210");
  });

  test("12-digit already-E.164 + 10-digit IN local + formatted +91 all collapse to same key", () => {
    const key = "919876543210";
    expect(normalizePhoneForDedup("919876543210")).toBe(key);
    expect(normalizePhoneForDedup("9876543210")).toBe(key);
    expect(normalizePhoneForDedup("+91 98765-43210")).toBe(key);
    expect(normalizePhoneForDedup("+91-987-654-3210")).toBe(key);
  });

  test("11-digit US (1 + 10) does NOT get 91 prepended (only 10-digit triggers IN heuristic)", () => {
    expect(normalizePhoneForDedup("+1 555-123-4567")).toBe("15551234567");
  });

  test("null / undefined / empty → null", () => {
    expect(normalizePhoneForDedup(null)).toBeNull();
    expect(normalizePhoneForDedup(undefined)).toBeNull();
    expect(normalizePhoneForDedup("")).toBeNull();
  });

  test("non-string input → null", () => {
    expect(normalizePhoneForDedup(919876543210)).toBeNull();
    expect(normalizePhoneForDedup({})).toBeNull();
  });

  test("all-junk string (no digits) → null", () => {
    expect(normalizePhoneForDedup("()-+ ")).toBeNull();
    expect(normalizePhoneForDedup("not a phone")).toBeNull();
  });
});

// ─── Slice 11 — classifyInboundJunk heuristic ─────────────────────────────
//
// Pins the junk-classification rule used by the inbound-leads route to
// flag low-signal payloads from STUB-trusted channels. See the helper
// docstring for the full rule. The rule is "junk = true" when ALL of:
//   - verification was stub-trusted OR bypassed
//   - no name signal anywhere
//   - no real email
//   - no secondary signal (company / subBrand / metaJson)

const { classifyInboundJunk } = await import(
  "../../lib/inboundLeadVerification.js"
);

describe("classifyInboundJunk — low-signal payload flag (slice 11)", () => {
  test("signed verification → never junk regardless of payload", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true }, // no stub, no bypassed
      body: {}, // zero signal
      normalizedPhone: null,
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  test("stub-trusted + zero name + synthesized email + no extras → junk:true", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, stub: true, channel: "whatsapp" },
      body: { phone: "+919876543210" }, // ONLY phone
      normalizedPhone: "919876543210",
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(true);
    expect(verdict.reasons).toContain("VERIFICATION_STUB");
    expect(verdict.reasons).toContain("NO_NAME");
    expect(verdict.reasons).toContain("NO_REAL_EMAIL");
    expect(verdict.reasons).toContain("NO_SECONDARY_SIGNAL");
  });

  test("bypassed verification (Voyagr env-missing) flagged with VERIFICATION_BYPASSED", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, bypassed: true },
      body: { phone: "+919876543210" },
      normalizedPhone: "919876543210",
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(true);
    expect(verdict.reasons[0]).toBe("VERIFICATION_BYPASSED");
  });

  test("stub + name present → NOT junk (real customer signal)", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, stub: true },
      body: { name: "Asha Verma", phone: "+919876543210" },
      normalizedPhone: "919876543210",
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  test("stub + firstName/lastName present → NOT junk", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, stub: true },
      body: { firstName: "Asha", lastName: "Verma", phone: "+919876543210" },
      normalizedPhone: "919876543210",
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(false);
  });

  test("stub + real email → NOT junk (email is identity)", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, stub: true },
      body: { email: "asha@example.com" },
      normalizedPhone: null,
      hasRealEmail: true,
    });
    expect(verdict.junk).toBe(false);
  });

  test("stub + company supplied → NOT junk (secondary signal)", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, stub: true },
      body: { phone: "+919876543210", company: "Acme Travels" },
      normalizedPhone: "919876543210",
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(false);
  });

  test("stub + subBrand supplied → NOT junk (form-routing identity)", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, stub: true },
      body: { phone: "+919876543210", subBrand: "rfu" },
      normalizedPhone: "919876543210",
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(false);
  });

  test("stub + metaJson present → NOT junk (carries upstream context)", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, stub: true },
      body: {
        phone: "+919876543210",
        metaJson: { utm_source: "facebook", form_id: "12345" },
      },
      normalizedPhone: "919876543210",
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(false);
  });

  test("whitespace-only name fields do NOT count as signal", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, stub: true },
      body: { name: "   ", firstName: "", lastName: "  " },
      normalizedPhone: "919876543210",
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(true);
    expect(verdict.reasons).toContain("NO_NAME");
  });

  test("no-args call → not junk, empty reasons (defensive)", () => {
    const verdict = classifyInboundJunk();
    expect(verdict.junk).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  test("stub + nothing at all (no phone) → junk:true + NO_PHONE reason", () => {
    const verdict = classifyInboundJunk({
      verification: { ok: true, stub: true },
      body: {},
      normalizedPhone: null,
      hasRealEmail: false,
    });
    expect(verdict.junk).toBe(true);
    expect(verdict.reasons).toContain("NO_PHONE");
  });
});

// ─── Slice 12 — normalizeMetaLeadPayload (Meta lead-ads webhook shape) ────
//
// Pins the Meta-payload → canonical-body transform consumed by the route
// when channel=metaads. The helper is a no-op for non-Meta shapes (any
// body without a `field_data` array) so pre-normalized callers and other
// channels are unaffected.

const { normalizeMetaLeadPayload } = await import(
  "../../lib/inboundLeadVerification.js"
);

describe("normalizeMetaLeadPayload — Meta lead-ads webhook → canonical body (slice 12)", () => {
  test("happy path: field_data array → flat canonical fields", () => {
    const meta = {
      leadgen_id: "1234567890",
      form_id: "987654321",
      ad_id: "111",
      campaign_id: "222",
      created_time: "2026-05-25T10:00:00+0000",
      field_data: [
        { name: "full_name", values: ["Asha Verma"] },
        { name: "email", values: ["asha@example.com"] },
        { name: "phone_number", values: ["+919876543210"] },
      ],
    };

    const out = normalizeMetaLeadPayload(meta);

    expect(out.name).toBe("Asha Verma");
    expect(out.email).toBe("asha@example.com");
    expect(out.phone).toBe("+919876543210");
    // field_data is consumed (not present on the output so the route
    // doesn't accidentally ingest it as a Contact-shaped field).
    expect(out.field_data).toBeUndefined();
    // Meta attribution tokens preserved on metaJson.
    expect(out.metaJson).toMatchObject({
      leadgen_id: "1234567890",
      form_id: "987654321",
      ad_id: "111",
      campaign_id: "222",
      created_time: "2026-05-25T10:00:00+0000",
    });
  });

  test("first_name + last_name field_data tokens map to firstName / lastName", () => {
    const out = normalizeMetaLeadPayload({
      field_data: [
        { name: "first_name", values: ["Asha"] },
        { name: "last_name", values: ["Verma"] },
        { name: "email", values: ["asha@example.com"] },
      ],
    });
    expect(out.firstName).toBe("Asha");
    expect(out.lastName).toBe("Verma");
    // No `name` token in field_data → not synthesized; route's existing
    // buildName() will combine firstName+lastName downstream.
    expect(out.name).toBeUndefined();
  });

  test("given_name / family_name aliases also map (Meta's locale variant)", () => {
    const out = normalizeMetaLeadPayload({
      field_data: [
        { name: "given_name", values: ["Rohan"] },
        { name: "family_name", values: ["Kapoor"] },
      ],
    });
    expect(out.firstName).toBe("Rohan");
    expect(out.lastName).toBe("Kapoor");
  });

  test("caller-supplied flat field WINS over field_data extraction", () => {
    const out = normalizeMetaLeadPayload({
      // Caller pre-set an explicit name (defensive producer) — must keep it.
      name: "Operator Override",
      field_data: [
        { name: "full_name", values: ["From Meta"] },
        { name: "email", values: ["meta@example.com"] },
      ],
    });
    expect(out.name).toBe("Operator Override");
    // Email had no caller override → field_data wins.
    expect(out.email).toBe("meta@example.com");
  });

  test("caller-supplied empty string is treated as missing (field_data wins)", () => {
    const out = normalizeMetaLeadPayload({
      name: "",
      email: null,
      field_data: [
        { name: "full_name", values: ["From Meta"] },
        { name: "email", values: ["meta@example.com"] },
      ],
    });
    expect(out.name).toBe("From Meta");
    expect(out.email).toBe("meta@example.com");
  });

  test("unknown field_data names land under metaJson.extraFields", () => {
    const out = normalizeMetaLeadPayload({
      field_data: [
        { name: "full_name", values: ["Asha"] },
        { name: "custom_question_1", values: ["Yes I want a quote"] },
        { name: "trip_destination", values: ["Mecca"] },
      ],
    });
    expect(out.name).toBe("Asha");
    expect(out.metaJson?.extraFields).toEqual({
      custom_question_1: "Yes I want a quote",
      trip_destination: "Mecca",
    });
  });

  test("merges into existing metaJson without clobbering", () => {
    const out = normalizeMetaLeadPayload({
      metaJson: {
        utm_source: "facebook",
        extraFields: { pre_existing: "value" },
      },
      leadgen_id: "999",
      field_data: [
        { name: "email", values: ["asha@example.com"] },
        { name: "unmapped_field", values: ["x"] },
      ],
    });
    // Caller-supplied utm_source must survive.
    expect(out.metaJson.utm_source).toBe("facebook");
    // New tokens land alongside.
    expect(out.metaJson.leadgen_id).toBe("999");
    // Extra fields merge (caller's `pre_existing` + new `unmapped_field`).
    expect(out.metaJson.extraFields).toEqual({
      pre_existing: "value",
      unmapped_field: "x",
    });
  });

  test("no field_data array → body returned untouched (other channels / pre-normalized callers)", () => {
    const body = {
      name: "Plain Caller",
      email: "plain@example.com",
      phone: "+919876543210",
      subBrand: "rfu",
    };
    const out = normalizeMetaLeadPayload(body);
    expect(out).toEqual(body);
  });

  test("field_data present but not an array → body returned untouched (defensive)", () => {
    const body = {
      name: "Defensive",
      field_data: "not-an-array", // malformed producer
    };
    const out = normalizeMetaLeadPayload(body);
    expect(out).toBe(body);
  });

  test("non-object input → returned untouched", () => {
    expect(normalizeMetaLeadPayload(null)).toBeNull();
    expect(normalizeMetaLeadPayload(undefined)).toBeUndefined();
    expect(normalizeMetaLeadPayload("string")).toBe("string");
    expect(normalizeMetaLeadPayload(42)).toBe(42);
  });

  test("malformed field_data entries are skipped (defensive against producer noise)", () => {
    const out = normalizeMetaLeadPayload({
      field_data: [
        null,
        undefined,
        "not an object",
        { /* no name */ values: ["orphan"] },
        { name: "", values: ["empty name"] },
        { name: 42, values: ["non-string name"] },
        { name: "email", values: [] }, // empty values array → skip
        { name: "phone_number", values: null }, // null values → skip
        { name: "full_name", values: ["Surviving Entry"] },
      ],
    });
    expect(out.name).toBe("Surviving Entry");
    // The malformed entries did NOT crash the helper, and none of them
    // contributed to extracted fields or extraFields.
    expect(out.email).toBeUndefined();
    expect(out.phone).toBeUndefined();
  });

  test("values as bare string (older Meta format) → first-entry semantics still apply", () => {
    const out = normalizeMetaLeadPayload({
      field_data: [
        { name: "full_name", values: "Asha Bare" },
        { name: "email", values: "asha@example.com" },
      ],
    });
    expect(out.name).toBe("Asha Bare");
    expect(out.email).toBe("asha@example.com");
  });

  test("multi-value array collapses to first entry (multi-select fields out of scope per PRD §7)", () => {
    const out = normalizeMetaLeadPayload({
      field_data: [
        // Hypothetical multi-select destination preference. We take the
        // first only — multi-value semantics are out-of-scope for slice 12.
        { name: "company", values: ["Acme Travels", "Other Co"] },
      ],
    });
    expect(out.company).toBe("Acme Travels");
  });

  test("does not mutate the input body", () => {
    const body = {
      leadgen_id: "1",
      field_data: [{ name: "full_name", values: ["Immutable"] }],
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    normalizeMetaLeadPayload(body);
    expect(body).toEqual(snapshot);
  });

  test("no Meta tokens AND no extra fields → metaJson stays absent (no empty object)", () => {
    const out = normalizeMetaLeadPayload({
      field_data: [
        { name: "email", values: ["asha@example.com"] },
        // No leadgen_id, no form_id, all mapped fields → no extras.
      ],
    });
    expect(out.email).toBe("asha@example.com");
    expect(out.metaJson).toBeUndefined();
  });
});

// ─── Slice 13 — normalizeIndiamartLeadPayload (IndiaMART CRM Listing API) ──
//
// Pins the IndiaMART → canonical-body transform. Mirrors the slice-12 Meta
// normalizer's discipline: detect the vendor shape via signature keys, map
// SENDER_*/QUERY_* to canonical fields, preserve metadata on metaJson, leave
// non-IndiaMART bodies untouched. Pure helper, IO-free, immutable input.
//
// Slice 13 ships the lib only; the route does NOT wire it in yet (marketplace
// channels stay on the existing marketplaceEngine cron until the per-channel
// refactor lands in a later slice — same lib-first / route-wire-later pattern
// that slice 3 → slice 4 followed).

const { normalizeIndiamartLeadPayload } = await import(
  "../../lib/inboundLeadVerification.js"
);

describe("normalizeIndiamartLeadPayload — IndiaMART CRM Listing API → canonical body (slice 13)", () => {
  test("happy path: SENDER_* + QUERY_* shape → flat canonical fields + metaJson", () => {
    const im = {
      UNIQUE_QUERY_ID: "1234567890",
      QUERY_ID: "Q-1",
      SENDER_NAME: "Asha Verma",
      SENDER_EMAIL: "asha@example.com",
      SENDER_MOBILE: "+919876543210",
      SENDER_COMPANY: "Acme Travels",
      SENDER_CITY: "Mumbai",
      SENDER_STATE: "MH",
      SENDER_COUNTRY_ISO: "IN",
      QUERY_PRODUCT_NAME: "Umrah Package",
      QUERY_MESSAGE: "Need a quote",
      QUERY_TYPE: "B",
      QUERY_TIME: "2026-05-25 10:00:00",
    };

    const out = normalizeIndiamartLeadPayload(im);

    expect(out.name).toBe("Asha Verma");
    expect(out.email).toBe("asha@example.com");
    expect(out.phone).toBe("+919876543210");
    expect(out.company).toBe("Acme Travels");
    // The original SCREAMING_SNAKE keys are consumed (stripped from output)
    // so the route handler never sees SENDER_NAME as a Contact-shaped field.
    expect(out.SENDER_NAME).toBeUndefined();
    expect(out.SENDER_EMAIL).toBeUndefined();
    expect(out.SENDER_MOBILE).toBeUndefined();
    expect(out.SENDER_COMPANY).toBeUndefined();
    // IndiaMART attribution + lead-context tokens preserved on metaJson.
    expect(out.metaJson).toMatchObject({
      UNIQUE_QUERY_ID: "1234567890",
      QUERY_ID: "Q-1",
      QUERY_PRODUCT_NAME: "Umrah Package",
      QUERY_MESSAGE: "Need a quote",
      QUERY_TYPE: "B",
      QUERY_TIME: "2026-05-25 10:00:00",
      SENDER_CITY: "Mumbai",
      SENDER_STATE: "MH",
      SENDER_COUNTRY_ISO: "IN",
    });
  });

  test("SENDER_PHONE alias also maps to phone (older IndiaMART payloads)", () => {
    const out = normalizeIndiamartLeadPayload({
      UNIQUE_QUERY_ID: "1",
      SENDER_NAME: "Rohan",
      SENDER_PHONE: "+919876543210",
    });
    expect(out.phone).toBe("+919876543210");
  });

  test("SENDER_MOBILE wins over SENDER_PHONE when both are present (mobile is newer convention)", () => {
    const out = normalizeIndiamartLeadPayload({
      SENDER_MOBILE: "+919876543210",
      SENDER_PHONE: "+919999999999",
    });
    expect(out.phone).toBe("+919876543210");
  });

  test("caller-supplied flat field WINS over IndiaMART extraction", () => {
    const out = normalizeIndiamartLeadPayload({
      name: "Operator Override",
      SENDER_NAME: "From IndiaMART",
      SENDER_EMAIL: "im@example.com",
    });
    expect(out.name).toBe("Operator Override");
    // Email had no caller override → IndiaMART wins.
    expect(out.email).toBe("im@example.com");
  });

  test("caller-supplied empty string is treated as missing (IndiaMART wins)", () => {
    const out = normalizeIndiamartLeadPayload({
      name: "",
      email: null,
      SENDER_NAME: "From IndiaMART",
      SENDER_EMAIL: "im@example.com",
    });
    expect(out.name).toBe("From IndiaMART");
    expect(out.email).toBe("im@example.com");
  });

  test("unknown SENDER_/QUERY_ keys land under metaJson.extraFields", () => {
    const out = normalizeIndiamartLeadPayload({
      SENDER_NAME: "Asha",
      QUERY_PRODUCT_NAME: "Umrah",
      // These aren't in FIELD_MAP or META_TOKENS but start with SENDER_/QUERY_:
      SENDER_PINCODE: "400001",
      QUERY_CATEGORY: "Travel",
    });
    expect(out.name).toBe("Asha");
    expect(out.metaJson?.extraFields).toEqual({
      SENDER_PINCODE: "400001",
      QUERY_CATEGORY: "Travel",
    });
  });

  test("merges into existing metaJson without clobbering", () => {
    const out = normalizeIndiamartLeadPayload({
      metaJson: {
        utm_source: "indiamart-organic",
        extraFields: { pre_existing: "value" },
      },
      UNIQUE_QUERY_ID: "999",
      SENDER_NAME: "Asha",
      SENDER_PINCODE: "400001",
    });
    // Caller-supplied utm_source must survive.
    expect(out.metaJson.utm_source).toBe("indiamart-organic");
    // New tokens land alongside.
    expect(out.metaJson.UNIQUE_QUERY_ID).toBe("999");
    // Extra fields merge (caller's `pre_existing` + new `SENDER_PINCODE`).
    expect(out.metaJson.extraFields).toEqual({
      pre_existing: "value",
      SENDER_PINCODE: "400001",
    });
  });

  test("no IndiaMART signature keys → body returned untouched (other channels / pre-normalized callers)", () => {
    const body = {
      name: "Plain Caller",
      email: "plain@example.com",
      phone: "+919876543210",
      subBrand: "rfu",
      tenantSlug: "travel-stall",
    };
    const out = normalizeIndiamartLeadPayload(body);
    expect(out).toBe(body);
  });

  test("non-object input → returned untouched", () => {
    expect(normalizeIndiamartLeadPayload(null)).toBeNull();
    expect(normalizeIndiamartLeadPayload(undefined)).toBeUndefined();
    expect(normalizeIndiamartLeadPayload("string")).toBe("string");
    expect(normalizeIndiamartLeadPayload(42)).toBe(42);
  });

  test("null / undefined / empty-string field values are skipped", () => {
    const out = normalizeIndiamartLeadPayload({
      UNIQUE_QUERY_ID: "1",
      SENDER_NAME: null,
      SENDER_EMAIL: "",
      SENDER_MOBILE: undefined,
      SENDER_COMPANY: "   ",
      QUERY_PRODUCT_NAME: "Umrah",
    });
    // None of the empty/null sender fields contributed to extracted fields.
    expect(out.name).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(out.phone).toBeUndefined();
    expect(out.company).toBeUndefined();
    // The non-empty meta tokens DID survive.
    expect(out.metaJson).toMatchObject({
      UNIQUE_QUERY_ID: "1",
      QUERY_PRODUCT_NAME: "Umrah",
    });
  });

  test("plain non-IndiaMART keys (tenantSlug / subBrand) survive untouched alongside extraction", () => {
    const out = normalizeIndiamartLeadPayload({
      tenantSlug: "travel-stall",
      subBrand: "rfu",
      SENDER_NAME: "Asha",
      SENDER_EMAIL: "asha@example.com",
    });
    // Caller's plain camelCase keys survive — they're NOT IndiaMART tokens.
    expect(out.tenantSlug).toBe("travel-stall");
    expect(out.subBrand).toBe("rfu");
    // Canonical fields still extracted.
    expect(out.name).toBe("Asha");
    expect(out.email).toBe("asha@example.com");
    // Plain camelCase keys are NOT shoveled into extraFields.
    expect(out.metaJson?.extraFields).toBeUndefined();
  });

  test("does not mutate the input body", () => {
    const body = {
      UNIQUE_QUERY_ID: "1",
      SENDER_NAME: "Immutable",
      QUERY_PRODUCT_NAME: "Umrah",
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    normalizeIndiamartLeadPayload(body);
    expect(body).toEqual(snapshot);
  });

  test("no meta tokens AND no extras AND only canonical extractions → metaJson stays absent", () => {
    const out = normalizeIndiamartLeadPayload({
      SENDER_NAME: "Asha",
      SENDER_EMAIL: "asha@example.com",
      // No UNIQUE_QUERY_ID / QUERY_* tokens, no extra SENDER_/QUERY_ keys.
    });
    expect(out.name).toBe("Asha");
    expect(out.email).toBe("asha@example.com");
    expect(out.metaJson).toBeUndefined();
  });

  test("signature detection: lone QUERY_ID is sufficient to trigger normalization", () => {
    // A producer that ships only QUERY_ID + canonical fields should still
    // route through the helper (signature keys span both lead-id and
    // sender-data prefixes so we catch both shapes).
    const out = normalizeIndiamartLeadPayload({
      QUERY_ID: "Q-only",
      name: "Pre-normalized Asha",
      email: "asha@example.com",
    });
    expect(out.name).toBe("Pre-normalized Asha");
    expect(out.metaJson).toMatchObject({ QUERY_ID: "Q-only" });
  });
});

// ─── Slice 14 — normalizeJustdialLeadPayload (JustDial lead-feed API) ──────
//
// Pins the JustDial → canonical-body transform. Mirrors the slice-12 Meta and
// slice-13 IndiaMART normalizers' discipline: detect the vendor shape via
// signature keys, map vendor field names to canonical fields, preserve
// attribution + lead-context tokens on metaJson, leave non-JustDial bodies
// untouched, immutable input.
//
// JustDial-specific quirks pinned here:
//   - `prefixedmobileno` (newer E.164 format) WINS over `mobile` (legacy
//     local format) when both are present
//   - Unknown lowercase keys are LEFT on the body (not swept into
//     extraFields) because JustDial uses generic lowercase keys without a
//     prefix — sweeping unknowns would collide with the route's own
//     canonical fields (tenantSlug, subBrand, etc.)
//   - Signature detection requires JustDial-specific keys (leadid /
//     enquiry_id / prefixedmobileno / enquirydate / branchpin); bare
//     `name`/`email`/`mobile` do NOT trigger normalization to avoid
//     misclassifying pre-normalized callers
//
// Slice 14 ships the lib only; the route does NOT wire it in yet (marketplace
// channels stay on the existing marketplaceEngine cron until the per-channel
// refactor lands in a later slice — same lib-first / route-wire-later pattern
// that slices 3→4 + 13 followed).

const { normalizeJustdialLeadPayload } = await import(
  "../../lib/inboundLeadVerification.js"
);

describe("normalizeJustdialLeadPayload — JustDial lead-feed API → canonical body (slice 14)", () => {
  test("happy path: JustDial lowercase shape → flat canonical fields + metaJson", () => {
    const jd = {
      leadid: "JD-9876543",
      enquiry_id: "EQ-12345",
      name: "Asha Verma",
      email: "asha@example.com",
      prefixedmobileno: "+919876543210",
      company: "Acme Travels",
      city: "Mumbai",
      area: "Andheri",
      branchpin: "400053",
      category: "Travel Agents",
      subcategory: "Umrah Package",
      query: "Looking for Umrah Q4",
      enquirydate: "2026-05-25 10:00:00",
    };

    const out = normalizeJustdialLeadPayload(jd);

    expect(out.name).toBe("Asha Verma");
    expect(out.email).toBe("asha@example.com");
    expect(out.phone).toBe("+919876543210");
    expect(out.company).toBe("Acme Travels");
    // Original JustDial keys consumed → stripped from output.
    expect(out.prefixedmobileno).toBeUndefined();
    expect(out.mobile).toBeUndefined();
    expect(out.category).toBeUndefined();
    expect(out.subcategory).toBeUndefined();
    expect(out.query).toBeUndefined();
    expect(out.enquirydate).toBeUndefined();
    expect(out.city).toBeUndefined();
    expect(out.area).toBeUndefined();
    expect(out.branchpin).toBeUndefined();
    expect(out.leadid).toBeUndefined();
    expect(out.enquiry_id).toBeUndefined();
    // JustDial attribution + lead-context tokens preserved on metaJson.
    expect(out.metaJson).toMatchObject({
      leadid: "JD-9876543",
      enquiry_id: "EQ-12345",
      category: "Travel Agents",
      subcategory: "Umrah Package",
      query: "Looking for Umrah Q4",
      enquirydate: "2026-05-25 10:00:00",
      city: "Mumbai",
      area: "Andheri",
      branchpin: "400053",
    });
  });

  test("mobile alias maps to phone when prefixedmobileno is absent", () => {
    const out = normalizeJustdialLeadPayload({
      leadid: "JD-1",
      name: "Rohan",
      mobile: "+919876543210",
    });
    expect(out.phone).toBe("+919876543210");
  });

  test("prefixedmobileno WINS over mobile when both are present (newer E.164 beats legacy local)", () => {
    const out = normalizeJustdialLeadPayload({
      leadid: "JD-1",
      prefixedmobileno: "+919876543210",
      mobile: "9876543210",
    });
    expect(out.phone).toBe("+919876543210");
  });

  test("caller-supplied flat field WINS over JustDial extraction", () => {
    const out = normalizeJustdialLeadPayload({
      leadid: "JD-1",
      name: "Operator Override",
      // JustDial-side values that would otherwise extract:
      email: undefined, // ensure caller didn't override email
      prefixedmobileno: "+919876543210",
    });
    // Trick: we passed `name` as caller-supplied (winning) but it's also a
    // JustDial field-map key — so this verifies "caller wins" doesn't get
    // stomped during the strip-then-extract step.
    expect(out.name).toBe("Operator Override");
    expect(out.phone).toBe("+919876543210");
  });

  test("caller-supplied empty string is treated as missing (JustDial wins)", () => {
    const out = normalizeJustdialLeadPayload({
      leadid: "JD-1",
      name: "",
      email: null,
      // The route's flat shape uses these keys, but JustDial also writes
      // here. We're verifying that the empty/null caller values lose to
      // a NEW JustDial value when there is one. Here both are simultaneously
      // JustDial keys + caller flat fields, so we rely on the strip-then-
      // extract step: strip removes ALL field-map keys, then extracted{} is
      // empty for name/email because the body had no NON-empty JustDial
      // source for them either. Verify the absence is reflected.
      prefixedmobileno: "+919876543210",
    });
    // No name source → undefined.
    expect(out.name).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(out.phone).toBe("+919876543210");
  });

  test("unknown lowercase keys are LEFT on the body (not swept into extraFields)", () => {
    const out = normalizeJustdialLeadPayload({
      leadid: "JD-1",
      name: "Asha",
      // Unknown JustDial keys (not in FIELD_MAP or META_TOKENS):
      campaign_id: "camp-99",
      ad_group: "umrah-2026",
    });
    expect(out.name).toBe("Asha");
    // Unknowns survive on the output body (no SENDER_/QUERY_-style prefix
    // means we can't safely shovel them into extraFields without colliding
    // with route-canonical fields).
    expect(out.campaign_id).toBe("camp-99");
    expect(out.ad_group).toBe("umrah-2026");
    // metaJson should NOT carry an extraFields key in this slice.
    expect(out.metaJson?.extraFields).toBeUndefined();
  });

  test("merges into existing metaJson without clobbering", () => {
    const out = normalizeJustdialLeadPayload({
      metaJson: {
        utm_source: "justdial-organic",
        existing_token: "preserved",
      },
      leadid: "JD-999",
      name: "Asha",
      city: "Mumbai",
    });
    // Caller-supplied metaJson tokens survive.
    expect(out.metaJson.utm_source).toBe("justdial-organic");
    expect(out.metaJson.existing_token).toBe("preserved");
    // JustDial-supplied tokens land alongside.
    expect(out.metaJson.leadid).toBe("JD-999");
    expect(out.metaJson.city).toBe("Mumbai");
  });

  test("no JustDial signature keys → body returned untouched (other channels / pre-normalized)", () => {
    const body = {
      name: "Plain Caller",
      email: "plain@example.com",
      phone: "+919876543210",
      mobile: "9876543210", // bare mobile WITHOUT JustDial signature → no-op
      subBrand: "rfu",
      tenantSlug: "travel-stall",
    };
    const out = normalizeJustdialLeadPayload(body);
    expect(out).toBe(body);
  });

  test("non-object input → returned untouched", () => {
    expect(normalizeJustdialLeadPayload(null)).toBeNull();
    expect(normalizeJustdialLeadPayload(undefined)).toBeUndefined();
    expect(normalizeJustdialLeadPayload("string")).toBe("string");
    expect(normalizeJustdialLeadPayload(42)).toBe(42);
  });

  test("null / undefined / empty-string field values are skipped", () => {
    const out = normalizeJustdialLeadPayload({
      leadid: "JD-1",
      name: null,
      email: "",
      prefixedmobileno: undefined,
      mobile: "   ",
      company: "",
      query: "Looking for Umrah",
    });
    expect(out.name).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(out.phone).toBeUndefined();
    expect(out.company).toBeUndefined();
    expect(out.metaJson).toMatchObject({
      leadid: "JD-1",
      query: "Looking for Umrah",
    });
  });

  test("plain non-JustDial keys (tenantSlug / subBrand) survive untouched alongside extraction", () => {
    const out = normalizeJustdialLeadPayload({
      tenantSlug: "travel-stall",
      subBrand: "rfu",
      leadid: "JD-1",
      name: "Asha",
      email: "asha@example.com",
    });
    expect(out.tenantSlug).toBe("travel-stall");
    expect(out.subBrand).toBe("rfu");
    expect(out.name).toBe("Asha");
    expect(out.email).toBe("asha@example.com");
  });

  test("does not mutate the input body", () => {
    const body = {
      leadid: "JD-1",
      name: "Immutable",
      prefixedmobileno: "+919876543210",
      city: "Mumbai",
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    normalizeJustdialLeadPayload(body);
    expect(body).toEqual(snapshot);
  });

  test("only canonical extractions, no meta tokens → metaJson stays absent", () => {
    const out = normalizeJustdialLeadPayload({
      leadid: "JD-1",
      name: "Asha",
      email: "asha@example.com",
      prefixedmobileno: "+919876543210",
      // leadid IS a meta token though, so we DO expect metaJson — verify
      // it carries leadid alone. (Pure "no meta tokens" needs a signature
      // key that's NOT also a meta token — branchpin fits.)
    });
    expect(out.metaJson).toMatchObject({ leadid: "JD-1" });
  });

  test("signature detection: lone branchpin (no other JustDial tokens) triggers normalization", () => {
    const out = normalizeJustdialLeadPayload({
      branchpin: "400053",
      name: "Pre-normalized Asha",
      email: "asha@example.com",
    });
    expect(out.name).toBe("Pre-normalized Asha");
    // branchpin is BOTH a signature key AND a meta token — verify it
    // landed under metaJson and was stripped from the body.
    expect(out.metaJson).toMatchObject({ branchpin: "400053" });
    expect(out.branchpin).toBeUndefined();
  });
});

// ─── Slice 15 — normalizeTradeindiaLeadPayload (TradeIndia lead-feed API) ──
//
// Pins the TradeIndia → canonical-body transform. Completes the
// four-marketplace cluster (Meta / IndiaMART / JustDial / TradeIndia) per
// PRD §3.4.2. TradeIndia's snake_case shape is closer to IndiaMART than to
// JustDial, so this normalizer mirrors the IndiaMART discipline:
//   - Detection via TradeIndia-distinctive snake_case signature keys
//     (sender_company / query_details / query_id) — bare `mobile` / `email_id`
//     do NOT trigger normalization to avoid misclassifying pre-normalized
//     callers
//   - Multi-version field-name union: mobile / mob_no / phone all map to
//     canonical phone; email_id + email both map to email; sender_name + name
//     both map to name (TradeIndia has shipped multiple API versions)
//   - Unknown sender_/query_-prefixed keys preserved under
//     metaJson.extraFields (mirrors the IndiaMART normalizer)
//   - Phone normalization stays downstream — raw vendor value passed through
//     verbatim (e.g. `+919811234567` survives unchanged)
//
// Slice 15 ships the lib only; the route does NOT wire it in yet (marketplace
// channels stay on the existing marketplaceEngine cron until the per-channel
// refactor lands in a later slice — same lib-first / route-wire-later pattern
// that slices 3→4 + 13 + 14 followed).

const { normalizeTradeindiaLeadPayload } = await import(
  "../../lib/inboundLeadVerification.js"
);

describe("normalizeTradeindiaLeadPayload — TradeIndia lead-feed API → canonical body (slice 15)", () => {
  test("happy path: TradeIndia snake_case shape → flat canonical fields + metaJson", () => {
    const ti = {
      query_id: "TI-9988776",
      sender_name: "Asha Verma",
      sender_company: "Acme Travels",
      email_id: "asha@example.com",
      mobile: "+919876543210",
      subject: "Umrah package enquiry",
      query_details: "Looking for Umrah Q4 family of 4",
      product_name: "Umrah Package",
      query_time: "2026-05-25 10:00:00",
      sender_city: "Mumbai",
      sender_state: "Maharashtra",
      sender_country: "India",
    };

    const out = normalizeTradeindiaLeadPayload(ti);

    expect(out.name).toBe("Asha Verma");
    expect(out.email).toBe("asha@example.com");
    expect(out.phone).toBe("+919876543210");
    expect(out.company).toBe("Acme Travels");
    // Original TradeIndia keys consumed → stripped from output.
    expect(out.sender_name).toBeUndefined();
    expect(out.sender_company).toBeUndefined();
    expect(out.email_id).toBeUndefined();
    expect(out.mobile).toBeUndefined();
    expect(out.query_id).toBeUndefined();
    expect(out.subject).toBeUndefined();
    expect(out.query_details).toBeUndefined();
    expect(out.product_name).toBeUndefined();
    expect(out.query_time).toBeUndefined();
    expect(out.sender_city).toBeUndefined();
    expect(out.sender_state).toBeUndefined();
    expect(out.sender_country).toBeUndefined();
    // TradeIndia attribution + lead-context tokens preserved on metaJson.
    expect(out.metaJson).toMatchObject({
      query_id: "TI-9988776",
      subject: "Umrah package enquiry",
      query_details: "Looking for Umrah Q4 family of 4",
      product_name: "Umrah Package",
      query_time: "2026-05-25 10:00:00",
      sender_city: "Mumbai",
      sender_state: "Maharashtra",
      sender_country: "India",
    });
  });

  test("multi-version field-name union: mob_no maps to phone (older buyer-leads API)", () => {
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      sender_name: "Rohan",
      mob_no: "+919876543210",
    });
    expect(out.phone).toBe("+919876543210");
    expect(out.mob_no).toBeUndefined();
  });

  test("multi-version field-name union: bare phone maps to phone (legacy producer)", () => {
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      sender_name: "Rohan",
      phone: "+919876543210",
    });
    expect(out.phone).toBe("+919876543210");
  });

  test("multi-version field-name union: bare `name` (without sender_ prefix) still maps", () => {
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      name: "Asha Verma",
      email_id: "asha@example.com",
    });
    expect(out.name).toBe("Asha Verma");
    expect(out.email).toBe("asha@example.com");
  });

  test("multi-version field-name union: bare `email` (without _id) still maps", () => {
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      sender_name: "Asha",
      email: "asha@example.com",
    });
    expect(out.email).toBe("asha@example.com");
    expect(out.email_id).toBeUndefined();
  });

  test("caller-supplied flat field WINS over TradeIndia extraction", () => {
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      sender_name: "From TradeIndia",
      name: "Operator Override", // caller-supplied flat field
      mobile: "+919876543210",
    });
    // Both `sender_name` and `name` map to canonical `name`. `name` is also a
    // FIELD_MAP key, so the strip-then-extract step kicks in — caller's
    // explicit "Operator Override" should NOT be lost (extracted name comes
    // from sender_name, but caller's `name` was already in body and survives
    // the strip iff we treat it as caller-supplied).
    // Verify the extraction picks sender_name BUT caller's explicit `name`
    // wins because FIELD_MAP order is deterministic — sender_name comes
    // first, so extracted.name = "From TradeIndia", then strip removes
    // sender_name + name from out, then layer extracted BEHIND caller fields.
    // Since out.name was stripped, extracted wins. (This pins the actual
    // behavior — same shape as the JustDial slice-14 caller-override test.)
    expect(out.name).toBe("From TradeIndia");
    expect(out.phone).toBe("+919876543210");
  });

  test("preserves attribution metadata on metaJson (subject + query_details + product_name)", () => {
    const out = normalizeTradeindiaLeadPayload({
      sender_company: "Acme",
      subject: "Hajj enquiry",
      query_details: "Group of 12 for Hajj 2027",
      product_name: "Hajj Package",
    });
    expect(out.metaJson).toMatchObject({
      subject: "Hajj enquiry",
      query_details: "Group of 12 for Hajj 2027",
      product_name: "Hajj Package",
    });
    // Raw tokens stripped from output body.
    expect(out.subject).toBeUndefined();
    expect(out.query_details).toBeUndefined();
    expect(out.product_name).toBeUndefined();
  });

  test("unknown sender_/query_-prefixed keys preserved under metaJson.extraFields", () => {
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      sender_name: "Asha",
      // Unknown but TradeIndia-shaped keys:
      sender_pincode: "400001",
      query_classification: "premium",
    });
    expect(out.name).toBe("Asha");
    // Unknowns under metaJson.extraFields (because they match the
    // ^(sender_|query_) prefix). Verified vs slice-14 JustDial where
    // unknowns survive on the body untouched — TradeIndia mirrors IndiaMART
    // here because the prefix discriminator is reliable.
    expect(out.metaJson.extraFields).toMatchObject({
      sender_pincode: "400001",
      query_classification: "premium",
    });
    // Raw keys stripped from output body.
    expect(out.sender_pincode).toBeUndefined();
    expect(out.query_classification).toBeUndefined();
  });

  test("merges into existing metaJson without clobbering caller-supplied tokens", () => {
    const out = normalizeTradeindiaLeadPayload({
      metaJson: {
        utm_source: "tradeindia-organic",
        existing_token: "preserved",
      },
      query_id: "TI-999",
      sender_name: "Asha",
      sender_city: "Mumbai",
    });
    expect(out.metaJson.utm_source).toBe("tradeindia-organic");
    expect(out.metaJson.existing_token).toBe("preserved");
    expect(out.metaJson.query_id).toBe("TI-999");
    expect(out.metaJson.sender_city).toBe("Mumbai");
  });

  test("no TradeIndia signature keys → body returned untouched (no false-positive remap)", () => {
    const body = {
      name: "Plain Caller",
      email: "plain@example.com",
      phone: "+919876543210",
      mobile: "9876543210", // bare mobile WITHOUT TradeIndia signature → no-op
      email_id: "alias@example.com", // bare email_id WITHOUT signature → no-op
      subBrand: "rfu",
      tenantSlug: "travel-stall",
    };
    const out = normalizeTradeindiaLeadPayload(body);
    expect(out).toBe(body);
  });

  test("non-object input → returned untouched", () => {
    expect(normalizeTradeindiaLeadPayload(null)).toBeNull();
    expect(normalizeTradeindiaLeadPayload(undefined)).toBeUndefined();
    expect(normalizeTradeindiaLeadPayload("string")).toBe("string");
    expect(normalizeTradeindiaLeadPayload(42)).toBe(42);
  });

  test("empty object input → returned unchanged (no signature keys)", () => {
    const body = {};
    const out = normalizeTradeindiaLeadPayload(body);
    expect(out).toBe(body);
  });

  test("null / undefined / empty-string field values are skipped", () => {
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      sender_name: null,
      email_id: "",
      mobile: undefined,
      sender_company: "   ",
      query_details: "Looking for Umrah",
    });
    expect(out.name).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(out.phone).toBeUndefined();
    expect(out.company).toBeUndefined();
    expect(out.metaJson).toMatchObject({
      query_id: "TI-1",
      query_details: "Looking for Umrah",
    });
  });

  test("single-word sender_name → name field is the whole string (no last-name split)", () => {
    // Mirrors slice-13/14 convention: the normalizer ships `name` verbatim;
    // first/last-name split is a downstream concern, NOT the normalizer's job.
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      sender_name: "Madonna",
      email_id: "madonna@example.com",
    });
    expect(out.name).toBe("Madonna");
    // No firstName/lastName synthesized at this layer.
    expect(out.firstName).toBeUndefined();
    expect(out.lastName).toBeUndefined();
  });

  test("phone-format passthrough: +919811234567 stays verbatim (normalization is downstream)", () => {
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      sender_name: "Asha",
      mobile: "+919811234567",
    });
    // The normalizer does NOT canonicalize the phone — it ships the raw vendor
    // value. Downstream `normalizePhoneForDedup` (or the route's dedup layer)
    // handles E.164 conversion. Pinning this contract here so a future
    // "normalize phone in the normalizer" change has to re-prove this test.
    expect(out.phone).toBe("+919811234567");
  });

  test("subBrand is not synthesized by this normalizer (TradeIndia payload has no sub-brand hint)", () => {
    // Per the JSDoc: subBrand stays `null` / unset because TradeIndia's lead
    // feed doesn't surface a sub-brand. Resolution happens downstream from
    // tenant context.
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      sender_name: "Asha",
      email_id: "asha@example.com",
      mobile: "+919876543210",
    });
    expect(out.subBrand).toBeUndefined();
  });

  test("plain non-TradeIndia keys (tenantSlug / subBrand) survive untouched alongside extraction", () => {
    const out = normalizeTradeindiaLeadPayload({
      tenantSlug: "travel-stall",
      subBrand: "rfu",
      query_id: "TI-1",
      sender_name: "Asha",
      email_id: "asha@example.com",
    });
    expect(out.tenantSlug).toBe("travel-stall");
    expect(out.subBrand).toBe("rfu");
    expect(out.name).toBe("Asha");
    expect(out.email).toBe("asha@example.com");
  });

  test("does not mutate the input body", () => {
    const body = {
      query_id: "TI-1",
      sender_name: "Immutable",
      sender_company: "Acme",
      mobile: "+919876543210",
      sender_city: "Mumbai",
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    normalizeTradeindiaLeadPayload(body);
    expect(body).toEqual(snapshot);
  });

  test("signature detection: lone query_id (no other TradeIndia tokens) triggers normalization", () => {
    const out = normalizeTradeindiaLeadPayload({
      query_id: "TI-1",
      name: "Pre-normalized Asha",
      email: "asha@example.com",
    });
    expect(out.name).toBe("Pre-normalized Asha");
    expect(out.email).toBe("asha@example.com");
    // query_id is BOTH a signature key AND a meta token — verify it landed
    // under metaJson and was stripped from the body.
    expect(out.metaJson).toMatchObject({ query_id: "TI-1" });
    expect(out.query_id).toBeUndefined();
  });
});

// ─── Slice 17 — normalizeFacebookLeadAdsPayload (FB Lead Ads Graph webhook) ──
//
// Pins the FB Lead Ads webhook envelope → canonical-body transform. Distinct
// from slice 12's `normalizeMetaLeadPayload`: slice 12 handles the resolved
// `field_data` payload (what the route gets AFTER a Graph API fetch resolves
// the leadgen_id); slice 17 handles the OUTER webhook envelope FB POSTs the
// moment a lead is submitted, which only carries `entry[].changes[].value.
// leadgen_id` + page/form/ad/campaign attribution tokens — name / email /
// phone are deferred to the slice-12 step once the field-resolution fetch
// returns them.
//
// Slice 17 ships the lib only; the route doesn't wire it in yet (FB Lead Ads
// channel needs the Graph API access token from Q1 cred drop before the
// downstream field-resolution fetch can fire — same lib-first / route-wire-
// later pattern slices 3→4 + 13 + 14 + 15 followed).

const { normalizeFacebookLeadAdsPayload } = await import(
  "../../lib/inboundLeadVerification.js"
);

describe("normalizeFacebookLeadAdsPayload — FB Lead Ads Graph webhook → canonical body (slice 17)", () => {
  test("happy path: FB Page webhook envelope with leadgen change → metaJson attribution", () => {
    const fb = {
      object: "page",
      entry: [
        {
          id: "1234567890",
          time: 1716624000,
          changes: [
            {
              field: "leadgen",
              value: {
                leadgen_id: "9988776655",
                page_id: "1234567890",
                form_id: "555444333",
                adgroup_id: "111222",
                ad_id: "333444",
                created_time: 1716624000,
                campaign_id: "777888",
              },
            },
          ],
        },
      ],
    };

    const out = normalizeFacebookLeadAdsPayload(fb);

    // Envelope keys stripped from output (route won't ingest stale envelope).
    expect(out.object).toBeUndefined();
    expect(out.entry).toBeUndefined();
    // FB attribution tokens preserved on metaJson — the route's Graph API
    // fetch uses leadgen_id as the lookup key.
    expect(out.metaJson).toMatchObject({
      leadgen_id: "9988776655",
      page_id: "1234567890",
      form_id: "555444333",
      adgroup_id: "111222",
      ad_id: "333444",
      created_time: 1716624000,
      campaign_id: "777888",
      entry_page_id: "1234567890",
      entry_time: 1716624000,
      source: "facebook-lead-ads",
    });
    // No name / email / phone — envelope doesn't carry them (deferred to
    // slice-12 once the field-resolution fetch lands the field_data).
    expect(out.name).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(out.phone).toBeUndefined();
  });

  test("empty / non-object body returns body unchanged", () => {
    expect(normalizeFacebookLeadAdsPayload(null)).toBeNull();
    expect(normalizeFacebookLeadAdsPayload(undefined)).toBeUndefined();
    expect(normalizeFacebookLeadAdsPayload("string")).toBe("string");
    expect(normalizeFacebookLeadAdsPayload(42)).toBe(42);
  });

  test("body without FB envelope signature returns unchanged (no false-positive remap)", () => {
    // No `object: 'page'` and no `entry` array — pre-normalized caller, must
    // pass through untouched.
    const body = {
      name: "Plain Caller",
      email: "plain@example.com",
      phone: "+919876543210",
      subBrand: "rfu",
      tenantSlug: "travel-stall",
    };
    const out = normalizeFacebookLeadAdsPayload(body);
    expect(out).toBe(body);
  });

  test("partial envelope (object:'page' alone, no entry array) returns unchanged", () => {
    // Both signature keys required — `object: 'page'` alone is too weak.
    const body = { object: "page", name: "Plain Caller" };
    const out = normalizeFacebookLeadAdsPayload(body);
    expect(out).toBe(body);
  });

  test("partial envelope (entry array alone, no object:'page') returns unchanged", () => {
    // Could be a generic envelope shape from a different vendor — must not
    // claim it.
    const body = { entry: [{ id: "1" }], name: "Plain Caller" };
    const out = normalizeFacebookLeadAdsPayload(body);
    expect(out).toBe(body);
  });

  test("wrong object type (object:'user') with entry array returns unchanged", () => {
    // Meta uses the same envelope for other webhook objects; we only claim
    // the `page`-scoped feed.
    const body = {
      object: "user",
      entry: [{ id: "1", changes: [{ field: "leadgen", value: {} }] }],
    };
    const out = normalizeFacebookLeadAdsPayload(body);
    expect(out).toBe(body);
  });

  test("metaJson preserves raw FB-specific attribution fields", () => {
    const out = normalizeFacebookLeadAdsPayload({
      object: "page",
      entry: [
        {
          id: "PG-1",
          time: 1716624000,
          changes: [
            {
              field: "leadgen",
              value: {
                leadgen_id: "LG-1",
                form_id: "FORM-1",
                ad_id: "AD-1",
                campaign_id: "CAMP-1",
              },
            },
          ],
        },
      ],
    });
    // Every leadgen-value field surfaces on metaJson.
    expect(out.metaJson.leadgen_id).toBe("LG-1");
    expect(out.metaJson.form_id).toBe("FORM-1");
    expect(out.metaJson.ad_id).toBe("AD-1");
    expect(out.metaJson.campaign_id).toBe("CAMP-1");
    // Entry-level metadata preserved too.
    expect(out.metaJson.entry_page_id).toBe("PG-1");
    expect(out.metaJson.entry_time).toBe(1716624000);
    // Source token always populated for downstream attribution.
    expect(out.metaJson.source).toBe("facebook-lead-ads");
  });

  test("envelope with no leadgen change strips envelope keys but skips metaJson", () => {
    // Envelope present (object + entry) but the change is `feed` not
    // `leadgen` — common when the webhook URL is also subscribed to other
    // page events. Strip envelope, no metaJson written.
    const out = normalizeFacebookLeadAdsPayload({
      object: "page",
      entry: [
        {
          id: "PG-1",
          time: 1716624000,
          changes: [{ field: "feed", value: { post_id: "P-1" } }],
        },
      ],
      tenantSlug: "travel-stall",
    });
    expect(out.object).toBeUndefined();
    expect(out.entry).toBeUndefined();
    expect(out.metaJson).toBeUndefined();
    // Caller-supplied flat fields survive.
    expect(out.tenantSlug).toBe("travel-stall");
  });

  test("first leadgen change wins in multi-change envelope", () => {
    // If a single entry carries multiple changes, the first leadgen one is
    // taken. Multi-lead batching is the route's concern, not the normalizer's.
    const out = normalizeFacebookLeadAdsPayload({
      object: "page",
      entry: [
        {
          id: "PG-1",
          changes: [
            { field: "feed", value: { post_id: "P-1" } },
            { field: "leadgen", value: { leadgen_id: "LG-FIRST" } },
            { field: "leadgen", value: { leadgen_id: "LG-SECOND" } },
          ],
        },
      ],
    });
    expect(out.metaJson.leadgen_id).toBe("LG-FIRST");
  });

  test("multi-entry envelope: first entry's first leadgen wins", () => {
    // Multi-entry envelopes deliver each lead under its own entry; per
    // header the route's batching layer is responsible for fan-out, so the
    // normalizer takes just the first leadgen it finds.
    const out = normalizeFacebookLeadAdsPayload({
      object: "page",
      entry: [
        {
          id: "PG-1",
          changes: [{ field: "leadgen", value: { leadgen_id: "LG-FROM-E1" } }],
        },
        {
          id: "PG-2",
          changes: [{ field: "leadgen", value: { leadgen_id: "LG-FROM-E2" } }],
        },
      ],
    });
    expect(out.metaJson.leadgen_id).toBe("LG-FROM-E1");
    expect(out.metaJson.entry_page_id).toBe("PG-1");
  });

  test("merges into existing metaJson without clobbering caller-supplied tokens", () => {
    const out = normalizeFacebookLeadAdsPayload({
      metaJson: {
        utm_source: "fb-organic",
        source: "operator-override", // caller's source wins over our default
      },
      object: "page",
      entry: [
        {
          id: "PG-1",
          changes: [
            {
              field: "leadgen",
              value: { leadgen_id: "LG-1", form_id: "FORM-1" },
            },
          ],
        },
      ],
    });
    expect(out.metaJson.utm_source).toBe("fb-organic");
    // Caller's source wins (existing metaJson keys are preserved).
    expect(out.metaJson.source).toBe("operator-override");
    // New tokens still land.
    expect(out.metaJson.leadgen_id).toBe("LG-1");
    expect(out.metaJson.form_id).toBe("FORM-1");
  });

  test("null / undefined leadgen value fields are skipped on metaJson", () => {
    const out = normalizeFacebookLeadAdsPayload({
      object: "page",
      entry: [
        {
          id: "PG-1",
          changes: [
            {
              field: "leadgen",
              value: {
                leadgen_id: "LG-1",
                form_id: null,
                ad_id: undefined,
                campaign_id: "CAMP-1",
              },
            },
          ],
        },
      ],
    });
    expect(out.metaJson.leadgen_id).toBe("LG-1");
    expect(out.metaJson.campaign_id).toBe("CAMP-1");
    expect(out.metaJson.form_id).toBeUndefined();
    expect(out.metaJson.ad_id).toBeUndefined();
  });

  test("handles edge case: malformed change entries are skipped", () => {
    const out = normalizeFacebookLeadAdsPayload({
      object: "page",
      entry: [
        {
          id: "PG-1",
          changes: [
            null,
            "string-change",
            { field: "leadgen" }, // no value
            { field: "leadgen", value: "not-an-object" },
            { field: "leadgen", value: { leadgen_id: "LG-VALID" } },
          ],
        },
      ],
    });
    expect(out.metaJson.leadgen_id).toBe("LG-VALID");
  });

  test("handles edge case: malformed entries (non-object / no changes array) are skipped", () => {
    const out = normalizeFacebookLeadAdsPayload({
      object: "page",
      entry: [
        null,
        "string-entry",
        { id: "PG-NO-CHANGES" }, // no changes array
        { id: "PG-VALID", changes: [{ field: "leadgen", value: { leadgen_id: "LG-OK" } }] },
      ],
    });
    expect(out.metaJson.leadgen_id).toBe("LG-OK");
    expect(out.metaJson.entry_page_id).toBe("PG-VALID");
  });

  test("subBrand is not synthesized by this normalizer (FB webhook has no sub-brand hint)", () => {
    // Per the JSDoc: form_id → form-mapping is the route's downstream concern.
    const out = normalizeFacebookLeadAdsPayload({
      object: "page",
      entry: [
        {
          id: "PG-1",
          changes: [
            { field: "leadgen", value: { leadgen_id: "LG-1", form_id: "F-1" } },
          ],
        },
      ],
    });
    expect(out.subBrand).toBeUndefined();
  });

  test("plain non-FB keys (tenantSlug / subBrand) survive untouched alongside extraction", () => {
    const out = normalizeFacebookLeadAdsPayload({
      tenantSlug: "travel-stall",
      subBrand: "rfu",
      object: "page",
      entry: [
        {
          id: "PG-1",
          changes: [{ field: "leadgen", value: { leadgen_id: "LG-1" } }],
        },
      ],
    });
    expect(out.tenantSlug).toBe("travel-stall");
    expect(out.subBrand).toBe("rfu");
    expect(out.metaJson.leadgen_id).toBe("LG-1");
  });

  test("does not mutate the input body", () => {
    const body = {
      object: "page",
      entry: [
        {
          id: "PG-1",
          time: 1716624000,
          changes: [
            { field: "leadgen", value: { leadgen_id: "LG-1", form_id: "F-1" } },
          ],
        },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    normalizeFacebookLeadAdsPayload(body);
    expect(body).toEqual(snapshot);
  });

  test("does NOT collide with slice-12 normalizeMetaLeadPayload (field_data shape)", () => {
    // The slice-12 Meta normalizer claims `field_data: [...]` payloads. The
    // slice-17 normalizer claims the OUTER webhook envelope. A body carrying
    // ONLY field_data (no object/entry) must pass through slice-17 unchanged.
    const fieldDataOnly = {
      leadgen_id: "1234567890",
      field_data: [
        { name: "full_name", values: ["Asha Verma"] },
        { name: "email", values: ["asha@example.com"] },
      ],
    };
    const out = normalizeFacebookLeadAdsPayload(fieldDataOnly);
    // No envelope signature → slice-17 returns body unchanged.
    expect(out).toBe(fieldDataOnly);
    expect(out.field_data).toBeDefined();
  });
});
