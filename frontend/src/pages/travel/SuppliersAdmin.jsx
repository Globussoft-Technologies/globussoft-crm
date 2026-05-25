// Travel CRM — Suppliers (master) admin page.
//
// Lands at /travel/suppliers-admin. Operator-facing master list of
// TravelSupplier rows — Hotel / Flight / Transport / Visa Consul / Other.
// CRUD wires to the /api/travel/suppliers endpoints (commit 192b8c1):
//   GET    /api/travel/suppliers                  list (filters: subBrand / supplierCategory / includeInactive)
//   POST   /api/travel/suppliers                  create (ADMIN+MANAGER)
//   PUT    /api/travel/suppliers/:id              edit   (ADMIN+MANAGER)
//   DELETE /api/travel/suppliers/:id              soft-delete (returns 204)
//
// SIBLING surface, not a replacement: the existing /travel/suppliers
// (Suppliers.jsx) hosts the encrypted SupplierCredential vault for
// airline/GDS/portal logins. This page is the operator-facing master
// list (name, GSTIN, contact, sub-brand). Different model, different
// concern.
//
// Template: cloned from frontend/src/pages/wellness/Patients.jsx (the
// canonical header + table + add/edit modal pattern). Empty-state
// honors the #829 permission-denied vs no-rows distinction.

import { useEffect, useState, useContext, Fragment } from "react";
import { Building2, Plus, Pencil, Trash2, ChevronDown, ChevronRight, CheckCircle2, XCircle, Wallet, BarChart3 } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { SUB_BRAND_BG } from "../../utils/travelSubBrand";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const SUPPLIER_CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "hotel", label: "Hotel" },
  { value: "flight", label: "Flight" },
  { value: "transport", label: "Transport" },
  { value: "visa-consul", label: "Visa Consul" },
  { value: "other", label: "Other" },
];

// Sub-brand pill background: imported from utils/travelSubBrand (rule-of-3
// promotion 2026-05-24 tick #99 — was inline here as the origin copy at
// commit 08ebe5e, then cloned into QuotesAdmin/InvoicesAdmin; promoted to
// the shared util once the third caller landed).

// PRD_TRAVEL_SUPPLIER_MASTER #903 slice 1 — GSTIN format (pinned from
// backend/routes/travel_suppliers.js GSTIN_REGEX). Used here for the
// client-side hint + soft-validation (the backend re-validates regardless).
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/;
const GSTIN_HINT = "Format: 22ABCDE1234F1Z5";

// Credit-currency dropdown choices — per slice prompt + Tenant.defaultCurrency
// canon (INR/USD/EUR/GBP/AED/SAR). Default INR matches backend slice 1 default.
const CREDIT_CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SAR"];

// Tax regime choices — per backend slice 1 (no enum, free String? — but the
// PRD's enumerated set is "regular" | "composite" | "exempt"). "" = unset.
const TAX_REGIMES = [
  { value: "", label: "(unset)" },
  { value: "regular", label: "Regular" },
  { value: "composite", label: "Composite" },
  { value: "exempt", label: "Exempt" },
];

// Suggested primary-contact roles (datalist autocomplete). Free-form string.
const CONTACT_ROLE_SUGGESTIONS = [
  "Accounts payable",
  "Sales rep",
  "Reservations",
  "Operations",
  "Owner",
  "Branch manager",
];

// Per-currency display symbol — rendered as a small prefix beside the credit
// limit field when the currency is set. INR is the default expected case.
const CURRENCY_SYMBOL = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  AED: "د.إ",
  SAR: "﷼",
};

// PRD_TRAVEL_SUPPLIER_MASTER #903 slice 4 — payables panel.
// Operator-facing A/P ledger surfaced inline per supplier row. Backend
// contract pinned from commit 59336ab7:
//   GET    /api/travel/suppliers/:id/payables          list + ?status filter
//   POST   /api/travel/suppliers/:id/payables          ADMIN+MANAGER create
//   PUT    /api/travel/suppliers/:id/payables/:pid     ADMIN+MANAGER patch
//   DELETE /api/travel/suppliers/:id/payables/:pid     ADMIN+MANAGER hard-delete
// Status enum: pending | scheduled | paid | cancelled.
// PUT status='paid' auto-sets paidAt=now() server-side; no client-side dance
// required.
const PAYABLE_STATUS_STYLE = {
  pending: { bg: "rgba(245, 158, 11, 0.18)", fg: "var(--warning-color, #f59e0b)" },
  scheduled: { bg: "rgba(59, 130, 246, 0.18)", fg: "#3b82f6" },
  paid: { bg: "rgba(34, 197, 94, 0.18)", fg: "var(--success-color, #22c55e)" },
  cancelled: { bg: "rgba(148, 163, 184, 0.18)", fg: "var(--text-secondary)" },
};

// PRD_TRAVEL_SUPPLIER_MASTER #903 slice 9 — Payables Aging panel.
// Operator-facing aged-payable summary at the top of the page. Consumes the
// backend report endpoint shipped in commit c7900645:
//   GET /api/travel/payables/aging
//     → 200 { asOf, subBrand, supplierCategory, bucketTotals, grandTotal,
//             excludedCount, excludedReasons }
// bucketTotals shape: { "current"|"1-30"|"31-60"|"61-90"|"90+":
//                       { count: <int>, totalAmount: <number> } }
// Urgency palette: green → yellow → orange → red → dark-red across the 5
// buckets. The page renders the panel on mount once (no auto-refresh — the
// numbers shift slowly enough that the operator can refresh by reloading
// the page when they want fresh data).
const AGING_BUCKETS = [
  { key: "current", label: "Current",   bg: "rgba(34, 197, 94, 0.18)",  fg: "var(--success-color, #22c55e)" }, // green
  { key: "1-30",    label: "1-30 days", bg: "rgba(234, 179, 8, 0.18)",  fg: "#eab308" },                       // yellow
  { key: "31-60",   label: "31-60 days",bg: "rgba(249, 115, 22, 0.18)", fg: "#f97316" },                       // orange
  { key: "61-90",   label: "61-90 days",bg: "rgba(244, 63, 94, 0.18)",  fg: "var(--danger-color, #f43f5e)" },  // red
  { key: "90+",     label: "90+ days",  bg: "rgba(127, 29, 29, 0.28)",  fg: "#dc2626" },                       // dark red
];

// Slice-4 add-payable form initial state. Empty strings normalise to null
// on submit (description + amount required, the rest optional).
const EMPTY_PAYABLE_FORM = {
  description: "",
  amount: "",
  dueDate: "",
  poNumber: "",
  notes: "",
};

const EMPTY_FORM = {
  name: "",
  contactPerson: "",
  phone: "",
  email: "",
  gstin: "",
  addressLine: "",
  supplierCategory: "other",
  subBrand: "tmc",
  // Slice 2 (#903) — payment terms + credit-tracking + metadata, surfaced
  // in the modal form. Empty strings normalise to null at submit time.
  paymentTermsDays: "",
  creditLimit: "",
  creditCurrency: "INR",
  taxRegimeCode: "",
  primaryContactRole: "",
  notes: "",
};

export default function SuppliersAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [suppliers, setSuppliers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // #829 — distinguish 403 from genuine empty so the empty-state copy
  // honestly says "Access restricted" instead of "No suppliers match."
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [subBrand, setSubBrand] = useState("");
  const [supplierCategory, setSupplierCategory] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Slice 4 (#903) — payables panel state. Single-expanded UX (only one
  // supplier's panel open at a time) keeps DOM + outbound fetches tight on
  // the suppliers list page; if an operator needs side-by-side comparison
  // they can open the supplier detail in a new tab. Per-supplier slot maps
  // keyed by supplier id avoid cross-row state collisions during expand/
  // collapse churn.
  const [expandedSupplierId, setExpandedSupplierId] = useState(null);
  const [payablesBySupplier, setPayablesBySupplier] = useState({}); // { [supplierId]: [rows] }
  const [payablesLoadingBy, setPayablesLoadingBy] = useState({});   // { [supplierId]: bool }
  const [payableForm, setPayableForm] = useState({});               // { [supplierId]: form }
  const [payableSaving, setPayableSaving] = useState({});           // { [supplierId]: bool }

  // Slice 9 (#903) — payables aging panel state. Loaded once on mount via
  // GET /api/travel/payables/aging. `aging` is null until first response;
  // `agingLoading` gates the placeholder render; `agingError` true on 5xx
  // (after notify.error fires) so the panel can render an inline retry
  // affordance rather than disappearing silently.
  const [aging, setAging] = useState(null);
  const [agingLoading, setAgingLoading] = useState(true);
  const [agingError, setAgingError] = useState(false);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (supplierCategory) qs.set("supplierCategory", supplierCategory);
    if (includeInactive) qs.set("includeInactive", "1");
    const url = `/api/travel/suppliers${qs.toString() ? `?${qs.toString()}` : ""}`;
    fetchApi(url)
      .then((d) => {
        setSuppliers(Array.isArray(d?.suppliers) ? d.suppliers : []);
        setTotal(Number.isFinite(d?.total) ? d.total : 0);
        setPermissionDenied(false);
      })
      .catch((err) => {
        setSuppliers([]);
        setTotal(0);
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [subBrand, supplierCategory, includeInactive]);

  // Slice 9 (#903) — load aged-payable report on mount + when sub-brand or
  // category filters change (so the panel mirrors the suppliers list the
  // operator is currently looking at). Single-fetch, no polling — operator
  // refreshes the page when they want a re-read.
  const loadAging = () => {
    setAgingLoading(true);
    setAgingError(false);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (supplierCategory) qs.set("supplierCategory", supplierCategory);
    const url = `/api/travel/payables/aging${qs.toString() ? `?${qs.toString()}` : ""}`;
    fetchApi(url)
      .then((d) => {
        setAging(d || null);
        setAgingError(false);
      })
      .catch((err) => {
        setAging(null);
        setAgingError(true);
        // 403 is silently absorbed (the suppliers list itself surfaces the
        // permission-denied empty state — duplicating it on the aging panel
        // would be noisy). All other failures get a notify.error.
        if (err?.status !== 403) {
          notify.error(err?.body?.error || err?.message || "Failed to load payables aging");
        }
      })
      .finally(() => setAgingLoading(false));
  };

  useEffect(loadAging, [subBrand, supplierCategory]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (s) => {
    setForm({
      name: s.name || "",
      contactPerson: s.contactPerson || "",
      phone: s.phone || "",
      email: s.email || "",
      gstin: s.gstin || "",
      addressLine: s.addressLine || "",
      supplierCategory: s.supplierCategory || "other",
      subBrand: s.subBrand || "tmc",
      // Slice 2 (#903) — prefill the new fields from the row. Coerce
      // numeric DB values back to strings so the controlled <input> stays
      // consistent (empty-string === unset).
      paymentTermsDays: s.paymentTermsDays != null ? String(s.paymentTermsDays) : "",
      creditLimit: s.creditLimit != null ? String(s.creditLimit) : "",
      creditCurrency: s.creditCurrency || "INR",
      taxRegimeCode: s.taxRegimeCode || "",
      primaryContactRole: s.primaryContactRole || "",
      notes: s.notes || "",
    });
    setEditingId(s.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedName = (form.name || "").trim();
    if (!trimmedName) {
      notify.error("Name is required");
      return;
    }
    // Slice 2 (#903) — client-side GSTIN soft-validation. Backend re-validates
    // either way; this just catches the typo before the round-trip. Empty
    // is allowed (the backend treats null/missing as "unset"); non-empty
    // must match the 15-char regex.
    const gstinTrimmed = form.gstin ? form.gstin.toUpperCase().trim() : "";
    if (gstinTrimmed && !GSTIN_REGEX.test(gstinTrimmed)) {
      notify.error(`Invalid GSTIN. ${GSTIN_HINT}`);
      return;
    }
    setSaving(true);
    try {
      // Slice 2 (#903) — empty optional STRINGS serialise to null (matching
      // the original contact/phone/email/gstin pattern). Numeric fields
      // (paymentTermsDays / creditLimit) parse to numbers when present,
      // null when empty.
      const paymentTermsDaysVal =
        form.paymentTermsDays === "" || form.paymentTermsDays == null
          ? null
          : parseInt(form.paymentTermsDays, 10);
      const creditLimitVal =
        form.creditLimit === "" || form.creditLimit == null
          ? null
          : Number(form.creditLimit);
      const payload = {
        ...form,
        name: trimmedName,
        // Empty strings -> null so backend doesn't store ""
        contactPerson: form.contactPerson || null,
        phone: form.phone || null,
        email: form.email || null,
        gstin: gstinTrimmed || null,
        addressLine: form.addressLine || null,
        // Slice 2 (#903) — new optional fields.
        paymentTermsDays: paymentTermsDaysVal,
        creditLimit: creditLimitVal,
        creditCurrency: form.creditCurrency || null,
        taxRegimeCode: form.taxRegimeCode || null,
        primaryContactRole: form.primaryContactRole || null,
        notes: form.notes || null,
      };
      if (editingId) {
        await fetchApi(`/api/travel/suppliers/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Supplier "${trimmedName}" updated`);
      } else {
        await fetchApi("/api/travel/suppliers", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        notify.success(`Supplier "${trimmedName}" added`);
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

  const handleDelete = async (s) => {
    if (!confirm(`Deactivate supplier "${s.name}"? (Soft-delete: row stays for referential integrity.)`)) return;
    try {
      await fetchApi(`/api/travel/suppliers/${s.id}`, { method: "DELETE" });
      notify.success(`Supplier "${s.name}" deactivated`);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Delete failed");
    }
  };

  // Slice 4 (#903) — payables panel handlers. Each takes a supplierId so the
  // map-key state shape stays clean.
  const loadPayables = (supplierId) => {
    setPayablesLoadingBy((m) => ({ ...m, [supplierId]: true }));
    fetchApi(`/api/travel/suppliers/${supplierId}/payables`)
      .then((d) => {
        setPayablesBySupplier((m) => ({
          ...m,
          [supplierId]: Array.isArray(d?.payables) ? d.payables : [],
        }));
      })
      .catch((err) => {
        setPayablesBySupplier((m) => ({ ...m, [supplierId]: [] }));
        notify.error(err?.body?.error || err?.message || "Failed to load payables");
      })
      .finally(() => {
        setPayablesLoadingBy((m) => ({ ...m, [supplierId]: false }));
      });
  };

  const togglePayablesPanel = (supplierId) => {
    if (expandedSupplierId === supplierId) {
      setExpandedSupplierId(null);
      return;
    }
    setExpandedSupplierId(supplierId);
    // Always re-fetch on open — payables state shifts often (mark-paid,
    // cancel, third-party reconciliation), so stale-while-revalidate would
    // mislead the operator. Fresh GET on every expand is the safe default.
    if (!payableForm[supplierId]) {
      setPayableForm((m) => ({ ...m, [supplierId]: EMPTY_PAYABLE_FORM }));
    }
    loadPayables(supplierId);
  };

  const updatePayableForm = (supplierId, patch) => {
    setPayableForm((m) => ({
      ...m,
      [supplierId]: { ...(m[supplierId] || EMPTY_PAYABLE_FORM), ...patch },
    }));
  };

  const handleAddPayable = async (e, supplierId) => {
    e.preventDefault();
    const f = payableForm[supplierId] || EMPTY_PAYABLE_FORM;
    const descTrimmed = (f.description || "").trim();
    if (!descTrimmed) {
      notify.error("Description is required");
      return;
    }
    if (f.amount === "" || f.amount == null) {
      notify.error("Amount is required");
      return;
    }
    const amountNum = Number(f.amount);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      notify.error("Amount must be a non-negative number");
      return;
    }
    setPayableSaving((m) => ({ ...m, [supplierId]: true }));
    try {
      await fetchApi(`/api/travel/suppliers/${supplierId}/payables`, {
        method: "POST",
        body: JSON.stringify({
          description: descTrimmed,
          amount: amountNum,
          dueDate: f.dueDate || null,
          poNumber: f.poNumber || null,
          notes: f.notes || null,
        }),
      });
      notify.success("Payable added");
      setPayableForm((m) => ({ ...m, [supplierId]: EMPTY_PAYABLE_FORM }));
      loadPayables(supplierId);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to add payable");
    } finally {
      setPayableSaving((m) => ({ ...m, [supplierId]: false }));
    }
  };

  const handleMarkPayablePaid = async (supplierId, payable) => {
    try {
      await fetchApi(`/api/travel/suppliers/${supplierId}/payables/${payable.id}`, {
        method: "PUT",
        body: JSON.stringify({ status: "paid" }),
      });
      notify.success("Payable marked paid");
      loadPayables(supplierId);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to mark paid");
    }
  };

  const handleCancelPayable = async (supplierId, payable) => {
    try {
      await fetchApi(`/api/travel/suppliers/${supplierId}/payables/${payable.id}`, {
        method: "PUT",
        body: JSON.stringify({ status: "cancelled" }),
      });
      notify.success("Payable cancelled");
      loadPayables(supplierId);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to cancel payable");
    }
  };

  const handleDeletePayable = async (supplierId, payable) => {
    const ok = await notify.confirm(
      `Delete payable "${payable.description}"? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/suppliers/${supplierId}/payables/${payable.id}`, {
        method: "DELETE",
      });
      notify.success("Payable deleted");
      loadPayables(supplierId);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to delete payable");
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
            <Building2 size={26} aria-hidden /> Travel Suppliers
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
            Master list — Hotel / Flight / Transport / Visa Consul / Other. {total.toLocaleString()} supplier{total === 1 ? "" : "s"}.
          </p>
        </div>
        {canWrite && (
          <button type="button" onClick={openCreate} style={primaryBtn}>
            <Plus size={14} /> New Supplier
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
        <select value={supplierCategory} onChange={(e) => setSupplierCategory(e.target.value)} style={selectStyle} aria-label="Filter by category">
          {SUPPLIER_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive
        </label>
      </div>

      {/* Slice 9 (#903) — Payables Aging panel. Consumes GET /api/travel/
          payables/aging (commit c7900645). Renders 5 urgency-coloured bucket
          cards + grand total + excluded summary line. Loading + error states
          inline. */}
      <section
        data-testid="payables-aging-panel"
        aria-label="Payables aging summary"
        className="glass"
        style={{ padding: 16, marginBottom: 16 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <BarChart3 size={16} aria-hidden style={{ color: "var(--text-secondary)" }} />
          <strong style={{ fontSize: 13 }}>Payables Aging</strong>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            Open invoices bucketed by days-overdue.
          </span>
        </div>

        {agingLoading ? (
          <div data-testid="aging-loading" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Loading aging&hellip;
          </div>
        ) : agingError ? (
          <div data-testid="aging-error" style={{ fontSize: 13, color: "var(--danger-color, #f43f5e)" }}>
            Failed to load aging report.
          </div>
        ) : (
          <>
            <div
              data-testid="aging-bucket-cards"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))",
                gap: 8,
              }}
            >
              {AGING_BUCKETS.map((b) => {
                const slot = aging?.bucketTotals?.[b.key] || { count: 0, totalAmount: 0 };
                const countVal = Number.isFinite(Number(slot.count)) ? Number(slot.count) : 0;
                const amountVal = Number.isFinite(Number(slot.totalAmount)) ? Number(slot.totalAmount) : 0;
                return (
                  <div
                    key={b.key}
                    data-testid={`aging-card-${b.key}`}
                    style={{
                      background: b.bg,
                      color: b.fg,
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: "1px solid rgba(255,255,255,0.04)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.85 }}>
                      {b.label}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700 }} data-testid={`aging-card-amount-${b.key}`}>
                      ₹{amountVal.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.85 }} data-testid={`aging-card-count-${b.key}`}>
                      {countVal} payable{countVal === 1 ? "" : "s"}
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px dashed var(--border-color)",
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
                alignItems: "baseline",
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              <span data-testid="aging-grand-total">
                <strong style={{ color: "var(--text-primary)" }}>Grand total:</strong>{" "}
                ₹{(Number(aging?.grandTotal) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </span>
              <span data-testid="aging-excluded-summary">
                {Number(aging?.excludedCount) || 0} excluded (paid/cancelled/missing dueDate)
              </span>
            </div>
          </>
        )}
      </section>

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
            placeholder="Name *"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
            aria-label="Supplier name"
          />
          <input
            placeholder="Contact person"
            value={form.contactPerson}
            onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
            style={inputStyle}
            aria-label="Contact person"
          />
          <input
            placeholder="Phone"
            type="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            style={inputStyle}
            aria-label="Phone"
          />
          <input
            placeholder="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            style={inputStyle}
            aria-label="Email"
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <input
              placeholder="GSTIN (15 chars)"
              type="text"
              maxLength={15}
              value={form.gstin}
              onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
              style={inputStyle}
              aria-label="GSTIN"
              aria-describedby="gstin-hint"
            />
            {/* PRD_TRAVEL_SUPPLIER_MASTER #903 slice 2 — inline format hint. */}
            <span
              id="gstin-hint"
              style={{ fontSize: 11, color: "var(--text-secondary)", paddingLeft: 2 }}
            >
              {GSTIN_HINT}
            </span>
          </div>
          <input
            placeholder="Address"
            value={form.addressLine}
            onChange={(e) => setForm({ ...form, addressLine: e.target.value })}
            style={inputStyle}
            aria-label="Address"
          />
          <select
            value={form.supplierCategory}
            onChange={(e) => setForm({ ...form, supplierCategory: e.target.value })}
            style={inputStyle}
            aria-label="Supplier category"
          >
            {SUPPLIER_CATEGORIES.filter((c) => c.value).map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
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
          {/* Slice 2 (#903) — payment terms (days). NET-30 / NET-45 style. */}
          <input
            placeholder="Payment terms (days)"
            type="number"
            min="0"
            value={form.paymentTermsDays}
            onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })}
            style={inputStyle}
            aria-label="Payment terms days"
          />
          {/* Slice 2 (#903) — credit limit + currency. Currency symbol prefix
              rendered for INR (the default) and other recognised currencies. */}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span
              aria-hidden
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                minWidth: 16,
                textAlign: "center",
              }}
            >
              {CURRENCY_SYMBOL[form.creditCurrency] || ""}
            </span>
            <input
              placeholder="Credit limit"
              type="number"
              min="0"
              step="0.01"
              value={form.creditLimit}
              onChange={(e) => setForm({ ...form, creditLimit: e.target.value })}
              style={{ ...inputStyle, flex: 1 }}
              aria-label="Credit limit"
            />
          </div>
          <select
            value={form.creditCurrency}
            onChange={(e) => setForm({ ...form, creditCurrency: e.target.value })}
            style={inputStyle}
            aria-label="Credit currency"
          >
            {CREDIT_CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {/* Slice 2 (#903) — tax regime (regular / composite / exempt). */}
          <select
            value={form.taxRegimeCode}
            onChange={(e) => setForm({ ...form, taxRegimeCode: e.target.value })}
            style={inputStyle}
            aria-label="Tax regime"
          >
            {TAX_REGIMES.map((r) => (
              <option key={r.value || "unset"} value={r.value}>{r.label}</option>
            ))}
          </select>
          {/* Slice 2 (#903) — primary contact role (free-form with suggestions). */}
          <input
            placeholder="Primary contact role"
            type="text"
            list="primary-contact-role-suggestions"
            value={form.primaryContactRole}
            onChange={(e) => setForm({ ...form, primaryContactRole: e.target.value })}
            style={inputStyle}
            aria-label="Primary contact role"
          />
          <datalist id="primary-contact-role-suggestions">
            {CONTACT_ROLE_SUGGESTIONS.map((r) => <option key={r} value={r} />)}
          </datalist>
          {/* Slice 2 (#903) — operator notes (multi-line). Spans full row width. */}
          <textarea
            placeholder="Notes (free-form)"
            rows={4}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            style={{ ...inputStyle, gridColumn: "1 / -1", resize: "vertical" }}
            aria-label="Notes"
          />
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
                <th style={th}>Name</th>
                <th style={th}>Contact</th>
                <th style={th}>Phone</th>
                <th style={th}>Email</th>
                <th style={th}>GSTIN</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Category</th>
                <th style={th}>Status</th>
                {canWrite && <th style={{ ...th, textAlign: "center" }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => {
                // Slice 2 (#903) — "PT/CL" sub-line under each supplier name,
                // surfacing payment-terms + credit-limit when populated.
                // Renders as "NET-30 · ₹50K credit". Either token may be
                // omitted when its source field is null/undefined; the
                // whole sub-line is absent when both are null (no empty
                // div, no flicker).
                const ptToken =
                  s.paymentTermsDays != null && Number.isFinite(Number(s.paymentTermsDays))
                    ? `NET-${s.paymentTermsDays}`
                    : null;
                let clToken = null;
                if (s.creditLimit != null && s.creditLimit !== "") {
                  const clNum = Number(s.creditLimit);
                  if (Number.isFinite(clNum) && clNum > 0) {
                    const sym = CURRENCY_SYMBOL[s.creditCurrency] || "";
                    // Render in K when ≥ 1000, otherwise full value.
                    const display =
                      clNum >= 1000
                        ? `${(clNum / 1000).toFixed(clNum >= 10000 ? 0 : 1)}K`
                        : String(clNum);
                    clToken = `${sym}${display} credit`;
                  }
                }
                const subLine = [ptToken, clToken].filter(Boolean).join(" · ");
                const isExpanded = expandedSupplierId === s.id;
                return (
                <Fragment key={s.id}>
                <tr style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={td}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => togglePayablesPanel(s.id)}
                        title={isExpanded ? `Hide payables for ${s.name}` : `Show payables for ${s.name}`}
                        aria-label={`Toggle payables for ${s.name}`}
                        aria-expanded={isExpanded}
                        style={{
                          ...iconBtn,
                          padding: 2,
                          marginRight: 0,
                          color: "var(--text-secondary)",
                        }}
                      >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <strong>{s.name}</strong>
                    </div>
                    {subLine && (
                      <div
                        data-testid={`supplier-finance-sub-${s.id}`}
                        style={{
                          fontSize: 11,
                          color: "var(--text-secondary)",
                          marginTop: 2,
                        }}
                      >
                        {subLine}
                      </div>
                    )}
                  </td>
                  <td style={td}>{s.contactPerson || "—"}</td>
                  <td style={td}>{s.phone || "—"}</td>
                  <td style={td}>{s.email || "—"}</td>
                  <td style={td}>{s.gstin || "—"}</td>
                  <td style={td}>
                    <span style={{ ...brandBadge, background: SUB_BRAND_BG[s.subBrand] || "rgba(255,255,255,0.08)" }}>
                      {s.subBrand || "—"}
                    </span>
                  </td>
                  <td style={td}>
                    <span style={categoryBadge}>{s.supplierCategory || "—"}</span>
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        ...statusBadge,
                        background: s.isActive ? "rgba(34, 197, 94, 0.18)" : "rgba(244, 63, 94, 0.18)",
                        color: s.isActive ? "var(--success-color, #22c55e)" : "var(--danger-color, #f43f5e)",
                      }}
                    >
                      {s.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  {canWrite && (
                    <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => openEdit(s)}
                        title={`Edit ${s.name}`}
                        aria-label={`Edit ${s.name}`}
                        style={iconBtn}
                      >
                        <Pencil size={16} />
                      </button>
                      {s.isActive && (
                        <button
                          type="button"
                          onClick={() => handleDelete(s)}
                          title={`Deactivate ${s.name}`}
                          aria-label={`Deactivate ${s.name}`}
                          style={{ ...iconBtn, color: "var(--danger-color, #f43f5e)" }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
                {isExpanded && (
                  <tr
                    data-testid={`payables-panel-${s.id}`}
                    style={{ borderTop: "1px solid rgba(255,255,255,0.04)", background: "rgba(255,255,255,0.02)" }}
                  >
                    <td colSpan={canWrite ? 9 : 8} style={{ padding: "12px 16px" }}>
                      {renderPayablesPanel({
                        supplier: s,
                        canWrite,
                        loading: !!payablesLoadingBy[s.id],
                        payables: payablesBySupplier[s.id] || [],
                        form: payableForm[s.id] || EMPTY_PAYABLE_FORM,
                        saving: !!payableSaving[s.id],
                        onFormChange: (patch) => updatePayableForm(s.id, patch),
                        onSubmit: (e) => handleAddPayable(e, s.id),
                        onMarkPaid: (p) => handleMarkPayablePaid(s.id, p),
                        onCancel: (p) => handleCancelPayable(s.id, p),
                        onDelete: (p) => handleDeletePayable(s.id, p),
                      })}
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
              {suppliers.length === 0 && (
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
                          Your role does not have permission to view travel suppliers. Ask an Admin to grant access if you need it.
                        </div>
                      </>
                    ) : (
                      <>
                        <Building2 size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
                        <div>No suppliers match.</div>
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

// Slice 4 (#903) — payables panel render. Pure function (no hooks); accepts
// every callback explicitly so the parent owns all state. Renders four
// regions:
//   1. Header: "Payables for <supplier name>" + a tiny help blurb.
//   2. List: data-testid="payable-row-<id>" rows with status badge +
//      mark-paid/cancel/delete actions (canWrite-gated). Strike-through on
//      cancelled rows. Empty list → empty-state copy.
//   3. Add form (canWrite only): description/amount required, plus dueDate,
//      poNumber, notes optional. Submit dispatches the POST callback.
//   4. Loading indicator: replaces (2) until the initial GET resolves.
function renderPayablesPanel({
  supplier,
  canWrite,
  loading,
  payables,
  form,
  saving,
  onFormChange,
  onSubmit,
  onMarkPaid,
  onCancel,
  onDelete,
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Wallet size={16} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <strong style={{ fontSize: 13 }}>Payables for {supplier.name}</strong>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          A/P ledger — track invoices owed to this supplier.
        </span>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Loading payables&hellip;</div>
      ) : payables.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-secondary)", fontStyle: "italic" }}>
          No payables recorded yet — add the first one below.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <th style={{ ...payableTh }}>Description</th>
              <th style={{ ...payableTh }}>Amount</th>
              <th style={{ ...payableTh }}>Due</th>
              <th style={{ ...payableTh }}>Status</th>
              <th style={{ ...payableTh }}>PO #</th>
              <th style={{ ...payableTh }}>Notes</th>
              {canWrite && <th style={{ ...payableTh, textAlign: "center" }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {payables.map((p) => {
              const statusKey = p.status || "pending";
              const style = PAYABLE_STATUS_STYLE[statusKey] || PAYABLE_STATUS_STYLE.pending;
              const isCancelled = statusKey === "cancelled";
              const isPaid = statusKey === "paid";
              const dueDisplay = p.dueDate ? new Date(p.dueDate).toISOString().slice(0, 10) : "—";
              const amountDisplay = p.amount != null ? String(p.amount) : "—";
              const currency = p.currency || "INR";
              return (
                <tr
                  key={p.id}
                  data-testid={`payable-row-${p.id}`}
                  style={{
                    borderTop: "1px solid rgba(255,255,255,0.04)",
                    textDecoration: isCancelled ? "line-through" : "none",
                    opacity: isCancelled ? 0.6 : 1,
                  }}
                >
                  <td style={payableTd}>{p.description || "—"}</td>
                  <td style={payableTd}>
                    {amountDisplay} {currency}
                  </td>
                  <td style={payableTd}>{dueDisplay}</td>
                  <td style={payableTd}>
                    <span
                      data-testid={`payable-status-${p.id}`}
                      style={{
                        ...statusBadge,
                        background: style.bg,
                        color: style.fg,
                        textTransform: "capitalize",
                      }}
                    >
                      {statusKey}
                    </span>
                  </td>
                  <td style={payableTd}>{p.poNumber || "—"}</td>
                  <td style={{ ...payableTd, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.notes || "—"}
                  </td>
                  {canWrite && (
                    <td style={{ ...payableTd, textAlign: "center", whiteSpace: "nowrap" }}>
                      {!isPaid && !isCancelled && (
                        <button
                          type="button"
                          onClick={() => onMarkPaid(p)}
                          title={`Mark paid: ${p.description}`}
                          aria-label={`Mark paid payable ${p.id}`}
                          style={{ ...iconBtn, color: "var(--success-color, #22c55e)" }}
                        >
                          <CheckCircle2 size={15} />
                        </button>
                      )}
                      {!isCancelled && !isPaid && (
                        <button
                          type="button"
                          onClick={() => onCancel(p)}
                          title={`Cancel: ${p.description}`}
                          aria-label={`Cancel payable ${p.id}`}
                          style={{ ...iconBtn, color: "var(--text-secondary)" }}
                        >
                          <XCircle size={15} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onDelete(p)}
                        title={`Delete: ${p.description}`}
                        aria-label={`Delete payable ${p.id}`}
                        style={{ ...iconBtn, color: "var(--danger-color, #f43f5e)" }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {canWrite && (
        <form
          onSubmit={onSubmit}
          data-testid={`payable-add-form-${supplier.id}`}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))",
            gap: 8,
            alignItems: "end",
            paddingTop: 8,
            borderTop: "1px dashed var(--border-color)",
          }}
        >
          <input
            placeholder="Description *"
            value={form.description}
            onChange={(e) => onFormChange({ description: e.target.value })}
            style={inputStyle}
            aria-label={`Payable description for ${supplier.name}`}
          />
          <input
            placeholder="Amount *"
            type="number"
            min="0"
            step="0.01"
            value={form.amount}
            onChange={(e) => onFormChange({ amount: e.target.value })}
            style={inputStyle}
            aria-label={`Payable amount for ${supplier.name}`}
          />
          <input
            placeholder="Due date"
            type="date"
            value={form.dueDate}
            onChange={(e) => onFormChange({ dueDate: e.target.value })}
            style={inputStyle}
            aria-label={`Payable due date for ${supplier.name}`}
          />
          <input
            placeholder="PO #"
            value={form.poNumber}
            onChange={(e) => onFormChange({ poNumber: e.target.value })}
            style={inputStyle}
            aria-label={`Payable PO number for ${supplier.name}`}
          />
          <input
            placeholder="Notes"
            value={form.notes}
            onChange={(e) => onFormChange({ notes: e.target.value })}
            style={inputStyle}
            aria-label={`Payable notes for ${supplier.name}`}
          />
          <button
            type="submit"
            disabled={saving}
            style={{ ...primaryBtn, background: "var(--success-color, var(--primary-color))" }}
          >
            <Plus size={13} /> {saving ? "Saving…" : "Add payable"}
          </button>
        </form>
      )}
    </div>
  );
}

const payableTh = {
  textAlign: "left",
  padding: "6px 8px",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-secondary)",
  fontWeight: 600,
};
const payableTd = { padding: "6px 8px", fontSize: 13, color: "var(--text-primary)" };

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
const categoryBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 500,
  background: "rgba(255,255,255,0.06)",
  color: "var(--text-secondary)",
  textTransform: "capitalize",
};
const statusBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
};
