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
//   - Slice 6 (commit d2eff34c): add a "Send to customer" action button
//     that opens a confirm modal explaining the Q9 (Wati WhatsApp)
//     credential dependency. STUB-mode delivery: on confirm we mark the
//     quote as "Sent" via PUT /api/travel/quotes/:id { status: "Sent" } so
//     the status pill flips, and surface a notify.info "Send queued"
//     message. Actual WhatsApp + email dispatch lives behind a Q9 cred
//     drop (Meta System User token + 3×WABA ID + 3×phoneNumberId + webhook
//     verify token). Once Q9 lands, wire the modal's confirm handler to
//     POST /api/travel/quotes/:id/send (route to be added in a later
//     slice) and remove the STUB marker.
//   - Slice 8 (THIS commit): "Calculate with markups" action button +
//     dismissable preview panel. Reads GET /api/travel/quotes/:id/
//     pricing-preview (slice 5 endpoint at commit 91a7b931) and renders
//     the per-rule markup breakdown alongside subtotal + new total.
//     Strictly informational — Save Draft still persists the pre-markup
//     grandTotal. A disclaimer ("Preview only — apply markup permanently
//     on Send") sits near the panel so operators don't conflate the
//     preview total with the persisted one. Button disabled when:
//       (a) quote is NEW (no saved id — endpoint requires :id), or
//       (b) the quote has zero visible lines (nothing to compute).
//     Empty markupApplied[] renders a "No markup rules apply for this
//     sub-brand" hint instead of an empty list. Error path: 4xx/5xx →
//     notify.error using the standard err.body.error / err.message
//     pattern that the other actions already follow.
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
//   GET    /api/travel/quotes/:id/pricing-preview    → 200 { subtotal, markupApplied[], total, currency, lines[] }
//
// pricing-preview response shape (slice 5, commit 91a7b931):
//   { subtotal: number,
//     markupApplied: [{ ruleId, ruleName, percent (nullable), amount }],
//     total: number,
//     currency: string,
//     lines: [{ id, lineType, description, amount, amountWithMarkup }] }
// `markupApplied` is dedupe'd by ruleId — one entry per rule even if it
// matched multiple lines, with the amounts summed.
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
import { Calculator, Plus, Trash2, Save, Send, Copy, Download, Check, X, TrendingUp, FileText, ThumbsUp, ThumbsDown } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
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
  // Contact picker — mirrors the InvoicesAdmin pattern. Loads the tenant's
  // contacts once on mount so the header field can be a labelled <select>
  // instead of a raw numeric "Contact ID" input that lets an operator
  // accidentally attach a quote to the wrong customer (see PRD §3 R-15).
  // contactsById is a per-id cache used to surface the current selection's
  // name in edit-mode even if that contact isn't in the loaded first page
  // (the >500-row tail).
  const [customers, setCustomers] = useState([]);
  const [contactsById, setContactsById] = useState({});
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
  // PRD_TRAVEL_SUPPLIER_MASTER G043 — per-supplier credit-utilization chips.
  // Keyed by supplierId → { current, limit, utilizationPct, status, currency }
  // (status ∈ "ok" | "warning" | "exceeded"). Populated on demand for the
  // suppliers actually referenced by line items; "ok" status renders no chip
  // (avoid visual noise for the common case).
  const [creditStatus, setCreditStatus] = useState({});
  // Delete-confirm modal target.
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Send-to-customer confirm modal flag (slice 6 — Q9 STUB).
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  // Slice 11: accept + decline workflow state.
  const [acceptInFlight, setAcceptInFlight] = useState(false);
  const [declineInFlight, setDeclineInFlight] = useState(false);
  const [declineConfirmOpen, setDeclineConfirmOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  // Slice 8: pricing preview state. `pricingPreview` is null until the
  // operator clicks "Calculate with markups"; once populated it renders
  // the side panel until dismissed (set back to null) or until a fresh
  // calculate fires (replaces the value). `previewLoading` gates the
  // button label so consecutive clicks don't fire multiple GETs.
  const [pricingPreview, setPricingPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // G017 — clone-with-margin modal state. The duplicate button opens this
  // modal so the operator can either (a) raw-duplicate (margin=0 or
  // blank) or (b) clone with a markup % applied to every line. Empty /
  // 0 input is treated as raw-clone; a number triggers the marginPercent
  // body field on POST /quotes/:id/duplicate.
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [duplicateMargin, setDuplicateMargin] = useState("");
  const [duplicating, setDuplicating] = useState(false);

  // G018 — per-line FX-rate panel. When the quote currency is non-INR (or
  // any non-tenant-default), we fetch the latest INR→quote rate from the
  // FX cache and surface it as a small reference line beneath the totals
  // strip. fail-soft: a missing rate just hides the widget.
  const [fxRate, setFxRate] = useState(null);
  useEffect(() => {
    let cancelled = false;
    async function loadFxRate() {
      if (!currency || currency === "INR") {
        setFxRate(null);
        return;
      }
      try {
        const r = await fetchApi(`/api/fx/latest?base=INR&quote=${encodeURIComponent(currency)}`);
        if (!cancelled && r && r.rate != null) {
          setFxRate({ base: r.base, quote: r.quote, rate: r.rate, fetchedAt: r.fetchedAt });
        } else if (!cancelled) {
          setFxRate(null);
        }
      } catch {
        if (!cancelled) setFxRate(null);
      }
    }
    loadFxRate();
    return () => { cancelled = true; };
  }, [currency]);

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
      notify.error(err?.data?.error || err?.message || "Failed to load lines");
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
        notify.error(err?.data?.error || err?.message || "Failed to load quote");
      })
      .finally(() => setLoading(false));
    // Intentionally only re-run when the route id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  // Load the tenant's contacts once for the customer dropdown. Mirrors
  // InvoicesAdmin so the two surfaces stay in shape-sync. summary fields +
  // limit=500 keeps the payload small while covering the long tail for most
  // tenants; tenants with more contacts still see the right selection in
  // edit-mode via the contactsById fallback below.
  useEffect(() => {
    fetchApi("/api/contacts?fields=summary&limit=500")
      .then((data) => {
        const list = Array.isArray(data) ? data : data?.contacts || data?.rows || [];
        list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        setCustomers(list);
      })
      .catch(() => setCustomers([]));
  }, []);

  // In edit-mode, if the current contactId isn't in the loaded customers
  // page, fetch its display name so the <select> shows the contact's name
  // (not just an opaque numeric id). silent:true on the fetch — a 404 here
  // means the quote references a deleted/cross-tenant contact; the fallback
  // option below renders `Contact #${id}` so the operator still knows
  // SOMETHING is selected.
  useEffect(() => {
    if (!contactId) return;
    const idNum = parseInt(contactId, 10);
    if (!Number.isFinite(idNum)) return;
    if (contactId in contactsById) return;
    if (customers.some((c) => String(c.id) === String(contactId))) return;
    let cancelled = false;
    fetchApi(`/api/contacts/${idNum}`, { silent: true })
      .then((c) => {
        if (cancelled || !c) return;
        setContactsById((prev) => ({
          ...prev,
          [contactId]: { name: c.name || null, email: c.email || null },
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setContactsById((prev) => ({ ...prev, [contactId]: { name: null, email: null } }));
      });
    return () => { cancelled = true; };
    // contactsById intentionally omitted — we only need to fetch on
    // contactId / customers changes; the guards above skip cache hits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, customers]);

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
        notify.error(err?.data?.error || err?.message || "Failed to load suppliers");
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

  // PRD_TRAVEL_SUPPLIER_MASTER G043 — fetch credit utilization for every
  // distinct supplier referenced by a line. Skips lines without a supplierId
  // and suppliers we've already fetched (poor-man's cache; the endpoint
  // sends Cache-Control: max-age=60 too). Best-effort: a failed fetch leaves
  // the chip absent for that supplier (no error toast — chip is advisory).
  useEffect(() => {
    const supplierIds = new Set();
    for (const ln of visibleLines) {
      if (ln.supplierId !== "" && ln.supplierId != null) {
        const sid = parseInt(ln.supplierId, 10);
        if (Number.isFinite(sid)) supplierIds.add(sid);
      }
    }
    let cancelled = false;
    for (const sid of supplierIds) {
      if (creditStatus[sid] !== undefined) continue;
      fetchApi(`/api/travel/suppliers/${sid}/credit-status`)
        .then((resp) => {
          if (cancelled || !resp) return;
          setCreditStatus((prev) => ({ ...prev, [sid]: resp }));
        })
        .catch(() => {
          // Best-effort — record null so we don't retry every render.
          if (!cancelled) setCreditStatus((prev) => ({ ...prev, [sid]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
    // visibleLines is rebuilt every render — gate the effect on a stable
    // signal (sorted supplierId set) so we don't fire fetches on every
    // unrelated state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(
      visibleLines.map((l) => l.supplierId).filter((s) => s != null && s !== ""),
    ),
  ]);

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
      notify.error(err?.data?.error || err?.message || "Failed to save line");
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
      notify.error(err?.data?.error || err?.message || "Failed to update line");
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
      notify.error(err?.data?.error || err?.message || "Failed to delete line");
    } finally {
      setBusyLineKey(null);
      setDeleteTarget(null);
    }
  };

  const buildPayload = () => {
    const contactIdInt = parseInt(contactId, 10);
    if (!Number.isFinite(contactIdInt)) {
      notify.error("Please select a customer before saving");
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
      notify.error(err?.data?.error || err?.message || "Save failed");
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
      notify.error(err?.data?.error || err?.message || "Send failed");
    } finally {
      setSending(false);
      setSendConfirmOpen(false);
    }
  };

  // G017 — open the clone-with-margin modal. The legacy raw-clone behaviour
  // is preserved by the modal's "Clone (no markup)" option (empty input
  // submits without a marginPercent field).
  const handleDuplicate = () => {
    if (!quoteId) {
      notify.error("Save the quote first before duplicating");
      return;
    }
    setDuplicateMargin("");
    setDuplicateOpen(true);
  };

  const closeDuplicateModal = () => {
    if (duplicating) return;
    setDuplicateOpen(false);
  };

  const confirmDuplicate = async () => {
    if (!quoteId) return;
    const trimmed = String(duplicateMargin).trim();
    let body = {};
    if (trimmed !== "") {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0 || n > 1000) {
        notify.error("Markup % must be a number between 0 and 1000");
        return;
      }
      body = { marginPercent: n };
    }
    setDuplicating(true);
    try {
      const dup = await fetchApi(`/api/travel/quotes/${quoteId}/duplicate`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const label = trimmed === "" || Number(trimmed) === 0
        ? `Quote duplicated as #${dup?.id ?? "new"}`
        : `Quote duplicated as #${dup?.id ?? "new"} with ${trimmed}% markup`;
      notify.success(label);
      setDuplicateOpen(false);
    } catch (err) {
      if (err?.status === 404) {
        notify.info("Duplicate endpoint not yet available — try again after backend deploy");
        return;
      }
      notify.error(err?.data?.error || err?.message || "Duplicate failed");
    } finally {
      setDuplicating(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!quoteId) {
      notify.error("Save the quote first before downloading PDF");
      return;
    }
    try {
      const token = getAuthToken();
      const response = await fetch(`/api/travel/quotes/${quoteId}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        notify.error(errData.error || `PDF download failed (${response.status})`);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quote-${quoteId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify.success(`PDF downloaded for quote #${quoteId}`);
    } catch (err) {
      notify.error(err?.message || "PDF download failed");
    }
  };

  // Slice 8: GET the markup-aware pricing preview from the backend and
  // stash it in `pricingPreview`. The endpoint requires a persisted quote
  // (button is disabled in NEW mode) and is informational only — the
  // preview total does NOT feed back into Save Draft's payload. The
  // separate disclaimer near the panel reinforces this for operators.
  const handlePricingPreview = async () => {
    if (!quoteId) {
      notify.error("Save the quote first before calculating with markups");
      return;
    }
    if (visibleLines.length === 0) {
      notify.error("Add at least one line before calculating with markups");
      return;
    }
    setPreviewLoading(true);
    try {
      const resp = await fetchApi(`/api/travel/quotes/${quoteId}/pricing-preview`);
      if (resp && typeof resp === "object") {
        setPricingPreview({
          subtotal: Number(resp.subtotal) || 0,
          total: Number(resp.total) || 0,
          currency: resp.currency || currency || "INR",
          markupApplied: Array.isArray(resp.markupApplied) ? resp.markupApplied : [],
          lines: Array.isArray(resp.lines) ? resp.lines : [],
        });
      }
    } catch (err) {
      notify.error(err?.data?.error || err?.message || "Pricing preview failed");
    } finally {
      setPreviewLoading(false);
    }
  };

  const dismissPricingPreview = () => setPricingPreview(null);

  // Slice 11: Accept / Decline workflow endpoints (POST
  // /api/travel/quotes/:id/{accept,decline}). Dedicated semantic
  // transitions distinct from the catch-all PUT — server enforces a
  // transition guard (only Draft|Sent can move to Accepted|Rejected;
  // already-{Accepted,Rejected} is idempotent; opposite-terminal is
  // 409 INVALID_TRANSITION). Decline opens a confirm modal with an
  // optional reason field (captured in the audit chain since the
  // schema has no rejectionReason column).
  const handleAccept = async () => {
    if (!quoteId) {
      notify.error("Save the quote first before accepting");
      return;
    }
    setAcceptInFlight(true);
    try {
      const resp = await fetchApi(`/api/travel/quotes/${quoteId}/accept`, {
        method: "POST",
      });
      if (resp?.alreadyAccepted) {
        notify.info(`Quote #${quoteId} was already accepted`);
      } else {
        notify.success(`Quote #${quoteId} accepted`);
      }
      if (resp?.quote?.status) setStatus(resp.quote.status);
    } catch (err) {
      if (err?.status === 409) {
        notify.error(
          err?.data?.error ||
            "Cannot accept this quote — it is already in a terminal state",
        );
        return;
      }
      notify.error(err?.data?.error || err?.message || "Accept failed");
    } finally {
      setAcceptInFlight(false);
    }
  };

  const openDeclineConfirm = () => {
    if (!quoteId) {
      notify.error("Save the quote first before declining");
      return;
    }
    setDeclineReason("");
    setDeclineConfirmOpen(true);
  };

  const confirmDecline = async () => {
    if (!quoteId) {
      setDeclineConfirmOpen(false);
      return;
    }
    setDeclineInFlight(true);
    try {
      const body = {};
      if (declineReason && declineReason.trim()) {
        body.reason = declineReason.trim();
      }
      const resp = await fetchApi(`/api/travel/quotes/${quoteId}/decline`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (resp?.alreadyRejected) {
        notify.info(`Quote #${quoteId} was already declined`);
      } else {
        notify.success(`Quote #${quoteId} declined`);
      }
      if (resp?.quote?.status) setStatus(resp.quote.status);
      setDeclineConfirmOpen(false);
      setDeclineReason("");
    } catch (err) {
      if (err?.status === 409) {
        notify.error(
          err?.data?.error ||
            "Cannot decline this quote — it is already in a terminal state",
        );
        return;
      }
      notify.error(err?.data?.error || err?.message || "Decline failed");
    } finally {
      setDeclineInFlight(false);
    }
  };

  // Slice 10: convert this quote to a Draft TravelInvoice via
  // POST /api/travel/quotes/:id/convert-to-invoice. Server-side is
  // idempotent — a second click returns the existing invoice with
  // alreadyConverted=true. We surface that explicitly so the operator
  // knows they're navigating to an existing invoice rather than creating
  // a duplicate. The created/existing invoice id is announced in the
  // toast; once the InvoicesAdmin route lands a router push could deep-
  // link there, but for now operators copy the id from the toast.
  const handleConvertToInvoice = async () => {
    if (!quoteId) {
      notify.error("Save the quote first before converting to invoice");
      return;
    }
    try {
      const resp = await fetchApi(
        `/api/travel/quotes/${quoteId}/convert-to-invoice`,
        { method: "POST" },
      );
      const invoice = resp?.invoice;
      const invId = invoice?.id;
      const invNum = invoice?.invoiceNum;
      if (resp?.alreadyConverted) {
        notify.info(
          `Already converted — invoice #${invId}${invNum ? ` (${invNum})` : ""}`,
        );
      } else {
        notify.success(
          `Invoice #${invId}${invNum ? ` (${invNum})` : ""} created from quote #${quoteId}`,
        );
      }
    } catch (err) {
      if (err?.status === 404) {
        notify.info(
          "Convert-to-invoice endpoint not yet available — try again after backend deploy",
        );
        return;
      }
      notify.error(err?.data?.error || err?.message || "Convert to invoice failed");
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
            <button
              type="button"
              onClick={handlePricingPreview}
              disabled={!quoteId || visibleLines.length === 0 || previewLoading}
              style={secondaryBtn}
              title={
                !quoteId
                  ? "Save first"
                  : visibleLines.length === 0
                    ? "Add a line first"
                    : "Calculate subtotal + markup-rule preview"
              }
              aria-label="Calculate with markups"
            >
              <TrendingUp size={14} />{" "}
              {previewLoading ? "Calculating…" : "Calculate with markups"}
            </button>
            <button
              type="button"
              onClick={handleConvertToInvoice}
              disabled={!quoteId}
              style={secondaryBtn}
              title={
                !quoteId
                  ? "Save first"
                  : "Convert this quote to a draft invoice"
              }
              aria-label="Convert to invoice"
            >
              <FileText size={14} /> Convert to invoice
            </button>
            <button
              type="button"
              onClick={handleAccept}
              disabled={
                !quoteId ||
                acceptInFlight ||
                status === "Accepted" ||
                status === "Rejected"
              }
              style={primaryBtn}
              aria-label="Accept quote"
              title={
                !quoteId
                  ? "Save first"
                  : status === "Accepted"
                    ? "Quote already accepted"
                    : status === "Rejected"
                      ? "Cannot accept a rejected quote"
                      : "Accept this quote"
              }
            >
              <ThumbsUp size={14} />{" "}
              {acceptInFlight ? "Accepting…" : "Accept"}
            </button>
            <button
              type="button"
              onClick={openDeclineConfirm}
              disabled={
                !quoteId ||
                declineInFlight ||
                status === "Accepted" ||
                status === "Rejected"
              }
              style={secondaryBtn}
              aria-label="Decline quote"
              title={
                !quoteId
                  ? "Save first"
                  : status === "Rejected"
                    ? "Quote already declined"
                    : status === "Accepted"
                      ? "Cannot decline an accepted quote"
                      : "Decline this quote"
              }
            >
              <ThumbsDown size={14} /> Decline
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
          Customer
          {/* Mirrors InvoicesAdmin's Select Customer dropdown so the two
              surfaces are consistent (PRD §3 R-15). Pre-fix this was a raw
              numeric "Contact ID *" input — an operator could attach a
              quote to the wrong customer by typing the wrong id, with no
              confirmation of who that id maps to. */}
          <select
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            style={inputStyle}
            aria-label="Customer"
          >
            <option value="">Select customer *</option>
            {/* Editing a quote whose contact isn't in the loaded page (or
                a >500-row tenant) keeps the existing selection visible. */}
            {contactId &&
              !customers.some((c) => String(c.id) === String(contactId)) && (
                <option value={contactId}>
                  {contactsById[contactId]?.name || `Contact #${contactId}`}
                </option>
              )}
            {customers.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {(c.name || `Contact #${c.id}`) + (c.email ? ` — ${c.email}` : "")}
              </option>
            ))}
          </select>
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

      {/* PRD_TRAVEL_SUPPLIER_MASTER G043 — credit-utilization advisory chips.
          Renders one chip per supplier referenced by a line whose credit
          utilization is at warning (≥80%) or exceeded (≥100%) bands. The
          "ok" band renders nothing — chip rail is only visible when there's
          something the operator needs to know. */}
      {(() => {
        const chips = [];
        const seen = new Set();
        for (const ln of visibleLines) {
          if (ln.supplierId === "" || ln.supplierId == null) continue;
          const sid = parseInt(ln.supplierId, 10);
          if (!Number.isFinite(sid) || seen.has(sid)) continue;
          seen.add(sid);
          const cs = creditStatus[sid];
          if (!cs || cs.status === "ok") continue;
          const supplier = suppliers.find((s) => s.id === sid);
          const name = supplier ? supplier.name : `Supplier ${sid}`;
          const isExceeded = cs.status === "exceeded";
          const bg = isExceeded ? "rgba(168, 50, 63, 0.14)" : "rgba(200, 154, 78, 0.16)";
          const color = isExceeded ? "#A8323F" : "#9A6F2E";
          const cur = (cs.currency || "INR") === "INR" ? "₹" : `${cs.currency} `;
          const fmtNum = (n) => Number(n || 0).toLocaleString();
          chips.push(
            <span
              key={sid}
              role="status"
              aria-label={`${name} credit ${cs.status}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                background: bg,
                color,
              }}
              title={isExceeded
                ? "Booking will be blocked — supplier credit limit exceeded"
                : "Approaching supplier credit limit"}
            >
              {isExceeded ? "Credit exceeded" : "Near credit limit"}
              {" · "}
              {name}
              {" · "}
              {cur}{fmtNum(cs.current)} / {cur}{fmtNum(cs.limit)}
            </span>,
          );
        }
        if (chips.length === 0) return null;
        return (
          <section
            aria-label="Supplier credit warnings"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 12,
            }}
          >
            {chips}
          </section>
        );
      })()}

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

          {fxRate && (
            <div
              aria-label="FX conversion reference"
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px dashed var(--border-color, rgba(148, 163, 184, 0.4))",
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              1 {fxRate.base} = {Number(fxRate.rate).toFixed(4)} {fxRate.quote}
              {fxRate.fetchedAt && (
                <span style={{ marginLeft: 6 }}>
                  (as of {new Date(fxRate.fetchedAt).toLocaleString()})
                </span>
              )}
              <span style={{ marginLeft: 6 }}>
                ≈ {fxRate.quote} {fmt(Number(grandTotal) * Number(fxRate.rate))}
              </span>
            </div>
          )}
        </div>
      </section>

      {pricingPreview && (
        <section
          className="glass"
          aria-label="Pricing preview"
          style={{ padding: 16, marginBottom: 16 }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: "1rem",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <TrendingUp size={16} aria-hidden /> Pricing preview
              </h2>
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  margin: "4px 0 0",
                }}
              >
                Preview only — apply markup permanently on Send.
              </p>
            </div>
            <button
              type="button"
              onClick={dismissPricingPreview}
              style={iconBtn}
              aria-label="Dismiss pricing preview"
              title="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={totalsRow}>
              <span style={totalsLabel}>Subtotal (pre-markup)</span>
              <span style={totalsValue} aria-label="Pricing preview subtotal">
                {pricingPreview.currency} {fmt(pricingPreview.subtotal)}
              </span>
            </div>
            {pricingPreview.markupApplied.length === 0 ? (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  fontStyle: "italic",
                  padding: "4px 0",
                }}
                aria-label="No markup rules apply"
              >
                No markup rules apply for this sub-brand
              </div>
            ) : (
              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                  }}
                >
                  Markup rules applied
                </div>
                <ul
                  style={{ margin: 0, padding: "0 0 0 16px", listStyle: "disc" }}
                  aria-label="Markup rules applied"
                >
                  {pricingPreview.markupApplied.map((r) => (
                    <li
                      key={r.ruleId}
                      style={{ fontSize: 13, padding: "2px 0" }}
                    >
                      <span>{r.ruleName}</span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {r.percent != null ? `: ${Number(r.percent)}%` : ""}{" "}
                        ({pricingPreview.currency} {fmt(r.amount)})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div
              style={{
                ...totalsRow,
                borderTop: "1px solid var(--border-color)",
                paddingTop: 6,
                marginTop: 6,
                fontWeight: 700,
              }}
            >
              <span style={totalsLabel}>Total with markup</span>
              <span
                style={{ ...totalsValue, color: "var(--primary-color, var(--accent-color))" }}
                aria-label="Pricing preview total"
              >
                {pricingPreview.currency} {fmt(pricingPreview.total)}
              </span>
            </div>
          </div>
        </section>
      )}

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

      {declineConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm decline quote"
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
              Decline quote #{quoteId}?
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 12 }}>
              The quote status will flip to <strong>Rejected</strong>. The
              customer's reason (if provided) is captured in the audit chain.
            </p>
            <label style={fieldLabel}>
              Reason (optional)
              <textarea
                rows={3}
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                placeholder="e.g. Budget too high — can you do 95k per student?"
                style={{ ...inputStyle, width: "100%", resize: "vertical" }}
                aria-label="Decline reason"
                maxLength={1000}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => {
                  setDeclineConfirmOpen(false);
                  setDeclineReason("");
                }}
                style={secondaryBtn}
                disabled={declineInFlight}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDecline}
                style={{ ...primaryBtn, background: "var(--danger-color, #f43f5e)" }}
                aria-label="Confirm decline quote"
                disabled={declineInFlight}
              >
                <ThumbsDown size={14} />{" "}
                {declineInFlight ? "Declining…" : "Confirm decline"}
              </button>
            </div>
          </div>
        </div>
      )}

      {duplicateOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Duplicate quote with markup"
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
            style={{ padding: 24, minWidth: 320, maxWidth: 480, borderRadius: 8 }}
          >
            <h3 style={{ margin: "0 0 12px", fontSize: "1.1rem" }}>
              Duplicate quote #{quoteId}
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 16 }}>
              Optionally apply a markup % to every line. Leave blank for a raw clone.
              Useful for sub-agents who price-up a parent quote before forwarding it.
            </p>
            <label style={fieldLabel}>
              Clone with markup %
              <input
                type="number"
                min={0}
                max={1000}
                step="0.01"
                value={duplicateMargin}
                onChange={(e) => setDuplicateMargin(e.target.value)}
                placeholder="e.g. 10 for +10%"
                style={inputStyle}
                aria-label="Markup percent"
              />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={closeDuplicateModal}
                style={secondaryBtn}
                disabled={duplicating}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDuplicate}
                style={primaryBtn}
                aria-label="Confirm duplicate"
                disabled={duplicating}
              >
                <Copy size={14} /> {duplicating ? "Cloning…" : "Clone"}
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
