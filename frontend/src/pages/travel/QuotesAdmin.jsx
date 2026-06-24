// Travel CRM — Quotes admin page.
//
// Lands at /travel/quotes-admin. Operator-facing list of TravelQuote rows —
// Draft / Sent / Accepted / Rejected. CRUD wires to the
// /api/travel/quotes endpoints (commit b02c091):
//   GET    /api/travel/quotes                      list (filters: subBrand / status)
//   POST   /api/travel/quotes                      create (ADMIN+MANAGER)
//   PUT    /api/travel/quotes/:id                  edit   (ADMIN+MANAGER)
//   DELETE /api/travel/quotes/:id                  hard-delete (returns 204)
//
// Template: cloned from frontend/src/pages/travel/SuppliersAdmin.jsx
// (commit 08ebe5e) — the canonical pattern for operator admin pages on
// the travel-vertical fork models (Quote / Billing / Supplier trio).
// Empty-state honors the #829 permission-denied vs no-rows distinction.
//
// Backend validation:
// - contactId (required, integer), totalAmount (required), currency (required)
// - status ∈ { Draft, Sent, Accepted, Rejected } (default "Draft")
// - validUntil — optional, must be today-or-future (parseable date)
// - subBrand — optional, defaults to "tmc"; sub-brand isolation enforced
//   server-side via getSubBrandAccessSet.

import { useEffect, useState, useContext } from "react";
import { Link } from "react-router-dom";
import { Receipt, Plus, Pencil, Trash2, Calculator } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { usePermissions } from "../../hooks/usePermissions";
import { formatMoney } from "../../utils/money";
import {
  SUB_BRAND_BG,
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";
import { useActiveSubBrand } from "../../utils/subBrand";
// Branding Wave 4 G102: per-sub-brand brand-kit lookup. Drives the primary
// CTA tint from BrandKit.primaryColor when a kit is active, falling back to
// the standing-rule `var(--primary-color, var(--accent-color))` CSS var.
import { useBrandKit, brandPrimaryColor } from "../../hooks/useBrandKit";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const QUOTE_STATUSES = [
  { value: "", label: "All statuses" },
  { value: "Draft", label: "Draft" },
  { value: "Sent", label: "Sent" },
  { value: "Accepted", label: "Accepted" },
  { value: "Rejected", label: "Rejected" },
];

// SUB_BRAND_BG now imported from ../../utils/travelSubBrand (rule-of-3
// promotion 2026-05-24 tick #99 — inline copy was a verbatim mirror of
// SuppliersAdmin's; promoted once InvoicesAdmin landed as the third caller).

// Status pill background — matches the lightweight badge palette used
// elsewhere in the travel admin pages.
const STATUS_BG = {
  Draft: "rgba(148, 163, 184, 0.18)",     // slate
  Sent: "rgba(59, 130, 246, 0.18)",       // blue
  Accepted: "rgba(34, 197, 94, 0.18)",    // green
  Rejected: "rgba(244, 63, 94, 0.18)",    // rose
};
const STATUS_COLOR = {
  Draft: "var(--text-secondary)",
  Sent: "#3b82f6",
  Accepted: "var(--success-color, #22c55e)",
  Rejected: "var(--danger-color, #f43f5e)",
};

const EMPTY_FORM = {
  contactId: "",
  totalAmount: "",
  currency: "INR",
  status: "Draft",
  validUntil: "",
  subBrand: "tmc",
};

// Tomorrow as min for the validUntil date picker. Backend accepts
// "today or future" but using tomorrow eliminates the TZ-window flake
// class (see CLAUDE.md standing rule on date-boundary tests).
function tomorrowISO() {
  const d = new Date(Date.now() + 86_400_000);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

export default function QuotesAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  // G102: BrandKit lookup. Module-level cache means re-mounts of QuotesAdmin
  // never re-fetch; safe to call unconditionally here.
  const { brandKit } = useBrandKit(activeSubBrand);
  const primaryBtnBranded = { ...primaryBtn, background: brandPrimaryColor(brandKit) };
  // Permission-driven action visibility. Backend routes already gate
  // each action with requirePermission(quotes, <action>); the UI checks
  // mirror those gates so buttons hide entirely when the role lacks the
  // grant. The legacy `canWrite = user.role === 'ADMIN' || …` check
  // was replaced 2026-06-15 — role-name gates can't reflect custom
  // roles configured via Roles & Permissions.
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission("quotes", "write");
  const canEdit = hasPermission("quotes", "update");
  const canDelete = hasPermission("quotes", "delete");
  // Combined for table-column rendering — show the Actions column if
  // ANY mutation is permitted.
  const canWrite = canCreate || canEdit || canDelete;

  // Sub-brand the create/edit form may assign. Single-brand users are locked
  // to their one brand (field rendered read-only); multi-brand users get a
  // dropdown limited to THEIR brands. Mirrors Leads.jsx.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const [quotes, setQuotes] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // #829 — distinguish 403 from genuine empty so the empty-state copy
  // honestly says "Access restricted" instead of "No quotes match."
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [subBrand, setSubBrand] = useState("");
  const [status, setStatus] = useState("");
  const [contactIdFilter, setContactIdFilter] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (status) qs.set("status", status);
    const url = `/api/travel/quotes${qs.toString() ? `?${qs.toString()}` : ""}`;
    fetchApi(url)
      .then((d) => {
        let rows = Array.isArray(d?.quotes) ? d.quotes : [];
        // contactId filter is client-side — backend doesn't expose a
        // ?contactId query param yet. Filter narrows the visible window
        // returned by the limit-bounded list.
        if (contactIdFilter.trim()) {
          const needle = contactIdFilter.trim();
          rows = rows.filter((q) => String(q.contactId).includes(needle));
        }
        setQuotes(rows);
        setTotal(Number.isFinite(d?.total) ? d.total : 0);
        setPermissionDenied(false);
      })
      .catch((err) => {
        setQuotes([]);
        setTotal(0);
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => setLoading(false));
  };

  // Sync the global sub-brand selector (sidebar) into the local filter so this
  // list re-scopes when the user switches brand — consistent with InvoicesAdmin
  // and the other travel modules. Without this the page ignored the global
  // selector entirely (only the in-page dropdown filtered).
  useEffect(() => {
    setSubBrand(activeSubBrand || "");
  }, [activeSubBrand]);

  useEffect(load, [subBrand, status, contactIdFilter]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
    setShowForm(true);
  };

  const openEdit = (q) => {
    setForm({
      contactId: q.contactId == null ? "" : String(q.contactId),
      totalAmount: q.totalAmount == null ? "" : String(q.totalAmount),
      currency: q.currency || "INR",
      status: q.status || "Draft",
      validUntil: q.validUntil ? q.validUntil.slice(0, 10) : "",
      subBrand: q.subBrand || "tmc",
    });
    setEditingId(q.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const contactIdInt = parseInt(form.contactId, 10);
    if (!Number.isFinite(contactIdInt)) {
      notify.error("Contact ID is required (must be a number)");
      return;
    }
    const totalAmountNum = parseFloat(form.totalAmount);
    if (!Number.isFinite(totalAmountNum)) {
      notify.error("Total amount is required (must be a number)");
      return;
    }
    if (!form.currency) {
      notify.error("Currency is required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        contactId: contactIdInt,
        totalAmount: totalAmountNum,
        currency: form.currency,
        status: form.status || "Draft",
        subBrand: form.subBrand || "tmc",
        // Empty string -> omit so backend treats as "no change" on PUT
        // and as "no validUntil" on POST.
        validUntil: form.validUntil || null,
      };
      if (editingId) {
        await fetchApi(`/api/travel/quotes/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Quote #${editingId} updated`);
      } else {
        await fetchApi("/api/travel/quotes", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        notify.success(`Quote for contact ${contactIdInt} created`);
      }
      setShowForm(false);
      resetForm();
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (q) => {
    if (!confirm(`Delete quote #${q.id} for contact ${q.contactId}? (Hard delete — no undo.)`)) return;
    try {
      await fetchApi(`/api/travel/quotes/${q.id}`, { method: "DELETE" });
      notify.success(`Quote #${q.id} deleted`);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Delete failed");
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto", animation: "fadeIn 0.4s ease-out" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: "1.75rem", fontWeight: 600 }}>
            <Receipt size={26} aria-hidden /> Travel Quotes
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
            Customer quotes — Draft / Sent / Accepted / Rejected. {total.toLocaleString()} quote{total === 1 ? "" : "s"}.
          </p>
        </div>
        {canCreate && (
          <button type="button" onClick={openCreate} style={primaryBtnBranded}>
            <Plus size={14} /> New Quote
          </button>
        )}
      </header>

      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <select value={subBrand} onChange={(e) => setSubBrand(e.target.value)} style={selectStyle} aria-label="Filter by sub-brand">
          {SUB_BRANDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle} aria-label="Filter by status">
          {QUOTE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <input
          type="text"
          placeholder="Filter by contact ID…"
          value={contactIdFilter}
          onChange={(e) => setContactIdFilter(e.target.value)}
          style={{ ...selectStyle, minWidth: 200 }}
          aria-label="Filter by contact ID"
        />
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="glass"
          style={{
            padding: 16,
            marginBottom: 16,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            gap: 10,
            alignItems: "end",
          }}
        >
          <input
            placeholder="Contact ID *"
            required
            type="number"
            value={form.contactId}
            onChange={(e) => setForm({ ...form, contactId: e.target.value })}
            style={inputStyle}
            aria-label="Contact ID"
          />
          <input
            placeholder="Total amount *"
            required
            type="number"
            step="0.01"
            value={form.totalAmount}
            onChange={(e) => setForm({ ...form, totalAmount: e.target.value })}
            style={inputStyle}
            aria-label="Total amount"
          />
          <input
            placeholder="Currency *"
            required
            type="text"
            maxLength={3}
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
            style={inputStyle}
            aria-label="Currency"
          />
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            style={inputStyle}
            aria-label="Status"
          >
            {QUOTE_STATUSES.filter((s) => s.value).map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <input
            type="date"
            min={tomorrowISO()}
            value={form.validUntil}
            onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
            style={inputStyle}
            aria-label="Valid until"
          />
          {lockedBrand ? (
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
              aria-label="Sub-brand"
            >
              {myBrands.map((b) => (
                <option key={b} value={b}>{subBrandShortLabel(b)}</option>
              ))}
            </select>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={saving} style={{ ...primaryBtn, background: "var(--success-color, var(--primary-color))" }}>
              {saving ? "Saving…" : editingId ? "Save Changes" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); resetForm(); }}
              style={secondaryBtn}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div
        className="glass"
        style={{ padding: 0, overflow: "hidden" }}
      >
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <th style={th}>Contact</th>
                <th style={th}>Status</th>
                <th style={th}>Total</th>
                <th style={th}>Currency</th>
                <th style={th}>Valid Until</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Created</th>
                {canWrite && <th style={{ ...th, textAlign: "center" }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={td}><strong>#{q.contactId}</strong></td>
                  <td style={td}>
                    <span
                      style={{
                        ...statusBadge,
                        background: STATUS_BG[q.status] || "rgba(255,255,255,0.08)",
                        color: STATUS_COLOR[q.status] || "var(--text-primary)",
                      }}
                    >
                      {q.status || "—"}
                    </span>
                  </td>
                  <td style={td}>{formatMoney(q.totalAmount, { currency: q.currency || "INR" })}</td>
                  <td style={td}>{q.currency || "—"}</td>
                  <td style={td}>{formatDate(q.validUntil)}</td>
                  <td style={td}>
                    <span style={{ ...brandBadge, background: SUB_BRAND_BG[q.subBrand] || "rgba(255,255,255,0.08)" }}>
                      {q.subBrand || "—"}
                    </span>
                  </td>
                  <td style={td}>{formatDate(q.createdAt)}</td>
                  {canWrite && (
                    <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                      {/* Per-action gating — Edit and Delete have
                          independent catalog actions (quotes.update vs
                          quotes.delete), so a role with update-only
                          shouldn't see Delete and vice-versa. */}
                      {/* Open the FULL builder (plan trip, flight/hotel/transfer
                          search, line + room editing) for this quote — the inline
                          pencil only edits the header fields. */}
                      <Link
                        to={`/travel/quotes/builder/${q.id}`}
                        title={`Open quote #${q.id} in the builder`}
                        aria-label={`Open quote #${q.id} in the builder`}
                        style={{ ...iconBtn, display: "inline-flex", textDecoration: "none", color: "var(--primary-color, var(--accent-color))" }}
                      >
                        <Calculator size={16} />
                      </Link>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => openEdit(q)}
                          title={`Quick-edit quote #${q.id} header`}
                          aria-label={`Quick-edit quote #${q.id} header`}
                          style={iconBtn}
                        >
                          <Pencil size={16} />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => handleDelete(q)}
                          title={`Delete quote #${q.id}`}
                          aria-label={`Delete quote #${q.id}`}
                          style={{ ...iconBtn, color: "var(--danger-color, #f43f5e)" }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {quotes.length === 0 && (
                <tr>
                  <td
                    colSpan={canWrite ? 8 : 7}
                    style={{
                      ...td,
                      textAlign: "center",
                      color: permissionDenied ? "var(--warning-color, #f59e0b)" : "var(--text-secondary)",
                      padding: permissionDenied ? "2rem 1rem" : "1.5rem 1rem",
                    }}
                  >
                    {/* #829 — honest empty-state when API returned 403. */}
                    {permissionDenied ? (
                      <>
                        <strong>Access restricted.</strong>
                        <div style={{ fontSize: "0.85rem", marginTop: "0.5rem", color: "var(--text-secondary)" }}>
                          Your role does not have permission to view travel quotes. Ask an Admin to grant access if you need it.
                        </div>
                      </>
                    ) : (
                      <>
                        <Receipt size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
                        <div>No quotes match.</div>
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
  fontWeight: 600,
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
};
const selectStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  minWidth: 160,
  fontSize: 13,
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  cursor: "pointer",
};
const iconBtn = {
  padding: 6,
  borderRadius: 4,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "none",
  cursor: "pointer",
  marginRight: 4,
};
const brandBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-primary)",
};
const statusBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
};
