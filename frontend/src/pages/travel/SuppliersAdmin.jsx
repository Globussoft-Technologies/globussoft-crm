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

import { useEffect, useState, useContext } from "react";
import { Building2, Plus, Pencil, Trash2 } from "lucide-react";
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
                return (
                <tr key={s.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={td}>
                    <strong>{s.name}</strong>
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
