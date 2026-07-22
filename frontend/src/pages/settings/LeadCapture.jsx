/**
 * /settings/lead-capture — Multi-channel Lead Capture admin page (G009).
 *
 * PRD: docs/PRD_TRAVEL_MULTICHANNEL_LEADS.md FR-3.7.
 * Backend: /api/settings/lead-capture (routes/lead_capture_settings.js).
 *
 * Scope
 * ─────
 * ADMIN-only page (RoleGuard wrap at the App.jsx route). Three sections:
 *
 *   1. Channel toggles — per-channel enable/disable for the canonical 17
 *      channels. Persisted on Tenant.leadCaptureChannelsJson.
 *   2. Cooldown UI — numeric input (seconds, 0-86400) per enabled channel.
 *      Persisted on Tenant.leadCaptureCooldownsJson. 0 means cooldown
 *      disabled for that channel.
 *   3. FormRoutingMapping UI — table of Meta form-ID → sub-brand mappings.
 *      Add / edit / delete rows. Cred-blocked on Q1 (Meta lead-ads access)
 *      per PRD §FR-3.3.6; UI surfaces a note while still letting operators
 *      pre-stage rows.
 *   4. Test intake button — operator picks a channel + payload, hits the
 *      existing /api/travel/inbound/leads/:channel handler with body
 *      `_test: true` so the route swallows it without persisting.
 *
 * Mocking + UX patterns mirror Channels.jsx + Settings.jsx (existing
 * admin pages). Save round-trip pattern: PUT then re-GET so displayed
 * state matches DB (#586 standing rule).
 */

import { useEffect, useState } from "react";
import {
  Save,
  Plus,
  Trash2,
  AlertCircle,
  Loader,
  RefreshCw,
  PlayCircle,
  Settings as SettingsIcon,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import TopScrollSync from "../../components/TopScrollSync";

// Canonical 17-channel allowlist — mirrors backend/routes/lead_capture_settings.js
// ALLOWED_CHANNELS. The GET response carries this in `allowedChannels` so the UI
// stays in sync if the backend extends the enum; fall back to this constant when
// the GET is still in-flight or has failed.
const FALLBACK_CHANNELS = [
  "voyagr",
  "web_form",
  "whatsapp",
  "ads",
  "adsgpt",
  "meta_ad",
  "manual",
  "indiamart",
  "justdial",
  "tradeindia",
  "voice",
  "sms",
  "email",
  "google_ad",
  "linkedin_ad",
  "referral",
  "chat",
];

const CHANNEL_LABELS = {
  voyagr: "Voyagr CMS",
  web_form: "Web Form",
  whatsapp: "WhatsApp",
  ads: "Ads (generic)",
  adsgpt: "AdsGPT",
  meta_ad: "Meta Lead Ads",
  manual: "Manual entry",
  indiamart: "IndiaMART",
  justdial: "JustDial",
  tradeindia: "TradeIndia",
  voice: "Voice call",
  sms: "SMS",
  email: "Email",
  google_ad: "Google Lead Ads",
  linkedin_ad: "LinkedIn Lead Ads",
  referral: "Referral",
  chat: "Live chat",
};

const SUB_BRANDS = ["tmc", "rfu", "travelstall", "visasure"];

const EMPTY_MAPPING = {
  channel: "meta_ad",
  externalFormId: "",
  subBrand: "",
  assignedTeamId: "",
  isActive: true,
  notes: "",
};

export default function LeadCapture() {
  const notify = useNotify();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [allowedChannels, setAllowedChannels] = useState(FALLBACK_CHANNELS);
  const [channels, setChannels] = useState({});
  const [cooldowns, setCooldowns] = useState({});
  const [mappings, setMappings] = useState([]);
  const [newMapping, setNewMapping] = useState(EMPTY_MAPPING);
  const [creating, setCreating] = useState(false);
  // Test-intake panel state
  const [testChannel, setTestChannel] = useState("web_form");
  const [testPayload, setTestPayload] = useState(
    '{\n  "name": "Test Lead",\n  "email": "test@example.com"\n}',
  );
  const [testing, setTesting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchApi("/api/settings/lead-capture");
      setAllowedChannels(
        Array.isArray(data.allowedChannels) && data.allowedChannels.length
          ? data.allowedChannels
          : FALLBACK_CHANNELS,
      );
      setChannels(data.channels || {});
      setCooldowns(data.cooldowns || {});
      setMappings(Array.isArray(data.formRoutingMappings) ? data.formRoutingMappings : []);
    } catch (err) {
      notify.error(err?.body?.error || "Failed to load lead-capture settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleChannel = (ch) => {
    setChannels((prev) => ({ ...prev, [ch]: !prev[ch] }));
  };
  const setCooldown = (ch, v) => {
    const n = Number(v);
    setCooldowns((prev) => ({
      ...prev,
      [ch]: Number.isFinite(n) ? Math.max(0, Math.min(86400, Math.floor(n))) : 0,
    }));
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await fetchApi("/api/settings/lead-capture", {
        method: "PUT",
        body: JSON.stringify({ channels, cooldowns }),
      });
      notify.success("Lead-capture settings saved");
      await load();
    } catch (err) {
      notify.error(err?.body?.error || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const createMapping = async (e) => {
    e?.preventDefault?.();
    if (!newMapping.externalFormId.trim()) {
      notify.error("External form-ID is required");
      return;
    }
    setCreating(true);
    try {
      const body = {
        channel: newMapping.channel,
        externalFormId: newMapping.externalFormId.trim(),
      };
      if (newMapping.subBrand) body.subBrand = newMapping.subBrand;
      if (newMapping.assignedTeamId) {
        const n = Number(newMapping.assignedTeamId);
        if (Number.isFinite(n)) body.assignedTeamId = n;
      }
      if (newMapping.notes) body.notes = newMapping.notes;
      body.isActive = Boolean(newMapping.isActive);
      await fetchApi("/api/settings/lead-capture/form-routing-mappings", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success("Form-routing mapping added");
      setNewMapping(EMPTY_MAPPING);
      await load();
    } catch (err) {
      notify.error(err?.body?.error || "Failed to add mapping");
    } finally {
      setCreating(false);
    }
  };

  const deleteMapping = async (id) => {
    if (!confirm("Delete this form-routing mapping?")) return;
    try {
      await fetchApi(`/api/settings/lead-capture/form-routing-mappings/${id}`, {
        method: "DELETE",
      });
      notify.success("Mapping deleted");
      await load();
    } catch (err) {
      notify.error(err?.body?.error || "Failed to delete mapping");
    }
  };

  const toggleMappingActive = async (m) => {
    try {
      await fetchApi(`/api/settings/lead-capture/form-routing-mappings/${m.id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive: !m.isActive }),
      });
      await load();
    } catch (err) {
      notify.error(err?.body?.error || "Failed to update mapping");
    }
  };

  const runTestIntake = async () => {
    let parsed;
    try {
      parsed = JSON.parse(testPayload);
    } catch {
      notify.error("Test payload must be valid JSON");
      return;
    }
    setTesting(true);
    try {
      const body = { ...parsed, _test: true, channel: testChannel };
      const res = await fetchApi(
        `/api/travel/inbound/leads/${encodeURIComponent(testChannel)}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      notify.success(
        `Test intake fired: ${res?.action || "received"} (no lead created)`,
      );
    } catch (err) {
      notify.error(err?.body?.error || "Test intake failed");
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)" }}>
          <Loader size={16} /> Loading lead-capture settings&hellip;
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <SettingsIcon size={26} aria-hidden /> Lead Capture
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, marginBottom: 0, maxWidth: 720 }}>
            Configure which channels accept inbound leads, per-channel cooldowns,
            and Meta lead-ad form-ID routing. Changes apply tenant-wide.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={load} style={refreshBtn} aria-label="Refresh">
            <RefreshCw size={14} /> Refresh
          </button>
          <button type="button" onClick={saveSettings} disabled={saving} style={primaryBtn} aria-label="Save channel + cooldown settings">
            <Save size={14} /> {saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </header>

      {/* Section 1 + 2: Channels + cooldowns */}
      <section style={cardStyle}>
        <h2 style={sectionTitle}>Channels &amp; cooldowns</h2>
        <p style={helpText}>
          Disabled channels reject inbound payloads (the intake route returns
          409 CHANNEL_DISABLED). Cooldown windows suppress same-contact
          re-leads within the window (per PRD FR-3.7.2; range 0–86400 sec).
        </p>
        <TopScrollSync>
        <table style={tableStyle} role="table" aria-label="Channels and cooldowns">
          <thead>
            <tr>
              <th style={th}>Channel</th>
              <th style={th}>Enabled</th>
              <th style={th}>Cooldown (sec)</th>
            </tr>
          </thead>
          <tbody>
            {allowedChannels.map((ch) => (
              <tr key={ch} style={trStyle}>
                <td style={td}>
                  <span style={{ fontWeight: 600 }}>{CHANNEL_LABELS[ch] || ch}</span>
                  <span style={chCodeStyle}>{ch}</span>
                </td>
                <td style={td}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={Boolean(channels[ch])}
                      onChange={() => toggleChannel(ch)}
                      aria-label={`Enable ${ch}`}
                    />
                    <span style={{ fontSize: 13 }}>{channels[ch] ? "On" : "Off"}</span>
                  </label>
                </td>
                <td style={td}>
                  <input
                    type="number"
                    min="0"
                    max="86400"
                    step="60"
                    value={cooldowns[ch] ?? 0}
                    onChange={(e) => setCooldown(ch, e.target.value)}
                    style={numberInput}
                    aria-label={`Cooldown for ${ch}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </TopScrollSync>
      </section>

      {/* Section 3: Form routing mappings */}
      <section style={cardStyle}>
        <h2 style={sectionTitle}>Form-ID routing</h2>
        <p style={helpText}>
          <AlertCircle size={14} aria-hidden style={{ verticalAlign: -2, marginRight: 4, color: "var(--warning-color)" }} />
          Real Meta form IDs require the AdsGPT/Meta access cred drop (PRD §FR-3.3.6, Q1).
          You can pre-stage mappings here; the intake handler will consume them
          once webhooks start arriving.
        </p>

        <form onSubmit={createMapping} style={mappingFormGrid}>
          <label style={fieldLabel}>
            Channel
            <select
              value={newMapping.channel}
              onChange={(e) => setNewMapping({ ...newMapping, channel: e.target.value })}
              style={inputStyle}
            >
              {["meta_ad", "google_ad", "linkedin_ad", "web_form"].map((c) => (
                <option key={c} value={c}>{CHANNEL_LABELS[c] || c}</option>
              ))}
            </select>
          </label>
          <label style={fieldLabel}>
            External Form ID
            <input
              type="text"
              required
              value={newMapping.externalFormId}
              onChange={(e) => setNewMapping({ ...newMapping, externalFormId: e.target.value })}
              placeholder="e.g. 1234567890123456"
              style={inputStyle}
              maxLength={128}
            />
          </label>
          <label style={fieldLabel}>
            Sub-brand
            <select
              value={newMapping.subBrand}
              onChange={(e) => setNewMapping({ ...newMapping, subBrand: e.target.value })}
              style={inputStyle}
            >
              <option value="">(none)</option>
              {SUB_BRANDS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label style={fieldLabel}>
            Team ID
            <input
              type="number"
              value={newMapping.assignedTeamId}
              onChange={(e) => setNewMapping({ ...newMapping, assignedTeamId: e.target.value })}
              placeholder="(optional)"
              style={inputStyle}
            />
          </label>
          <label style={{ ...fieldLabel, gridColumn: "span 2" }}>
            Notes
            <input
              type="text"
              value={newMapping.notes}
              onChange={(e) => setNewMapping({ ...newMapping, notes: e.target.value })}
              placeholder="Optional context for this mapping"
              style={inputStyle}
              maxLength={1000}
            />
          </label>
          <div style={{ alignSelf: "end" }}>
            <button type="submit" disabled={creating} style={primaryBtn} aria-label="Add form-routing mapping">
              <Plus size={14} /> {creating ? "Adding…" : "Add mapping"}
            </button>
          </div>
        </form>

        {mappings.length === 0 ? (
          <div style={emptyState}>No form-routing mappings configured yet.</div>
        ) : (
          <TopScrollSync>
          <table style={tableStyle} role="table" aria-label="Form-routing mappings">
            <thead>
              <tr>
                <th style={th}>Channel</th>
                <th style={th}>External Form ID</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Team</th>
                <th style={th}>Active</th>
                <th style={th}>Notes</th>
                <th style={th} aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id} style={trStyle}>
                  <td style={td}>{CHANNEL_LABELS[m.channel] || m.channel}</td>
                  <td style={td}><code style={chCodeStyle}>{m.externalFormId}</code></td>
                  <td style={td}>{m.subBrand || "—"}</td>
                  <td style={td}>{m.assignedTeamId || "—"}</td>
                  <td style={td}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={m.isActive}
                        onChange={() => toggleMappingActive(m)}
                        aria-label={`Toggle active for mapping ${m.id}`}
                      />
                      <span style={{ fontSize: 12 }}>{m.isActive ? "Yes" : "No"}</span>
                    </label>
                  </td>
                  <td style={{ ...td, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{m.notes || "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button
                      type="button"
                      onClick={() => deleteMapping(m.id)}
                      style={iconBtn}
                      aria-label={`Delete mapping ${m.id}`}
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </section>

      {/* Section 4: Test intake */}
      <section style={cardStyle}>
        <h2 style={sectionTitle}>Test intake</h2>
        <p style={helpText}>
          Sends a payload to <code>/api/travel/inbound/leads/&lt;channel&gt;</code> with
          a <code>_test: true</code> flag — the intake handler validates the shape
          but does not persist a lead.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 12 }}>
          <label style={fieldLabel}>
            Channel
            <select
              value={testChannel}
              onChange={(e) => setTestChannel(e.target.value)}
              style={inputStyle}
            >
              {allowedChannels.map((c) => (
                <option key={c} value={c}>{CHANNEL_LABELS[c] || c}</option>
              ))}
            </select>
          </label>
          <label style={fieldLabel}>
            Sample payload (JSON)
            <textarea
              value={testPayload}
              onChange={(e) => setTestPayload(e.target.value)}
              rows={8}
              style={{ ...inputStyle, fontFamily: "monospace", resize: "vertical" }}
              aria-label="Test payload JSON"
            />
          </label>
        </div>
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={runTestIntake} disabled={testing} style={primaryBtn} aria-label="Run test intake">
            <PlayCircle size={14} /> {testing ? "Sending…" : "Test intake"}
          </button>
        </div>
      </section>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────
const cardStyle = {
  background: "var(--surface-color)",
  border: "1px solid var(--border-color)",
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
};
const sectionTitle = { margin: "0 0 8px 0", fontSize: 16, fontWeight: 600 };
const helpText = { color: "var(--text-secondary)", fontSize: 13, marginTop: 0, marginBottom: 12, maxWidth: 720 };
const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 };
const th = {
  textAlign: "left", padding: "8px 10px", fontSize: 11,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const td = { padding: "8px 10px", color: "var(--text-primary)" };
const trStyle = { borderTop: "1px solid var(--border-light)" };
const chCodeStyle = {
  display: "inline-block",
  marginLeft: 8,
  fontSize: 11,
  color: "var(--text-secondary)",
  fontFamily: "monospace",
};
const numberInput = {
  width: 110,
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))",
  color: "var(--text-primary)",
  fontSize: 13,
};
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))",
  color: "var(--text-primary)",
  fontSize: 14,
};
const fieldLabel = {
  display: "flex", flexDirection: "column", gap: 4,
  fontSize: 12, color: "var(--text-secondary)", fontWeight: 500,
};
const mappingFormGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
  gap: 12,
  padding: 12,
  background: "var(--subtle-bg)",
  border: "1px solid var(--border-color)",
  borderRadius: 6,
  marginBottom: 12,
  alignItems: "end",
};
const emptyState = {
  padding: 24, textAlign: "center", color: "var(--text-secondary)",
  fontSize: 13, background: "var(--subtle-bg)", borderRadius: 6,
};
const refreshBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 500, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-secondary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  border: "1px solid var(--primary-color, var(--accent-color))",
  cursor: "pointer",
};
const iconBtn = {
  background: "transparent", border: "none", color: "var(--text-secondary)",
  cursor: "pointer", padding: 4,
};
