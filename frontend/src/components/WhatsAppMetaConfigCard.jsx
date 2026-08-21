import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Link2Off,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import { fetchApi } from "../utils/api";

// Per-tenant WhatsApp (Meta Cloud API) configuration.
//
// Every organization brings its OWN Meta app + WhatsApp Business Account —
// there is no shared platform number. Credentials are validated against Meta
// before the integration is marked connected, encrypted at rest, and returned
// masked (`****1234`); the plaintext access token never comes back to the
// browser after it is saved.
//
// The three field groups below are deliberate: operators consistently get
// stuck not knowing which value they invent, which value Meta issues, and
// which value we generate. See docs/WHATSAPP_TENANT_SETUP.md.
//
// THEMING — this app is dark-first: bare `:root` in index.css holds the DARK
// palette and `[data-theme="light"]` overrides it. So every colour here comes
// from a token that is defined in all three blocks (:root / [data-theme=dark] /
// [data-theme=light]) and carries NO hex fallback — a literal fallback would
// silently pin one mode's colour and break the other. (This card originally
// used `var(--card-bg, #fff)`; `--card-bg` is not a token in this codebase, so
// it resolved to white and the inherited white text became invisible.)
// Status/alert tints are translucent rgba over the surface plus a token text
// colour, so they read correctly on either background.

const S = {
  text: "var(--text-primary)",
  muted: "var(--text-secondary)",
  border: "var(--border-color)",
  surface: "var(--surface-color)",
  inputBg: "var(--input-bg)",
  subtle: "var(--hover-bg)",
};

// Severity → translucent tint + token text colour. Works on light and dark
// because the tint is an alpha wash over whatever the surface happens to be.
const SEVERITY_STYLES = {
  ok: { bg: "rgba(16, 185, 129, 0.14)", fg: "var(--success-color)", dot: "var(--success-color)" },
  info: { bg: "var(--hover-bg)", fg: "var(--text-secondary)", dot: "var(--text-secondary)" },
  warn: { bg: "rgba(245, 158, 11, 0.16)", fg: "var(--warning-color)", dot: "var(--warning-color)" },
  error: { bg: "rgba(239, 68, 68, 0.14)", fg: "var(--danger-color)", dot: "var(--danger-color)" },
};

// Fields the tenant types in. `secret` fields render as password inputs and
// are pre-filled with the masked sentinel so an untouched save keeps the
// stored value (the backend treats a masked echo as "unchanged").
const META_FIELDS = [
  {
    key: "phoneNumberId",
    label: "Phone Number ID",
    required: true,
    hint: "Meta Business Manager → WhatsApp Accounts → your WABA → API Setup. A numeric id, NOT the phone number itself.",
    placeholder: "123456789012345",
  },
  {
    key: "businessAccountId",
    label: "WhatsApp Business Account ID (WABA ID)",
    required: true,
    hint: "Same API Setup screen, directly above the phone number id.",
    placeholder: "987654321098765",
  },
  {
    key: "businessId",
    label: "Meta Business ID",
    required: false,
    hint: "Business Settings → Business Info. Optional — stored for reference only.",
    placeholder: "Optional",
  },
  {
    key: "accessToken",
    label: "Access token (System User token)",
    required: true,
    secret: true,
    hint: "Business Settings → Users → System Users → Generate token, with whatsapp_business_messaging + whatsapp_business_management. Use a permanent System User token — a 24-hour test token will disconnect overnight.",
    placeholder: "EAAG...",
  },
];

const labelStyle = {
  display: "block",
  fontSize: "0.8rem",
  fontWeight: 600,
  marginBottom: "0.25rem",
  color: S.text,
};

const hintStyle = {
  margin: "0.25rem 0 0",
  fontSize: "0.75rem",
  color: S.muted,
  lineHeight: 1.45,
};

const groupHeadingStyle = {
  margin: "1rem 0 0.5rem",
  fontSize: "0.72rem",
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: S.muted,
};

function StatusBadge({ status }) {
  const c = SEVERITY_STYLES[status?.severity] || SEVERITY_STYLES.info;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.2rem 0.6rem",
        borderRadius: "999px",
        background: c.bg,
        color: c.fg,
        fontSize: "0.78rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.dot }} />
      {status?.label || "Not connected"}
    </span>
  );
}

function CopyRow({ label, value, hint }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (non-HTTPS origin) — the value is selectable anyway */
    }
  };
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label style={labelStyle}>{label}</label>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          readOnly
          value={value}
          onFocus={(e) => e.target.select()}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "0.45rem 0.6rem",
            border: `1px solid ${S.border}`,
            borderRadius: 6,
            background: S.subtle,
            color: S.text,
            fontFamily: "monospace",
            fontSize: "0.8rem",
          }}
        />
        <button
          type="button"
          onClick={copy}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3rem",
            padding: "0.45rem 0.7rem",
            border: `1px solid ${S.border}`,
            borderRadius: 6,
            background: "transparent",
            color: S.text,
            cursor: "pointer",
            fontSize: "0.8rem",
            whiteSpace: "nowrap",
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  );
}

export default function WhatsAppMetaConfigCard() {
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [errorFields, setErrorFields] = useState([]);
  const [success, setSuccess] = useState("");
  const [form, setForm] = useState({
    phoneNumberId: "",
    businessAccountId: "",
    businessId: "",
    accessToken: "",
    webhookVerifyToken: "",
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchApi("/api/whatsapp/config/status");
      setState(res);
      setForm({
        phoneNumberId: res?.config?.phoneNumberId || "",
        businessAccountId: res?.config?.businessAccountId || "",
        businessId: res?.meta?.metaBusinessId || "",
        // Secrets come back as {configured, last4}. Seed the input with the
        // masked sentinel so an untouched save means "keep current value".
        accessToken: res?.config?.accessToken?.last4 || "",
        webhookVerifyToken: res?.config?.webhookVerifyToken?.last4 || "",
      });
    } catch (err) {
      setError(err.message || "Failed to load WhatsApp configuration.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleConnect = async (e) => {
    e.preventDefault();
    setConnecting(true);
    setError("");
    setErrorFields([]);
    setSuccess("");
    try {
      const res = await fetchApi("/api/whatsapp/config/meta_cloud/connect", {
        method: "POST",
        // Feedback is rendered inline (with per-field highlighting), so skip
        // fetchApi's automatic toast to avoid saying it twice.
        silent: true,
        body: JSON.stringify({
          phoneNumberId: form.phoneNumberId.trim(),
          businessAccountId: form.businessAccountId.trim(),
          businessId: form.businessId.trim() || null,
          accessToken: form.accessToken,
          webhookVerifyToken: form.webhookVerifyToken,
        }),
      });
      setSuccess(
        res?.meta?.displayPhoneNumber
          ? `Connected ${res.meta.displayPhoneNumber}${res.meta.verifiedName ? ` (${res.meta.verifiedName})` : ""}.`
          : "WhatsApp connected.",
      );
      await load();
    } catch (err) {
      // The backend returns {error, code, fields?}; fetchApi hangs the parsed
      // body on err.data. Surface the field list so the admin knows exactly
      // which value Meta rejected.
      setError(err.message || "Meta rejected these credentials.");
      setErrorFields(Array.isArray(err.data?.fields) ? err.data.fields : []);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (
      !window.confirm(
        "Disconnect WhatsApp? Sending stops immediately. Your credentials and message history are kept, so reconnecting only needs a re-validation.",
      )
    ) {
      return;
    }
    setDisconnecting(true);
    setError("");
    setSuccess("");
    try {
      await fetchApi("/api/whatsapp/config/meta_cloud/disconnect", {
        method: "POST",
        silent: true,
        body: JSON.stringify({}),
      });
      setSuccess("WhatsApp disconnected.");
      await load();
    } catch (err) {
      setError(err.message || "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  };

  const inputStyle = (invalid) => ({
    width: "100%",
    boxSizing: "border-box",
    padding: "0.45rem 0.6rem",
    border: `1px solid ${invalid ? "var(--danger-color)" : S.border}`,
    borderRadius: 6,
    background: S.inputBg,
    color: S.text,
    fontSize: "0.85rem",
  });

  const banner = (severity) => ({
    display: "flex",
    gap: "0.5rem",
    padding: "0.6rem 0.75rem",
    borderRadius: 6,
    background: SEVERITY_STYLES[severity].bg,
    color: SEVERITY_STYLES[severity].fg,
    fontSize: "0.82rem",
    lineHeight: 1.45,
    marginBottom: "0.85rem",
  });

  const connected = state?.status?.status === "CONNECTED";

  return (
    <div
      style={{
        border: `1px solid ${S.border}`,
        borderRadius: 10,
        padding: "1.25rem",
        marginBottom: "1rem",
        background: S.surface,
        color: S.text,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "0.35rem",
        }}
      >
        <h3
          style={{
            margin: 0,
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "1.05rem",
            color: S.text,
          }}
        >
          <MessageCircle size={18} /> WhatsApp / Meta Configuration
        </h3>
        <StatusBadge status={state?.status} />
      </div>
      <p style={{ margin: "0 0 1rem", fontSize: "0.83rem", color: S.muted, lineHeight: 1.5 }}>
        Connect your organization&apos;s own WhatsApp Business account. These credentials are used only for
        your account — messages, templates, and webhooks are never shared with another organization.
      </p>

      {loading ? (
        <p style={{ fontSize: "0.85rem", color: S.muted }}>Loading…</p>
      ) : (
        <>
          {state?.status?.reason && !connected && (
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.8rem", color: S.muted }}>
              {state.status.reason}
            </p>
          )}

          {error && (
            <div role="alert" style={banner("error")}>
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div style={banner("ok")}>
              <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{success}</span>
            </div>
          )}

          <form onSubmit={handleConnect}>
            {/* ── Group 1: values the CLIENT gets FROM Meta ─────────────── */}
            <p style={{ ...groupHeadingStyle, marginTop: 0 }}>
              From your Meta account — you provide these
            </p>
            {META_FIELDS.map((f) => (
              <div key={f.key} style={{ marginBottom: "0.75rem" }}>
                <label htmlFor={`wa-${f.key}`} style={labelStyle}>
                  {f.label}
                  {f.required && <span style={{ color: "var(--danger-color)" }}> *</span>}
                </label>
                <input
                  id={`wa-${f.key}`}
                  type={f.secret ? "password" : "text"}
                  value={form[f.key]}
                  placeholder={f.placeholder}
                  autoComplete={f.secret ? "new-password" : "off"}
                  onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                  style={inputStyle(errorFields.includes(f.key))}
                />
                <p style={hintStyle}>{f.hint}</p>
              </div>
            ))}

            {/* ── Group 2: value the CLIENT invents, used on BOTH sides ─── */}
            <p style={groupHeadingStyle}>You choose this — enter the same value in Meta</p>
            <div style={{ marginBottom: "0.75rem" }}>
              <label htmlFor="wa-verify-token" style={labelStyle}>
                Webhook verify token
              </label>
              <input
                id="wa-verify-token"
                type="password"
                value={form.webhookVerifyToken}
                placeholder="Any random string you invent"
                autoComplete="new-password"
                onChange={(e) => setForm((p) => ({ ...p, webhookVerifyToken: e.target.value }))}
                style={inputStyle(false)}
              />
              <p style={hintStyle}>
                Pick any random string. Paste the identical value into Meta → WhatsApp → Configuration →
                Webhook → &ldquo;Verify token&rdquo;. Meta uses it once, to prove the callback URL below is really ours.
              </p>
            </div>

            {/* ── Group 3: values OUR system generates ──────────────────── */}
            <p style={groupHeadingStyle}>Generated by us — copy these into Meta</p>
            <CopyRow
              label="Callback URL"
              value={state?.ours?.callbackUrl || ""}
              hint={
                state?.ours?.callbackUrlConfigured
                  ? "Meta → WhatsApp → Configuration → Webhook → Edit → Callback URL."
                  : "Incomplete: ask your administrator to set WEBHOOK_BASE_URL on the server, otherwise Meta cannot reach this CRM."
              }
            />

            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "1rem" }}>
              <button
                type="submit"
                disabled={connecting}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  padding: "0.5rem 0.9rem",
                  border: "none",
                  borderRadius: 6,
                  // Primary action buttons in this app keep a fixed saturated
                  // fill with white text in BOTH themes (see .btn-primary in
                  // index.css, which uses a constant blue gradient). Tokenising
                  // this would swap in --success-color's lighter dark-mode
                  // value (#10b981), dropping white-on-green contrast to
                  // ~2.4:1; the darker stop here keeps it legible.
                  background: "linear-gradient(135deg, #10b981, #059669)",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "0.85rem",
                  cursor: connecting ? "wait" : "pointer",
                  opacity: connecting ? 0.7 : 1,
                }}
              >
                <ShieldCheck size={15} />
                {connecting ? "Validating with Meta…" : connected ? "Re-validate & Save" : "Validate & Connect"}
              </button>
              {state?.configured && (
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    padding: "0.5rem 0.9rem",
                    border: `1px solid ${S.border}`,
                    borderRadius: 6,
                    background: "transparent",
                    color: S.text,
                    fontSize: "0.85rem",
                    cursor: disconnecting ? "wait" : "pointer",
                  }}
                >
                  <Link2Off size={15} />
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </button>
              )}
            </div>
            <p style={{ ...hintStyle, marginTop: "0.7rem" }}>
              Nothing is activated until Meta confirms these credentials. Saved tokens are encrypted and only
              ever shown masked.
            </p>
          </form>

          {connected && (
            <div
              style={{
                marginTop: "1rem",
                paddingTop: "0.85rem",
                borderTop: `1px solid ${S.border}`,
                fontSize: "0.8rem",
                color: S.muted,
                display: "grid",
                gap: "0.25rem",
              }}
            >
              {state?.meta?.displayPhoneNumber && (
                <span>
                  Business number:{" "}
                  <strong style={{ color: S.text }}>{state.meta.displayPhoneNumber}</strong>
                  {state.meta.verifiedName ? ` — ${state.meta.verifiedName}` : ""}
                </span>
              )}
              <span>Webhooks subscribed: {state?.config?.webhookVerified ? "yes" : "no"}</span>
              {state?.config?.qualityRating && <span>Number quality: {state.config.qualityRating}</span>}
              {state?.config?.tokenExpiresAt ? (
                <span>Token expires: {new Date(state.config.tokenExpiresAt).toLocaleDateString()}</span>
              ) : (
                <span>Token expiry: never (System User token)</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
