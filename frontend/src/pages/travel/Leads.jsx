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

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle, Filter, RefreshCw, Tag, UserPlus,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

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

export default function TravelLeads() {
  const notify = useNotify();
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState("");
  const [stage, setStage] = useState("");

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
        <button type="button" onClick={load} style={refreshBtn} aria-label="Refresh leads">
          <RefreshCw size={14} /> Refresh
        </button>
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
                  <td style={td}>{d.contact?.name || d.contact?.email || "—"}</td>
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
