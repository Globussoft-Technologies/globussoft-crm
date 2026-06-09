// Travel CRM — Cost master admin (supplier rate book).
//
// Lands at /travel/cost-master. Operator + manager surface for the
// supplier rate book RFU + Travel Stall advisors look up when building
// itinerary line items. Editing inline isn't supported in Phase 1 (per
// schema-edit-discipline); add new rows + flip isActive on outdated
// ones.

import { useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BadgePercent, IndianRupee, Download, Filter, Plus, ToggleLeft, ToggleRight, Upload } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import { useActiveSubBrand } from "../../utils/subBrand";
import { accessibleSubBrands, defaultSubBrandFor, subBrandShortLabel } from "../../utils/travelSubBrand";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC" },
  { value: "rfu", label: "RFU" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];
const CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "hotel", label: "Hotel" },
  { value: "flight", label: "Flight" },
  { value: "transport", label: "Transport" },
  { value: "visa", label: "Visa" },
  { value: "insurance", label: "Insurance" },
];

export default function CostMaster() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  // ADMIN / unrestricted users get all 4 brands; users granted a subset get
  // just those; single-brand users are pinned to their one brand (read-only).
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;
  const [rates, setRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState("");
  const [category, setCategory] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    subBrand: "rfu",
    category: "hotel",
    routeOrSku: "",
    baseRate: "",
    currency: "INR",
  });

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (category) qs.set("category", category);
    qs.set("limit", "200");
    fetchApi(`/api/travel/cost-master?${qs.toString()}`)
      .then((res) => setRates(Array.isArray(res?.rates) ? res.rates : []))
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load rates");
        setRates([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [subBrand, category]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!form.routeOrSku.trim() || !form.baseRate) {
      notify.error("routeOrSku and baseRate required");
      return;
    }
    try {
      await fetchApi("/api/travel/cost-master", {
        method: "POST",
        body: JSON.stringify({ ...form, baseRate: Number(form.baseRate) }),
      });
      notify.success("Rate added");
      setForm({ ...form, routeOrSku: "", baseRate: "" });
      setAdding(false);
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to add rate");
    }
  };

  const fileRef = useRef(null);

  const exportCsv = async () => {
    try {
      const qs = new URLSearchParams();
      if (subBrand) qs.set("subBrand", subBrand);
      if (category) qs.set("category", category);
      const res = await fetch(`/api/travel/cost-master/export.csv?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "travel-cost-master.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify.error(e.message || "Failed to export");
    }
  };

  const importCsv = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = await fetch("/api/travel/cost-master/import.csv", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getAuthToken()}`,
          "Content-Type": "text/csv",
        },
        body: text,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Import failed (${res.status})`);
      const summary = `Imported ${body.imported}, updated ${body.updated}, skipped ${body.skipped}`;
      if (body.errors?.length) {
        notify.error(`${summary}. First error row ${body.errors[0].rowNumber}: ${body.errors[0].reason}`);
      } else {
        notify.success(summary);
      }
      load();
    } catch (e) {
      notify.error(e.message || "Failed to import");
    } finally {
      // Reset so the same file can be re-selected (browsers skip change events
      // when the value matches the prior one).
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const toggleActive = async (rate) => {
    try {
      await fetchApi(`/api/travel/cost-master/${rate.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !rate.isActive }),
      });
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to toggle");
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <IndianRupee size={28} aria-hidden /> Cost Master
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4 }}>
            Supplier rate book. /pricing/quote applies seasons + markup rules over these base rates.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link to="/travel/pricing-rules" style={{ ...secondaryBtn, textDecoration: "none" }}>
            <BadgePercent size={14} /> Pricing rules
          </Link>
          <button type="button" onClick={exportCsv} style={secondaryBtn}>
            <Download size={14} /> Export CSV
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={secondaryBtn}
            title="Bulk-upload supplier rates. Columns: subBrand, category, routeOrSku, baseRate, currency, supplierId, seasonId, attributesJson, validFrom, validTo, isActive."
          >
            <Upload size={14} /> Import CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={importCsv}
            style={{ display: "none" }}
            aria-label="Upload cost-master CSV"
          />
          {!adding && (
            <button
              type="button"
              onClick={() => {
                setForm((f) => ({ ...f, subBrand: defaultSubBrandFor(user, activeSubBrand, "rfu") }));
                setAdding(true);
              }}
              style={primaryBtn}
            >
              <Plus size={14} /> Add rate
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center",
        background: "var(--surface-color)", padding: 12, borderRadius: 8,
        border: "1px solid var(--border-color)", marginBottom: 16, marginTop: 12,
      }}>
        <Filter size={16} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <select value={subBrand} onChange={(e) => setSubBrand(e.target.value)} style={selectStyle} aria-label="Sub-brand">
          {SUB_BRANDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={selectStyle} aria-label="Category">
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>

      {/* Add form */}
      {adding && (
        <div style={{ background: "var(--surface-color)", padding: 16, borderRadius: 8, border: "1px solid var(--border-color)", marginBottom: 16 }}>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}>
            {lockedBrand ? (
              // Single-brand user: auto-selected, not editable. The value is
              // already pinned in form.subBrand via defaultSubBrandFor.
              <input
                type="text"
                value={subBrandShortLabel(lockedBrand)}
                readOnly
                disabled
                aria-label="Sub-brand (locked to your assigned brand)"
                style={{ ...input, opacity: 0.7, cursor: "not-allowed" }}
              />
            ) : (
              <select value={form.subBrand} onChange={(e) => setForm({ ...form, subBrand: e.target.value })} style={input}>
                {myBrands.map((b) => <option key={b} value={b}>{subBrandShortLabel(b)}</option>)}
              </select>
            )}
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={input}>
              {CATEGORIES.filter((c) => c.value).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <input
              placeholder="routeOrSku (e.g. Makkah:Hilton:Deluxe)"
              value={form.routeOrSku}
              onChange={(e) => setForm({ ...form, routeOrSku: e.target.value })}
              style={input}
            />
            <input
              placeholder="baseRate (INR)"
              type="number"
              value={form.baseRate}
              onChange={(e) => setForm({ ...form, baseRate: e.target.value })}
              style={input}
            />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button type="button" onClick={add} style={primaryBtn}>Save</button>
            <button type="button" onClick={() => setAdding(false)} style={secondaryBtn}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{
        background: "var(--surface-color)", borderRadius: 8,
        border: "1px solid var(--border-color)", overflow: "hidden",
      }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : rates.length === 0 ? (
          <div style={empty}>No rates yet. Add one above.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Sub-brand</th>
                <th style={th}>Category</th>
                <th style={th}>Route / SKU</th>
                <th style={th}>Base rate</th>
                <th style={th}>Currency</th>
                <th style={th}>Active</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid var(--border-light)", opacity: r.isActive ? 1 : 0.5 }}>
                  <td style={td}><span style={brandBadge}>{r.subBrand}</span></td>
                  <td style={td}>{r.category}</td>
                  <td style={td}><code style={{ fontSize: 12 }}>{r.routeOrSku}</code></td>
                  <td style={td}>₹{Number(r.baseRate).toLocaleString()}</td>
                  <td style={td}>{r.currency}</td>
                  <td style={td}>
                    <button type="button" onClick={() => toggleActive(r)} style={iconBtn} aria-label={`Toggle active for ${r.routeOrSku}`}>
                      {r.isActive ? <ToggleRight size={20} style={{ color: "var(--success-color)" }} /> : <ToggleLeft size={20} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const selectStyle = {
  padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  minWidth: 160, fontSize: 13,
};
const input = {
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)", color: "var(--text-primary)", fontSize: 13,
};
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const brandBadge = {
  padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg-3)", color: "var(--primary-color)",
  textTransform: "uppercase", letterSpacing: 0.5,
};
const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color)", color: "#fff",
  border: "none", cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
const iconBtn = {
  padding: 4, borderRadius: 4,
  background: "transparent", color: "var(--text-secondary)",
  border: "none", cursor: "pointer",
};
