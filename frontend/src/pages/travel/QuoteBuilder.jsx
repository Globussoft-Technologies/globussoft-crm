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
import { Calculator, Plus, Trash2, Save, Send, Copy, Download, Check, X, TrendingUp, FileText, ThumbsUp, ThumbsDown, Plane, Hotel, Search, Car, LayoutTemplate, CreditCard, CheckCircle } from "lucide-react";
import { FlightResultsBoard, HotelResultsGrid, TransferResultsList, SuggestedItinerary } from "../../components/TravelSearchResults";
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
const SUB_BRAND_LABELS = Object.fromEntries(SUB_BRANDS.map((s) => [s.value, s.label]));

const LINE_TYPES = ["hotel", "flight", "transport", "visa", "service", "other"];

// TBO search data-source badge (mirrors tboClient's `provider`): live TBO,
// an AI web estimate, or offline sample data — so the operator verifies before
// quoting.
const PROVIDER_LABEL = { serpapi: "Google live", "osm-road": "Live road distance", tbo: "TBO live", "llm-web": "AI web estimate", stub: "Sample data" };
const PROVIDER_COLORS = {
  serpapi: { bg: "rgba(34,197,94,0.16)", fg: "#1e8449" },
  "osm-road": { bg: "rgba(14,124,134,0.16)", fg: "#0e7c86" },
  tbo: { bg: "rgba(34,197,94,0.16)", fg: "#1e8449" },
  "llm-web": { bg: "rgba(59,130,246,0.16)", fg: "#1e4d8c" },
  stub: { bg: "rgba(148,163,184,0.18)", fg: "var(--text-secondary)" },
};
function providerBadge(p) {
  const c = PROVIDER_COLORS[p] || PROVIDER_COLORS.stub;
  return { display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11, fontWeight: 700, marginRight: 6, background: c.bg, color: c.fg };
}
function fmtSearchTime(s) {
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

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
  const [customerSearch, setCustomerSearch] = useState("");
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
  // Send-to-customer confirm modal flag + the resulting share link/channel.
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [shareInfo, setShareInfo] = useState(null); // { shareUrl, channel, ... }
  // Save-as-template modal state — snapshots the current line set into the
  // Quote Template library (POST /api/travel/quote-templates) for reuse.
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateCategory, setTemplateCategory] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  // Slice 11: accept + decline workflow state.
  const [acceptInFlight, setAcceptInFlight] = useState(false);
  const [declineInFlight, setDeclineInFlight] = useState(false);
  // Customer acceptance details fetched from audit-trail when status=Accepted.
  const [acceptanceDetails, setAcceptanceDetails] = useState(null);
  // Advance payment details from the quote row (populated by Razorpay webhook).
  const [paymentInfo, setPaymentInfo] = useState(null); // { amount, paidAt, reference, status }
  const [declineConfirmOpen, setDeclineConfirmOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  // Slice 8: pricing preview state. `pricingPreview` is null until the
  // operator clicks "Calculate with markups"; once populated it renders
  // the side panel until dismissed (set back to null) or until a fresh
  // calculate fires (replaces the value). `previewLoading` gates the
  // button label so consecutive clicks don't fire multiple GETs.
  const [pricingPreview, setPricingPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // ── TBO trip search (flights + hotels) ──────────────────────────
  // Searches live options (TBO → AI web → sample via tboClient) and drops a
  // chosen result into the quote as a draft line. City names OR IATA codes
  // are accepted for flights (the backend resolves to IATA).
  const [fSearch, setFSearch] = useState({ from: "", to: "", departDate: "", cabinClass: "Economy" });
  const [fResults, setFResults] = useState([]);
  const [fMeta, setFMeta] = useState(null);
  const [fLoading, setFLoading] = useState(false);
  const [hSearch, setHSearch] = useState({ city: "", checkIn: "", checkOut: "", rooms: 1, starRating: "" });
  const [hResults, setHResults] = useState([]);
  const [hMeta, setHMeta] = useState(null);
  const [hLoading, setHLoading] = useState(false);
  const [tSearch, setTSearch] = useState({ from: "", to: "", date: "" });
  const [tResults, setTResults] = useState([]);
  const [tMeta, setTMeta] = useState(null);
  const [tLoading, setTLoading] = useState(false);

  // ── Plan trip (destinations → 1-click AI auto-suggest) ──────────
  // The nexus-style headline: enter cities + nights + basics, click Suggest,
  // and we auto-fill round-trip flights + a hotel per city as draft lines
  // (reusing the TBO→AI→sample search). The operator then edits via the
  // search panels / line table before saving.
  const [leavingFrom, setLeavingFrom] = useState("");
  const [tripStart, setTripStart] = useState("");
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [rooms, setRooms] = useState(1);
  const [destinations, setDestinations] = useState([{ city: "", nights: 2, noStay: false }]);
  const [suggesting, setSuggesting] = useState(false);
  // Structured AI suggestion (full option sets per leg/city) powering the
  // visual "Suggested itinerary" panel + Change flight/hotel. Selections sync
  // into draftLines (tagged _suggested) so the Line Items stay the save target.
  const [suggestion, setSuggestion] = useState(null);
  // Sub-brand markup rules — auto-applied to AI-suggested prices (the Suggest
  // flow has no manual markup field, so suggested lines must carry margin).
  const [markupRules, setMarkupRules] = useState([]);

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
        if (q.advancePaidAmount != null) {
          setPaymentInfo({
            amount: Number(q.advancePaidAmount),
            paidAt: q.advancePaidAt || null,
            reference: q.paymentReference || q.advancePaymentId || null,
            status: q.status || null,
          });
        }
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

  // Fetch customer acceptance details (name + note + timestamp) from audit-trail.
  const loadAcceptanceDetails = useCallback(async (id) => {
    if (!id) return;
    try {
      const trail = await fetchApi(`/api/travel/quotes/${id}/audit-trail`);
      const rows = Array.isArray(trail?.entries) ? trail.entries : [];
      const snap = rows.find(
        (r) => r.action === "TRAVEL_QUOTE_CUSTOMER_ACCEPTED" || r.action === "TRAVEL_QUOTE_ACCEPTED",
      );
      if (snap) {
        const details = snap.details || {};
        setAcceptanceDetails({
          customerName: details.customerName || null,
          note: details.changeReason || null,
          acceptedAt: snap.createdAt || null,
        });
      }
    } catch {
      // Non-fatal — acceptance details are supplementary.
    }
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
        if (q.advancePaidAmount != null) {
          setPaymentInfo({
            amount: Number(q.advancePaidAmount),
            paidAt: q.advancePaidAt || null,
            reference: q.paymentReference || q.advancePaymentId || null,
            status: q.status || null,
          });
        }
        // Slice 4 hydration: pull persisted lines from the dedicated endpoint.
        await refreshLines(q.id);
        if ((q.status || "Draft") === "Accepted") {
          await loadAcceptanceDetails(q.id);
        }
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

  // Scope the customer dropdown to the active sub-brand (PRD §3.4): show
  // contacts tagged with THIS sub-brand, plus untagged ones (available to
  // any). A contact tagged to a DIFFERENT sub-brand is hidden so a, say, TMC
  // quote can't accidentally attach an RFU customer. The currently-selected
  // contact is always kept visible via the preserved <option> below, even if
  // it belongs to another sub-brand (edit-mode safety). Re-derives whenever
  // subBrand or the loaded contacts change.
  const visibleCustomers = customers.filter((c) => !c.subBrand || c.subBrand === subBrand);
  const selectedCustomer = customers.find((c) => String(c.id) === String(contactId));

  // Filtered list for the customer search input.
  const customerSearchLower = customerSearch.toLowerCase();
  const filteredCustomers = customerSearchLower
    ? visibleCustomers.filter((c) =>
        (c.name || "").toLowerCase().includes(customerSearchLower) ||
        (c.email || "").toLowerCase().includes(customerSearchLower) ||
        (c.phone || "").toLowerCase().includes(customerSearchLower),
      )
    : visibleCustomers;

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

  // ── TBO search → draft line ─────────────────────────────────────
  const runFlightSearch = async () => {
    if (!fSearch.from.trim() || !fSearch.to.trim()) { notify.error("Enter flight from and to (city or IATA)"); return; }
    if (!fSearch.departDate) { notify.error("Pick a flight date"); return; }
    setFLoading(true); setFResults([]); setFMeta(null);
    try {
      const res = await fetchApi("/api/travel/search/flights", {
        method: "POST",
        body: JSON.stringify({ from: fSearch.from.trim(), to: fSearch.to.trim(), departDate: fSearch.departDate, cabinClass: fSearch.cabinClass, currency: currency || "INR" }),
      });
      setFResults(Array.isArray(res?.options) ? res.options : []);
      setFMeta({ provider: res?.provider || "stub", note: res?.note || null, resolved: res?.resolved || null });
    } catch (err) {
      notify.error(err?.data?.error || err?.body?.error || err?.message || "Flight search failed");
    } finally { setFLoading(false); }
  };
  const runHotelSearch = async () => {
    if (!hSearch.city.trim()) { notify.error("Enter a hotel city"); return; }
    if (!hSearch.checkIn || !hSearch.checkOut) { notify.error("Pick hotel check-in and check-out"); return; }
    setHLoading(true); setHResults([]); setHMeta(null);
    try {
      const res = await fetchApi("/api/travel/search/hotels", {
        method: "POST",
        body: JSON.stringify({
          city: hSearch.city.trim(), checkIn: hSearch.checkIn, checkOut: hSearch.checkOut,
          rooms: parseInt(hSearch.rooms, 10) || 1,
          starRating: hSearch.starRating ? parseInt(hSearch.starRating, 10) : undefined,
          currency: currency || "INR",
        }),
      });
      setHResults(Array.isArray(res?.hotels) ? res.hotels : []);
      setHMeta({ provider: res?.provider || "stub", note: res?.note || null });
    } catch (err) {
      notify.error(err?.data?.error || err?.body?.error || err?.message || "Hotel search failed");
    } finally { setHLoading(false); }
  };
  // Pure builders so manual "Add" and the auto-suggest share one mapping.
  // fromLabel/toLabel let the auto-suggest show FULL city names ("Bangalore →
  // Paris") in the customer-facing description while the IATA codes go in notes —
  // bare codes (BLR→CDG) confused customers.
  const flightDraft = (o, fromLabel, toLabel, pax) => {
    const fl = fromLabel || o.from;
    const tl = toLabel || o.to;
    // Fare is PER traveller → quantity = pax so the line multiplies by headcount
    // (2 adults → qty 2). Customer description uses FULL names; IATA + times in notes.
    const seats = Math.max(1, parseInt(pax, 10) || 1);
    const desc = `${o.airlineName || o.airline || "Flight"}${o.flightNumber ? ` ${o.flightNumber}` : ""} ${fl} → ${tl}${o.fareClass ? ` (${o.fareClass})` : ""}`.trim();
    const notes = [o.from && o.to && `${o.from}→${o.to}`, fmtSearchTime(o.departAt) && `Dep ${fmtSearchTime(o.departAt)}`, fmtSearchTime(o.arriveAt) && `Arr ${fmtSearchTime(o.arriveAt)}`, o.baggage && `Bag ${o.baggage}`].filter(Boolean).join(" · ");
    return { ...EMPTY_DRAFT(), lineType: "flight", description: desc, quantity: seats, unitPrice: Number(o.fare) || 0, notes };
  };
  const hotelDraft = (h) => {
    // Multiply the stay transparently: qty = nights, unit price = per-night rate
    // (so 1 room × 2 nights shows "2 × ₹/night"). totalRate from search already
    // factors nights × rooms, so per-night = totalRate / nights keeps it exact.
    const nights = Number(h.nights) > 0 ? Math.round(Number(h.nights)) : 1;
    const total = Number(h.totalRate != null ? h.totalRate : (Number(h.ratePerNight) || 0) * nights) || 0;
    const perNight = nights > 0 ? Math.round((total / nights) * 100) / 100 : total;
    const desc = `${h.name || "Hotel"}${h.city ? `, ${h.city}` : ""}${h.roomType ? ` — ${h.roomType}` : ""}`;
    const notes = [h.starRating && `${h.starRating}★`, `${nights} night${nights === 1 ? "" : "s"}`, h.board, h.refundable === true && "Refundable"].filter(Boolean).join(" · ");
    return { ...EMPTY_DRAFT(), lineType: "hotel", description: desc, quantity: nights, unitPrice: perNight, notes };
  };
  // Drop a search result into the quote as a draft line (operator saves it like
  // any other line — Save the quote first if it's brand new).
  const addFlightLine = (o) => {
    const pax = (parseInt(adults, 10) || 1) + (parseInt(children, 10) || 0);
    setDraftLines((p) => [...p, flightDraft(o, undefined, undefined, pax)]);
    notify.success?.(`Added flight ${o.from}→${o.to} (${pax} traveller${pax === 1 ? "" : "s"})`);
  };
  const addHotelLine = (h) => {
    // Derive nights from the hotel-search dates so the line multiplies correctly.
    let nights = Number(h.nights) || 1;
    if (hSearch.checkIn && hSearch.checkOut) {
      const a = new Date(hSearch.checkIn); const b = new Date(hSearch.checkOut);
      if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
        nights = Math.max(1, Math.round((b - a) / (24 * 60 * 60 * 1000)));
      }
    }
    setDraftLines((p) => [...p, hotelDraft({ ...h, nights })]);
    notify.success?.(`Added hotel ${h.name || ""}`);
  };
  const transferDraft = (t) => {
    const desc = `Transfer: ${t.from || ""} → ${t.to || ""}${t.vehicle ? ` (${t.vehicle})` : ""}`.trim();
    const notes = [t.durationMinutes && `~${t.durationMinutes} min`, t.note].filter(Boolean).join(" · ");
    return { ...EMPTY_DRAFT(), lineType: "transport", description: desc, quantity: 1, unitPrice: Number(t.price) || 0, notes };
  };
  const addTransferLine = (t) => {
    setDraftLines((p) => [...p, transferDraft(t)]);
    notify.success?.(`Added transfer ${t.from} → ${t.to}`);
  };
  const runTransferSearch = async () => {
    if (!tSearch.from.trim() || !tSearch.to.trim()) { notify.error("Enter transfer from and to"); return; }
    setTLoading(true); setTResults([]); setTMeta(null);
    try {
      const res = await fetchApi("/api/travel/search/transfers", {
        method: "POST",
        body: JSON.stringify({ from: tSearch.from.trim(), to: tSearch.to.trim(), date: tSearch.date || undefined, pax: parseInt(adults, 10) || 2, currency: currency || "INR" }),
      });
      setTResults(Array.isArray(res?.transfers) ? res.transfers : []);
      setTMeta({ provider: res?.provider || "stub", note: res?.note || null });
    } catch (err) {
      notify.error(err?.data?.error || err?.body?.error || err?.message || "Transfer search failed");
    } finally { setTLoading(false); }
  };

  // Plan-trip destination handlers.
  const setDest = (i, patch) => setDestinations((p) => p.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  const addDest = () => setDestinations((p) => [...p, { city: "", nights: 1, noStay: false }]);
  const removeDest = (i) => setDestinations((p) => (p.length <= 1 ? p : p.filter((_, idx) => idx !== i)));

  // 1-click AI auto-suggest: round-trip flights (leaving-from → first city, last
  // city → leaving-from) + a hotel per staying city, dates derived from nights.
  // Each leg/city is best-effort — a leg that can't resolve is skipped, not
  // fatal. Reuses the same /search endpoints (TBO → AI web → sample).
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Rebuild the _suggested draft lines from the current selection set (called on
  // first suggest + every Change flight/hotel). Keeps manually-added lines.
  // Client mirror of lib/travelPricing.pickMarkup: highest-priority active rule
  // for a scope (owner-scoped rules apply to that user; null = everyone).
  const pickClientMarkup = (rules, scope, uid) => {
    const eligible = (rules || [])
      .filter((r) => r.isActive !== false && r.scope === scope)
      .filter((r) => r.ownerUserId == null || r.ownerUserId === uid)
      .sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000));
    return eligible[0] || null;
  };
  // Apply the matched markup rule to a pre-markup line TOTAL (% or flat).
  const applyMarkupToTotal = (rules, scope, baseTotal, uid) => {
    const r = pickClientMarkup(rules, scope, uid);
    if (!r) return baseTotal;
    let out = baseTotal;
    if (r.markupPct != null) out = baseTotal * (1 + Number(r.markupPct) / 100);
    else if (r.markupFlat != null) out = baseTotal + Number(r.markupFlat);
    return Math.round(out * 100) / 100;
  };

  const rebuildSuggestedLines = (sug, rules = markupRules) => {
    if (!sug) return;
    const pax = Math.max(1, sug.pax || 1);
    const uid = user?.userId ?? null;
    const drafts = [];
    for (const leg of sug.flights || []) {
      const o = leg.options[leg.selectedIdx];
      if (!o) continue;
      // Auto-apply the sub-brand flight markup rule (no manual markup field in
      // the suggest flow) → the quote carries margin, not raw supplier cost.
      const baseFare = Number(o.fare) || 0;
      const markedFare = pax > 0 ? applyMarkupToTotal(rules, "flight", baseFare * pax, uid) / pax : baseFare;
      drafts.push(flightDraft({ ...o, fare: markedFare }, leg.fromLabel, leg.toLabel, pax));
    }
    for (const tr of sug.transfers || []) {
      const t = tr.options[tr.selectedIdx];
      if (!t) continue;
      const markedPrice = applyMarkupToTotal(rules, "transport", Number(t.price) || 0, uid);
      drafts.push(transferDraft({ ...t, price: markedPrice, from: tr.fromLabel, to: tr.toLabel }));
    }
    for (const st of sug.stays || []) {
      const h = st.options[st.selectedIdx];
      if (!h) continue;
      const baseTotal = Number(h.totalRate != null ? h.totalRate : (Number(h.ratePerNight) || 0) * (st.nights || 1)) || 0;
      const markedTotal = applyMarkupToTotal(rules, "hotel", baseTotal, uid);
      drafts.push(hotelDraft({ ...h, totalRate: markedTotal, city: st.city, nights: st.nights }));
    }
    setDraftLines((p) => [...p.filter((d) => !d._suggested), ...drafts.map((d) => ({ ...d, _suggested: true }))]);
  };
  // Swap the chosen flight/hotel in the visual panel + re-sync the line items.
  const changeSuggestion = (kind, idx, optIdx) => {
    setSuggestion((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [kind]: prev[kind].map((g, i) => (i === idx ? { ...g, selectedIdx: optIdx } : g)) };
      rebuildSuggestedLines(next);
      return next;
    });
  };

  const suggestTrip = async () => {
    const from = leavingFrom.trim();
    const dests = destinations.filter((d) => d.city.trim());
    if (!from) { notify.error("Enter where the trip leaves from"); return; }
    if (!tripStart) { notify.error("Pick the trip start date"); return; }
    if (dests.length === 0) { notify.error("Add at least one destination city"); return; }
    const start = new Date(tripStart);
    if (Number.isNaN(start.getTime())) { notify.error("Invalid start date"); return; }
    setSuggesting(true);
    const cur = currency || "INR";
    const roomCount = parseInt(rooms, 10) || 1;
    const headcount = (parseInt(adults, 10) || 1) + (parseInt(children, 10) || 0);
    try {
      // Per-city stay windows (running date pointer).
      let cursor = new Date(start);
      const stops = dests.map((d) => {
        const checkIn = new Date(cursor);
        const n = parseInt(d.nights, 10) || 0;
        const checkOut = new Date(cursor.getTime() + n * 86400000);
        cursor = new Date(checkOut);
        return { city: d.city.trim(), nights: n, noStay: d.noStay, checkIn, checkOut };
      });
      const totalNights = stops.reduce((s, c) => s + c.nights, 0);
      const endDate = new Date(start.getTime() + totalNights * 86400000);

      // Capture the FULL option set per leg/city (not just the first) so the
      // visual panel can offer "Change flight / Change hotel" alternatives.
      const sFlights = []; const sTransfers = []; const sStays = [];
      // FLIGHTS: outbound (leaving-from → first city) + return (last city →
      // leaving-from). Inter-city hops are done as ground TRANSFERS below
      // (e.g. Makkah → Madina by road) — the common real case; if a customer
      // wants an inter-city flight (e.g. Paris → London) the advisor adds it
      // from the flight search panel.
      const flightLegs = [
        { from, to: stops[0].city, date: ymd(start) },
        { from: stops[stops.length - 1].city, to: from, date: ymd(endDate) },
      ];
      for (const leg of flightLegs) {
        try {
          const res = await fetchApi("/api/travel/search/flights", {
            method: "POST",
            body: JSON.stringify({ from: leg.from, to: leg.to, departDate: leg.date, cabinClass: "Economy", currency: cur }),
          });
          const options = Array.isArray(res?.options) ? res.options : [];
          if (options.length) sFlights.push({ fromLabel: leg.from, toLabel: leg.to, date: leg.date, options, selectedIdx: 0 });
        } catch { /* skip this leg */ }
      }
      // TRANSFERS: inter-city ground hops (city[i] → city[i+1]).
      for (let i = 0; i < stops.length - 1; i += 1) {
        try {
          const res = await fetchApi("/api/travel/search/transfers", {
            method: "POST",
            body: JSON.stringify({ from: stops[i].city, to: stops[i + 1].city, date: ymd(stops[i].checkOut), pax: parseInt(adults, 10) || 2, currency: cur }),
          });
          const options = Array.isArray(res?.transfers) ? res.transfers : [];
          if (options.length) sTransfers.push({ fromLabel: stops[i].city, toLabel: stops[i + 1].city, options, selectedIdx: 0 });
        } catch { /* skip this hop */ }
      }
      // A hotel per staying city (with the full alternatives list).
      for (const c of stops) {
        if (c.noStay || c.nights <= 0) continue;
        try {
          const res = await fetchApi("/api/travel/search/hotels", {
            method: "POST",
            body: JSON.stringify({ city: c.city, checkIn: ymd(c.checkIn), checkOut: ymd(c.checkOut), rooms: roomCount, currency: cur }),
          });
          const options = (Array.isArray(res?.hotels) ? res.hotels : []).map((h) => ({ ...h, city: c.city, nights: c.nights }));
          if (options.length) sStays.push({ city: c.city, nights: c.nights, options, selectedIdx: 0 });
        } catch { /* skip this city */ }
      }
      const nFlights = sFlights.length; const nHotels = sStays.length; const nTransfers = sTransfers.length;
      if (nFlights + nHotels + nTransfers === 0) {
        notify.error("Couldn't fetch any options — try adjusting the cities or dates");
        return;
      }
      // Fetch the sub-brand's active markup rules so suggested prices carry
      // margin automatically (the suggest flow has no manual markup field).
      let rulesFetched = [];
      try {
        const rr = await fetchApi(`/api/travel/markup-rules?subBrand=${encodeURIComponent(subBrand)}&active=true`);
        rulesFetched = Array.isArray(rr?.rules) ? rr.rules : [];
      } catch { rulesFetched = []; }
      setMarkupRules(rulesFetched);

      // Build the structured suggestion → render the visual panel + (re)build the
      // _suggested draft lines. Re-running Suggest REPLACES the previous set
      // while keeping any lines the operator added manually.
      const sug = { flights: sFlights, transfers: sTransfers, stays: sStays, currency: cur, pax: headcount, adults: parseInt(adults, 10) || 1 };
      setSuggestion(sug);
      rebuildSuggestedLines(sug, rulesFetched);
      const parts = [`${nFlights} flight${nFlights === 1 ? "" : "s"}`, `${nHotels} hotel${nHotels === 1 ? "" : "s"}`];
      if (nTransfers > 0) parts.push(`${nTransfers} transfer${nTransfers === 1 ? "" : "s"}`);
      const markupNote = rulesFetched.length ? " — prices include your markup rules" : " — no markup rules set for this sub-brand";
      notify.success(`Suggested ${parts.join(" + ")}${markupNote}`);
    } catch (e) {
      notify.error(e?.message || "Suggest failed");
    } finally {
      setSuggesting(false);
    }
  };

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
    const wasNew = !quoteId;
    setSaving(true);
    try {
      let id = quoteId;
      if (id) {
        await fetchApi(`/api/travel/quotes/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        const created = await fetchApi("/api/travel/quotes", { method: "POST", body: JSON.stringify(payload) });
        id = created?.id;
        if (id) setQuoteId(id);
      }
      if (!id) { notify.error("Save failed — no quote id returned"); return; }

      // Auto-commit ALL draft (un-persisted) lines so Save Draft saves the
      // WHOLE quote — header + lines. Previously drafts stayed local until each
      // row's ✓ was clicked, so the PDF / public view (which read persisted
      // lines) came out empty even though the total was set. Best-effort per
      // line; the backend recomputes the quote total after the writes.
      const pending = draftLines.filter((d) => d.description && d.description.trim());
      let committed = 0;
      for (const d of pending) {
        const unit = Number(d.unitPrice);
        if (!Number.isFinite(unit) || unit < 0) continue;
        try {
          const body = {
            lineType: d.lineType || "other",
            description: d.description.trim(),
            quantity: Math.max(1, parseInt(d.quantity, 10) || 1),
            unitPrice: unit,
          };
          if (d.supplierId !== "" && d.supplierId != null) body.supplierId = parseInt(d.supplierId, 10);
          if (d.notes) body.notes = String(d.notes);
          await fetchApi(`/api/travel/quotes/${id}/lines`, { method: "POST", body: JSON.stringify(body) });
          committed += 1;
        } catch { /* skip a bad line, keep going */ }
      }
      if (committed > 0) {
        setDraftLines((prev) => prev.filter((d) => !pending.includes(d)));
        await refreshLines(id);
        await refreshParentQuote(id);
      }
      notify.success(
        wasNew
          ? `Quote created (#${id})${committed ? ` with ${committed} line${committed === 1 ? "" : "s"}` : ""}`
          : `Quote #${id} saved${committed ? ` (+${committed} line${committed === 1 ? "" : "s"})` : ""}`,
      );
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

  // Real send: mint a customer-share link + deliver it via email (if the
  // contact has one) + WhatsApp (the connected number). The link opens the
  // public quote page (/p/quote/:token) where the customer can view + accept.
  const confirmSend = async () => {
    if (!quoteId) {
      setSendConfirmOpen(false);
      return;
    }
    setSending(true);
    try {
      const res = await fetchApi(`/api/travel/quotes/${quoteId}/share`, {
        method: "POST",
        body: JSON.stringify({ channel: "auto", frontendBase: window.location.origin }),
      });
      if (res?.status) setStatus(res.status);
      setShareInfo(res || null);
      const ch = res?.channel || "none";
      if (ch === "none") {
        notify.success("Share link created — send it manually (the contact has no email/phone, or WhatsApp isn't connected)");
      } else {
        const parts = [];
        if (ch.includes("email")) parts.push("email");
        if (ch.includes("whatsapp")) parts.push("WhatsApp");
        notify.success(`Quote sent to the customer via ${parts.join(" + ")}`);
      }
    } catch (err) {
      notify.error(err?.data?.error || err?.body?.error || err?.message || "Send failed");
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
      await loadAcceptanceDetails(quoteId);
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

  // ── Save as template ────────────────────────────────────────────────
  // Snapshot the current line set (persisted + draft) into the reusable Quote
  // Template library. Works from a saved OR a brand-new quote — the template
  // endpoint only needs the lines, not a quoteId. Lines are stored as the
  // linesJson shape the apply-to-quote endpoint expects.
  const buildTemplateLines = () =>
    visibleLines
      .filter((l) => l.description && String(l.description).trim())
      .map((l, idx) => {
        const item = {
          description: String(l.description).trim(),
          lineType: l.lineType || "other",
          quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
          unitPrice: Math.max(0, Number(l.unitPrice) || 0),
          currency: l.currency || currency || "INR",
          sortOrder: idx,
        };
        if (l.notes) item.notes = String(l.notes);
        return item;
      });

  const openTemplateModal = () => {
    if (buildTemplateLines().length === 0) {
      notify.error("Add at least one line before saving as a template");
      return;
    }
    // Seed a sensible default name from the contact / sub-brand.
    const cName = (contactsById[contactId] && contactsById[contactId].name) || "";
    setTemplateName(cName ? `${cName} — ${(subBrand || "Quote").toUpperCase()}` : "");
    setTemplateCategory("");
    setTemplateModalOpen(true);
  };

  const saveAsTemplate = async () => {
    const lines = buildTemplateLines();
    if (lines.length === 0) {
      notify.error("Add at least one line before saving as a template");
      return;
    }
    if (!templateName.trim()) {
      notify.error("Template name is required");
      return;
    }
    setSavingTemplate(true);
    try {
      const body = {
        name: templateName.trim(),
        currency: currency || "INR",
        linesJson: JSON.stringify(lines),
      };
      if (subBrand) body.subBrand = subBrand;
      if (templateCategory.trim()) body.category = templateCategory.trim();
      const created = await fetchApi("/api/travel/quote-templates", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success(
        `Saved as template "${created?.name || templateName.trim()}" (${lines.length} line${lines.length === 1 ? "" : "s"}) — find it under Quote Templates`,
      );
      setTemplateModalOpen(false);
      setTemplateName("");
      setTemplateCategory("");
    } catch (err) {
      notify.error(err?.data?.error || err?.message || "Failed to save template");
    } finally {
      setSavingTemplate(false);
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
            {/* Save the current line set into the reusable Quote Template
                library — works even before the quote is saved (it only needs
                the lines). Hidden until at least one line exists. */}
            <button
              type="button"
              onClick={openTemplateModal}
              disabled={savingTemplate || visibleLines.length === 0}
              style={secondaryBtn}
              title={visibleLines.length === 0 ? "Add a line first" : "Save these lines as a reusable template"}
              aria-label="Save as template"
            >
              <LayoutTemplate size={14} /> Save as template
            </button>
            {/* Everything beyond Save Draft acts on a SAVED quote (send, PDF,
                convert, accept/decline) — hidden in new/create mode, shown once
                the quote exists / when opened from the quotes history. */}
            {quoteId && (
              <>
            <button
              type="button"
              onClick={openSendConfirm}
              disabled={saving || sending || !quoteId}
              style={secondaryBtn}
              title="Send / re-send to customer (WhatsApp + email)"
            >
              <Send size={14} /> {status === "Sent" ? "Re-send" : "Send to customer"}
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
              </>
            )}
          </div>
        )}
      </header>

      {shareInfo?.shareUrl && (
        <section
          className="glass"
          aria-label="Customer share link"
          style={{ padding: 12, marginBottom: 16, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
        >
          <Send size={14} aria-hidden style={{ color: "var(--primary-color, var(--accent-color))" }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Customer link:</span>
          <code style={{ fontSize: 12, wordBreak: "break-all", flex: 1, minWidth: 0 }}>{shareInfo.shareUrl}</code>
          <button
            type="button"
            onClick={() => { navigator.clipboard?.writeText(shareInfo.shareUrl).then(() => notify.success("Link copied")).catch(() => notify.error("Copy failed — select the link")); }}
            style={secondaryBtn}
          >
            <Copy size={14} /> Copy
          </button>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            {shareInfo.channel && shareInfo.channel !== "none"
              ? `Sent via ${shareInfo.channel.replace("+", " + ")}`
              : "Not delivered — share the link manually"}
          </span>
        </section>
      )}

      {status === "Accepted" && (
        <section
          className="glass"
          aria-label="Customer acceptance details"
          style={{
            padding: 14,
            marginBottom: 16,
            borderLeft: "4px solid var(--success-color, #22c55e)",
            background: "rgba(34, 197, 94, 0.07)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ThumbsUp size={16} aria-hidden style={{ color: "var(--success-color, #22c55e)", flexShrink: 0 }} />
            <span style={{ fontWeight: 700, fontSize: 14, color: "var(--success-color, #22c55e)" }}>
              Quote accepted by customer
            </span>
            {acceptanceDetails?.acceptedAt && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: "auto" }}>
                {new Date(acceptanceDetails.acceptedAt).toLocaleString()}
              </span>
            )}
          </div>
          {acceptanceDetails ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 24px", paddingLeft: 24, fontSize: 13 }}>
              <span>
                <span style={{ fontWeight: 600 }}>Name: </span>
                {acceptanceDetails.customerName || <em style={{ color: "var(--text-secondary)" }}>not provided</em>}
              </span>
              <span style={{ flex: "1 1 100%" }}>
                <span style={{ fontWeight: 600 }}>Note: </span>
                {acceptanceDetails.note
                  ? <span style={{ whiteSpace: "pre-wrap" }}>{acceptanceDetails.note}</span>
                  : <em style={{ color: "var(--text-secondary)" }}>none</em>
                }
              </span>
            </div>
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-secondary)", paddingLeft: 24 }}>
              Loading acceptance details…
            </span>
          )}
        </section>
      )}

      {paymentInfo && (
        <section
          className="glass"
          aria-label="Advance payment details"
          style={{
            padding: 14,
            marginBottom: 16,
            borderLeft: `4px solid ${paymentInfo.status === "fully_paid" ? "var(--primary-color, var(--accent-color))" : "#f59e0b"}`,
            background: paymentInfo.status === "fully_paid" ? "rgba(34, 197, 94, 0.05)" : "rgba(245, 158, 11, 0.07)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {paymentInfo.status === "fully_paid"
              ? <CheckCircle size={16} aria-hidden style={{ color: "var(--primary-color, var(--accent-color))", flexShrink: 0 }} />
              : <CreditCard size={16} aria-hidden style={{ color: "#f59e0b", flexShrink: 0 }} />
            }
            <span style={{ fontWeight: 700, fontSize: 14, color: paymentInfo.status === "fully_paid" ? "var(--primary-color, var(--accent-color))" : "#b45309" }}>
              {paymentInfo.status === "fully_paid" ? "Fully paid" : "Advance payment received"}
            </span>
            {paymentInfo.paidAt && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: "auto" }}>
                {new Date(paymentInfo.paidAt).toLocaleString()}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 24px", paddingLeft: 24, fontSize: 13 }}>
            <span>
              <span style={{ fontWeight: 600 }}>Amount paid: </span>
              {currency} {Number(paymentInfo.amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            {paymentInfo.reference && (
              <span>
                <span style={{ fontWeight: 600 }}>Reference: </span>
                <code style={{ fontSize: 12, background: "rgba(0,0,0,0.06)", padding: "1px 5px", borderRadius: 3 }}>{paymentInfo.reference}</code>
              </span>
            )}
          </div>
        </section>
      )}

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
          {/* Search input filters the native select options below. */}
          <input
            type="text"
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
            placeholder="Search customers…"
            style={{ ...inputStyle, marginBottom: 4 }}
          />
          <select
            value={contactId}
            onChange={(e) => { setContactId(e.target.value); setCustomerSearch(""); }}
            style={inputStyle}
            aria-label="Customer"
          >
            <option value="">Select customer *</option>
            {contactId && !filteredCustomers.some((c) => String(c.id) === String(contactId)) && (
              <option value={contactId}>
                {(selectedCustomer?.name || contactsById[contactId]?.name || `Contact #${contactId}`)
                  + (selectedCustomer?.subBrand && selectedCustomer.subBrand !== subBrand
                    ? ` — ${SUB_BRAND_LABELS[selectedCustomer.subBrand] || selectedCustomer.subBrand}`
                    : "")}
              </option>
            )}
            {filteredCustomers.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {(c.name || `Contact #${c.id}`) + (c.email ? ` — ${c.email}` : "") + (!c.subBrand ? " · (unassigned)" : "")}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4, display: "block" }}>
            {visibleCustomers.length === 0
              ? `No ${SUB_BRAND_LABELS[subBrand] || subBrand} customers yet`
              : `Showing ${SUB_BRAND_LABELS[subBrand] || subBrand} customers`}
          </span>
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

      {/* Plan trip — destinations + 1-click AI auto-suggest (nexus-style). */}
      <section className="glass" aria-label="Plan trip" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          <Calculator size={16} aria-hidden /> Plan trip
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "4px 0 12px" }}>
          Enter the cities + nights, then let AI suggest flights &amp; hotels — it fills the lines below, which you can edit via the search panels.
        </p>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%,150px),1fr))", marginBottom: 10 }}>
          <input placeholder="Leaving from (city)" value={leavingFrom} onChange={(e) => setLeavingFrom(e.target.value)} style={inputStyle} aria-label="Leaving from" />
          <input type="date" value={tripStart} onChange={(e) => setTripStart(e.target.value)} style={inputStyle} aria-label="Trip start date" />
          <input type="number" min="1" placeholder="Adults" value={adults} onChange={(e) => setAdults(e.target.value)} style={inputStyle} aria-label="Adults" />
          <input type="number" min="0" placeholder="Children" value={children} onChange={(e) => setChildren(e.target.value)} style={inputStyle} aria-label="Children" />
          <input type="number" min="1" placeholder="Rooms" value={rooms} onChange={(e) => setRooms(e.target.value)} style={inputStyle} aria-label="Rooms" />
        </div>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Destinations (in order)</div>
        {destinations.map((d, i) => (
          <div key={i} style={{ display: "grid", gap: 8, gridTemplateColumns: "2fr 1fr auto auto", alignItems: "center", marginBottom: 6 }}>
            <input placeholder={`City ${i + 1} (e.g. Makkah)`} value={d.city} onChange={(e) => setDest(i, { city: e.target.value })} style={inputStyle} aria-label={`Destination city ${i + 1}`} />
            <input type="number" min="0" placeholder="Nights" value={d.nights} onChange={(e) => setDest(i, { nights: e.target.value })} style={inputStyle} aria-label={`Nights in city ${i + 1}`} disabled={d.noStay} />
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={d.noStay} onChange={(e) => setDest(i, { noStay: e.target.checked })} aria-label={`No stay in city ${i + 1}`} /> No stay
            </label>
            <button type="button" onClick={() => removeDest(i)} disabled={destinations.length <= 1} style={{ ...iconBtn, opacity: destinations.length <= 1 ? 0.4 : 1 }} aria-label={`Remove city ${i + 1}`}>
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <button type="button" onClick={addDest} style={secondaryBtn}><Plus size={14} /> Add city</button>
          <button type="button" onClick={suggestTrip} disabled={suggesting} style={primaryBtn}>
            <TrendingUp size={14} /> {suggesting ? "Suggesting…" : "Suggest flights & hotels"}
          </button>
        </div>
      </section>

      {/* Visual review of the 1-click Suggest output — hotel cards with imagery,
          a price summary, and Change flight/hotel (re-syncs the Line Items). */}
      <SuggestedItinerary
        suggestion={suggestion}
        onChangeFlight={(idx, optIdx) => changeSuggestion("flights", idx, optIdx)}
        onChangeStay={(idx, optIdx) => changeSuggestion("stays", idx, optIdx)}
      />

      {/* TBO trip search — flights + hotels → draft lines (PRD trip builder).
          Live options via tboClient (TBO → AI web → sample); "Add" drops a
          result into the quote as a draft line the operator then saves. */}
      <section className="glass" aria-label="Search flights and hotels" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          <Search size={16} aria-hidden /> Search flights &amp; hotels
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "4px 0 12px" }}>
          Live options via TBO (falls back to an AI web estimate, then sample data). Add a result to drop it into the quote below as a line.
        </p>

        <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}><Plane size={14} aria-hidden /> Flights</div>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%,140px),1fr))" }}>
          <input placeholder="From (city or IATA)" value={fSearch.from} onChange={(e) => setFSearch({ ...fSearch, from: e.target.value })} style={inputStyle} aria-label="Flight from" />
          <input placeholder="To (city or IATA)" value={fSearch.to} onChange={(e) => setFSearch({ ...fSearch, to: e.target.value })} style={inputStyle} aria-label="Flight to" />
          <input type="date" value={fSearch.departDate} onChange={(e) => setFSearch({ ...fSearch, departDate: e.target.value })} style={inputStyle} aria-label="Flight date" />
          <select value={fSearch.cabinClass} onChange={(e) => setFSearch({ ...fSearch, cabinClass: e.target.value })} style={inputStyle} aria-label="Cabin class">
            {["Economy", "Premium Economy", "Business", "First"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button type="button" onClick={runFlightSearch} disabled={fLoading} style={primaryBtn}><Search size={14} /> {fLoading ? "Searching…" : "Search flights"}</button>
        </div>
        {fMeta && (
          <p style={{ fontSize: 12, margin: "8px 0 0", color: "var(--text-secondary)" }}>
            <span style={providerBadge(fMeta.provider)}>{PROVIDER_LABEL[fMeta.provider] || fMeta.provider}</span>
            {fMeta.resolved ? `${fMeta.resolved.from.input} → ${fMeta.resolved.from.iata} · ${fMeta.resolved.to.input} → ${fMeta.resolved.to.iata}. ` : ""}
            {fMeta.note || ""}
          </p>
        )}
        <FlightResultsBoard results={fResults} currency={currency} onAdd={addFlightLine} addLabel="Add" />

        <div style={{ margin: "16px 0 8px", fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}><Hotel size={14} aria-hidden /> Hotels</div>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%,140px),1fr))" }}>
          <input placeholder="City" value={hSearch.city} onChange={(e) => setHSearch({ ...hSearch, city: e.target.value })} style={inputStyle} aria-label="Hotel city" />
          <input type="date" value={hSearch.checkIn} onChange={(e) => setHSearch({ ...hSearch, checkIn: e.target.value })} style={inputStyle} aria-label="Check-in" />
          <input type="date" value={hSearch.checkOut} onChange={(e) => setHSearch({ ...hSearch, checkOut: e.target.value })} style={inputStyle} aria-label="Check-out" />
          <input type="number" min="1" placeholder="Rooms" value={hSearch.rooms} onChange={(e) => setHSearch({ ...hSearch, rooms: e.target.value })} style={inputStyle} aria-label="Rooms" />
          <select value={hSearch.starRating} onChange={(e) => setHSearch({ ...hSearch, starRating: e.target.value })} style={inputStyle} aria-label="Star rating">
            <option value="">Any rating</option>{[3, 4, 5].map((s) => <option key={s} value={s}>{s} star</option>)}
          </select>
          <button type="button" onClick={runHotelSearch} disabled={hLoading} style={primaryBtn}><Search size={14} /> {hLoading ? "Searching…" : "Search hotels"}</button>
        </div>
        {hMeta && (
          <p style={{ fontSize: 12, margin: "8px 0 0", color: "var(--text-secondary)" }}>
            <span style={providerBadge(hMeta.provider)}>{PROVIDER_LABEL[hMeta.provider] || hMeta.provider}</span>{hMeta.note || ""}
          </p>
        )}
        <HotelResultsGrid results={hResults} currency={currency} city={hSearch.city} onAdd={addHotelLine} addLabel="Add to quote" />

        <div style={{ margin: "16px 0 8px", fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}><Car size={14} aria-hidden /> Transfers (taxi / road)</div>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%,140px),1fr))" }}>
          <input placeholder="From (city / airport)" value={tSearch.from} onChange={(e) => setTSearch({ ...tSearch, from: e.target.value })} style={inputStyle} aria-label="Transfer from" />
          <input placeholder="To (city / hotel)" value={tSearch.to} onChange={(e) => setTSearch({ ...tSearch, to: e.target.value })} style={inputStyle} aria-label="Transfer to" />
          <input type="date" value={tSearch.date} onChange={(e) => setTSearch({ ...tSearch, date: e.target.value })} style={inputStyle} aria-label="Transfer date" />
          <button type="button" onClick={runTransferSearch} disabled={tLoading} style={primaryBtn}><Search size={14} /> {tLoading ? "Searching…" : "Search transfers"}</button>
        </div>
        {tMeta && (
          <p style={{ fontSize: 12, margin: "8px 0 0", color: "var(--text-secondary)" }}>
            <span style={providerBadge(tMeta.provider)}>{PROVIDER_LABEL[tMeta.provider] || tMeta.provider}</span>{tMeta.note || ""}
          </p>
        )}
        <TransferResultsList results={tResults} currency={currency} onAdd={addTransferLine} addLabel="Add" />
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

      {templateModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Save quote as template"
          onClick={(e) => { if (e.target === e.currentTarget && !savingTemplate) setTemplateModalOpen(false); }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1100,
            padding: "1rem",
          }}
        >
          <div
            style={{
              background: "var(--bg-color)",
              color: "var(--text-primary)",
              padding: 24,
              minWidth: 320,
              maxWidth: 520,
              width: "100%",
              borderRadius: 10,
              border: "1px solid var(--border-color)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
            }}
          >
            <h3 style={{ margin: "0 0 6px", fontSize: "1.1rem", display: "flex", alignItems: "center", gap: 8 }}>
              <LayoutTemplate size={18} /> Save as template
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 16 }}>
              Saves the current{" "}
              <strong>{buildTemplateLines().length} line{buildTemplateLines().length === 1 ? "" : "s"}</strong>{" "}
              into the Quote Template library so you can reuse them on a future quote in one click.
            </p>
            <label style={fieldLabel}>
              Template name
              <input
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g. Umrah 7-day · Premium"
                style={{ ...inputStyle, width: "100%" }}
                aria-label="Template name"
                maxLength={255}
                autoFocus
              />
            </label>
            <label style={{ ...fieldLabel, marginTop: 12 }}>
              Category <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>(optional)</span>
              <input
                type="text"
                value={templateCategory}
                onChange={(e) => setTemplateCategory(e.target.value)}
                placeholder="e.g. Umrah · India-tour · Europe"
                style={{ ...inputStyle, width: "100%" }}
                aria-label="Template category"
                maxLength={120}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button
                type="button"
                onClick={() => setTemplateModalOpen(false)}
                style={secondaryBtn}
                disabled={savingTemplate}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveAsTemplate}
                style={primaryBtn}
                aria-label="Confirm save as template"
                disabled={savingTemplate || !templateName.trim()}
              >
                <LayoutTemplate size={14} /> {savingTemplate ? "Saving…" : "Save template"}
              </button>
            </div>
          </div>
        </div>
      )}

      {sendConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm send to customer"
          onClick={(e) => { if (e.target === e.currentTarget && !sending) setSendConfirmOpen(false); }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1100,
            padding: "1rem",
          }}
        >
          <div
            style={{
              background: "var(--bg-color)",
              color: "var(--text-primary)",
              padding: 24,
              minWidth: 320,
              maxWidth: 520,
              borderRadius: 10,
              border: "1px solid var(--border-color)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
            }}
          >
            <h3 style={{ margin: "0 0 12px", fontSize: "1.1rem" }}>
              Send quote #{quoteId} to customer?
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 16 }}>
              This creates a secure customer link (they can view + accept the
              quote) and delivers it by <strong>email</strong> (if on file) and
              <strong> WhatsApp</strong> via your connected number. You can
              re-send any time.
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
          onClick={(e) => { if (e.target === e.currentTarget) setDeleteTarget(null); }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1100,
            padding: "1rem",
          }}
        >
          {/* Solid surface — NOT .glass — so the dialog isn't see-through over
              the page content behind it (that looked broken). */}
          <div
            style={{
              background: "var(--bg-color)",
              color: "var(--text-primary)",
              padding: 24,
              minWidth: 320,
              maxWidth: 480,
              borderRadius: 10,
              border: "1px solid var(--border-color)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
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
