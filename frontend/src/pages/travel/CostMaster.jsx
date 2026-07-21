import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BadgePercent, IndianRupee, Download, Filter, Plus, Upload,
  Pencil, Trash2, Check, X,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import { useActiveSubBrand } from "../../utils/subBrand";
import {
  accessibleSubBrands, defaultSubBrandFor,
  SUB_BRAND_IDS, SUB_BRAND_LABEL,
} from "../../utils/travelSubBrand";

const CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "hotel", label: "Hotel" },
  { value: "flight", label: "Flight" },
  { value: "transport", label: "Transport" },
  { value: "visa", label: "Visa" },
  { value: "insurance", label: "Insurance" },
];

const HOTEL_VIEWS = [
  { value: "", label: "View (none)" },
  { value: "haram_facing", label: "Haram facing" },
  { value: "kaaba_facing", label: "Kaaba facing" },
  { value: "city_view", label: "City view" },
  { value: "standard", label: "Standard" },
];
const HOTEL_FLOORS = [
  { value: "", label: "Floor (none)" },
  { value: "low", label: "Low floor" },
  { value: "mid", label: "Mid floor" },
  { value: "high", label: "High floor" },
];
const VIEW_LABELS = {
  haram_facing: "Haram facing", kaaba_facing: "Kaaba facing",
  city_view: "City view", standard: "Standard",
};
const FLOOR_LABELS = { low: "Low floor", mid: "Mid floor", high: "High floor" };

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SAR"];

function AttributeChips({ attributes }) {
  const chips = [];
  if (attributes?.view) chips.push(VIEW_LABELS[attributes.view] || String(attributes.view));
  if (attributes?.floorLevel) chips.push(FLOOR_LABELS[attributes.floorLevel] || String(attributes.floorLevel));
  if (attributes?.roomCategory) chips.push(String(attributes.roomCategory));
  if (chips.length === 0) {
    return <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>&mdash;</span>;
  }
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {chips.map((c) => <span key={c} style={attrChip}>{c}</span>)}
    </span>
  );
}

function PillToggle({ active, onChange, label }) {
  return (
    <button
      type="button"
      onClick={onChange}
      aria-label={label}
      aria-pressed={active}
      style={{
        position: "relative", width: 40, height: 22, borderRadius: 999,
        border: active ? "1px solid var(--success-color, #3ecf7e)" : "1px solid var(--border-color)",
        background: active ? "rgba(62,207,126,0.18)" : "var(--surface-color)",
        cursor: "pointer", padding: 0, flexShrink: 0,
        transition: "background .15s ease, border-color .15s ease",
      }}
    >
      <span style={{
        position: "absolute", top: 2, left: active ? 20 : 2,
        width: 16, height: 16, borderRadius: "50%",
        background: active ? "var(--success-color, #3ecf7e)" : "var(--text-secondary)",
        transition: "left .15s ease, background .15s ease",
      }} />
    </button>
  );
}

function EditRow({ rate, onSave, onCancel, saving }) {
  const [edit, setEdit] = useState({
    category: rate.category,
    routeOrSku: rate.routeOrSku,
    baseRate: String(rate.baseRate),
    currency: rate.currency,
    view: rate.attributes?.view || "",
    floorLevel: rate.attributes?.floorLevel || "",
    roomCategory: rate.attributes?.roomCategory || "",
  });

  return (
    <tr style={{ background: "var(--subtle-bg, rgba(255,255,255,0.03))", borderBottom: "1px solid var(--border-color)" }}>
      <td style={td}><span style={brandBadge}>{rate.subBrand}</span></td>
      <td style={td}>
        <select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}
          style={inlineInput} aria-label="Edit category">
          {CATEGORIES.filter((c) => c.value).map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </td>
      <td style={td}>
        <input value={edit.routeOrSku} onChange={(e) => setEdit({ ...edit, routeOrSku: e.target.value })}
          style={{ ...inlineInput, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", minWidth: 180 }}
          aria-label="Edit route or SKU" />
      </td>
      <td style={td}>
        <input type="number" value={edit.baseRate} onChange={(e) => setEdit({ ...edit, baseRate: e.target.value })}
          style={{ ...inlineInput, width: 100 }} aria-label="Edit base rate" />
      </td>
      <td style={td}>
        <select value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value })}
          style={{ ...inlineInput, width: 80 }} aria-label="Edit currency">
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </td>
      <td style={td}>
        {edit.category === "hotel" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <select value={edit.view} onChange={(e) => setEdit({ ...edit, view: e.target.value })}
              style={{ ...inlineInput, fontSize: 11 }} aria-label="Edit hotel view">
              {HOTEL_VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
            <select value={edit.floorLevel} onChange={(e) => setEdit({ ...edit, floorLevel: e.target.value })}
              style={{ ...inlineInput, fontSize: 11 }} aria-label="Edit floor level">
              {HOTEL_FLOORS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <input value={edit.roomCategory} onChange={(e) => setEdit({ ...edit, roomCategory: e.target.value })}
              placeholder="Room category" style={{ ...inlineInput, fontSize: 11 }} aria-label="Edit room category" />
          </div>
        ) : (
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>&mdash;</span>
        )}
      </td>
      <td style={td}>
        <PillToggle active={rate.isActive} onChange={() => {}} label="Active (toggle on list)" />
      </td>
      <td style={td}>
        <div style={{ display: "flex", gap: 4 }}>
          <button type="button" onClick={() => onSave(edit)} disabled={saving}
            aria-label={`Save changes for ${rate.routeOrSku}`}
            style={{ ...iconBtn, color: "var(--success-color, #3ecf7e)", borderColor: "var(--success-color, #3ecf7e)" }}>
            <Check size={14} />
          </button>
          <button type="button" onClick={onCancel} aria-label="Cancel edit" style={iconBtn}>
            <X size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}


export default function CostMaster() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const [rates, setRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterSubBrand, setFilterSubBrand] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);

  const defaultBrand = defaultSubBrandFor(user, activeSubBrand, myBrands[0]);
  const [form, setForm] = useState({
    subBrand: defaultBrand || myBrands[0] || "tmc",
    category: "flight",
    routeOrSku: "",
    baseRate: "",
    currency: "INR",
    view: "",
    floorLevel: "",
    roomCategory: "",
  });

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterSubBrand) qs.set("subBrand", filterSubBrand);
    if (filterCategory) qs.set("category", filterCategory);
    qs.set("limit", "200");
    fetchApi(`/api/travel/cost-master?${qs.toString()}`)
      .then((res) => setRates(Array.isArray(res?.rates) ? res.rates : []))
      .catch((e) => { notify.error(e?.body?.error || "Failed to load rates"); setRates([]); })
      .finally(() => setLoading(false));
  }, [filterSubBrand, filterCategory]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(load, [load]);

  const add = async () => {
    if (!form.routeOrSku.trim() || !form.baseRate) {
      notify.error("routeOrSku and baseRate required");
      return;
    }
    try {
      const { view, floorLevel, roomCategory, ...rest } = form;
      const body = { ...rest, baseRate: Number(form.baseRate) };
      if (form.category === "hotel") {
        const attributes = {};
        if (view) attributes.view = view;
        if (floorLevel) attributes.floorLevel = floorLevel;
        if (roomCategory.trim()) attributes.roomCategory = roomCategory.trim();
        if (Object.keys(attributes).length > 0) body.attributes = attributes;
      }
      await fetchApi("/api/travel/cost-master", { method: "POST", body: JSON.stringify(body) });
      notify.success("Rate added");
      setForm((f) => ({ ...f, routeOrSku: "", baseRate: "", view: "", floorLevel: "", roomCategory: "" }));
      setAdding(false);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to add rate");
    }
  };

  const saveEdit = async (rate, editFields) => {
    if (!editFields.routeOrSku.trim() || !editFields.baseRate) {
      notify.error("Route/SKU and base rate are required");
      return;
    }
    setSaving(true);
    try {
      const body = {
        category: editFields.category,
        routeOrSku: editFields.routeOrSku.trim(),
        baseRate: Number(editFields.baseRate),
        currency: editFields.currency,
      };
      if (editFields.category === "hotel") {
        const attributes = {};
        if (editFields.view) attributes.view = editFields.view;
        if (editFields.floorLevel) attributes.floorLevel = editFields.floorLevel;
        if (editFields.roomCategory.trim()) attributes.roomCategory = editFields.roomCategory.trim();
        body.attributes = Object.keys(attributes).length > 0 ? attributes : null;
      }
      await fetchApi(`/api/travel/cost-master/${rate.id}`, { method: "PATCH", body: JSON.stringify(body) });
      notify.success("Rate updated");
      setEditingId(null);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to update rate");
    } finally {
      setSaving(false);
    }
  };

  const deleteRate = async (rate) => {
    const ok = await notify.confirm(`Delete rate "${rate.routeOrSku}"? This cannot be undone.`);
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/cost-master/${rate.id}`, { method: "DELETE" });
      notify.success("Rate deleted");
      setRates((prev) => prev.filter((r) => r.id !== rate.id));
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete rate");
    }
  };

  const toggleActive = async (rate) => {
    setRates((prev) => prev.map((r) => (r.id === rate.id ? { ...r, isActive: !r.isActive } : r)));
    try {
      await fetchApi(`/api/travel/cost-master/${rate.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !rate.isActive }),
      });
      load();
    } catch (e) {
      setRates((prev) => prev.map((r) => (r.id === rate.id ? { ...r, isActive: rate.isActive } : r)));
      notify.error(e?.body?.error || "Failed to toggle");
    }
  };

  const fileRef = useRef(null);

  const exportCsv = async () => {
    try {
      const qs = new URLSearchParams();
      if (filterSubBrand) qs.set("subBrand", filterSubBrand);
      if (filterCategory) qs.set("category", filterCategory);
      const res = await fetch(`/api/travel/cost-master/export.csv?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "travel-cost-master.csv";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { notify.error(e.message || "Failed to export"); }
  };

  const importCsv = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      // FormData upload (not raw text body) so both CSV and binary XLSX
      // files work — the backend's multer middleware already accepts
      // either via upload.single("file") and picks the parser by
      // extension/mimetype.
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/travel/cost-master/import.csv", {
        method: "POST",
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: formData,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Import failed (${res.status})`);
      const summary = `Imported ${body.imported}, updated ${body.updated}, skipped ${body.skipped}`;
      if (body.errors?.length) notify.error(`${summary}. First error row ${body.errors[0].rowNumber}: ${body.errors[0].reason}`);
      else notify.success(summary);
      load();
    } catch (e) { notify.error(e.message || "Failed to import"); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  };

  // All sub-brands for the filter dropdown (not scoped to user access — filter
  // should show what's IN the table, not what the user can create).
  const ALL_SUBBRAND_OPTIONS = [
    { value: "", label: "All sub-brands" },
    ...SUB_BRAND_IDS.map((id) => ({ value: id, label: SUB_BRAND_LABEL[id] || id })),
  ];

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 6 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 22, fontWeight: 600, color: "var(--success-color, #3ecf7e)" }}>
          <IndianRupee size={22} aria-hidden /> Cost Master
        </h1>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link to="/travel/pricing-rules" style={{ ...secondaryBtn, textDecoration: "none" }}>
            <BadgePercent size={14} /> Pricing rules
          </Link>
          <button type="button" onClick={exportCsv} style={secondaryBtn}>
            <Download size={14} /> Export CSV
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} style={secondaryBtn}
            title="Bulk-upload supplier rates (CSV or Excel). Columns: subBrand, category, routeOrSku, baseRate, currency, supplierId, seasonId, attributesJson, validFrom, validTo, isActive.">
            <Upload size={14} /> Import CSV/Excel
          </button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv" onChange={importCsv}
            style={{ display: "none" }} aria-label="Upload cost-master CSV or Excel file" />
          {!adding && (
            <button type="button" onClick={() => { setAdding(true); setEditingId(null); }} style={primaryBtn}>
              <Plus size={14} /> Add rate
            </button>
          )}
        </div>
      </div>
      <p style={{ color: "var(--text-secondary)", fontSize: 13.5, margin: "2px 0 22px" }}>
        Supplier rate book. /pricing/quote applies seasons + markup rules over these base rates.
      </p>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", background: "var(--surface-color)", padding: 16, borderRadius: 12, border: "1px solid var(--border-color)", marginBottom: 20 }}>
        <Filter size={15} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <select value={filterSubBrand} onChange={(e) => setFilterSubBrand(e.target.value)} style={selectStyle} aria-label="Sub-brand">
          {ALL_SUBBRAND_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} style={selectStyle} aria-label="Category">
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>

      {/* Add form */}
      {adding && (
        <div style={{ background: "var(--surface-color)", padding: 16, borderRadius: 12, border: "1px solid var(--border-color)", marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: "var(--text-primary)" }}>New rate</div>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}>
            {/* Sub-brand — show all accessible brands with full readable labels */}
            {lockedBrand ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={fieldLabel}>Sub-brand</label>
                <input type="text" value={SUB_BRAND_LABEL[lockedBrand] || lockedBrand} readOnly disabled
                  aria-label="Sub-brand (locked to your assigned brand)"
                  style={{ ...input, opacity: 0.7, cursor: "not-allowed" }} />
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={fieldLabel}>Sub-brand</label>
                <select value={form.subBrand} onChange={(e) => setForm({ ...form, subBrand: e.target.value })} style={input}>
                  {myBrands.map((b) => (
                    <option key={b} value={b}>{SUB_BRAND_LABEL[b] || b}</option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={fieldLabel}>Category</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={input}>
                {CATEGORIES.filter((c) => c.value).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={fieldLabel}>Route / SKU</label>
              <input placeholder="e.g. BLR-DPS-Economy or Makkah:Hilton:Deluxe"
                value={form.routeOrSku} onChange={(e) => setForm({ ...form, routeOrSku: e.target.value })} style={input} />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={fieldLabel}>Base rate</label>
              <input placeholder="e.g. 22000" type="number"
                value={form.baseRate} onChange={(e) => setForm({ ...form, baseRate: e.target.value })} style={input} />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={fieldLabel}>Currency</label>
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} style={input}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {form.category === "hotel" && (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={fieldLabel}>View</label>
                  <select value={form.view} onChange={(e) => setForm({ ...form, view: e.target.value })} style={input} aria-label="Hotel view preference">
                    {HOTEL_VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={fieldLabel}>Floor</label>
                  <select value={form.floorLevel} onChange={(e) => setForm({ ...form, floorLevel: e.target.value })} style={input} aria-label="Hotel floor level">
                    {HOTEL_FLOORS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={fieldLabel}>Room category</label>
                  <input placeholder="e.g. Deluxe" value={form.roomCategory}
                    onChange={(e) => setForm({ ...form, roomCategory: e.target.value })} style={input} aria-label="Room category" />
                </div>
              </>
            )}
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button type="button" onClick={add} style={primaryBtn}>Save</button>
            <button type="button" onClick={() => setAdding(false)} style={secondaryBtn}>Cancel</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ background: "var(--surface-color)", borderRadius: 12, border: "1px solid var(--border-color)", overflow: "hidden" }}>
        {loading ? (
          <div style={emptyStyle}>Loading&hellip;</div>
        ) : rates.length === 0 ? (
          <div style={emptyStyle}>No rates yet. Add one using the &ldquo;+ Add rate&rdquo; button above.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Sub-brand</th>
                <th style={th}>Category</th>
                <th style={th}>Route / SKU</th>
                <th style={th}>Base rate</th>
                <th style={th}>Currency</th>
                <th style={th}>Attributes</th>
                <th style={th}>Active</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) =>
                editingId === r.id ? (
                  <EditRow key={r.id} rate={r} saving={saving}
                    onSave={(fields) => saveEdit(r, fields)}
                    onCancel={() => setEditingId(null)} />
                ) : (
                  <tr key={r.id}
                    style={{ borderBottom: "1px solid var(--border-color)", opacity: r.isActive ? 1 : 0.55, transition: "background .12s" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--hover-bg, rgba(255,255,255,0.03))"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}>
                    <td style={td}><span style={brandBadge}>{r.subBrand}</span></td>
                    <td style={td}>{r.category}</td>
                    <td style={td}>
                      <code style={{ fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontSize: 13 }}>{r.routeOrSku}</code>
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>₹{Number(r.baseRate).toLocaleString()}</td>
                    <td style={td}>{r.currency}</td>
                    <td style={td}><AttributeChips attributes={r.attributes} /></td>
                    <td style={td}>
                      <PillToggle active={r.isActive} onChange={() => toggleActive(r)}
                        label={`Toggle active for ${r.routeOrSku}`} />
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button type="button" title="Edit rate" aria-label={`Edit rate ${r.routeOrSku}`}
                          onClick={() => { setEditingId(r.id); setAdding(false); }}
                          style={iconBtn}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--subtle-bg)"; e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.color = "var(--text-primary)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--text-secondary)"; }}>
                          <Pencil size={14} />
                        </button>
                        <button type="button" title="Delete rate" aria-label={`Delete rate ${r.routeOrSku}`}
                          onClick={() => deleteRate(r)}
                          style={iconBtn}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--subtle-bg)"; e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.color = "var(--danger-color, #f06a6a)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--text-secondary)"; }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}

const fieldLabel = { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-secondary)" };
const selectStyle = { padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border-color)", background: "var(--surface-color)", color: "var(--text-primary)", minWidth: 160, fontSize: 13 };
const input = { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border-color)", background: "var(--bg-color)", color: "var(--text-primary)", fontSize: 13 };
const inlineInput = { padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-color)", background: "var(--bg-color)", color: "var(--text-primary)", fontSize: 13, width: "100%" };
const emptyStyle = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const th = { textAlign: "left", padding: "14px 16px", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)", fontWeight: 600 };
const td = { padding: "14px 16px", fontSize: 13.5, color: "var(--text-primary)", verticalAlign: "middle" };
const brandBadge = { display: "inline-block", padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--subtle-bg-3, rgba(91,110,248,0.15))", color: "var(--primary-color, #5b6ef8)", textTransform: "uppercase", letterSpacing: 0.5 };
const attrChip = { padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: "var(--subtle-bg)", color: "var(--text-secondary)", border: "1px solid var(--border-color)", whiteSpace: "nowrap" };
const primaryBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, fontWeight: 500, fontSize: 13, background: "var(--primary-color, #5b6ef8)", color: "#fff", border: "1px solid var(--primary-color, #5b6ef8)", cursor: "pointer", whiteSpace: "nowrap" };
const secondaryBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, fontWeight: 500, fontSize: 13, background: "var(--surface-color)", color: "var(--text-primary)", border: "1px solid var(--border-color)", cursor: "pointer", whiteSpace: "nowrap" };
const ghostBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 12, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-color)", cursor: "pointer" };
const iconBtn = { width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 7, border: "1px solid transparent", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, transition: "background .12s, color .12s" };
