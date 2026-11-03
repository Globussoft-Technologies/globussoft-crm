import { useEffect, useState } from "react";
import { MessageCircle, Settings as SettingsIcon, X } from "lucide-react";
import WhatsAppMetaConfigCard from "../../../components/WhatsAppMetaConfigCard";
import { fetchApi } from "../../../utils/api";

// Meta Cloud API connection bar for the agent inbox.
//
// The Meta counterpart to WhatsAppWebConnect (the QR-scan bar). There is no
// QR here: a Meta Cloud number is connected once, in Settings → WhatsApp / Meta
// Configuration, by validating the tenant's own credentials against Graph. The
// status bar opens that existing configuration card in-place so an admin does
// not lose the active inbox context.
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
  const [configOpen, setConfigOpen] = useState(false);

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
    <>
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
          <button
            type="button"
            onClick={() => setConfigOpen(true)}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
            padding: "0.3rem 0.7rem",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
          >
            <SettingsIcon size={14} />
            {connected ? "Manage" : "Configure"}
          </button>
        )}
      </div>

      {isAdmin && configOpen && (
        <div
          onClick={() => setConfigOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            background: "rgba(15, 23, 42, 0.72)",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="whatsapp-inbox-config-title"
            className="modal"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(900px, 96vw)",
              maxHeight: "92vh",
              overflowY: "auto",
              padding: "1.25rem",
              border: "1px solid var(--border-color)",
              borderRadius: 16,
              background: "var(--modal-bg)",
              color: "var(--text-primary)",
              opacity: 1,
              backdropFilter: "none",
              WebkitBackdropFilter: "none",
              boxShadow: "0 25px 50px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", marginBottom: "1rem" }}>
              <div>
                <h2 id="whatsapp-inbox-config-title" style={{ margin: 0, fontSize: "1.3rem" }}>Configure WhatsApp</h2>
                <p style={{ margin: "0.35rem 0 0", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                  Connect the WhatsApp Business account used by your Generic CRM sequences.
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfigOpen(false)}
                aria-label="Close WhatsApp configuration"
                style={{ padding: "0.45rem" }}
              >
                <X size={18} />
              </button>
            </div>
            <WhatsAppMetaConfigCard embedded />
          </div>
        </div>
      )}
    </>
  );
}
