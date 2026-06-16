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
