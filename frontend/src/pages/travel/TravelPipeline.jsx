// Travel CRM — Sales Pipeline page.
//
// Lives at /travel/pipeline. Shows all Itineraries across sub-brands as a
// flat table with live KPI tiles (total pipeline value, won/accepted, in
// negotiation, lost). Operators can filter by sub-brand, status, and free-
// text search (destination or contact name). Inline status dropdown lets an
// advisor move a quote from "sent" → "accepted" without leaving the page.
//
// Data source: GET /api/travel/itineraries (full shape — includes contact
// name). Pagination-safe: load up to 200 rows per fetch; shows a "Load
// more" button when total > loaded count.
//
// Create flow: "+ New Deal" opens a minimal drawer that posts to
// POST /api/travel/itineraries (contactId + subBrand + destination +
// optional totalAmount + optional dates). On success navigates to the new
// itinerary's detail page (/travel/itineraries/:id).

import { useContext, useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  Plane, Plus, Download, RefreshCw, Pencil, Trash2, X,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import TopScrollSync from "../../components/TopScrollSync";
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";

// ─── Constants ────────────────────────────────────────────────────────────

const SUB_BRAND_OPTIONS = [
  { value: "", label: "All companies" },
  { value: "tmc", label: "TMC" },
  { value: "rfu", label: "RFU" },
  { value: "travelstall", label: "TravelStall" },
  { value: "visasure", label: "Visa Sure" },
];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "revised", label: "Revised" },
  { value: "accepted", label: "Accepted" },
  { value: "advance_paid", label: "Advance paid" },
  { value: "fully_paid", label: "Fully paid" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
];

// Editable statuses — the inline dropdown only shows these so advisors
// can advance/withdraw a quote without accidentally setting edge-case
// terminal statuses via a mis-click.
const EDITABLE_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "revised", label: "Revised" },
  { value: "accepted", label: "Accepted" },
  { value: "advance_paid", label: "Advance paid" },
  { value: "fully_paid", label: "Fully paid" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
];

// Status → visual style (matched to reference: won=green, lost=red, achieved=blue, negotiation=amber, draft/new=gray)
const STATUS_STYLE = {
  draft:        { bg: "#20202a", color: "#9a9aa5" },
  sent:         { bg: "#332a12", color: "#e8b34a" },
  revised:      { bg: "#1a2033", color: "#5b6ef8" },
  accepted:     { bg: "#123324", color: "#4fd48a" },
  advance_paid: { bg: "#123324", color: "#4fd48a" },
  fully_paid:   { bg: "#0d2a1a", color: "#2ecc71" },
  rejected:     { bg: "#331515", color: "#f06a6a" },
  expired:      { bg: "#20202a", color: "#9a9aa5" },
  // legacy aliases used in some tenants
  won:          { bg: "#123324", color: "#4fd48a" },
  lost:         { bg: "#331515", color: "#f06a6a" },
  achieved:     { bg: "#1a2033", color: "#fff",    solidBg: "#5b6ef8" },
  negotiation:  { bg: "#332a12", color: "#e8b34a" },
  new:          { bg: "#20202a", color: "#9a9aa5" },
};

// Sub-brand tag colors (reference: TMC=dark navy, TravelStall=amber/gold, RFU=gray)
const SUB_BRAND_STYLE = {
  tmc:         { bg: "#0f1a2e", color: "#6b8ecf",  label: "TMC" },
  rfu:         { bg: "#1a1f1a", color: "#8aaa8a",  label: "RFU" },
  travelstall: { bg: "#2a1f10", color: "#d9a552",  label: "TravelStall" },
  visasure:    { bg: "#1a1228", color: "#a78bfa",  label: "Visa Sure" },
};

// "Won" = itineraries where money is committed (accepted or paid). Used
// for the KPI tile labelled "Won / Accepted".
const WON_STATUSES = new Set(["accepted", "advance_paid", "fully_paid"]);
// "In negotiation" = active drafts being worked on.
const NEGOTIATION_STATUSES = new Set(["sent", "revised"]);
// "Lost" = closed-negative.
const LOST_STATUSES = new Set(["rejected", "expired"]);

// ─── Helpers ──────────────────────────────────────────────────────────────

function fmtMoney(amt, currency = "INR") {
  const n = Number(amt);
  if (!Number.isFinite(n) || n === 0) return currency === "INR" ? "₹0" : `${currency} 0`;
  const sym = currency === "INR" ? "₹" : `${currency} `;
  if (currency === "INR") {
    if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
    if (n >= 100000)   return `₹${(n / 100000).toFixed(2)}L`;
    return `₹${n.toLocaleString("en-IN")}`;
  }
  return `${sym}${n.toLocaleString()}`;
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return "—";
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── Export helper ────────────────────────────────────────────────────────

function exportCsv(rows) {
  const headers = ["ID", "Destination", "Contact", "Sub-brand", "Total amount", "Currency", "Status", "Travel date", "Created"];
  const lines = [
    headers.join(","),
    ...rows.map((r) => [
      r.id,
      `"${(r.destination || "").replace(/"/g, '""')}"`,
      `"${(r.contact?.name || "").replace(/"/g, '""')}"`,
      r.subBrand || "",
      r.totalAmount || "",
      r.currency || "INR",
      r.status || "",
      r.startDate ? fmtDate(r.startDate) : "",
      fmtDate(r.createdAt),
    ].join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `travel-pipeline-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Empty form ───────────────────────────────────────────────────────────

const EMPTY_FORM = {
  contactId: "", subBrand: "travelstall", destination: "",
  totalAmount: "", currency: "INR", startDate: "", endDate: "",
};

// ─── Component ────────────────────────────────────────────────────────────

export default function TravelPipeline() {
  const { user } = useContext(AuthContext);
  const notify = useNotify();
  const navigate = useNavigate();

  // Data
  const [itineraries, setItineraries] = useState([]);
  const [total, setTotal]             = useState(0);
  const [loading, setLoading]         = useState(true);
  const [offset, setOffset]           = useState(0);
  const LIMIT = 100;

  // Filters
  const [filterSubBrand,   setFilterSubBrand]   = useState("");
  const [filterStatus,     setFilterStatus]     = useState("");
  const [search,           setSearch]           = useState("");
  const [filterContact,  setFilterContact]  = useState("");

  // Inline status update
  const [updatingId, setUpdatingId] = useState(null);

  // Delete
  const [deletingId, setDeletingId] = useState(null);

  // Create drawer
  const [creating, setCreating] = useState(false);
  const [form, setForm]         = useState(EMPTY_FORM);
  const [contacts, setContacts] = useState([]);
  const [saving, setSaving]     = useState(false);

  // Sub-brands the current user can access
  const allowedSubBrands = useMemo(
    () => accessibleSubBrands(user),
    [user],
  );

  // ── Load contacts for the create drawer ─────────────────────────────
  useEffect(() => {
    if (!creating) return;
    if (contacts.length > 0) return;
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : (res?.contacts || [])))
      .catch(() => setContacts([]));
  }, [creating]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load itineraries ────────────────────────────────────────────────
  const load = (resetOffset = true) => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterSubBrand) qs.set("subBrand", filterSubBrand);
    if (filterStatus)   qs.set("status", filterStatus);
    const newOffset = resetOffset ? 0 : offset;
    qs.set("limit", String(LIMIT));
    qs.set("offset", String(newOffset));
    fetchApi(`/api/travel/itineraries?${qs.toString()}`)
      .then((res) => {
        const rows = Array.isArray(res?.itineraries) ? res.itineraries : [];
        setItineraries(resetOffset ? rows : (prev) => [...prev, ...rows]);
        setTotal(typeof res?.total === "number" ? res.total : rows.length);
        if (resetOffset) setOffset(0);
      })
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load pipeline");
        setItineraries([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(true); }, [filterSubBrand, filterStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = () => {
    const newOffset = offset + LIMIT;
    setOffset(newOffset);
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterSubBrand) qs.set("subBrand", filterSubBrand);
    if (filterStatus)   qs.set("status", filterStatus);
    qs.set("limit", String(LIMIT));
    qs.set("offset", String(newOffset));
    fetchApi(`/api/travel/itineraries?${qs.toString()}`)
      .then((res) => {
        const rows = Array.isArray(res?.itineraries) ? res.itineraries : [];
        setItineraries((prev) => [...prev, ...rows]);
        setTotal(typeof res?.total === "number" ? res.total : total);
      })
      .catch((e) => notify.error(e?.body?.error || "Failed to load more"))
      .finally(() => setLoading(false));
  };

  // ── Filtered rows (client-side search on top of server-side filters) ─
  const visible = useMemo(() => {
    let rows = itineraries;
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((r) =>
      (r.destination || "").toLowerCase().includes(q) ||
      (r.contact?.name || "").toLowerCase().includes(q) ||
      (r.subBrand || "").toLowerCase().includes(q),
    );
    const cq = filterContact.trim().toLowerCase();
    if (cq) rows = rows.filter((r) =>
      (r.contact?.name || "").toLowerCase().includes(cq),
    );
    return rows;
  }, [itineraries, search, filterContact]);

  // ── KPI tiles ───────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    let totalVal = 0, wonVal = 0, negotiationVal = 0, lostVal = 0;
    for (const r of itineraries) {
      const amt = Number(r.totalAmount) || 0;
      totalVal += amt;
      if (WON_STATUSES.has(r.status))         wonVal         += amt;
      if (NEGOTIATION_STATUSES.has(r.status)) negotiationVal += amt;
      if (LOST_STATUSES.has(r.status))        lostVal        += amt;
    }
    return { totalVal, wonVal, negotiationVal, lostVal };
  }, [itineraries]);

  // ── Inline status update ─────────────────────────────────────────────
  const updateStatus = async (id, newStatus) => {
    setUpdatingId(id);
    try {
      await fetchApi(`/api/travel/itineraries/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      setItineraries((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r)),
      );
    } catch (e) {
      notify.error(e?.body?.error || "Failed to update status");
    } finally {
      setUpdatingId(null);
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────
  const remove = async (row) => {
    const ok = await notify.confirm({
      title: "Delete itinerary",
      message: `Delete the "${row.destination}" itinerary for ${row.contact?.name || `#${row.contactId}`}? This cannot be undone.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(row.id);
    try {
      await fetchApi(`/api/travel/itineraries/${row.id}`, { method: "DELETE" });
      notify.success("Itinerary deleted");
      setItineraries((prev) => prev.filter((r) => r.id !== row.id));
      setTotal((t) => t - 1);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete");
    } finally {
      setDeletingId(null);
    }
  };

  // ── Create ──────────────────────────────────────────────────────────
  const openCreate = () => {
    setForm({
      ...EMPTY_FORM,
      subBrand: defaultSubBrandFor(user, "") || "travelstall",
    });
    setCreating(true);
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!form.contactId) { notify.error("Contact is required"); return; }
    if (!form.destination.trim()) { notify.error("Destination is required"); return; }
    setSaving(true);
    try {
      const body = {
        contactId: parseInt(form.contactId, 10),
        subBrand: form.subBrand,
        destination: form.destination.trim(),
        status: "draft",
        currency: form.currency || "INR",
      };
      if (form.totalAmount) body.totalAmount = Number(form.totalAmount);
      if (form.startDate)   body.startDate   = form.startDate;
      if (form.endDate)     body.endDate     = form.endDate;
      const res = await fetchApi("/api/travel/itineraries", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success("Itinerary created");
      setCreating(false);
      // Navigate to the new itinerary's detail page
      const newId = res?.id || res?.itinerary?.id;
      if (newId) {
        navigate(`/travel/itineraries/${newId}`);
      } else {
        load(true);
      }
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to create");
    } finally {
      setSaving(false);
    }
  };

  // ── Sub-brand badge ─────────────────────────────────────────────────
  function SubBrandBadge({ value }) {
    const style = SUB_BRAND_STYLE[value] || { bg: "#20202a", color: "#9a9aa5", label: value };
    const displayLabel = style.label || subBrandShortLabel(value) || value || "—";
    return (
      <span style={{
        display: "inline-block", padding: "3px 9px", borderRadius: 6,
        fontSize: 11.5, fontWeight: 700,
        background: style.bg, color: style.color,
        letterSpacing: "0.02em",
      }}>
        {displayLabel}
      </span>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "24px 28px", maxWidth: 1280, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "var(--subtle-bg)", border: "1px solid var(--border-color)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Plane size={16} style={{ color: "var(--primary-color)" }} />
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
            Travel Pipeline
          </h1>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            onClick={() => exportCsv(visible)}
            style={secondaryBtn}
            aria-label="Export pipeline as CSV"
            title="Export to CSV"
          >
            <Download size={14} /> Export
          </button>
          <button
            type="button"
            onClick={openCreate}
            style={primaryBtn}
            aria-label="Create a new deal"
          >
            <Plus size={14} /> New Deal
          </button>
        </div>
      </div>

      {/* Sub-line */}
      <p style={{ margin: "0 0 20px 0", fontSize: 13.5, color: "var(--text-secondary)" }}>
        Sales pipeline —{" "}
        {["Draft", "Negotiation", "Won", "Lost", "Achieved"]
          .map((s, i) => (
            <span key={s}>
              {i > 0 && " / "}
              <strong style={{ color: "var(--text-primary)" }}>{s}</strong>
            </span>
          ))
        }.{" "}
        <strong style={{ color: "var(--text-primary)" }}>{total}</strong> deal{total !== 1 ? "s" : ""}.
      </p>

      {/* Filters */}
      <div style={{
        display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center",
        background: "var(--surface-color)",
        border: "1px solid var(--border-color)",
        borderRadius: 12, padding: "16px",
        marginBottom: 20,
      }}>
        <select
          value={filterSubBrand}
          onChange={(e) => setFilterSubBrand(e.target.value)}
          style={selectStyle}
          aria-label="Filter by sub-brand"
        >
          {SUB_BRAND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          style={selectStyle}
          aria-label="Filter by status"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by tour title..."
          aria-label="Filter by tour title"
          style={{ ...selectStyle, minWidth: 180 }}
        />
        <input
          type="search"
          value={filterContact}
          onChange={(e) => setFilterContact(e.target.value)}
          placeholder="Filter by contact name..."
          aria-label="Filter by contact name"
          style={{ ...selectStyle, minWidth: 170 }}
        />
        <button
          type="button"
          onClick={() => load(true)}
          style={secondaryBtn}
          title="Refresh"
          aria-label="Refresh pipeline"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* KPI tiles */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
        gap: 12, marginBottom: 20,
      }}>
        {[
          { label: "Total pipeline value", val: kpis.totalVal,         color: "var(--text-primary)" },
          { label: "Won",                   val: kpis.wonVal,           color: "#4fd48a" },
          { label: "In negotiation",        val: kpis.negotiationVal,   color: "#e8b34a" },
          { label: "Lost",                  val: kpis.lostVal,          color: "#f06a6a" },
        ].map((tile) => (
          <div key={tile.label} style={{
            background: "var(--surface-color)",
            border: "1px solid var(--border-color)",
            borderRadius: 12, padding: "14px 16px",
          }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
              {tile.label}
            </div>
            <div style={{ fontSize: 20, fontWeight: 600, color: tile.color }}>
              {fmtMoney(tile.val)}
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div style={{
        background: "var(--surface-color)",
        border: "1px solid var(--border-color)",
        borderRadius: 12, overflow: "hidden",
      }}>
        {loading && itineraries.length === 0 ? (
          <div style={emptyStyle}>Loading pipeline…</div>
        ) : visible.length === 0 ? (
          <div style={emptyStyle}>
            {itineraries.length === 0
              ? 'No deals yet. Create the first one with "+ New Deal".'
              : `No deals match "${search}".`}
          </div>
        ) : (
          <TopScrollSync scrollWidth={780}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 780 }}>
              <thead>
                <tr>
                  {["Tour title", "Contact", "Company", "Package cost", "Travel date", "Status", "Actions"].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.id}
                    style={{ borderTop: "1px solid var(--border-light)" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--subtle-bg)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    {/* Tour / Destination */}
                    <td style={tdStyle}>
                      <Link
                        to={`/travel/itineraries/${row.id}`}
                        style={{ color: "var(--text-primary)", textDecoration: "none", fontWeight: 600, fontSize: 14 }}
                        title="Open itinerary detail"
                      >
                        {row.destination || "—"}
                      </Link>
                      {/* subtitle: duration + any sub-destinations from items */}
                      {(row.startDate && row.endDate) ? (() => {
                        const days = Math.round((new Date(row.endDate) - new Date(row.startDate)) / 86400000);
                        const nights = Math.max(0, days - 1);
                        const sub = nights > 0 ? `${nights}N/${days}D` : `${days}D`;
                        return (
                          <div style={{ fontSize: 11.5, color: "var(--text-muted, #6b6b76)", marginTop: 2 }}>
                            {sub}
                          </div>
                        );
                      })() : row.currency && row.currency !== "INR" ? (
                        <div style={{ fontSize: 11.5, color: "var(--text-muted, #6b6b76)", marginTop: 2 }}>
                          {row.currency}
                        </div>
                      ) : null}
                    </td>

                    {/* Contact */}
                    <td style={tdStyle}>
                      {row.contact ? (
                        <Link
                          to={`/travel/leads/${row.contactId}`}
                          style={{ color: "var(--text-primary)", textDecoration: "none" }}
                          title="Open lead view"
                        >
                          {row.contact.name}
                        </Link>
                      ) : (
                        <span style={{ color: "var(--text-tertiary)" }}>#{row.contactId}</span>
                      )}
                    </td>

                    {/* Sub-brand */}
                    <td style={tdStyle}>
                      <SubBrandBadge value={row.subBrand} />
                    </td>

                    {/* Package cost */}
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {fmtMoney(row.totalAmount, row.currency || "INR")}
                    </td>

                    {/* Travel date */}
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      {row.startDate ? fmtDate(row.startDate) : (
                        <span style={{ color: "var(--text-tertiary)" }}>—</span>
                      )}
                    </td>

                    {/* Status — inline editable dropdown */}
                    <td style={tdStyle}>
                      <StatusDropdown
                        id={row.id}
                        current={row.status}
                        disabled={updatingId === row.id}
                        onChange={(newStatus) => updateStatus(row.id, newStatus)}
                      />
                    </td>

                    {/* Actions */}
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <Link
                          to={`/travel/itineraries/${row.id}`}
                          title="Edit itinerary"
                          style={iconBtnStyle}
                          aria-label={`Edit itinerary ${row.destination}`}
                        >
                          <Pencil size={13} />
                        </Link>
                        <button
                          type="button"
                          onClick={() => remove(row)}
                          disabled={deletingId === row.id}
                          title="Delete deal"
                          aria-label={`Delete itinerary ${row.destination}`}
                          style={{
                            ...iconBtnStyle,
                            opacity: deletingId === row.id ? 0.4 : 1,
                            cursor: deletingId === row.id ? "wait" : "pointer",
                            color: "var(--danger-color, #A8323F)",
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TopScrollSync>
        )}

        {/* Load more */}
        {!loading && itineraries.length < total && (
          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border-light)", textAlign: "center" }}>
            <button type="button" onClick={loadMore} style={secondaryBtn}>
              Load more ({total - itineraries.length} remaining)
            </button>
          </div>
        )}
        {loading && itineraries.length > 0 && (
          <div style={{ padding: "10px 16px", textAlign: "center", fontSize: 13, color: "var(--text-secondary)" }}>
            Loading…
          </div>
        )}
      </div>

      {/* Create drawer */}
      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setCreating(false); }}
          style={overlayStyle}
        >
          <form
            onSubmit={submitCreate}
            className="card"
            role="dialog"
            aria-modal="true"
            aria-label="New deal"
            style={drawerStyle}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>New Deal</h2>
              <button type="button" onClick={() => setCreating(false)} style={closeBtn} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Contact */}
              <label style={labelStyle}>
                Contact
                <select
                  required
                  value={form.contactId}
                  onChange={(e) => setForm({ ...form, contactId: e.target.value })}
                  style={inputStyle}
                >
                  <option value="">— select a contact —</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ""}</option>
                  ))}
                </select>
              </label>

              {/* Sub-brand */}
              <label style={labelStyle}>
                Sub-brand
                <select
                  value={form.subBrand}
                  onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                  style={inputStyle}
                >
                  {SUB_BRAND_OPTIONS.filter((o) => o.value).map((o) => (
                    <option key={o.value} value={o.value}
                      disabled={allowedSubBrands && allowedSubBrands.length > 0 && !allowedSubBrands.includes(o.value)}
                    >
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* Destination */}
              <label style={labelStyle}>
                Destination / Tour title
                <input
                  required
                  type="text"
                  value={form.destination}
                  onChange={(e) => setForm({ ...form, destination: e.target.value })}
                  style={inputStyle}
                  placeholder="e.g. Bali Honeymoon 7N/8D"
                />
              </label>

              {/* Package cost + currency */}
              <div style={{ display: "flex", gap: 10 }}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Package cost (optional)
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={form.totalAmount}
                    onChange={(e) => setForm({ ...form, totalAmount: e.target.value })}
                    style={inputStyle}
                    placeholder="0"
                  />
                </label>
                <label style={{ ...labelStyle, width: 90 }}>
                  Currency
                  <select
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    style={inputStyle}
                  >
                    {["INR", "USD", "EUR", "GBP", "AED"].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Travel dates */}
              <div style={{ display: "flex", gap: 10 }}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Travel date (optional)
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                    style={inputStyle}
                  />
                </label>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Return date (optional)
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    style={inputStyle}
                    min={form.startDate || undefined}
                  />
                </label>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
              <button type="button" onClick={() => setCreating(false)} style={secondaryBtn}>
                Cancel
              </button>
              <button type="submit" disabled={saving} style={primaryBtn}>
                {saving ? "Creating…" : "Create Deal"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ─── StatusDropdown ───────────────────────────────────────────────────────
//
// Renders a styled <select> that matches the current status's colour pill.
// When `disabled` is true (update in flight) it shows a spinner-like faded
// state.
function StatusDropdown({ id: _id, current, disabled, onChange }) {
  const s = STATUS_STYLE[current] || { bg: "#20202a", color: "#9a9aa5" };
  const bgColor = s.solidBg || s.bg;
  return (
    <select
      value={current || ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Change status"
      style={{
        background: bgColor,
        color: s.color,
        border: `1px solid ${s.color}40`,
        borderRadius: 20,
        padding: "5px 28px 5px 10px",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.6 : 1,
        appearance: "none",
        WebkitAppearance: "none",
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='${encodeURIComponent(s.color)}'/%3E%3C/svg%3E")`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 8px center",
        minWidth: 120,
      }}
    >
      {EDITABLE_STATUSES.map((o) => (
        <option key={o.value} value={o.value}
          style={{ background: "#16161d", color: "#f3f3f5" }}
        >
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const selectStyle = {
  padding: "7px 10px", borderRadius: 8,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 13, minWidth: 140,
};

const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 8,
  fontSize: 13, fontWeight: 600, cursor: "pointer",
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  border: "1px solid var(--primary-color, var(--accent-color))",
  whiteSpace: "nowrap",
};

const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: "pointer",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  whiteSpace: "nowrap",
};

const thStyle = {
  textAlign: "left", padding: "12px 14px",
  fontSize: 11.5, letterSpacing: "0.04em",
  fontWeight: 600, textTransform: "uppercase",
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "12px 14px",
  fontSize: 13.5,
  color: "var(--text-primary)",
  verticalAlign: "middle",
};

const emptyStyle = {
  padding: 40, textAlign: "center",
  fontSize: 14, color: "var(--text-secondary)",
};

const iconBtnStyle = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 30, height: 30, borderRadius: 7,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer", textDecoration: "none",
  fontSize: 14,
};

const overlayStyle = {
  position: "fixed", inset: 0,
  background: "rgba(0,0,0,0.55)",
  backdropFilter: "blur(4px)",
  WebkitBackdropFilter: "blur(4px)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 1000, padding: "1rem",
};

const drawerStyle = {
  background: "var(--bg-color, var(--surface-color))",
  color: "var(--text-primary)",
  width: "100%", maxWidth: 500,
  maxHeight: "90vh", overflowY: "auto",
  padding: "1.5rem",
};

const closeBtn = {
  background: "transparent", border: "none",
  color: "var(--text-secondary)", cursor: "pointer", padding: 4,
  display: "flex", alignItems: "center", justifyContent: "center",
};

const labelStyle = {
  display: "flex", flexDirection: "column", gap: 5,
  fontSize: 12, color: "var(--text-secondary)", fontWeight: 500,
};

const inputStyle = {
  padding: "8px 10px", borderRadius: 7,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))",
  color: "var(--text-primary)", fontSize: 14,
};
