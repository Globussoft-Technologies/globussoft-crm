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

// Sub-brand pill background — neutral fallback works under both light
// and travel-dark themes; the active sub-brand surfaces upstream
// (TmcMicrositePreview etc.) carry the brand colors.
const SUB_BRAND_BG = {
  tmc: "rgba(18, 38, 71, 0.18)",        // travel-navy tint
  rfu: "rgba(38, 88, 85, 0.18)",        // teal-ish (RFU pilgrim)
  travelstall: "rgba(200, 154, 78, 0.18)", // warm gold
  visasure: "rgba(99, 102, 241, 0.18)",  // indigo
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
    setSaving(true);
    try {
      const payload = {
        ...form,
        name: trimmedName,
        // Empty strings -> null so backend doesn't store ""
        contactPerson: form.contactPerson || null,
        phone: form.phone || null,
        email: form.email || null,
        gstin: form.gstin ? form.gstin.toUpperCase() : null,
        addressLine: form.addressLine || null,
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
          <input
            placeholder="GSTIN (15 chars)"
            type="text"
            maxLength={15}
            value={form.gstin}
            onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
            style={inputStyle}
            aria-label="GSTIN"
          />
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
              {suppliers.map((s) => (
                <tr key={s.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={td}><strong>{s.name}</strong></td>
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
              ))}
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
