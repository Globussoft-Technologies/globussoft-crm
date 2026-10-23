import { useEffect, useState } from "react";
import { Lock, MessageSquareText, RefreshCw, Save, X } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

const EMPTY_CONFIG = {
  provider: "twilio",
  apiKey: null,
  authToken: null,
  senderId: "",
  isActive: false,
};

function SecretRow({ label, value, onRotate }) {
  const configured = Boolean(value && typeof value === "object" && value.configured);
  const last4 = configured ? value.last4 || "****" : "Not configured";

  return (
    <div>
      <label style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
        <Lock size={11} style={{ verticalAlign: "middle", marginRight: "0.35rem" }} />
        {label}
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.55rem 0.75rem", background: "var(--subtle-bg)", border: "1px solid var(--border-color)", borderRadius: 6 }}>
        <code style={{ flex: 1, minWidth: 0, color: configured ? "var(--text-primary)" : "var(--text-secondary)", fontStyle: configured ? "normal" : "italic" }}>
          {last4}
        </code>
        <button type="button" className="btn-secondary" onClick={onRotate} aria-label={`${configured ? "Rotate" : "Set"} ${label}`} style={{ padding: "0.35rem 0.65rem", whiteSpace: "nowrap" }}>
          <RefreshCw size={12} /> {configured ? "Rotate" : "Set"}
        </button>
      </div>
    </div>
  );
}

function RotateCredentialDialog({ field, label, onClose, onSaved }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    try {
      await onSaved(field, value.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 220, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem", background: "var(--overlay-bg)", backdropFilter: "blur(8px)" }}>
      <form onSubmit={submit} className="card" role="dialog" aria-modal="true" aria-labelledby="twilio-credential-title" style={{ width: "min(460px, 100%)", padding: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", marginBottom: "0.5rem" }}>
          <h3 id="twilio-credential-title" style={{ fontSize: "1.1rem", fontWeight: 600 }}>Rotate {label}</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: 0, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", padding: "0.25rem" }}><X size={18} /></button>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", marginBottom: "1rem" }}>
          Enter the complete new credential. Saved credentials are never displayed again.
        </p>
        <input autoFocus className="input-field" type="password" autoComplete="new-password" aria-label={`New ${label}`} value={value} onChange={(event) => setValue(event.target.value)} style={{ width: "100%" }} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || !value.trim()}>{saving ? "Saving…" : `Save ${label}`}</button>
        </div>
      </form>
    </div>
  );
}

export default function TwilioSettingsCard() {
  const notify = useNotify();
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(null);

  const loadConfig = async () => {
    try {
      const rows = await fetchApi("/api/sms/config");
      const twilio = Array.isArray(rows) ? rows.find((row) => row?.provider === "twilio") : null;
      setConfig(twilio ? { ...EMPTY_CONFIG, ...twilio } : EMPTY_CONFIG);
    } catch {
      setConfig(EMPTY_CONFIG);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadConfig(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      await fetchApi("/api/sms/config/twilio", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "twilio",
          senderId: config.senderId,
          isActive: config.isActive,
        }),
      });
      notify.success("Twilio configuration saved");
      await loadConfig();
    } catch {
      // fetchApi displays the API error toast.
    } finally {
      setSaving(false);
    }
  };

  const rotate = async (field, value) => {
    await fetchApi("/api/sms/config/twilio", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "twilio", isActive: config.isActive, [field]: value }),
    });
    notify.success(`${field === "apiKey" ? "Account SID" : "Auth Token"} rotated`);
    await loadConfig();
  };

  return (
    <div className="card" data-testid="generic-twilio-settings" style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.35rem" }}>
        <MessageSquareText size={20} color="var(--primary-color, var(--accent-color))" /> Twilio SMS
      </h3>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
        Configure the same Twilio SMS connection available under Communication Channels.
      </p>
      {loading ? (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Loading Twilio configuration…</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          <SecretRow label="Account SID" value={config.apiKey} onRotate={() => setRotating({ field: "apiKey", label: "Account SID" })} />
          <SecretRow label="Auth Token" value={config.authToken} onRotate={() => setRotating({ field: "authToken", label: "Auth Token" })} />
          <div>
            <label htmlFor="settings-twilio-phone" style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>Phone Number</label>
            <input id="settings-twilio-phone" className="input-field" type="tel" value={config.senderId || ""} onChange={(event) => setConfig((current) => ({ ...current, senderId: event.target.value }))} placeholder="+17372508034" style={{ width: "100%" }} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.875rem" }}>
            <input type="checkbox" checked={Boolean(config.isActive)} onChange={(event) => setConfig((current) => ({ ...current, isActive: event.target.checked }))} /> Enable
          </label>
          <button type="button" className="btn-primary" onClick={save} disabled={saving} style={{ width: "fit-content" }}>
            <Save size={15} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
      {rotating && <RotateCredentialDialog field={rotating.field} label={rotating.label} onClose={() => setRotating(null)} onSaved={rotate} />}
    </div>
  );
}
