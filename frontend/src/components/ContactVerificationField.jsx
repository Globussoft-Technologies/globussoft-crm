import { useId, useState } from "react";

/**
 * ContactVerificationField — email OTP verification.
 *
 * Email-only: there is no phone-number login, so the phone tab was
 * removed. The parent receives a short-lived verificationToken via
 * onVerifiedChange(). The parent also receives the verified contact
 * value via onContactChange({ type: 'email', value }).
 *
 * Styling mirrors EmailOtpField — pass inputClassName / inputStyle / labelStyle.
 */
export default function ContactVerificationField({
  purpose, // "signup" | "customer-register"
  onVerifiedChange, // (token | null) => void
  onContactChange, // ({ type, value } | null) => void — optional
  inputClassName,
  inputStyle,
  labelStyle,
  required = true,
  disabled = false,
}) {
  const [email, setEmail] = useState("");
  const [emailRequested, setEmailRequested] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [emailVerified, setEmailVerified] = useState(false);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type: 'error'|'info'|'success', text }

  const emailInputId = useId();
  const otpInputId = useId();

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((email || "").trim());

  const notify = (token, contactValue) => {
    if (onVerifiedChange) onVerifiedChange(token);
    if (onContactChange) onContactChange(token ? { type: "email", value: contactValue } : null);
    setEmailVerified(!!token);
  };

  // ── Email flow ────────────────────────────────────────────────────────────

  const requestEmailOtp = async () => {
    if (!emailOk) { setMsg({ type: "error", text: "Enter a valid email address" }); return; }
    setBusy(true); setMsg(null);
    try {
      // Pre-check: already-registered emails are told to sign in BEFORE any
      // code is sent, so existing users never go through OTP verification.
      // Fail-open: if the check itself fails, fall through to the OTP request.
      try {
        const c = await fetch("/api/auth/check-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
        const cd = await c.json().catch(() => ({}));
        if (cd.exists) {
          setMsg({ type: "error", text: "This email is already registered. Please sign in instead." });
          return;
        }
      } catch { /* fall through to OTP request */ }
      const r = await fetch("/api/auth/email-otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), purpose }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ type: "error", text: d.error || "Couldn't send the code — try again" }); return; }
      setEmailRequested(true);
      setMsg({ type: "info", text: `We've emailed a 6-digit code to ${email.trim()}.` });
    } catch { setMsg({ type: "error", text: "Network error — please try again" }); }
    finally { setBusy(false); }
  };

  const verifyEmailOtp = async () => {
    if (!emailCode.trim()) { setMsg({ type: "error", text: "Enter the 6-digit code" }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/auth/email-otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), purpose, code: emailCode.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.verificationToken) { setMsg({ type: "error", text: d.error || "Incorrect code — try again" }); return; }
      setMsg({ type: "success", text: "Email verified ✓" });
      notify(d.verificationToken, email.trim());
    } catch { setMsg({ type: "error", text: "Network error — please try again" }); }
    finally { setBusy(false); }
  };

  const handleEmailChange = (e) => {
    setEmail(e.target.value);
    if (emailVerified || emailRequested) {
      setEmailVerified(false); setEmailRequested(false); setEmailCode(""); setMsg(null);
      notify(null, "");
    }
  };

  // ── Styles ────────────────────────────────────────────────────────────────

  const labelSt = labelStyle || {
    display: "block", marginBottom: "0.5rem", fontSize: "0.875rem",
    color: "var(--text-secondary)",
  };
  const actionBtn = {
    padding: "0 0.9rem", borderRadius: 8, border: "none",
    background: "var(--primary-color, var(--accent-color, #6366f1))",
    color: "#fff", fontWeight: 600, fontSize: "0.8rem",
    cursor: busy ? "wait" : "pointer", whiteSpace: "nowrap",
  };
  return (
    <div>
          <label htmlFor={emailInputId} style={labelSt}>Email Address</label>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <input
              id={emailInputId}
              type="email"
              data-testid="otp-email"
              className={inputClassName}
              style={inputStyle ? { ...inputStyle, flex: 1 } : { flex: 1 }}
              placeholder="name@company.com"
              value={email}
              onChange={handleEmailChange}
              required={required}
              disabled={disabled || emailVerified}
              autoComplete="email"
            />
            {emailVerified ? (
              <span data-testid="otp-verified" style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "0 0.7rem", color: "#16a34a", fontSize: "0.8rem",
                fontWeight: 600, whiteSpace: "nowrap",
              }}>✓ Verified</span>
            ) : (
              <button type="button" data-testid="otp-validate" onClick={requestEmailOtp}
                disabled={busy || disabled || !emailOk}
                style={{ ...actionBtn, opacity: busy || !emailOk ? 0.6 : 1 }}
              >
                {busy && !emailRequested ? "Sending…" : emailRequested ? "Resend" : "Validate"}
              </button>
            )}
          </div>
          {emailRequested && !emailVerified && (
            <div data-testid="otp-box" style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                id={otpInputId}
                type="text"
                inputMode="numeric"
                data-testid="otp-code"
                className={inputClassName}
                style={inputStyle ? { ...inputStyle, flex: 1 } : { flex: 1 }}
                placeholder="Enter 6-digit code"
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value)}
                maxLength={6}
                autoComplete="one-time-code"
              />
              <button type="button" data-testid="otp-verify" onClick={verifyEmailOtp}
                disabled={busy}
                style={{ ...actionBtn, opacity: busy ? 0.6 : 1 }}
              >
                {busy ? "Verifying…" : "Verify"}
              </button>
            </div>
          )}

      {msg && (
        <div data-testid="otp-msg" style={{
          marginTop: 6, fontSize: "0.78rem",
          color: msg.type === "error"
            ? "var(--danger-color, #ef4444)"
            : msg.type === "success" ? "#16a34a"
            : "var(--text-secondary)",
        }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
