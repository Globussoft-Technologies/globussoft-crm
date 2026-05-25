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
