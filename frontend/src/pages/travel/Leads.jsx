// Travel CRM — Unified Leads page (PRD §7).
//
// Lives at /travel/leads for tenants with vertical="travel". Pulls
// Deal rows scoped to the user's tenant + filtered by subBrand +
// stage. Server-side filtering (extended deals route accepts
// ?subBrand=) so the page doesn't violate the "client-side
// aggregation over paginated endpoint is a structural correctness
// bug" rule from CLAUDE.md — a 100-row window on a 5,000-deal tenant
// would silently miss most leads.
//
// Click into a row → /deals/:id (the existing generic CRM deal page,
// which knows nothing about sub-brand but renders the row correctly).
// Future: spin up a travel-specific Deal detail page if the generic
// page misses Travel-specific drilldown (diagnosticId link, sub-brand
// pipeline stage labels). Phase 1 reuses the generic page.

import { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle, Filter, Plus, RefreshCw, Tag, UserPlus, UserCircle, X,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import { useActiveSubBrand } from "../../utils/subBrand";
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC" },
  { value: "rfu", label: "RFU" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const STAGES = [
  { value: "", label: "All stages" },
  { value: "lead", label: "Lead" },
  { value: "contacted", label: "Contacted" },
  { value: "proposal", label: "Proposal" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

const EMPTY_FORM = {
  title: "", contactId: "", subBrand: "tmc", stage: "lead",
  amount: "", expectedClose: "",
};

export default function TravelLeads() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState("");
  const [stage, setStage] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [contacts, setContacts] = useState([]);

  // Sub-brands this user may create a lead under. A user restricted to a
  // single brand has it auto-selected (no dropdown); admins + multi-brand
  // users get a dropdown limited to THEIR brands. See defaultSubBrandFor.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
    setCreating(true);
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : (res?.contacts || [])))
      .catch(() => setContacts([]));
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      notify.error("Title is required");
      return;
    }
    setSaving(true);
    try {
      const body = {
        title: form.title.trim(),
        stage: form.stage,
        subBrand: form.subBrand,
      };
      if (form.contactId) body.contactId = parseInt(form.contactId, 10);
      if (form.amount) body.amount = Number(form.amount);
      if (form.expectedClose) body.expectedClose = form.expectedClose;
      await fetchApi("/api/deals", { method: "POST", body: JSON.stringify(body) });
      notify.success("Travel lead created");
      setCreating(false);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to create lead");
    } finally {
      setSaving(false);
    }
  };

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (stage) qs.set("stage", stage);
    qs.set("limit", "200");
    fetchApi(`/api/deals?${qs.toString()}`)
      .then((res) => setDeals(Array.isArray(res) ? res : []))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load leads");
        setDeals([]);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, [subBrand, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <UserPlus size={28} aria-hidden /> Travel Leads
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, marginBottom: 0 }}>
            Unified deal pipeline across all sub-brands. Server-scoped to the caller&apos;s sub-brand access.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={openCreate} style={primaryBtn} aria-label="Create a new travel lead">
            <Plus size={14} /> New Travel Lead
          </button>
          <button type="button" onClick={load} style={refreshBtn} aria-label="Refresh leads">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </header>

      <div style={filterRow}>
        <Filter size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <select value={subBrand} onChange={(e) => setSubBrand(e.target.value)} style={selectStyle} aria-label="Filter by sub-brand">
          {SUB_BRANDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value)} style={selectStyle} aria-label="Filter by stage">
          {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: "auto" }}>
          {deals.length} {deals.length === 1 ? "deal" : "deals"}
        </span>
      </div>

      <div style={tableWrap}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : deals.length === 0 ? (
          <div style={empty}>
            <AlertCircle size={18} aria-hidden style={{ color: "var(--warning-color)", marginRight: 8, verticalAlign: -3 }} />
            No deals match the current filters.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Title</th>
                <th style={th}>Contact</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Stage</th>
                <th style={thRight}>Amount</th>
                <th style={th}>Diagnostic</th>
              </tr>
            </thead>
            <tbody>
              {deals.map((d) => (
                <tr key={d.id} style={trStyle}>
                  <td style={td}>
                    <Link to={`/deals/${d.id}`} style={dealLink}>{d.title || `Deal #${d.id}`}</Link>
                  </td>
                  <td style={td}>
                    {d.contactId ? (
                      <Link to={`/travel/leads/${d.contactId}`} style={{ ...dealLink, fontWeight: 500 }} title="Open unified travel lead view">
                        <UserCircle size={14} aria-hidden />
                        {d.contact?.name || d.contact?.email || `Contact #${d.contactId}`}
                      </Link>
                    ) : (
                      d.contact?.name || d.contact?.email || "—"
                    )}
                  </td>
                  <td style={td}>
                    {d.subBrand ? <span style={brandBadge}>{d.subBrand}</span> : <span style={{ color: "var(--text-secondary)" }}>—</span>}
                  </td>
                  <td style={td}><span style={stageBadge(d.stage)}>{d.stage}</span></td>
                  <td style={tdRight}>
                    {d.amount != null ? `${d.currency || "USD"} ${Number(d.amount).toLocaleString()}` : "—"}
                  </td>
                  <td style={td}>
                    {d.diagnosticId ? (
                      <Link to={`/travel/diagnostics`} style={{ ...dealLink, fontSize: 12 }}>
                        <Tag size={12} aria-hidden /> #{d.diagnosticId}
                      </Link>
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>—</span>
                    )}
                    {d.subBrand === "rfu" && d.contactId && (
                      <Link
                        to={`/travel/rfu/customers/${d.contactId}`}
                        style={{ ...dealLink, fontSize: 11, marginLeft: 8 }}
                        title="Open RFU customer profile"
                      >
                        RFU profile →
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setCreating(false); }}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 1000, padding: "1rem",
          }}
        >
          <form onSubmit={submitCreate} className="card" role="dialog" aria-modal="true" style={drawerStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>New Travel Lead</h2>
              <button type="button" onClick={() => setCreating(false)} aria-label="Close" style={iconBtn}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={fieldLabel}>
                Title
                <input
                  required type="text" value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  style={inputStyle}
                  placeholder='e.g. "Mumbai School — Andaman 2026"'
                />
              </label>
              <label style={fieldLabel}>
                Contact
                <select
                  value={form.contactId}
                  onChange={(e) => setForm({ ...form, contactId: e.target.value })}
                  style={inputStyle}
                >
                  <option value="">(none — link later)</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.email || `Contact #${c.id}`}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                Sub-brand
                {lockedBrand ? (
                  // Single-brand user: auto-selected, not editable. The value
                  // is already pinned in form.subBrand via defaultSubBrandFor.
                  <input
                    type="text"
                    value={subBrandShortLabel(lockedBrand)}
                    readOnly
                    disabled
                    aria-label="Sub-brand (locked to your assigned brand)"
                    style={{ ...inputStyle, opacity: 0.7, cursor: "not-allowed" }}
                  />
                ) : (
                  <select
                    value={form.subBrand}
                    onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                    style={inputStyle}
                  >
                    {myBrands.map((b) => (
                      <option key={b} value={b}>{subBrandShortLabel(b)}</option>
                    ))}
                  </select>
                )}
              </label>
              <label style={fieldLabel}>
                Stage
                <select
                  value={form.stage}
                  onChange={(e) => setForm({ ...form, stage: e.target.value })}
                  style={inputStyle}
                >
                  {STAGES.filter((s) => s.value).map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                Estimated value
                <input
                  type="number" min="0" step="any" value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  style={inputStyle}
                  placeholder="0"
                />
              </label>
              <label style={fieldLabel}>
                Expected close
                <input
                  type="date" value={form.expectedClose}
                  onChange={(e) => setForm({ ...form, expectedClose: e.target.value })}
                  style={inputStyle}
                />
              </label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button type="button" onClick={() => setCreating(false)} style={refreshBtn}>Cancel</button>
              <button type="submit" disabled={saving} style={primaryBtn}>
                {saving ? "Creating…" : "Create Lead"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function stageBadge(stage) {
  const base = {
    padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5,
  };
  switch (stage) {
    case "won":
      return { ...base, background: "var(--subtle-bg-2)", color: "var(--success-color)" };
    case "lost":
      return { ...base, background: "var(--subtle-bg)", color: "var(--danger-color)" };
    case "proposal":
      return { ...base, background: "var(--subtle-bg-3)", color: "var(--primary-color)" };
    case "contacted":
      return { ...base, background: "var(--subtle-bg)", color: "var(--text-primary)" };
    default:
      return { ...base, background: "var(--subtle-bg)", color: "var(--text-secondary)" };
  }
}

const filterRow = {
  display: "flex", gap: 8, alignItems: "center",
  padding: 12, marginBottom: 12,
  background: "var(--subtle-bg)", borderRadius: 8,
  border: "1px solid var(--border-color)",
};
const tableWrap = {
  background: "var(--surface-color)", borderRadius: 8,
  border: "1px solid var(--border-color)", overflow: "hidden",
};
const selectStyle = {
  padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  minWidth: 140, fontSize: 13,
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
// Centred modal — mirrors the Itineraries + Staff add-staff-member pattern.
// `.card` (set on the form element) supplies border-radius, border, blur
// and lifted shadow; we force opaque `--bg-color` here so the panel
// doesn't read as glassmorphic over the page content behind it.
const drawerStyle = {
  background: "var(--bg-color)", color: "var(--text-primary)",
  width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto",
  padding: "1.5rem",
};
const iconBtn = {
  background: "transparent", border: "none", color: "var(--text-secondary)",
  cursor: "pointer", padding: 4,
};
const fieldLabel = {
  display: "flex", flexDirection: "column", gap: 4,
  fontSize: 12, color: "var(--text-secondary)", fontWeight: 500,
};
const inputStyle = {
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))", color: "var(--text-primary)",
  fontSize: 14,
};
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 11,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const thRight = { ...th, textAlign: "right" };
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const tdRight = { ...td, textAlign: "right" };
const trStyle = { borderTop: "1px solid var(--border-light)" };
const dealLink = {
  color: "var(--primary-color)", textDecoration: "none", fontWeight: 600,
  display: "inline-flex", alignItems: "center", gap: 4,
};
const brandBadge = {
  padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg-3)", color: "var(--primary-color)",
  textTransform: "uppercase", letterSpacing: 0.5,
};
