// Travel CRM — Invoices admin page.
//
// Lands at /travel/invoices-admin. Operator-facing list of TravelInvoice
// rows — Draft / Issued / Partial / Paid / Voided. CRUD wires to the
// /api/travel/invoices endpoints (commit b2a9dcb):
//   GET    /api/travel/invoices                    list (filters:
//                                                  subBrand / status /
//                                                  contactId / quoteId)
//   POST   /api/travel/invoices                    create (ADMIN+MANAGER);
//                                                  invoiceNum is server-
//                                                  assigned (TINV-YYYY-NNNN)
//   PUT    /api/travel/invoices/:id                edit (ADMIN+MANAGER);
//                                                  invoiceNum immutable;
//                                                  forward-only status
//                                                  transitions enforced
//                                                  server-side
//   DELETE /api/travel/invoices/:id                hard-delete (returns 204).
//                                                  ONLY Draft may be
//                                                  deleted; other statuses
//                                                  return 422
//                                                  INVOICE_DELETE_FORBIDDEN
//                                                  so the audit trail stays
//                                                  intact for Voided rows.
//
// Template: cloned from frontend/src/pages/travel/QuotesAdmin.jsx
// (commit aaf8cb2) — the canonical pattern for operator admin pages on
// the travel-vertical fork models (Quote / Invoice / Supplier trio).
// Empty-state honors the #829 permission-denied vs no-rows distinction.
//
// Status-transition matrix (forward-only, any -> Voided always allowed):
//   Draft   -> Issued | Voided
//   Issued  -> Partial | Paid | Voided
//   Partial -> Paid | Voided
//   Paid    -> Voided
//   Voided  -> (terminal)
//
// Frontend mirrors the matrix in EDIT mode — the status <select> in the
// modal only shows the current status + the legal next-states. CREATE
// mode allows any starting status (Draft is the sensible default).

import { useEffect, useState, useContext } from "react";
import { Receipt, Plus, Pencil, Trash2, FileDown } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { formatMoney } from "../../utils/money";
import { SUB_BRAND_BG } from "../../utils/travelSubBrand";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const INVOICE_STATUSES = [
  { value: "", label: "All statuses" },
  { value: "Draft", label: "Draft" },
  { value: "Issued", label: "Issued" },
  { value: "Partial", label: "Partial" },
  { value: "Paid", label: "Paid" },
  { value: "Voided", label: "Voided" },
];

// SUB_BRAND_BG now imported from ../../utils/travelSubBrand (rule-of-3
// promotion 2026-05-24 tick #99 — this file was the third caller that
// triggered the extraction; the inline copy here was an explicit hold to
// give the extraction clean call sites to work from).

// Status pill background — matches the lightweight badge palette used
// by QuotesAdmin's STATUS_BG. Voided is rendered with a strike-through
// in the row cell to make the terminal state obvious at a glance.
const STATUS_BG = {
  Draft: "rgba(148, 163, 184, 0.18)",     // slate (gray)
  Issued: "rgba(59, 130, 246, 0.18)",     // blue
  Partial: "rgba(245, 158, 11, 0.18)",    // amber
  Paid: "rgba(34, 197, 94, 0.18)",        // green
  Voided: "rgba(244, 63, 94, 0.18)",      // rose (red)
};
const STATUS_COLOR = {
  Draft: "var(--text-secondary)",
  Issued: "#3b82f6",
  Partial: "var(--warning-color, #f59e0b)",
  Paid: "var(--success-color, #22c55e)",
  Voided: "var(--danger-color, #f43f5e)",
};

// Forward-only transition map — mirror of backend ALLOWED_TRANSITIONS.
// Used by the EDIT modal to narrow the <select> options. The backend is
// the source of truth — even if this map drifts, server-side enforcement
// still kicks the bad transition out with 422 INVALID_INVOICE_TRANSITION.
const ALLOWED_TRANSITIONS = {
  Draft: ["Issued", "Voided"],
  Issued: ["Partial", "Paid", "Voided"],
  Partial: ["Paid", "Voided"],
  Paid: ["Voided"],
  Voided: [],
};

const EMPTY_FORM = {
  contactId: "",
  totalAmount: "",
  currency: "INR",
  status: "Draft",
  dueDate: "",
  quoteId: "",
  subBrand: "tmc",
};

// Tomorrow as default for the dueDate date picker. Backend accepts any
// parseable date (back-dated invoices are legitimate ops) so this is a
// UX default, not a hard validation floor. Pattern mirrors QuotesAdmin's
// tomorrowISO + the CLAUDE.md date-boundary standing rule on
// unambiguous-future defaults.
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

export default function InvoicesAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [invoices, setInvoices] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // #829 — distinguish 403 from genuine empty so the empty-state copy
  // honestly says "Access restricted" instead of "No invoices match."
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [subBrand, setSubBrand] = useState("");
  const [status, setStatus] = useState("");
  const [contactIdFilter, setContactIdFilter] = useState("");
  const [quoteIdFilter, setQuoteIdFilter] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingStatus, setEditingStatus] = useState(null); // server-side starting status, drives transition narrowing
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // Per-row PDF download in-flight tracker. Holds the invoice.id while its
  // GET /:id/pdf is hitting the server so the action button can flip to
  // "Downloading…" and be disabled (defence against double-click producing
  // two browser-side downloads of the same blob).
  const [downloadingId, setDownloadingId] = useState(null);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (status) qs.set("status", status);
    if (contactIdFilter.trim()) qs.set("contactId", contactIdFilter.trim());
    if (quoteIdFilter.trim()) qs.set("quoteId", quoteIdFilter.trim());
    const url = `/api/travel/invoices${qs.toString() ? `?${qs.toString()}` : ""}`;
    fetchApi(url)
      .then((d) => {
        const rows = Array.isArray(d?.invoices) ? d.invoices : [];
        setInvoices(rows);
        setTotal(Number.isFinite(d?.total) ? d.total : 0);
        setPermissionDenied(false);
      })
      .catch((err) => {
        setInvoices([]);
        setTotal(0);
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [subBrand, status, contactIdFilter, quoteIdFilter]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setEditingStatus(null);
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (inv) => {
    setForm({
      contactId: inv.contactId == null ? "" : String(inv.contactId),
      totalAmount: inv.totalAmount == null ? "" : String(inv.totalAmount),
      currency: inv.currency || "INR",
      status: inv.status || "Draft",
      dueDate: inv.dueDate ? inv.dueDate.slice(0, 10) : "",
      quoteId: inv.quoteId == null ? "" : String(inv.quoteId),
      subBrand: inv.subBrand || "tmc",
    });
    setEditingId(inv.id);
    setEditingStatus(inv.status || "Draft");
    setShowForm(true);
  };

  // Allowed status options inside the modal. CREATE mode is unconstrained
  // (operator picks the starting status). EDIT mode = current status +
  // its allowed next-states. Backend enforces the same matrix; this just
  // gives a cleaner UI than letting the operator pick a backward
  // transition that will 422.
  const statusOptionsForModal = () => {
    if (!editingId) {
      return INVOICE_STATUSES.filter((s) => s.value);
    }
    const current = editingStatus || "Draft";
    const next = ALLOWED_TRANSITIONS[current] || [];
    const labels = new Set([current, ...next]);
    return INVOICE_STATUSES.filter((s) => s.value && labels.has(s.value));
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
    if (!form.dueDate) {
      notify.error("Due date is required");
      return;
    }
    setSaving(true);
    try {
      // quoteId is optional FK — omit entirely if blank (backend would
      // accept null too but staying consistent with QuotesAdmin's omit-
      // when-blank convention keeps the request body minimal).
      const payload = {
        contactId: contactIdInt,
        totalAmount: totalAmountNum,
        currency: form.currency,
        status: form.status || "Draft",
        subBrand: form.subBrand || "tmc",
        dueDate: form.dueDate,
      };
      if (form.quoteId && form.quoteId.trim()) {
        const qid = parseInt(form.quoteId.trim(), 10);
        if (Number.isFinite(qid)) payload.quoteId = qid;
      }
      if (editingId) {
        await fetchApi(`/api/travel/invoices/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Invoice #${editingId} updated`);
      } else {
        await fetchApi("/api/travel/invoices", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        notify.success(`Invoice for contact ${contactIdInt} created`);
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

  const handleDelete = async (inv) => {
    if (inv.status !== "Draft") {
      // Belt-and-braces: the button itself is disabled, but a
      // keyboard-focused click could still reach here.
      notify.error(`Only Draft invoices may be deleted (current: ${inv.status})`);
      return;
    }
    if (!confirm(`Delete invoice ${inv.invoiceNum} for contact ${inv.contactId}? (Hard delete — no undo.)`)) return;
    try {
      await fetchApi(`/api/travel/invoices/${inv.id}`, { method: "DELETE" });
      notify.success(`Invoice ${inv.invoiceNum} deleted`);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Delete failed");
    }
  };

  // GET /api/travel/invoices/:id/pdf returns a PDF Buffer with
  // Content-Type=application/pdf + Content-Disposition=attachment;
  // filename="invoice-<id>.pdf" (shipped commit e1f994b0). We can't go
  // through fetchApi() here because that helper JSON-parses every 2xx
  // body — for a binary PDF we need raw fetch + Authorization header +
  // .blob(). Mirrors the Estimates.jsx / Invoices.jsx per-row pattern
  // (commit `#603` family) which has shipped tests pinning the same
  // shape. Errors flow into notify.error('Failed to download PDF').
  const downloadPdf = async (inv) => {
    if (!inv?.id) {
      notify.error("Save the invoice first before downloading PDF");
      return;
    }
    setDownloadingId(inv.id);
    try {
      const token = getAuthToken();
      const baseUrl = import.meta.env.VITE_API_URL || "";
      const resp = await fetch(`${baseUrl}/api/travel/invoices/${inv.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) {
        notify.error("Failed to download PDF");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${inv.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify.error(err?.message || "Failed to download PDF");
    } finally {
      setDownloadingId(null);
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
            <Receipt size={26} aria-hidden /> Travel Invoices
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
            Customer invoices — Draft / Issued / Partial / Paid / Voided. {total.toLocaleString()} invoice{total === 1 ? "" : "s"}.
          </p>
        </div>
        {canWrite && (
          <button type="button" onClick={openCreate} style={primaryBtn}>
            <Plus size={14} /> New Invoice
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
          {INVOICE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <input
          type="text"
          placeholder="Filter by contact ID…"
          value={contactIdFilter}
          onChange={(e) => setContactIdFilter(e.target.value)}
          style={{ ...selectStyle, minWidth: 180 }}
          aria-label="Filter by contact ID"
        />
        <input
          type="text"
          placeholder="Filter by quote ID…"
          value={quoteIdFilter}
          onChange={(e) => setQuoteIdFilter(e.target.value)}
          style={{ ...selectStyle, minWidth: 180 }}
          aria-label="Filter by quote ID"
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
          <input
            type="date"
            required
            min={editingId ? undefined : tomorrowISO()}
            value={form.dueDate}
            onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            style={inputStyle}
            aria-label="Due date"
            title="Due date"
          />
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            style={inputStyle}
            aria-label="Status"
          >
            {statusOptionsForModal().map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <input
            placeholder="Quote ID (optional)"
            type="number"
            value={form.quoteId}
            onChange={(e) => setForm({ ...form, quoteId: e.target.value })}
            style={inputStyle}
            aria-label="Quote ID"
          />
          <select
            value={form.subBrand}
            onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
            style={inputStyle}
            aria-label="Sub-brand"
          >
            {SUB_BRANDS.filter((s) => s.value).map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
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
                <th style={th}>Invoice #</th>
                <th style={th}>Contact</th>
                <th style={th}>Status</th>
                <th style={th}>Total</th>
                <th style={th}>Currency</th>
                <th style={th}>Due Date</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Paid At</th>
                {canWrite && <th style={{ ...th, textAlign: "center" }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const isVoided = inv.status === "Voided";
                const canDelete = inv.status === "Draft";
                return (
                  <tr
                    key={inv.id}
                    style={{
                      borderTop: "1px solid rgba(255,255,255,0.04)",
                      // Strike-through the entire row for voided invoices to
                      // make the terminal state unmistakable at a glance.
                      textDecoration: isVoided ? "line-through" : "none",
                      opacity: isVoided ? 0.7 : 1,
                    }}
                  >
                    <td style={{ ...td, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>
                      {inv.invoiceNum || "—"}
                    </td>
                    <td style={td}><strong>#{inv.contactId}</strong></td>
                    <td style={td}>
                      <span
                        style={{
                          ...statusBadge,
                          background: STATUS_BG[inv.status] || "rgba(255,255,255,0.08)",
                          color: STATUS_COLOR[inv.status] || "var(--text-primary)",
                        }}
                      >
                        {inv.status || "—"}
                      </span>
                    </td>
                    <td style={td}>{formatMoney(inv.totalAmount, { currency: inv.currency || "INR" })}</td>
                    <td style={td}>{inv.currency || "—"}</td>
                    <td style={td}>{formatDate(inv.dueDate)}</td>
                    <td style={td}>
                      <span style={{ ...brandBadge, background: SUB_BRAND_BG[inv.subBrand] || "rgba(255,255,255,0.08)" }}>
                        {inv.subBrand || "—"}
                      </span>
                    </td>
                    <td style={td}>{formatDate(inv.paidAt)}</td>
                    {canWrite && (
                      <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          onClick={() => openEdit(inv)}
                          title={`Edit invoice ${inv.invoiceNum}`}
                          aria-label={`Edit invoice ${inv.invoiceNum}`}
                          style={iconBtn}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadPdf(inv)}
                          // Defensive: NEW rows in-flight wouldn't have an id
                          // yet (won't appear in this list, but guarded anyway)
                          // + disable while the in-flight download is active so
                          // a double-click doesn't trigger two browser saves.
                          disabled={!inv?.id || downloadingId === inv.id}
                          title={
                            downloadingId === inv.id
                              ? "Downloading…"
                              : `Download PDF for invoice ${inv.invoiceNum}`
                          }
                          aria-label={`Download PDF for invoice ${inv.invoiceNum}`}
                          style={{
                            ...iconBtn,
                            opacity: downloadingId === inv.id ? 0.5 : 1,
                            cursor: downloadingId === inv.id ? "wait" : "pointer",
                          }}
                        >
                          {downloadingId === inv.id ? (
                            <span style={{ fontSize: 11, fontWeight: 600 }}>Downloading…</span>
                          ) : (
                            <FileDown size={16} />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(inv)}
                          disabled={!canDelete}
                          // Tooltip explains the audit-trail reason — Voided
                          // rows MUST stay so the historical chain is intact.
                          title={
                            canDelete
                              ? `Delete invoice ${inv.invoiceNum}`
                              : "Only Draft invoices may be deleted (Voided required for issued/paid — audit trail)"
                          }
                          aria-label={
                            canDelete
                              ? `Delete invoice ${inv.invoiceNum}`
                              : `Delete disabled for ${inv.status} invoice`
                          }
                          style={{
                            ...iconBtn,
                            color: canDelete ? "var(--danger-color, #f43f5e)" : "var(--text-secondary)",
                            opacity: canDelete ? 1 : 0.4,
                            cursor: canDelete ? "pointer" : "not-allowed",
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {invoices.length === 0 && (
                <tr>
                  <td
                    colSpan={canWrite ? 9 : 8}
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
                          Your role does not have permission to view travel invoices. Ask an Admin to grant access if you need it.
                        </div>
                      </>
                    ) : (
                      <>
                        <Receipt size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
                        <div>No invoices match.</div>
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
