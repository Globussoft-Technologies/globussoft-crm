// Travel CRM — Quote Templates admin page.
//
// S31 slice (docs/TRAVEL_BIG_SCOPE_BACKLOG.md) — PRD_TRAVEL_QUOTE_BUILDER
// §3.5 "Templates". Operator-facing list of TravelQuoteTemplate rows —
// Umrah-7d / Golden-Triangle-5d / Schengen-visa-checklist / etc. CRUD
// wires to the /api/travel/quote-templates endpoints (commit S31):
//   GET    /api/travel/quote-templates                  list (filters: subBrand / category / isActive)
//   POST   /api/travel/quote-templates                  create (ADMIN+MANAGER)
//   PATCH  /api/travel/quote-templates/:id              edit   (ADMIN+MANAGER)
//   DELETE /api/travel/quote-templates/:id              soft-delete (returns row with isActive=false)
//
// Template: cloned from frontend/src/pages/travel/QuotesAdmin.jsx
// (commit aaf8cb2) — the canonical pattern for operator admin pages on
// the travel-vertical fork models. Empty-state honors the #829
// permission-denied vs no-rows distinction.
//
// Backend validation:
// - name (required, non-empty)
// - linesJson (required, JSON array of line shapes — see backend route
//   docs for the per-item schema)
// - currency — defaults to "INR"; must be 3-letter ISO uppercase when
//   supplied
// - subBrand — optional; sub-brand isolation enforced server-side
// - category — coarse filter dimension (Umrah / India-tour / Europe-
//   tour / Visa / etc.)
//
// The line editor is intentionally simple — a textarea on the linesJson
// field — because the rich line-builder lives on the QuoteBuilder UI
// (out of scope for S31). Operators paste the JSON in here for the
// admin-curated library.

import { useEffect, useState, useContext } from "react";
import { FileText, Plus, Pencil, Trash2 } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import {
  SUB_BRAND_BG,
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";
import { useActiveSubBrand } from "../../utils/subBrand";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "Umrah", label: "Umrah" },
  { value: "India-tour", label: "India tour" },
  { value: "Europe-tour", label: "Europe tour" },
  { value: "Asia-tour", label: "Asia tour" },
  { value: "Visa", label: "Visa" },
  { value: "School-trip", label: "School trip" },
  { value: "Other", label: "Other" },
];

const ACTIVE_FILTER = [
  { value: "", label: "All (active + inactive)" },
  { value: "true", label: "Active only" },
  { value: "false", label: "Inactive only" },
];

const EMPTY_FORM = {
  name: "",
  description: "",
  category: "",
  currency: "INR",
  subBrand: "tmc",
  linesJson: "[]",
  isActive: true,
};

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

// Count lines without throwing on malformed JSON — used in the list cell
// "Lines" column. Returns the array length, or "—" if not parseable.
function countLines(linesJson) {
  if (!linesJson) return "—";
  try {
    const arr = JSON.parse(linesJson);
    if (Array.isArray(arr)) return arr.length;
    return "—";
  } catch (_e) {
    return "—";
  }
}

export default function QuoteTemplates() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";
  const canDelete = user?.role === "ADMIN";

  // Sub-brand the create/edit form may assign. Mirrors QuotesAdmin.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const [templates, setTemplates] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [subBrand, setSubBrand] = useState("");
  const [category, setCategory] = useState("");
  const [isActiveFilter, setIsActiveFilter] = useState("true");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (category) qs.set("category", category);
    if (isActiveFilter) qs.set("isActive", isActiveFilter);
    const url = `/api/travel/quote-templates${qs.toString() ? `?${qs.toString()}` : ""}`;
    fetchApi(url)
      .then((d) => {
        const rows = Array.isArray(d?.items) ? d.items : [];
        setTemplates(rows);
        setTotal(Number.isFinite(d?.total) ? d.total : rows.length);
        setPermissionDenied(false);
      })
      .catch((err) => {
        setTemplates([]);
        setTotal(0);
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [subBrand, category, isActiveFilter]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      subBrand: defaultSubBrandFor(user, activeSubBrand) || "tmc",
    });
    setShowForm(true);
  };

  const openEdit = (t) => {
    setForm({
      name: t.name || "",
      description: t.description || "",
      category: t.category || "",
      currency: t.currency || "INR",
      subBrand: t.subBrand || "tmc",
      linesJson: t.linesJson || "[]",
      isActive: t.isActive !== false,
    });
    setEditingId(t.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      notify.error("Name is required");
      return;
    }
    // Validate JSON locally before posting — backend will also validate,
    // but a local check yields a faster + clearer error for operators.
    let parsedLines;
    try {
      parsedLines = JSON.parse(form.linesJson);
    } catch (_e) {
      notify.error("Lines JSON is not valid JSON");
      return;
    }
    if (!Array.isArray(parsedLines)) {
      notify.error("Lines JSON must encode an array");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description || null,
        category: form.category || null,
        currency: form.currency || "INR",
        subBrand: form.subBrand || null,
        linesJson: form.linesJson,
        isActive: !!form.isActive,
      };
      if (editingId) {
        await fetchApi(`/api/travel/quote-templates/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        notify.success(`Template #${editingId} updated`);
      } else {
        await fetchApi("/api/travel/quote-templates", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        notify.success(`Template "${payload.name}" created`);
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

  const handleDelete = async (t) => {
    if (!confirm(`Deactivate template "${t.name}"? (Soft delete — sets isActive=false.)`)) return;
    try {
      await fetchApi(`/api/travel/quote-templates/${t.id}`, { method: "DELETE" });
      notify.success(`Template "${t.name}" deactivated`);
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
            <FileText size={26} aria-hidden /> Quote Templates
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
            Pre-filled line sets for common itineraries — Umrah / India / Visa / etc.
            {" "}{total.toLocaleString()} template{total === 1 ? "" : "s"}.
          </p>
        </div>
        {canWrite && (
          <button type="button" onClick={openCreate} style={primaryBtn}>
            <Plus size={14} /> New Template
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
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={selectStyle} aria-label="Filter by category">
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={isActiveFilter} onChange={(e) => setIsActiveFilter(e.target.value)} style={selectStyle} aria-label="Filter by active status">
          {ACTIVE_FILTER.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
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
            alignItems: "start",
          }}
        >
          <input
            placeholder="Template name *"
            required
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
            aria-label="Template name"
          />
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            style={inputStyle}
            aria-label="Category"
          >
            {CATEGORIES.filter((c) => c.value).map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
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
          <label style={{ ...inputStyle, display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={!!form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              aria-label="Active"
            />
            <span>Active</span>
          </label>
          <textarea
            placeholder="Description (optional)"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            style={{ ...inputStyle, gridColumn: "1 / -1", minHeight: 60 }}
            aria-label="Description"
          />
          <textarea
            placeholder='Lines JSON * — e.g. [{"lineType":"hotel","description":"3 nights","quantity":3,"unitPrice":4500}]'
            required
            value={form.linesJson}
            onChange={(e) => setForm({ ...form, linesJson: e.target.value })}
            style={{ ...inputStyle, gridColumn: "1 / -1", minHeight: 140, fontFamily: "monospace" }}
            aria-label="Lines JSON"
          />
          <div style={{ display: "flex", gap: 8, gridColumn: "1 / -1" }}>
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
                <th style={th}>Category</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Currency</th>
                <th style={th}>Lines</th>
                <th style={th}>Active</th>
                <th style={th}>Updated</th>
                {canWrite && <th style={{ ...th, textAlign: "center" }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={td}><strong>{t.name}</strong></td>
                  <td style={td}>{t.category || "—"}</td>
                  <td style={td}>
                    <span style={{ ...brandBadge, background: SUB_BRAND_BG[t.subBrand] || "rgba(255,255,255,0.08)" }}>
                      {t.subBrand || "—"}
                    </span>
                  </td>
                  <td style={td}>{t.currency || "—"}</td>
                  <td style={td}>{countLines(t.linesJson)}</td>
                  <td style={td}>
                    <span
                      style={{
                        ...statusBadge,
                        background: t.isActive ? "rgba(34, 197, 94, 0.18)" : "rgba(148, 163, 184, 0.18)",
                        color: t.isActive ? "var(--success-color, #22c55e)" : "var(--text-secondary)",
                      }}
                    >
                      {t.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td style={td}>{formatDate(t.updatedAt || t.createdAt)}</td>
                  {canWrite && (
                    <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => openEdit(t)}
                        title={`Edit template ${t.name}`}
                        aria-label={`Edit template ${t.name}`}
                        style={iconBtn}
                      >
                        <Pencil size={16} />
                      </button>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => handleDelete(t)}
                          title={`Deactivate template ${t.name}`}
                          aria-label={`Deactivate template ${t.name}`}
                          style={{ ...iconBtn, color: "var(--danger-color, #f43f5e)" }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {templates.length === 0 && (
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
                    {permissionDenied ? (
                      <>
                        <strong>Access restricted.</strong>
                        <div style={{ fontSize: "0.85rem", marginTop: "0.5rem", color: "var(--text-secondary)" }}>
                          Your role does not have permission to view quote templates. Ask an Admin to grant access if you need it.
                        </div>
                      </>
                    ) : (
                      <>
                        <FileText size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
                        <div>No templates match.</div>
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
