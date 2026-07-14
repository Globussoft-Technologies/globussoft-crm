import { useId, useState } from "react";

/**
 * ContactVerificationField — email OR phone OTP verification, user's choice.
 *
 * The user toggles between "Email" and "Phone" tabs. Whichever they verify,
 * the parent receives a short-lived verificationToken via onVerifiedChange().
 * The parent also receives the verified contact value (email or phone) via
 * onContactChange({ type: 'email'|'phone', value }).
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
  const [tab, setTab] = useState("email"); // "email" | "phone"

  // Email state
  const [email, setEmail] = useState("");
  const [emailRequested, setEmailRequested] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [emailVerified, setEmailVerified] = useState(false);

  // Phone state
  const [phone, setPhone] = useState("");
  const [phoneRequested, setPhoneRequested] = useState(false);
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(false);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type: 'error'|'info'|'success', text }

  const emailInputId = useId();
  const phoneInputId = useId();
  const otpInputId = useId();

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((email || "").trim());
  const phoneOk = /^(\+?\d{7,15}|\d{10})$/.test((phone || "").replace(/\s/g, ""));

  const notify = (parent, token, contactType, contactValue) => {
    if (onVerifiedChange) onVerifiedChange(token);
    if (onContactChange) onContactChange(token ? { type: contactType, value: contactValue } : null);
    if (parent === "email") {
      setEmailVerified(!!token);
    } else {
      setPhoneVerified(!!token);
    }
  };

  const switchTab = (next) => {
    if (next === tab) return;
    setTab(next);
    setMsg(null);
    // Reset the OTHER tab's verification state so parent gets null when switching
    if (emailVerified || phoneVerified) {
      if (onVerifiedChange) onVerifiedChange(null);
      if (onContactChange) onContactChange(null);
      setEmailVerified(false);
      setPhoneVerified(false);
      setEmailRequested(false);
      setPhoneRequested(false);
      setEmailCode("");
      setPhoneCode("");
    }
  };

  // ── Email flow ────────────────────────────────────────────────────────────

  const requestEmailOtp = async () => {
    if (!emailOk) { setMsg({ type: "error", text: "Enter a valid email address" }); return; }
    setBusy(true); setMsg(null);
    try {
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
      notify("email", d.verificationToken, "email", email.trim());
    } catch { setMsg({ type: "error", text: "Network error — please try again" }); }
    finally { setBusy(false); }
  };

  const handleEmailChange = (e) => {
    setEmail(e.target.value);
    if (emailVerified || emailRequested) {
      setEmailVerified(false); setEmailRequested(false); setEmailCode(""); setMsg(null);
      notify("email", null, "email", "");
    }
  };

  // ── Phone flow ────────────────────────────────────────────────────────────

  const requestPhoneOtp = async () => {
    if (!phoneOk) { setMsg({ type: "error", text: "Enter a valid phone number (10 digits or with country code)" }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/auth/phone-otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.replace(/\s/g, ""), purpose }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ type: "error", text: d.error || "Couldn't send the code — try again" }); return; }
      setPhoneRequested(true);
      if (d.sent) {
        setMsg({ type: "info", text: `We've sent a 6-digit code to ${phone}.` });
      } else {
        setMsg({ type: "info", text: "SMS is not configured yet — contact support or use email verification instead." });
      }
    } catch { setMsg({ type: "error", text: "Network error — please try again" }); }
    finally { setBusy(false); }
  };

  const verifyPhoneOtp = async () => {
    if (!phoneCode.trim()) { setMsg({ type: "error", text: "Enter the 6-digit code" }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/auth/phone-otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.replace(/\s/g, ""), purpose, code: phoneCode.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.verificationToken) { setMsg({ type: "error", text: d.error || "Incorrect code — try again" }); return; }
      setMsg({ type: "success", text: "Phone verified ✓" });
      notify("phone", d.verificationToken, "phone", phone.replace(/\s/g, ""));
    } catch { setMsg({ type: "error", text: "Network error — please try again" }); }
    finally { setBusy(false); }
  };

  const handlePhoneChange = (e) => {
    setPhone(e.target.value);
    if (phoneVerified || phoneRequested) {
      setPhoneVerified(false); setPhoneRequested(false); setPhoneCode(""); setMsg(null);
      notify("phone", null, "phone", "");
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
  const tabBase = {
    flex: 1, padding: "0.4rem 0.75rem", border: "1px solid var(--border-color, #e5e7eb)",
    borderRadius: 6, cursor: "pointer", fontSize: "0.8rem", fontWeight: 600,
    background: "transparent", transition: "all 0.15s",
  };
  const tabActive = {
    ...tabBase,
    background: "var(--primary-color, var(--accent-color, #6366f1))",
    color: "#fff", borderColor: "var(--primary-color, var(--accent-color, #6366f1))",
  };

  const isEmailTab = tab === "email";
  const verified = isEmailTab ? emailVerified : phoneVerified;
  const requested = isEmailTab ? emailRequested : phoneRequested;

  return (
    <div>
      {/* Tab toggle */}
      <div style={{ display: "flex", gap: 6, marginBottom: "0.75rem" }}>
        <button type="button" onClick={() => switchTab("email")}
          style={isEmailTab ? tabActive : tabBase}
          disabled={disabled}
        >
          Email
        </button>
        <button type="button" onClick={() => switchTab("phone")}
          style={!isEmailTab ? tabActive : tabBase}
          disabled={disabled}
        >
          Phone
        </button>
      </div>

      {/* Email tab */}
      {isEmailTab && (
        <>
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
              required={required && isEmailTab}
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
        </>
      )}

      {/* Phone tab */}
      {!isEmailTab && (
        <>
          <label htmlFor={phoneInputId} style={labelSt}>Phone Number</label>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <input
              id={phoneInputId}
              type="tel"
              data-testid="otp-phone"
              className={inputClassName}
              style={inputStyle ? { ...inputStyle, flex: 1 } : { flex: 1 }}
              placeholder="+91 98765 43210"
              value={phone}
              onChange={handlePhoneChange}
              required={required && !isEmailTab}
              disabled={disabled || phoneVerified}
              autoComplete="tel"
            />
            {phoneVerified ? (
              <span data-testid="otp-phone-verified" style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "0 0.7rem", color: "#16a34a", fontSize: "0.8rem",
                fontWeight: 600, whiteSpace: "nowrap",
              }}>✓ Verified</span>
            ) : (
              <button type="button" data-testid="otp-phone-validate" onClick={requestPhoneOtp}
                disabled={busy || disabled || !phoneOk}
                style={{ ...actionBtn, opacity: busy || !phoneOk ? 0.6 : 1 }}
              >
                {busy && !phoneRequested ? "Sending…" : phoneRequested ? "Resend" : "Send Code"}
              </button>
            )}
          </div>
          {phoneRequested && !phoneVerified && (
            <div data-testid="otp-phone-box" style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                type="text"
                inputMode="numeric"
                data-testid="otp-phone-code"
                className={inputClassName}
                style={inputStyle ? { ...inputStyle, flex: 1 } : { flex: 1 }}
                placeholder="Enter 6-digit code"
                value={phoneCode}
                onChange={(e) => setPhoneCode(e.target.value)}
                maxLength={6}
                autoComplete="one-time-code"
              />
              <button type="button" data-testid="otp-phone-verify" onClick={verifyPhoneOtp}
                disabled={busy}
                style={{ ...actionBtn, opacity: busy ? 0.6 : 1 }}
              >
                {busy ? "Verifying…" : "Verify"}
              </button>
            </div>
          )}
        </>
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
