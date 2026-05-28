// Travel CRM — Supplier credentials vault.
//
// Lands at /travel/suppliers. ADMIN+MANAGER list of stored airline /
// hotel / GDS / visa-portal credentials. List view shows ONLY metadata
// (no encrypted blobs); the "Reveal" button hits POST /:id/reveal
// (ADMIN-only) which writes an access-log row + returns the plaintext
// for display. Each reveal closes when the modal is dismissed.

import { useEffect, useState, useContext } from "react";
import { Key, Eye, Plus, Trash2, AlertTriangle, X } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import PasswordInput from "../../components/PasswordInput";

const CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "airline", label: "Airline" },
  { value: "hotel", label: "Hotel" },
  { value: "gds", label: "GDS" },
  { value: "visa-portal", label: "Visa Portal" },
  { value: "payment-gateway", label: "Payment GW" },
  { value: "insurance", label: "Insurance" },
  { value: "government", label: "Government" },
];

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

export default function Suppliers() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";

  const [creds, setCreds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ category: "airline", supplierName: "", loginId: "", password: "" });
  const [revealed, setRevealed] = useState(null); // { id, loginId, password, metadata }

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (category) qs.set("category", category);
    fetchApi(`/api/travel/supplier-credentials?${qs.toString()}`)
      .then((res) => setCreds(Array.isArray(res?.credentials) ? res.credentials : []))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load credentials");
        setCreds([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [category]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!form.supplierName.trim() || !form.loginId || !form.password) {
      notify.error("supplierName + loginId + password required");
      return;
    }
    try {
      await fetchApi("/api/travel/supplier-credentials", {
        method: "POST",
        body: JSON.stringify(form),
      });
      notify.success("Credential stored (encrypted)");
      setForm({ category: "airline", supplierName: "", loginId: "", password: "" });
      setAdding(false);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to add credential");
    }
  };

  const reveal = async (cred) => {
    try {
      const res = await fetchApi(`/api/travel/supplier-credentials/${cred.id}/reveal`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setRevealed(res);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to reveal");
    }
  };

  const remove = async (cred) => {
    if (!confirm(`Delete credential for ${cred.supplierName}?`)) return;
    try {
      await fetchApi(`/api/travel/supplier-credentials/${cred.id}`, { method: "DELETE" });
      notify.success("Deleted");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete");
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <Key size={28} aria-hidden /> Supplier Credentials
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4 }}>
            Encrypted vault. AES-256-GCM at-rest. Every reveal is logged.
          </p>
        </div>
        {isAdmin && !adding && (
          <button type="button" onClick={() => setAdding(true)} style={primaryBtn}>
            <Plus size={14} /> Add credential
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12, marginBottom: 16 }}>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={selectStyle} aria-label="Filter by category">
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>

      {/* Warning banner — visible to operators so they know this is sensitive */}
      <div style={{
        background: "rgba(200,154,78,0.12)", border: "1px solid rgba(200,154,78,0.3)",
        borderRadius: 8, padding: 12, marginBottom: 16,
        display: "flex", alignItems: "center", gap: 8, fontSize: 13,
      }}>
        <AlertTriangle size={18} aria-hidden style={{ color: "var(--warning-color)", flexShrink: 0 }} />
        <span>
          Every <strong>Reveal</strong> click writes an access-log row (user, IP, timestamp) BEFORE the
          credential decrypts. Only use when actively logging into the supplier portal.
        </span>
      </div>

      {adding && (
        <div style={{ background: "var(--surface-color)", padding: 16, borderRadius: 8, border: "1px solid var(--border-color)", marginBottom: 16 }}>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={input}>
              {CATEGORIES.filter((c) => c.value).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <input placeholder="Supplier name" value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} style={input} />
            <input placeholder="Login ID" value={form.loginId} onChange={(e) => setForm({ ...form, loginId: e.target.value })} style={input} />
            <PasswordInput placeholder="Password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={input} className="" autoComplete="off" />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button type="button" onClick={add} style={primaryBtn}>Save</button>
            <button type="button" onClick={() => setAdding(false)} style={secondaryBtn}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{
        background: "var(--surface-color)", borderRadius: 8,
        border: "1px solid var(--border-color)", overflow: "hidden",
      }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : creds.length === 0 ? (
          <div style={empty}>No credentials stored.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Category</th>
                <th style={th}>Supplier</th>
                <th style={th}>Last used</th>
                <th style={th} colSpan={2}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {creds.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                  <td style={td}>{c.category}</td>
                  <td style={td}><strong>{c.supplierName}</strong></td>
                  <td style={td}>{fmt(c.lastUsedAt)}</td>
                  <td style={{ ...td, width: 0 }}>
                    {isAdmin && (
                      <button type="button" onClick={() => reveal(c)} style={iconBtn} aria-label={`Reveal credential for ${c.supplierName}`}>
                        <Eye size={16} />
                      </button>
                    )}
                  </td>
                  <td style={{ ...td, width: 0 }}>
                    {isAdmin && (
                      <button type="button" onClick={() => remove(c)} style={{ ...iconBtn, color: "var(--danger-color)" }} aria-label={`Delete credential for ${c.supplierName}`}>
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

      {/* Reveal modal */}
      {revealed && (
        <div
          role="dialog"
          aria-label="Revealed credential"
          onClick={() => setRevealed(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface-color)", padding: 24, borderRadius: 12,
              maxWidth: 500, width: "100%", border: "1px solid var(--border-color)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <strong>{revealed.supplierName}</strong>
              <button type="button" onClick={() => setRevealed(null)} style={iconBtn} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <Field label="Login ID" value={revealed.loginId} />
            <Field label="Password" value={revealed.password} />
            {revealed.metadata && <Field label="Metadata" value={revealed.metadata} />}
            <div style={{ marginTop: 16, fontSize: 12, color: "var(--text-secondary)" }}>
              This view has been logged in the credential's access trail.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)" }}>
        {label}
      </div>
      <code style={{
        display: "block", background: "var(--bg-color)", padding: 8, borderRadius: 4,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13,
        wordBreak: "break-all",
      }}>
        {value}
      </code>
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
  background: "var(--primary-color)", color: "#fff",
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
