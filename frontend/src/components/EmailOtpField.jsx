import { useState } from "react";

/**
 * EmailOtpField — email input + "Validate" → OTP entry → "Verify" flow used to
 * gate self-service registration (org signup + customer registration).
 *
 * Flow: user types email → clicks Validate → backend emails a 6-digit code
 * (SendGrid) → an OTP box appears → user enters the code → Verify → on success
 * the parent receives a short-lived verificationToken via onVerifiedChange().
 * Editing the email after verifying resets verification (onVerifiedChange(null))
 * so the parent can keep its "Create" button disabled until re-verified.
 *
 * Styling is form-agnostic: pass `inputClassName` (class-based forms) and/or
 * `inputStyle` (inline-styled forms).
 */
export default function EmailOtpField({
  value,
  onChange,
  purpose, // "signup" | "customer-register"
  onVerifiedChange, // (token | null) => void
  label = "Email Address",
  placeholder = "name@company.com",
  inputClassName,
  inputStyle,
  labelStyle,
  required = true,
  disabled = false,
}) {
  const [requested, setRequested] = useState(false);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type: 'error' | 'info' | 'success', text }

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((value || "").trim());

  const resetVerification = () => {
    if (verified || requested) {
      setVerified(false);
      setRequested(false);
      setCode("");
      setMsg(null);
      if (onVerifiedChange) onVerifiedChange(null);
    }
  };

  const handleEmailChange = (e) => {
    onChange(e);
    resetVerification();
  };

  const request = async () => {
    if (!emailOk) {
      setMsg({ type: "error", text: "Enter a valid email first" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/auth/email-otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value.trim(), purpose }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ type: "error", text: d.error || "Couldn't send the code — try again" });
        return;
      }
      setRequested(true);
      setMsg({
        type: "info",
        text: d.devCode
          ? `Code sent. Dev code: ${d.devCode}`
          : `We've emailed a 6-digit code to ${value.trim()}.`,
      });
    } catch {
      setMsg({ type: "error", text: "Network error — please try again" });
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!code.trim()) {
      setMsg({ type: "error", text: "Enter the 6-digit code" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/auth/email-otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value.trim(), purpose, code: code.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.verificationToken) {
        setMsg({ type: "error", text: d.error || "Incorrect code" });
        return;
      }
      setVerified(true);
      setMsg({ type: "success", text: "Email verified" });
      if (onVerifiedChange) onVerifiedChange(d.verificationToken);
    } catch {
      setMsg({ type: "error", text: "Network error — please try again" });
    } finally {
      setBusy(false);
    }
  };

  const actionBtn = {
    padding: "0 0.9rem",
    borderRadius: 8,
    border: "none",
    background: "var(--primary-color, var(--accent-color, #6366f1))",
    color: "#fff",
    fontWeight: 600,
    fontSize: "0.8rem",
    cursor: busy ? "wait" : "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div>
      {label && (
        <label
          style={
            labelStyle || {
              display: "block",
              marginBottom: "0.5rem",
              fontSize: "0.875rem",
              color: "var(--text-secondary)",
            }
          }
        >
          {label}
        </label>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <input
          type="email"
          data-testid="otp-email"
          className={inputClassName}
          style={inputStyle ? { ...inputStyle, flex: 1 } : { flex: 1 }}
          placeholder={placeholder}
          value={value}
          onChange={handleEmailChange}
          required={required}
          disabled={disabled || verified}
          autoComplete="email"
        />
        {verified ? (
          <span
            data-testid="otp-verified"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "0 0.7rem",
              color: "#16a34a",
              fontSize: "0.8rem",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            ✓ Verified
          </span>
        ) : (
          <button
            type="button"
            data-testid="otp-validate"
            onClick={request}
            disabled={busy || disabled || !emailOk}
            style={{ ...actionBtn, opacity: busy || !emailOk ? 0.6 : 1 }}
          >
            {busy && !requested ? "Sending…" : requested ? "Resend" : "Validate"}
          </button>
        )}
      </div>

      {requested && !verified && (
        <div data-testid="otp-box" style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            type="text"
            inputMode="numeric"
            data-testid="otp-code"
            className={inputClassName}
            style={inputStyle ? { ...inputStyle, flex: 1 } : { flex: 1 }}
            placeholder="Enter 6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
            autoComplete="one-time-code"
          />
          <button
            type="button"
            data-testid="otp-verify"
            onClick={verify}
            disabled={busy}
            style={{ ...actionBtn, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
        </div>
      )}

      {msg && (
        <div
          data-testid="otp-msg"
          style={{
            marginTop: 6,
            fontSize: "0.78rem",
            color:
              msg.type === "error"
                ? "var(--danger-color, #ef4444)"
                : msg.type === "success"
                  ? "#16a34a"
                  : "var(--text-secondary)",
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
