import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MessageCircle, Settings as SettingsIcon } from "lucide-react";
import { fetchApi } from "../../../utils/api";

// Meta Cloud API connection bar for the agent inbox.
//
// The Meta counterpart to WhatsAppWebConnect (the QR-scan bar). There is no
// QR here: a Meta Cloud number is connected once, in Settings → WhatsApp / Meta
// Configuration, by validating the tenant's own credentials against Graph. This
// bar is therefore read-only status + a deep link to that card, not a connect
// control.
//
// Deliberately NOT WhatsAppEmbeddedSignup: that panel drives Meta's Embedded
// Signup popup, which needs Meta App Review plus VITE_META_APP_ID /
// VITE_META_ES_CONFIG_ID. The manual-credential path works today without any
// of that.
//
// Colours come from theme tokens only (this app is dark-first: bare `:root` is
// the dark palette), so no hex fallbacks — see WhatsAppMetaConfigCard.jsx.

const SEVERITY = {
  ok: { bg: "rgba(16, 185, 129, 0.14)", fg: "var(--success-color)" },
  info: { bg: "var(--hover-bg)", fg: "var(--text-secondary)" },
  warn: { bg: "rgba(245, 158, 11, 0.16)", fg: "var(--warning-color)" },
  error: { bg: "rgba(239, 68, 68, 0.14)", fg: "var(--danger-color)" },
};

export default function WhatsAppMetaConnectBar({ isAdmin }) {
  const [state, setState] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Non-admins get 403 from the ADMIN-gated status route — that is not an
        // error worth a toast on an inbox page, so stay silent and just render
        // the neutral bar.
        const res = await fetchApi("/api/whatsapp/config/status", { silent: true });
        if (!cancelled) setState(res);
      } catch {
        /* non-fatal — the inbox itself works regardless of config visibility */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) return null;

  const status = state?.status;
  const tone = SEVERITY[status?.severity] || SEVERITY.info;
  const number = state?.meta?.displayPhoneNumber;
  const connected = status?.status === "CONNECTED";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
        padding: "0.6rem 1rem",
        borderBottom: "1px solid var(--border-color)",
        background: "var(--surface-color)",
        color: "var(--text-primary)",
        fontSize: "0.83rem",
      }}
    >
      <MessageCircle size={16} style={{ flexShrink: 0 }} />
      <span style={{ fontWeight: 600 }}>WhatsApp Business</span>

      <span
        style={{
          padding: "0.15rem 0.55rem",
          borderRadius: 999,
          background: tone.bg,
          color: tone.fg,
          fontWeight: 600,
          fontSize: "0.76rem",
          whiteSpace: "nowrap",
        }}
      >
        {status?.label || "Not connected"}
      </span>

      {number && <span style={{ color: "var(--text-secondary)" }}>{number}</span>}

      {!connected && (
        <span style={{ color: "var(--text-secondary)" }}>
          {isAdmin
            ? "Connect your Meta credentials to send and receive."
            : "Ask an admin to connect the WhatsApp Business account."}
        </span>
      )}

      {isAdmin && (
        <Link
          to="/settings"
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
            padding: "0.3rem 0.7rem",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            color: "var(--text-primary)",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          <SettingsIcon size={14} />
          {connected ? "Manage" : "Configure"}
        </Link>
      )}
    </div>
  );
}
