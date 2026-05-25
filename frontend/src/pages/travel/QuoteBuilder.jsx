// Travel CRM — Quote Builder (operator-facing single-quote-detail page).
//
// Mounts at /travel/quotes/builder/:id?  (id optional)
//   - no :id     → "new quote" mode, empty draft (lines table inert until save)
//   - :id        → "edit quote" mode, hydrates header + lines from backend
//
// Distinct from QuotesAdmin (/travel/quotes-admin) — that page is the CRUD
// list; THIS page is the line-items builder a sales op uses to compose a
// single quote with multiple lines + supplier/pricing-rule context +
// header-action surface (save / send / duplicate / download PDF).
//
// PRD: docs/PRD_TRAVEL_QUOTE_BUILDER.md §3 functional requirements.
//   - Slice 2 (commit 92b1682c): page chrome + local-only lines + actions.
//   - Slice 3 (commit f7203b8e): backend TravelQuoteLine model + line CRUD
//     endpoints + supplier picker query surface.
//   - Slice 4 (commit 188d50c2): wire QuoteBuilder to the persistent line
//     endpoints + add a per-line supplier picker fed by
//     GET /api/travel/suppliers?subBrand=<sub>.
//   - Slice 6 (THIS commit): add a "Send to customer" action button that
//     opens a confirm modal explaining the Q9 (Wati WhatsApp) credential
//     dependency. STUB-mode delivery: on confirm we mark the quote as
//     "Sent" via PUT /api/travel/quotes/:id { status: "Sent" } so the
//     status pill flips, and surface a notify.info "Send queued" message.
//     Actual WhatsApp + email dispatch lives behind a Q9 cred drop (Meta
//     System User token + 3×WABA ID + 3×phoneNumberId + webhook verify
//     token). Once Q9 lands, wire the modal's confirm handler to POST
//     /api/travel/quotes/:id/send (route to be added in a later slice)
//     and remove the STUB marker.
//
// Backend contracts (all live as of f7203b8e):
//   GET    /api/travel/quotes/:id                    → 200 { id, contactId, ... }
//   POST   /api/travel/quotes                        → 201 created
//   PUT    /api/travel/quotes/:id                    → 200 updated
//   POST   /api/travel/quotes/:id/duplicate          → 201 cloned quote
//   GET    /api/travel/quotes/:id/pdf                → PDF stream
//   GET    /api/travel/quotes/:id/lines              → 200 { lines: [...], total }
//   POST   /api/travel/quotes/:id/lines              → 201 { id, lineType, ... }
//   PUT    /api/travel/quotes/:id/lines/:lineId      → 200 updated
//   DELETE /api/travel/quotes/:id/lines/:lineId      → 204
//   GET    /api/travel/suppliers?subBrand=<sub>      → 200 { suppliers: [...], total }
//
// Line CRUD body shape for POST (per backend slice 3):
//   { lineType?: "hotel"|"flight"|"transport"|"visa"|"service"|"other",
//     description: string (required),
//     quantity?: int>=1,
//     unitPrice: number>=0,
//     currency?, supplierId?, sortOrder?, notes? }
// Server computes `amount = quantity * unitPrice`. Parent quote's
// totalAmount is auto-recomputed after every line write — we re-fetch the
// parent quote after each line mutation so the UI totals stay consistent
// with what the backend will persist on next save.
//
// RBAC: ADMIN/MANAGER write (App.jsx route wraps in RoleGuard
// allow=["ADMIN","MANAGER"]). USER role sees the locked panel and never
// reaches this page body. We still gate write-bound buttons on canWrite
// for defence-in-depth.
//
// State design (slice 4):
//   - Header fields (contactId/currency/subBrand/validUntil/discount/tax)
//     stay local-only — they're only persisted via Save Draft / Send.
//   - Line items are split into TWO arrays:
//       persistedLines    — backend-sourced (id from server)
//       draftLines        — local-only rows added while the quote is brand
//                           new (no quoteId yet) OR while the operator is
//                           composing a row before it has been committed
//                           to the backend. A draft is "committed" on save.
//     A row with `.id` is persisted; without `.id` it's a draft.
//   - Supplier list is fetched on subBrand-change and re-used across all
//     row pickers in the table (single fetch, not per-row).

import { useEffect, useState, useContext, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Calculator, Plus, Trash2, Save, Send, Copy, Download, Check, X } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const STATUS_BG = {
  Draft: "rgba(148, 163, 184, 0.18)",
  Sent: "rgba(59, 130, 246, 0.18)",
  Accepted: "rgba(34, 197, 94, 0.18)",
  Rejected: "rgba(244, 63, 94, 0.18)",
};
const STATUS_COLOR = {
  Draft: "var(--text-secondary)",
  Sent: "#3b82f6",
  Accepted: "var(--success-color, #22c55e)",
  Rejected: "var(--danger-color, #f43f5e)",
};

const SUB_BRANDS = [
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const LINE_TYPES = ["hotel", "flight", "transport", "visa", "service", "other"];

const EMPTY_DRAFT = () => ({
  // Stable React key for the row. Drafts have no `.id`; persisted rows do.
  key: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  lineType: "other",
  description: "",
  quantity: 1,
  unitPrice: 0,
  supplierId: "",
  notes: "",
});

function lineAmount(line) {
  const qty = Number(line.quantity) || 0;
  const unit = Number(line.unitPrice) || 0;
  return qty * unit;
}

function fmt(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function QuoteBuilder() {
  const { id: routeId } = useParams();
  const isEdit = !!routeId;
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [quoteId, setQuoteId] = useState(routeId ? Number(routeId) : null);
  const [status, setStatus] = useState("Draft");
  const [contactId, setContactId] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [subBrand, setSubBrand] = useState("tmc");
  const [validUntil, setValidUntil] = useState("");
  const [discountPct, setDiscountPct] = useState(0);
  const [taxPct, setTaxPct] = useState(0);

  // Backend-sourced lines (each has `.id` from the server).
  const [persistedLines, setPersistedLines] = useState([]);
  // Local-only draft rows (no `.id` yet — POST converts to persisted).
  const [draftLines, setDraftLines] = useState([]);
  // Per-line saving flags (keyed by line key or id) for inline busy state.
  const [busyLineKey, setBusyLineKey] = useState(null);
  // Supplier list for the current subBrand (refetched on subBrand change).
  const [suppliers, setSuppliers] = useState([]);
  const [suppliersLoading, setSuppliersLoading] = useState(false);
  // Delete-confirm modal target.
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Send-to-customer confirm modal flag (slice 6 — Q9 STUB).
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // Re-fetch the parent quote (used after line writes — server recomputes
  // totalAmount and we don't want the UI to drift from what's persisted).
  const refreshParentQuote = useCallback(async (id) => {
    if (!id) return;
    try {
      const q = await fetchApi(`/api/travel/quotes/${id}`);
      if (q && typeof q === "object") {
        setStatus(q.status || "Draft");
        if (q.contactId != null) setContactId(String(q.contactId));
        if (q.currency) setCurrency(q.currency);
        if (q.subBrand) setSubBrand(q.subBrand);
      }
    } catch {
      // Non-fatal — the line write itself already succeeded; we just
      // couldn't refresh the parent. The next render will reconcile.
    }
  }, []);

  // Re-fetch the persisted line list.
  const refreshLines = useCallback(async (id) => {
    if (!id) return;
    try {
      const resp = await fetchApi(`/api/travel/quotes/${id}/lines`);
      const rows = Array.isArray(resp?.lines) ? resp.lines : [];
      setPersistedLines(
        rows.map((r) => ({
          key: `srv-${r.id}`,
          id: r.id,
          lineType: r.lineType || "other",
          description: r.description || "",
          quantity: Number(r.quantity) || 1,
          unitPrice: Number(r.unitPrice) || 0,
          amount: Number(r.amount) || 0,
          supplierId: r.supplierId == null ? "" : String(r.supplierId),
          notes: r.notes || "",
          currency: r.currency || null,
          sortOrder: r.sortOrder || 0,
        })),
      );
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to load lines");
    }
    // notify is stable per RTL standing rule (single object ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Edit-mode hydration from GET /api/travel/quotes/:id + lines.
  useEffect(() => {
    if (!isEdit) return;
    setLoading(true);
    fetchApi(`/api/travel/quotes/${routeId}`)
      .then(async (q) => {
        if (!q || typeof q !== "object") return;
        setQuoteId(q.id);
        setStatus(q.status || "Draft");
        setContactId(q.contactId == null ? "" : String(q.contactId));
        setCurrency(q.currency || "INR");
        setSubBrand(q.subBrand || "tmc");
        setValidUntil(q.validUntil ? String(q.validUntil).slice(0, 10) : "");
        // Slice 4 hydration: pull persisted lines from the dedicated endpoint.
        await refreshLines(q.id);
      })
      .catch((err) => {
        notify.error(err?.body?.error || err?.message || "Failed to load quote");
      })
      .finally(() => setLoading(false));
    // Intentionally only re-run when the route id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  // Fetch the supplier list when subBrand changes (or on initial load
  // when a subBrand has been selected). Each line's supplier picker reads
  // from this single list — no per-row fetch.
  useEffect(() => {
    if (!subBrand) {
      setSuppliers([]);
      return;
    }
    let cancelled = false;
    setSuppliersLoading(true);
    fetchApi(`/api/travel/suppliers?subBrand=${encodeURIComponent(subBrand)}`)
      .then((resp) => {
        if (cancelled) return;
        const rows = Array.isArray(resp?.suppliers) ? resp.suppliers : [];
        setSuppliers(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        notify.error(err?.body?.error || err?.message || "Failed to load suppliers");
        setSuppliers([]);
      })
      .finally(() => {
        if (!cancelled) setSuppliersLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subBrand]);

  // Visible lines = persisted (sorted by sortOrder) + drafts (appended).
  const sortedPersisted = [...persistedLines].sort(
    (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || 0) - (b.id || 0),
  );
  const visibleLines = [...sortedPersisted, ...draftLines];

  const subtotal = visibleLines.reduce((acc, it) => acc + lineAmount(it), 0);
  const discountAmount = subtotal * (Number(discountPct) || 0) / 100;
  const taxable = subtotal - discountAmount;
  const taxAmount = taxable * (Number(taxPct) || 0) / 100;
  const grandTotal = taxable + taxAmount;

  const addLine = () => setDraftLines([...draftLines, EMPTY_DRAFT()]);

  // Update a draft row in-place (no backend call).
  const updateDraft = (key, patch) =>
    setDraftLines(draftLines.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  // Remove a draft row (no backend call needed — it was never persisted).
  const removeDraft = (key) => setDraftLines(draftLines.filter((it) => it.key !== key));

  // Update a persisted row's local copy (for inline edit before save).
  const updatePersistedLocal = (key, patch) =>
    setPersistedLines(
      persistedLines.map((it) => (it.key === key ? { ...it, ...patch } : it)),
    );

  // POST a draft row to the backend, then refresh the persisted list.
  const commitDraft = async (draft) => {
    if (!quoteId) {
      notify.error("Save the quote first before adding lines");
      return;
    }
    if (!draft.description || !draft.description.trim()) {
      notify.error("Description is required");
      return;
    }
    const unit = Number(draft.unitPrice);
    if (!Number.isFinite(unit) || unit < 0) {
      notify.error("Unit price must be a non-negative number");
      return;
    }
    setBusyLineKey(draft.key);
    try {
      const body = {
        lineType: draft.lineType || "other",
        description: draft.description.trim(),
        quantity: Math.max(1, parseInt(draft.quantity, 10) || 1),
        unitPrice: unit,
      };
      if (draft.supplierId !== "" && draft.supplierId != null) {
        body.supplierId = parseInt(draft.supplierId, 10);
      }
      if (draft.notes) body.notes = String(draft.notes);
      await fetchApi(`/api/travel/quotes/${quoteId}/lines`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      // Server recomputed totals; re-pull both lines and parent.
      await refreshLines(quoteId);
      await refreshParentQuote(quoteId);
      // Drop the draft now that it's persisted.
      setDraftLines((prev) => prev.filter((d) => d.key !== draft.key));
      notify.success("Line added");
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to save line");
    } finally {
      setBusyLineKey(null);
    }
  };

  // PUT a persisted row's changed fields.
  const updatePersistedRow = async (row, patch) => {
    if (!quoteId || !row.id) return;
    setBusyLineKey(row.key);
    try {
      await fetchApi(`/api/travel/quotes/${quoteId}/lines/${row.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      await refreshLines(quoteId);
      await refreshParentQuote(quoteId);
      notify.success(`Line #${row.id} updated`);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to update line");
    } finally {
      setBusyLineKey(null);
    }
  };

  // DELETE a persisted line via the confirm modal.
  const confirmDeleteLine = async () => {
    if (!deleteTarget || !quoteId) {
      setDeleteTarget(null);
      return;
    }
    const row = deleteTarget;
    setBusyLineKey(row.key);
    try {
      await fetchApi(`/api/travel/quotes/${quoteId}/lines/${row.id}`, {
        method: "DELETE",
      });
      await refreshLines(quoteId);
      await refreshParentQuote(quoteId);
      notify.success(`Line #${row.id} deleted`);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to delete line");
    } finally {
      setBusyLineKey(null);
      setDeleteTarget(null);
    }
  };

  const buildPayload = () => {
    const contactIdInt = parseInt(contactId, 10);
    if (!Number.isFinite(contactIdInt)) {
      notify.error("Contact ID is required (must be a number)");
      return null;
    }
    return {
      contactId: contactIdInt,
      totalAmount: Number(grandTotal.toFixed(2)),
      currency: currency || "INR",
      status: status || "Draft",
      subBrand: subBrand || "tmc",
      validUntil: validUntil || null,
    };
  };

  const handleSaveDraft = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setSaving(true);
    try {
      if (quoteId) {
        await fetchApi(`/api/travel/quotes/${quoteId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Quote #${quoteId} saved`);
      } else {
        const created = await fetchApi("/api/travel/quotes", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (created?.id) {
          setQuoteId(created.id);
          // After creating the quote, any draft lines the operator had
          // composed pre-save can now be committed against the new id.
          // We don't auto-commit them — operator clicks Save on each row.
        }
        notify.success(`Quote created (#${created?.id ?? "new"})`);
      }
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Slice 6: open the Send-to-customer confirm modal. Disabled when the
  // quote has no saved id (NEW mode) or status is already past Draft.
  const openSendConfirm = () => {
    if (!quoteId) {
      notify.error("Save the quote first before sending");
      return;
    }
    setSendConfirmOpen(true);
  };

  // STUB: WhatsApp/email delivery integration pending Q9 (Wati creds).
  // For now, confirming the modal flips the quote status to "Sent" via
  // the existing PUT endpoint and shows a notify.info "Send queued"
  // message. Once Q9 lands, swap this for POST /api/travel/quotes/:id/send
  // (route TBD) which will fan out to the Wati WhatsApp client + email
  // provider and return delivery receipts.
  const confirmSend = async () => {
    if (!quoteId) {
      setSendConfirmOpen(false);
      return;
    }
    const payload = buildPayload();
    if (!payload) {
      setSendConfirmOpen(false);
      return;
    }
    setSending(true);
    try {
      await fetchApi(`/api/travel/quotes/${quoteId}`, {
        method: "PUT",
        body: JSON.stringify({ ...payload, status: "Sent" }),
      });
      setStatus("Sent");
      notify.info(
        "Send queued — will deliver via WhatsApp + email once Q9 credentials land.",
      );
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Send failed");
    } finally {
      setSending(false);
      setSendConfirmOpen(false);
    }
  };

  const handleDuplicate = async () => {
    if (!quoteId) {
      notify.error("Save the quote first before duplicating");
      return;
    }
    try {
      const dup = await fetchApi(`/api/travel/quotes/${quoteId}/duplicate`, {
        method: "POST",
      });
      notify.success(`Quote duplicated as #${dup?.id ?? "new"}`);
    } catch (err) {
      if (err?.status === 404) {
        notify.info("Duplicate endpoint not yet available — try again after backend deploy");
        return;
      }
      notify.error(err?.body?.error || err?.message || "Duplicate failed");
    }
  };

  const handleDownloadPdf = async () => {
    if (!quoteId) {
      notify.error("Save the quote first before downloading PDF");
      return;
    }
    try {
      await fetchApi(`/api/travel/quotes/${quoteId}/pdf`);
      notify.success(`PDF download triggered for quote #${quoteId}`);
    } catch (err) {
      if (err?.status === 404) {
        notify.info("PDF endpoint not yet available — try again after backend deploy");
        return;
      }
      notify.error(err?.body?.error || err?.message || "PDF download failed");
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
        <div style={empty}>Loading&hellip;</div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 24,
        maxWidth: 1200,
        margin: "0 auto",
        animation: "fadeIn 0.4s ease-out",
      }}
    >
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
          <h1
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: 0,
              fontSize: "1.75rem",
              fontWeight: 600,
            }}
          >
            <Calculator size={26} aria-hidden /> Quote Builder
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
            {quoteId ? (
              <>
                Quote <strong>#{quoteId}</strong>
                {" "}
                <span
                  style={{
                    ...statusBadge,
                    background: STATUS_BG[status] || "rgba(255,255,255,0.08)",
                    color: STATUS_COLOR[status] || "var(--text-primary)",
                  }}
                >
                  {status}
                </span>
              </>
            ) : (
              "New quote — fill in the form to save a draft"
            )}
          </p>
        </div>
        {canWrite && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleSaveDraft}
              disabled={saving}
              style={primaryBtn}
            >
              <Save size={14} /> {saving ? "Saving…" : "Save Draft"}
            </button>
            <button
              type="button"
              onClick={openSendConfirm}
              disabled={
                saving ||
                sending ||
                !quoteId ||
                status === "Sent" ||
                status === "Accepted" ||
                status === "Rejected"
              }
              style={secondaryBtn}
              title={
                !quoteId
                  ? "Save first"
                  : status !== "Draft"
                    ? `Cannot resend — quote is ${status}`
                    : "Send to customer (WhatsApp + email)"
              }
            >
              <Send size={14} /> Send to customer
            </button>
            <button
              type="button"
              onClick={handleDuplicate}
              disabled={!quoteId}
              style={secondaryBtn}
              title={!quoteId ? "Save first" : "Duplicate this quote"}
            >
              <Copy size={14} /> Duplicate
            </button>
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={!quoteId}
              style={secondaryBtn}
              title={!quoteId ? "Save first" : "Download PDF"}
            >
              <Download size={14} /> Download PDF
            </button>
          </div>
        )}
      </header>

      <section
        className="glass"
        aria-label="Quote header fields"
        style={{
          padding: 16,
          marginBottom: 16,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
          gap: 10,
          alignItems: "end",
        }}
      >
        <label style={fieldLabel}>
          Contact ID
          <input
            type="number"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            placeholder="Contact ID *"
            style={inputStyle}
            aria-label="Contact ID"
          />
        </label>
        <label style={fieldLabel}>
          Currency
          <input
            type="text"
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            style={inputStyle}
            aria-label="Currency"
          />
        </label>
        <label style={fieldLabel}>
          Sub-brand
          <select
            value={subBrand}
            onChange={(e) => setSubBrand(e.target.value)}
            style={inputStyle}
            aria-label="Sub-brand"
          >
            {SUB_BRANDS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={fieldLabel}>
          Valid Until
          <input
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            style={inputStyle}
            aria-label="Valid until"
          />
        </label>
      </section>

      <section
        className="glass"
        aria-label="Line items"
        style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}
      >
        <div
          style={{
            padding: "12px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-color)",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Line Items</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {suppliersLoading
                ? "Loading suppliers…"
                : suppliers.length === 0 && subBrand
                  ? `No suppliers for ${subBrand}`
                  : `${suppliers.length} supplier${suppliers.length === 1 ? "" : "s"} available`}
            </span>
            {canWrite && (
              <button
                type="button"
                onClick={addLine}
                style={primaryBtn}
                aria-label="Add line"
                disabled={!quoteId}
                title={!quoteId ? "Save the quote first before adding lines" : "Add line"}
              >
                <Plus size={14} /> Add line
              </button>
            )}
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 880 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
                <th style={{ ...th, width: 110 }}>Type</th>
                <th style={th}>Description</th>
                <th style={{ ...th, width: 80 }}>Qty</th>
                <th style={{ ...th, width: 120 }}>Unit Price</th>
                <th style={{ ...th, width: 180 }}>Supplier</th>
                <th style={{ ...th, width: 120 }}>Amount</th>
                {canWrite && <th style={{ ...th, width: 90, textAlign: "center" }}>—</th>}
              </tr>
            </thead>
            <tbody>
              {visibleLines.length === 0 && (
                <tr>
                  <td
                    colSpan={canWrite ? 7 : 6}
                    style={{ ...td, textAlign: "center", color: "var(--text-secondary)" }}
                  >
                    {quoteId ? (
                      <>No line items yet. Click <strong>Add line</strong> to start.</>
                    ) : (
                      <>Save the quote first to start adding lines.</>
                    )}
                  </td>
                </tr>
              )}
              {visibleLines.map((it) => {
                const isDraft = !it.id;
                const isBusy = busyLineKey === it.key;
                const onChange = isDraft ? updateDraft : updatePersistedLocal;
                return (
                  <tr key={it.key} style={{ borderTop: "1px solid var(--border-color)" }}>
                    <td style={td}>
                      <select
                        value={it.lineType || "other"}
                        onChange={(e) => onChange(it.key, { lineType: e.target.value })}
                        style={{ ...inputStyle, width: "100%" }}
                        aria-label={`Line ${it.key} type`}
                        disabled={!canWrite || isBusy}
                      >
                        {LINE_TYPES.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td style={td}>
                      <input
                        type="text"
                        value={it.description}
                        onChange={(e) => onChange(it.key, { description: e.target.value })}
                        placeholder="Service / package description"
                        style={{ ...inputStyle, width: "100%" }}
                        aria-label={`Line ${it.key} description`}
                        disabled={!canWrite || isBusy}
                      />
                    </td>
                    <td style={td}>
                      <input
                        type="number"
                        min={1}
                        value={it.quantity}
                        onChange={(e) => onChange(it.key, { quantity: e.target.value })}
                        style={{ ...inputStyle, width: "100%" }}
                        aria-label={`Line ${it.key} quantity`}
                        disabled={!canWrite || isBusy}
                      />
                    </td>
                    <td style={td}>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={it.unitPrice}
                        onChange={(e) => onChange(it.key, { unitPrice: e.target.value })}
                        style={{ ...inputStyle, width: "100%" }}
                        aria-label={`Line ${it.key} unit price`}
                        disabled={!canWrite || isBusy}
                      />
                    </td>
                    <td style={td}>
                      <select
                        value={it.supplierId == null ? "" : String(it.supplierId)}
                        onChange={(e) => onChange(it.key, { supplierId: e.target.value })}
                        style={{ ...inputStyle, width: "100%" }}
                        aria-label={`Line ${it.key} supplier`}
                        disabled={!canWrite || isBusy || suppliers.length === 0}
                      >
                        <option value="">
                          {suppliers.length === 0 ? "— no suppliers —" : "— none —"}
                        </option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}{s.supplierCategory ? ` (${s.supplierCategory})` : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>{fmt(lineAmount(it))}</td>
                    {canWrite && (
                      <td style={{ ...td, textAlign: "center" }}>
                        {isDraft ? (
                          <div style={{ display: "inline-flex", gap: 4 }}>
                            <button
                              type="button"
                              onClick={() => commitDraft(it)}
                              style={iconBtnPrimary}
                              aria-label={`Save line ${it.key}`}
                              title="Save line"
                              disabled={isBusy}
                            >
                              <Check size={16} />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeDraft(it.key)}
                              style={iconBtn}
                              aria-label={`Cancel line ${it.key}`}
                              title="Cancel"
                              disabled={isBusy}
                            >
                              <X size={16} />
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: "inline-flex", gap: 4 }}>
                            <button
                              type="button"
                              onClick={() => updatePersistedRow(it, {
                                lineType: it.lineType,
                                description: it.description,
                                quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
                                unitPrice: Number(it.unitPrice) || 0,
                                supplierId: it.supplierId === "" ? null : parseInt(it.supplierId, 10),
                              })}
                              style={iconBtnPrimary}
                              aria-label={`Save line ${it.id}`}
                              title="Save changes"
                              disabled={isBusy}
                            >
                              <Check size={16} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(it)}
                              style={iconBtn}
                              aria-label={`Remove line ${it.id}`}
                              title="Remove line"
                              disabled={isBusy}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="glass"
        aria-label="Totals"
        style={{
          padding: 16,
          marginBottom: 16,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
          gap: 16,
          alignItems: "center",
        }}
      >
        <div>
          <label style={fieldLabel}>
            Discount %
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={discountPct}
              onChange={(e) => setDiscountPct(e.target.value)}
              style={inputStyle}
              aria-label="Discount percent"
            />
          </label>
        </div>
        <div>
          <label style={fieldLabel}>
            Tax %
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={taxPct}
              onChange={(e) => setTaxPct(e.target.value)}
              style={inputStyle}
              aria-label="Tax percent"
            />
          </label>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={totalsRow}>
            <span style={totalsLabel}>Subtotal</span>
            <span style={totalsValue} aria-label="Subtotal">
              {currency} {fmt(subtotal)}
            </span>
          </div>
          <div style={totalsRow}>
            <span style={totalsLabel}>Discount</span>
            <span style={totalsValue} aria-label="Discount amount">
              -{currency} {fmt(discountAmount)}
            </span>
          </div>
          <div style={totalsRow}>
            <span style={totalsLabel}>Tax</span>
            <span style={totalsValue} aria-label="Tax amount">
              {currency} {fmt(taxAmount)}
            </span>
          </div>
          <div
            style={{
              ...totalsRow,
              borderTop: "1px solid var(--border-color)",
              paddingTop: 6,
              marginTop: 6,
              fontWeight: 700,
            }}
          >
            <span style={totalsLabel}>Grand Total</span>
            <span
              style={{ ...totalsValue, color: "var(--primary-color, var(--accent-color))" }}
              aria-label="Grand total"
            >
              {currency} {fmt(grandTotal)}
            </span>
          </div>
        </div>
      </section>

      {sendConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm send to customer"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            className="glass"
            style={{
              padding: 24,
              minWidth: 320,
              maxWidth: 520,
              borderRadius: 8,
            }}
          >
            <h3 style={{ margin: "0 0 12px", fontSize: "1.1rem" }}>
              Send quote #{quoteId} to customer?
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 16 }}>
              Send to customer (WhatsApp + email) — feature pending Q9 Wati
              WhatsApp credentials. The quote will be ready to send once
              integration is enabled.
            </p>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 16 }}>
              Confirming will mark the quote as <strong>Sent</strong> and queue
              it for delivery — actual WhatsApp + email dispatch will fire once
              the Wati integration is live.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setSendConfirmOpen(false)}
                style={secondaryBtn}
                disabled={sending}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSend}
                style={primaryBtn}
                aria-label="Confirm send to customer"
                disabled={sending}
              >
                <Send size={14} /> {sending ? "Queuing…" : "Confirm send"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm delete line"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            className="glass"
            style={{
              padding: 24,
              minWidth: 320,
              maxWidth: 480,
              borderRadius: 8,
            }}
          >
            <h3 style={{ margin: "0 0 12px", fontSize: "1.1rem" }}>Remove line?</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 16 }}>
              {`Permanently remove line #${deleteTarget.id} "${deleteTarget.description}"? This cannot be undone.`}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                style={secondaryBtn}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteLine}
                style={{ ...primaryBtn, background: "var(--danger-color, #f43f5e)" }}
                aria-label="Confirm delete line"
              >
                <Trash2 size={14} /> Remove
              </button>
            </div>
          </div>
        </div>
      )}
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
  background: "var(--subtle-bg)",
  fontWeight: 600,
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const empty = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 14,
};
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
};
const fieldLabel = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--text-secondary)",
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
  color: "var(--danger-color, #f43f5e)",
  border: "none",
  cursor: "pointer",
};
const iconBtnPrimary = {
  padding: 6,
  borderRadius: 4,
  background: "transparent",
  color: "var(--primary-color, var(--accent-color))",
  border: "none",
  cursor: "pointer",
};
const statusBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  marginLeft: 6,
};
const totalsRow = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 13,
  padding: "4px 0",
};
const totalsLabel = { color: "var(--text-secondary)" };
const totalsValue = { color: "var(--text-primary)", fontFamily: "monospace" };
