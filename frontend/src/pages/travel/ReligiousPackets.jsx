// Travel CRM — Religious-guidance content library admin UI.
//
// PRD §4.8 + §4.10 RFU sub-brand. Editing surface for the daily
// religiousGuidanceEngine cron's content packets. Library is edited
// here; cron consumes it at fire time so a PATCH takes effect on the
// next daily tick without a redeploy. Mirrors Suppliers.jsx for layout
// and routes onto backend/routes/travel_religious_packets.js.

import { useEffect, useState, useContext } from "react";
import { BookOpen, Plus, Pencil, Trash2, X } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC" },
  { value: "rfu", label: "RFU" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const ACTIVE_FILTERS = [
  { value: "", label: "Active + inactive" },
  { value: "true", label: "Active only" },
  { value: "false", label: "Inactive only" },
];

const CHANNEL_OPTIONS = ["wa", "email", "sms"];

const EMPTY_FORM = {
  subBrand: "rfu",
  dayOffset: 14,
  title: "",
  contentHtml: "",
  channels: { wa: true, email: true, sms: false },
  isActive: true,
};

function channelsToString(map) {
  return CHANNEL_OPTIONS.filter((c) => map[c]).join(",");
}

function channelsFromString(s) {
  const set = new Set(String(s || "").split(","));
  return { wa: set.has("wa"), email: set.has("email"), sms: set.has("sms") };
}

export default function ReligiousPackets() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";

  const [packets, setPackets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState("");
  const [isActive, setIsActive] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  // Edit modal — null when closed; { id, ...fields, channels: {wa,email,sms} } when open.
  const [editing, setEditing] = useState(null);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (isActive) qs.set("isActive", isActive);
    fetchApi(`/api/travel/religious-packets?${qs.toString()}`)
      .then((res) => setPackets(Array.isArray(res?.packets) ? res.packets : []))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load packets");
        setPackets([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [subBrand, isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    const channels = channelsToString(form.channels);
    if (!form.title.trim() || !form.contentHtml.trim()) {
      notify.error("title + contentHtml required");
      return;
    }
    if (!channels) {
      notify.error("at least one channel required");
      return;
    }
    try {
      await fetchApi("/api/travel/religious-packets", {
        method: "POST",
        body: JSON.stringify({
          subBrand: form.subBrand,
          dayOffset: Number(form.dayOffset),
          title: form.title,
          contentHtml: form.contentHtml,
          channels,
          isActive: form.isActive,
        }),
      });
      notify.success("Packet created");
      setForm(EMPTY_FORM);
      setAdding(false);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to create packet");
    }
  };

  const save = async () => {
    if (!editing) return;
    const channels = channelsToString(editing.channels);
    if (!editing.title.trim() || !editing.contentHtml.trim()) {
      notify.error("title + contentHtml required");
      return;
    }
    if (!channels) {
      notify.error("at least one channel required");
      return;
    }
    try {
      await fetchApi(`/api/travel/religious-packets/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          subBrand: editing.subBrand,
          dayOffset: Number(editing.dayOffset),
          title: editing.title,
          contentHtml: editing.contentHtml,
          channels,
          isActive: editing.isActive,
        }),
      });
      notify.success("Packet saved");
      setEditing(null);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save packet");
    }
  };

  const remove = async (p) => {
    if (!confirm(`Delete packet "${p.title}" (${p.subBrand}, T-${p.dayOffset}d)?`)) return;
    try {
      await fetchApi(`/api/travel/religious-packets/${p.id}`, { method: "DELETE" });
      notify.success("Deleted");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete packet");
    }
  };

  const startEdit = (p) => {
    setEditing({
      id: p.id,
      subBrand: p.subBrand,
      dayOffset: p.dayOffset,
      title: p.title,
      contentHtml: p.contentHtml,
      channels: channelsFromString(p.channels),
      isActive: Boolean(p.isActive),
    });
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <BookOpen size={28} aria-hidden /> Religious Guidance Packets
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4 }}>
            Admin-curated content library fired at fixed pre-departure offsets by the daily cron. Edits take effect on the next tick.
          </p>
        </div>
        {isAdmin && !adding && (
          <button type="button" onClick={() => setAdding(true)} style={primaryBtn}>
            <Plus size={14} /> Add packet
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <select value={subBrand} onChange={(e) => setSubBrand(e.target.value)} style={selectStyle} aria-label="Filter by sub-brand">
          {SUB_BRANDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={isActive} onChange={(e) => setIsActive(e.target.value)} style={selectStyle} aria-label="Filter by active state">
          {ACTIVE_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      {adding && (
        <PacketForm
          form={form}
          setForm={setForm}
          onSave={add}
          onCancel={() => {
            setForm(EMPTY_FORM);
            setAdding(false);
          }}
        />
      )}

      <div style={{
        background: "var(--surface-color)", borderRadius: 8,
        border: "1px solid var(--border-color)", overflow: "hidden",
      }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : packets.length === 0 ? (
          <div style={empty}>No packets in this filter.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Sub-brand</th>
                <th style={th}>Day offset</th>
                <th style={th}>Title</th>
                <th style={th}>Channels</th>
                <th style={th}>Active</th>
                <th style={th} colSpan={2}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {packets.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                  <td style={td}><strong>{p.subBrand.toUpperCase()}</strong></td>
                  <td style={td}>T-{p.dayOffset}d</td>
                  <td style={td}>{p.title}</td>
                  <td style={{ ...td, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                    {p.channels}
                  </td>
                  <td style={td}>
                    <span style={p.isActive ? badgeActive : badgeInactive}>
                      {p.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td style={{ ...td, width: 0 }}>
                    {isAdmin && (
                      <button type="button" onClick={() => startEdit(p)} style={iconBtn} aria-label={`Edit packet ${p.title}`}>
                        <Pencil size={16} />
                      </button>
                    )}
                  </td>
                  <td style={{ ...td, width: 0 }}>
                    {isAdmin && (
                      <button type="button" onClick={() => remove(p)} style={{ ...iconBtn, color: "var(--danger-color)" }} aria-label={`Delete packet ${p.title}`}>
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div
          role="dialog"
          aria-label="Edit packet"
          onClick={() => setEditing(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface-color)", padding: 24, borderRadius: 12,
              maxWidth: 720, width: "100%", border: "1px solid var(--border-color)",
              maxHeight: "90vh", overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <strong>Edit packet</strong>
              <button type="button" onClick={() => setEditing(null)} style={iconBtn} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <PacketFields
              values={editing}
              onChange={(patch) => setEditing({ ...editing, ...patch })}
              showActiveToggle
            />
            <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setEditing(null)} style={secondaryBtn}>Cancel</button>
              <button type="button" onClick={save} style={primaryBtn}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PacketForm({ form, setForm, onSave, onCancel }) {
  return (
    <div style={{ background: "var(--surface-color)", padding: 16, borderRadius: 8, border: "1px solid var(--border-color)", marginBottom: 16 }}>
      <PacketFields
        values={form}
        onChange={(patch) => setForm({ ...form, ...patch })}
        showActiveToggle
      />
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button type="button" onClick={onSave} style={primaryBtn}>Save</button>
        <button type="button" onClick={onCancel} style={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}

function PacketFields({ values, onChange, showActiveToggle }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}>
        <label style={fieldLabel}>
          Sub-brand
          <select
            value={values.subBrand}
            onChange={(e) => onChange({ subBrand: e.target.value })}
            style={input}
          >
            {SUB_BRANDS.filter((s) => s.value).map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldLabel}>
          Day offset (T-N days pre-trip)
          <input
            type="number"
            min={0}
            max={365}
            value={values.dayOffset}
            onChange={(e) => onChange({ dayOffset: e.target.value })}
            style={input}
          />
        </label>
      </div>
      <label style={fieldLabel}>
        Title
        <input
          placeholder="e.g. Umrah preparation — 14 days out"
          value={values.title}
          onChange={(e) => onChange({ title: e.target.value })}
          style={input}
          maxLength={200}
        />
      </label>
      <label style={fieldLabel}>
        Content HTML
        <textarea
          placeholder="HTML body. Rendered into the WhatsApp / email / SMS message body at fire time."
          value={values.contentHtml}
          onChange={(e) => onChange({ contentHtml: e.target.value })}
          style={{ ...input, minHeight: 160, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}
        />
      </label>
      <fieldset style={{ border: "1px solid var(--border-light)", borderRadius: 6, padding: "8px 12px" }}>
        <legend style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)", padding: "0 6px" }}>
          Channels
        </legend>
        <div style={{ display: "flex", gap: 16 }}>
          {CHANNEL_OPTIONS.map((c) => (
            <label key={c} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={Boolean(values.channels[c])}
                onChange={(e) =>
                  onChange({ channels: { ...values.channels, [c]: e.target.checked } })
                }
              />
              {c === "wa" ? "WhatsApp" : c.toUpperCase()}
            </label>
          ))}
        </div>
      </fieldset>
      {showActiveToggle && (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={Boolean(values.isActive)}
            onChange={(e) => onChange({ isActive: e.target.checked })}
          />
          Active (cron picks this up on the next tick)
        </label>
      )}
    </div>
  );
}

const selectStyle = {
  padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)", background: "var(--surface-color)",
  color: "var(--text-primary)", minWidth: 160, fontSize: 13,
};
const input = {
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)", color: "var(--text-primary)", fontSize: 13,
  width: "100%",
};
const fieldLabel = {
  display: "grid", gap: 4, fontSize: 11,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)",
};
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color, var(--accent-color))", color: "#fff",
  border: "none", cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const iconBtn = {
  padding: 6, borderRadius: 4,
  background: "transparent", color: "var(--text-secondary)",
  border: "none", cursor: "pointer",
};
const badgeActive = {
  padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
  background: "rgba(34,197,94,0.15)", color: "var(--success-color, #16a34a)",
};
const badgeInactive = {
  padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
  background: "rgba(148,163,184,0.18)", color: "var(--text-secondary)",
};
