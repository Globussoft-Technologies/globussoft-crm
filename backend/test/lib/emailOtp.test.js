// Unit tests for backend/lib/emailOtp.js — code generation, email validation,
// and the verification-token issue/check roundtrip used to gate self-service
// registration. sendOtpEmail's no-key branch is covered; the SendGrid network
// path isn't (no live key in tests).

const emailOtp = require("../../lib/emailOtp");

describe("emailOtp.generateOtpCode", () => {
  it("returns a zero-padded 6-digit numeric string", () => {
    for (let i = 0; i < 50; i++) {
      const code = emailOtp.generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe("emailOtp.isValidEmail", () => {
  it("accepts well-formed addresses, rejects junk", () => {
    expect(emailOtp.isValidEmail("a@b.com")).toBe(true);
    expect(emailOtp.isValidEmail("  Person@Example.co.in  ")).toBe(true);
    expect(emailOtp.isValidEmail("nope")).toBe(false);
    expect(emailOtp.isValidEmail("no@domain")).toBe(false);
    expect(emailOtp.isValidEmail("")).toBe(false);
    expect(emailOtp.isValidEmail(null)).toBe(false);
  });
});

describe("emailOtp verification token", () => {
  it("issues a token that checks out for the same (email, purpose) — case/space insensitive on email", () => {
    const token = emailOtp.issueVerificationToken("Owner@Acme.com", "signup");
    expect(emailOtp.checkVerificationToken(token, "owner@acme.com", "signup")).toBe(true);
    expect(emailOtp.checkVerificationToken(token, "  OWNER@ACME.COM ", "signup")).toBe(true);
  });

  it("rejects a wrong purpose, wrong email, or a tampered/garbage token", () => {
    const token = emailOtp.issueVerificationToken("owner@acme.com", "signup");
    expect(emailOtp.checkVerificationToken(token, "owner@acme.com", "customer-register")).toBe(false);
    expect(emailOtp.checkVerificationToken(token, "someone-else@acme.com", "signup")).toBe(false);
    expect(emailOtp.checkVerificationToken("not-a-jwt", "owner@acme.com", "signup")).toBe(false);
    expect(emailOtp.checkVerificationToken(null, "owner@acme.com", "signup")).toBe(false);
    expect(emailOtp.checkVerificationToken("", "owner@acme.com", "signup")).toBe(false);
  });
});

describe("emailOtp.sendOtpEmail", () => {
  it("returns { sent: false } (no throw) when SENDGRID_API_KEY is unset", async () => {
    const saved = process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_KEY;
    try {
      const r = await emailOtp.sendOtpEmail("x@y.com", "123456", "signup");
      expect(r.sent).toBe(false);
      expect(r.reason).toBe("no_api_key");
    } finally {
      if (saved !== undefined) process.env.SENDGRID_API_KEY = saved;
    }
  });
});

// Route-layer enforcement (closes the "POST without a token skips OTP" bypass).
// Opt-in only — default OFF everywhere (so it can't silently 403 GetStarted.jsx
// signups / Settings team-invites that share /auth/register). REQUIRE_EMAIL_OTP
// is the sole control; nothing else reads it, so mutating it here can't bleed.
describe("emailOtp.isRegistrationOtpEnforced", () => {
  const savedReq = process.env.REQUIRE_EMAIL_OTP;
  afterEach(() => {
    if (savedReq === undefined) delete process.env.REQUIRE_EMAIL_OTP; else process.env.REQUIRE_EMAIL_OTP = savedReq;
  });

  it("is OFF by default (opt-in); REQUIRE_EMAIL_OTP=1 turns it on, =0 keeps it off", () => {
    delete process.env.REQUIRE_EMAIL_OTP;
    expect(emailOtp.isRegistrationOtpEnforced()).toBe(false);
    process.env.REQUIRE_EMAIL_OTP = "1";
    expect(emailOtp.isRegistrationOtpEnforced()).toBe(true);
    process.env.REQUIRE_EMAIL_OTP = "0";
    expect(emailOtp.isRegistrationOtpEnforced()).toBe(false);
  });
});

describe("emailOtp.enforceRegistrationOtp", () => {
  const savedReq = process.env.REQUIRE_EMAIL_OTP;
  afterEach(() => {
    if (savedReq === undefined) delete process.env.REQUIRE_EMAIL_OTP; else process.env.REQUIRE_EMAIL_OTP = savedReq;
  });

  it("ENFORCED: absent token → 403 EMAIL_VERIFICATION_REQUIRED (the bypass, now closed)", () => {
    process.env.REQUIRE_EMAIL_OTP = "1";
    const r = emailOtp.enforceRegistrationOtp(undefined, "a@b.com", "signup");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.code).toBe("EMAIL_VERIFICATION_REQUIRED");
  });

  it("ENFORCED: valid token → ok with emailVerifiedAt; invalid token → 403 EMAIL_NOT_VERIFIED", () => {
    process.env.REQUIRE_EMAIL_OTP = "1";
    const token = emailOtp.issueVerificationToken("a@b.com", "signup");
    const ok = emailOtp.enforceRegistrationOtp(token, "a@b.com", "signup");
    expect(ok.ok).toBe(true);
    expect(ok.emailVerifiedAt instanceof Date).toBe(true);

    const bad = emailOtp.enforceRegistrationOtp("garbage", "a@b.com", "signup");
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("RELAXED: absent token → ok with emailVerifiedAt null (backward-compatible)", () => {
    process.env.REQUIRE_EMAIL_OTP = "0";
    const r = emailOtp.enforceRegistrationOtp(undefined, "a@b.com", "signup");
    expect(r.ok).toBe(true);
    expect(r.emailVerifiedAt).toBe(null);
  });

  it("RELAXED: a provided token is STILL validated (invalid → 403 even when relaxed)", () => {
    process.env.REQUIRE_EMAIL_OTP = "0";
    const bad = emailOtp.enforceRegistrationOtp("garbage", "a@b.com", "signup");
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("EMAIL_NOT_VERIFIED");
  });
});
