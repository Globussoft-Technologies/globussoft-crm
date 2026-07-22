// Travel CRM — Pricing Rules admin (Seasons + Markup Rules).
//
// Lands at /travel/pricing-rules. Replaces the API-only flow for managing
// the two tables that feed /api/travel/pricing/quote:
//   - TravelSeasonCalendar  → multiplies the baseRate when tripDate falls
//                              inside startDate..endDate for the sub-brand.
//   - TravelMarkupRule      → adds markupPct OR markupFlat on top of the
//                              season-multiplied baseRate (ordered by priority).
//
// Backend (already shipped in v3.9.x):
//   GET    /api/travel/seasons              list (filter ?subBrand)
//   POST   /api/travel/seasons              ADMIN | MANAGER
//   PATCH  /api/travel/seasons/:id          ADMIN | MANAGER
//   DELETE /api/travel/seasons/:id          ADMIN only
//   GET    /api/travel/markup-rules         list (filter ?subBrand, ?scope, ?active)
//   POST   /api/travel/markup-rules         ADMIN | MANAGER
//   PATCH  /api/travel/markup-rules/:id     ADMIN | MANAGER
//   DELETE /api/travel/markup-rules/:id     ADMIN only
//
// Backend invariants we mirror client-side (route still re-validates):
//   - subBrand ∈ {tmc, rfu, travelstall, visasure}
//   - scope ∈ {flight, hotel, transport, package}
//   - exactly ONE of markupPct / markupFlat must be set on a markup rule
//   - endDate >= startDate on a season
//
// Closes Phase 1.5 / 8e from the 2026-05-20 PM handoff. Backend routes were
// already shipped; this is the missing admin UI on top.

import { useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarRange, ChevronLeft, Download, Edit2, Filter,
  Percent, Plus, Save, ToggleLeft, ToggleRight, Trash2, Upload, X,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";
import TopScrollSync from "../../components/TopScrollSync";
import { useActiveSubBrand } from "../../utils/subBrand";
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";

// Shared helpers for the CSV Export / Import buttons on both sections.
// Same pattern as CostMaster.jsx + DiagnosticBuilder.jsx in v3.9.1.
async function downloadCsv(notify, url, filename) {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch (e) {
    notify.error(e.message || "Failed to export");
  }
}
async function uploadCsv(notify, url, file, onDone) {
  // FormData upload (not raw text body) so both CSV and binary XLSX files
  // work — the backend's multer middleware already accepts either via
  // upload.single("file") and picks the parser by extension/mimetype.
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: formData,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `Import failed (${res.status})`);
  const summary = `Imported ${body.imported}, updated ${body.updated}, skipped ${body.skipped}`;
  if (body.errors?.length) {
    notify.error(`${summary}. Row ${body.errors[0].rowNumber}: ${body.errors[0].reason}`);
  } else {
    notify.success(summary);
  }
  onDone?.();
}

const SUB_BRANDS = [
  { value: "tmc", label: "TMC" },
  { value: "rfu", label: "RFU" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];
const SCOPES = [
  { value: "flight", label: "Flight" },
  { value: "hotel", label: "Hotel" },
  { value: "transport", label: "Transport" },
  { value: "package", label: "Package" },
];

// Render a date column as YYYY-MM-DD without the time noise.
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

export default function PricingRules() {
  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <Percent size={28} aria-hidden /> Pricing Rules
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, marginBottom: 0 }}>
            Seasons multiply baseRate; markup rules add a % or flat amount on top. Both feed
            <code style={{ marginLeft: 4 }}>POST /api/travel/pricing/quote</code>.
          </p>
        </div>
        <Link to="/travel/cost-master" style={backLink}>
          <ChevronLeft size={16} aria-hidden /> Cost Master
        </Link>
      </header>

      <SeasonsSection />
      <div style={{ height: 24 }} />
      <MarkupRulesSection />
    </div>
  );
}

// ─── Seasons ────────────────────────────────────────────────────────

function SeasonsSection() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  // Sub-brands this user may create rows for. Single-brand users get a locked
  // read-only field; ADMIN / multi-brand users get a dropdown of THEIR brands.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;
  const [seasons, setSeasons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterSubBrand, setFilterSubBrand] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const blankForm = { subBrand: defaultSubBrandFor(user, activeSubBrand, "rfu"), seasonName: "", startDate: "", endDate: "", multiplier: "" };
  const [form, setForm] = useState(blankForm);
  const fileRef = useRef(null);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterSubBrand) qs.set("subBrand", filterSubBrand);
    fetchApi(`/api/travel/seasons?${qs.toString()}`)
      .then((res) => setSeasons(Array.isArray(res?.seasons) ? res.seasons : []))
      .catch((e) => { notify.error(e?.body?.error || "Failed to load seasons"); setSeasons([]); })
      .finally(() => setLoading(false));
  };
  useEffect(load, [filterSubBrand]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (s) => {
    setEditingId(s.id);
    setAdding(false);
    setForm({
      subBrand: s.subBrand,
      seasonName: s.seasonName,
      startDate: fmtDate(s.startDate),
      endDate: fmtDate(s.endDate),
      multiplier: s.multiplier != null ? String(s.multiplier) : "",
    });
  };
  const cancelEdit = () => { setEditingId(null); setAdding(false); setForm(blankForm); };

  const save = async () => {
    if (!form.seasonName.trim() || !form.startDate || !form.endDate) {
      notify.error("seasonName, startDate, endDate required");
      return;
    }
    const body = {
      seasonName: form.seasonName.trim(),
      startDate: form.startDate,
      endDate: form.endDate,
      multiplier: form.multiplier === "" ? null : Number(form.multiplier),
    };
    try {
      if (editingId) {
        await fetchApi(`/api/travel/seasons/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        notify.success("Season updated");
      } else {
        await fetchApi("/api/travel/seasons", {
          method: "POST",
          body: JSON.stringify({ ...body, subBrand: form.subBrand }),
        });
        notify.success("Season created");
      }
      cancelEdit();
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save season");
    }
  };

  const remove = async (s) => {
    if (!window.confirm(`Delete season "${s.seasonName}" (${s.subBrand})?`)) return;
    try {
      await fetchApi(`/api/travel/seasons/${s.id}`, { method: "DELETE" });
      notify.success("Season deleted");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete season");
    }
  };

  const showForm = adding || editingId != null;

  const exportCsv = () => {
    const qs = new URLSearchParams();
    if (filterSubBrand) qs.set("subBrand", filterSubBrand);
    return downloadCsv(notify, `/api/travel/seasons/export.csv?${qs.toString()}`, "travel-seasons.csv");
  };
  const importCsv = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await uploadCsv(notify, "/api/travel/seasons/import.csv", file, load);
    } catch (err) {
      notify.error(err.message || "Failed to import");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section style={card}>
      <div style={sectionHeader}>
        <h2 style={sectionTitle}>
          <CalendarRange size={20} aria-hidden style={{ marginRight: 6, verticalAlign: -4 }} />
          Seasons
          <span style={countBadge}>{seasons.length}</span>
        </h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={exportCsv} style={secondaryBtn}>
            <Download size={14} /> Export CSV
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={secondaryBtn}
            title="Bulk-upload seasons (CSV or Excel). Columns: subBrand, seasonName, startDate, endDate, multiplier."
          >
            <Upload size={14} /> Import CSV/Excel
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            onChange={importCsv}
            style={{ display: "none" }}
            aria-label="Upload seasons CSV or Excel file"
          />
          {!showForm && (
            <button type="button" onClick={() => { setAdding(true); setEditingId(null); setForm(blankForm); }} style={primaryBtn}>
              <Plus size={14} /> Add season
            </button>
          )}
        </div>
      </div>

      <div style={filterRow}>
        <Filter size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <select value={filterSubBrand} onChange={(e) => setFilterSubBrand(e.target.value)} style={selectStyle} aria-label="Filter seasons by sub-brand">
          <option value="">All sub-brands</option>
          {SUB_BRANDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      {showForm && (
        <div style={formBox}>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}>
            {lockedBrand ? (
              // Single-brand user: field is pinned to their assigned brand and
              // shown read-only. The value is already set in form.subBrand via
              // defaultSubBrandFor / startEdit.
              <input
                type="text"
                value={subBrandShortLabel(form.subBrand)}
                readOnly
                disabled
                aria-label="Sub-brand (locked to your assigned brand)"
                style={{ ...input, opacity: 0.7, cursor: "not-allowed" }}
              />
            ) : (
              <select
                value={form.subBrand}
                onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                style={input}
                disabled={editingId != null}
                aria-label="Sub-brand"
              >
                {myBrands.map((b) => <option key={b} value={b}>{subBrandShortLabel(b)}</option>)}
              </select>
            )}
            <input
              placeholder="seasonName (e.g. ramadan-peak)"
              value={form.seasonName}
              onChange={(e) => setForm({ ...form, seasonName: e.target.value })}
              style={input}
              aria-label="Season name"
            />
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              style={input}
              aria-label="Start date"
            />
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              style={input}
              aria-label="End date"
            />
            <input
              type="number"
              step="0.0001"
              min="0"
              placeholder="multiplier (e.g. 1.4)"
              value={form.multiplier}
              onChange={(e) => setForm({ ...form, multiplier: e.target.value })}
              style={input}
              aria-label="Multiplier"
            />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button type="button" onClick={save} style={primaryBtn}>
              <Save size={14} /> {editingId ? "Save changes" : "Create"}
            </button>
            <button type="button" onClick={cancelEdit} style={secondaryBtn}>
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      <div style={tableWrap}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : seasons.length === 0 ? (
          <div style={empty}>No seasons yet. Add one above.</div>
        ) : (
          <TopScrollSync>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Sub-brand</th>
                <th style={th}>Name</th>
                <th style={th}>Start</th>
                <th style={th}>End</th>
                <th style={th}>Multiplier</th>
                <th style={{ ...th, width: 100 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {seasons.map((s) => (
                <tr key={s.id} style={trStyle}>
                  <td style={td}><span style={brandBadge}>{s.subBrand}</span></td>
                  <td style={td}>{s.seasonName}</td>
                  <td style={td}>{fmtDate(s.startDate)}</td>
                  <td style={td}>{fmtDate(s.endDate)}</td>
                  <td style={td}>{s.multiplier != null ? `×${Number(s.multiplier).toFixed(2)}` : <span style={{ color: "var(--text-secondary)" }}>—</span>}</td>
                  <td style={td}>
                    <button type="button" onClick={() => startEdit(s)} style={iconBtn} aria-label={`Edit ${s.seasonName}`}>
                      <Edit2 size={16} />
                    </button>
                    <button type="button" onClick={() => remove(s)} style={iconBtn} aria-label={`Delete ${s.seasonName}`}>
                      <Trash2 size={16} style={{ color: "var(--danger-color)" }} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </div>
    </section>
  );
}

// ─── Markup rules ───────────────────────────────────────────────────

function MarkupRulesSection() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  // See SeasonsSection: single-brand users get a locked read-only sub-brand;
  // ADMIN / multi-brand users get a dropdown of THEIR brands.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterSubBrand, setFilterSubBrand] = useState("");
  const [filterScope, setFilterScope] = useState("");
  const [filterActive, setFilterActive] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const blankForm = {
    subBrand: defaultSubBrandFor(user, activeSubBrand, "rfu"), scope: "hotel", matchKeyJson: "{}",
    markupType: "pct", markupValue: "", priority: "100",
  };
  const [form, setForm] = useState(blankForm);
  const fileRef = useRef(null);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterSubBrand) qs.set("subBrand", filterSubBrand);
    if (filterScope) qs.set("scope", filterScope);
    if (filterActive) qs.set("active", filterActive);
    fetchApi(`/api/travel/markup-rules?${qs.toString()}`)
      .then((res) => setRules(Array.isArray(res?.rules) ? res.rules : []))
      .catch((e) => { notify.error(e?.body?.error || "Failed to load markup rules"); setRules([]); })
      .finally(() => setLoading(false));
  };
  useEffect(load, [filterSubBrand, filterScope, filterActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (r) => {
    setEditingId(r.id);
    setAdding(false);
    setForm({
      subBrand: r.subBrand,
      scope: r.scope,
      matchKeyJson: r.matchKeyJson || "{}",
      markupType: r.markupPct != null ? "pct" : "flat",
      markupValue: r.markupPct != null ? String(r.markupPct) : (r.markupFlat != null ? String(r.markupFlat) : ""),
      priority: String(r.priority ?? 100),
    });
  };
  const cancelEdit = () => { setEditingId(null); setAdding(false); setForm(blankForm); };

  const save = async () => {
    if (!form.matchKeyJson.trim() || !form.markupValue) {
      notify.error("matchKeyJson and markup value required");
      return;
    }
    try { JSON.parse(form.matchKeyJson); }
    catch { notify.error("matchKeyJson is not valid JSON"); return; }

    const n = Number(form.markupValue);
    if (!Number.isFinite(n) || n < 0) {
      notify.error("markup value must be a non-negative number");
      return;
    }

    const body = {
      scope: form.scope,
      matchKeyJson: form.matchKeyJson,
      priority: parseInt(form.priority || "100", 10),
      // backend enforces "exactly one of markupPct / markupFlat" — send the
      // chosen field set + the other explicitly nulled so editing one to the
      // other clears the prior value.
      markupPct: form.markupType === "pct" ? n : null,
      markupFlat: form.markupType === "flat" ? n : null,
    };
    try {
      if (editingId) {
        await fetchApi(`/api/travel/markup-rules/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        notify.success("Markup rule updated");
      } else {
        await fetchApi("/api/travel/markup-rules", {
          method: "POST",
          body: JSON.stringify({ ...body, subBrand: form.subBrand }),
        });
        notify.success("Markup rule created");
      }
      cancelEdit();
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save markup rule");
    }
  };

  const toggleActive = async (r) => {
    try {
      await fetchApi(`/api/travel/markup-rules/${r.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !r.isActive }),
      });
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to toggle");
    }
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete markup rule (${r.scope} / ${r.subBrand}, priority ${r.priority})?`)) return;
    try {
      await fetchApi(`/api/travel/markup-rules/${r.id}`, { method: "DELETE" });
      notify.success("Markup rule deleted");
      load();
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete");
    }
  };

  const formatMarkup = (r) => {
    if (r.markupPct != null) return `${(Number(r.markupPct) * 100).toFixed(2)}%`;
    if (r.markupFlat != null) return `+₹${Number(r.markupFlat).toLocaleString()}`;
    return "—";
  };

  const showForm = adding || editingId != null;

  const exportCsv = () => {
    const qs = new URLSearchParams();
    if (filterSubBrand) qs.set("subBrand", filterSubBrand);
    if (filterScope) qs.set("scope", filterScope);
    return downloadCsv(notify, `/api/travel/markup-rules/export.csv?${qs.toString()}`, "travel-markup-rules.csv");
  };
  const importCsv = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await uploadCsv(notify, "/api/travel/markup-rules/import.csv", file, load);
    } catch (err) {
      notify.error(err.message || "Failed to import");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section style={card}>
      <div style={sectionHeader}>
        <h2 style={sectionTitle}>
          <Percent size={20} aria-hidden style={{ marginRight: 6, verticalAlign: -4 }} />
          Markup Rules
          <span style={countBadge}>{rules.length}</span>
        </h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={exportCsv} style={secondaryBtn}>
            <Download size={14} /> Export CSV
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={secondaryBtn}
            title="Bulk-upload markup rules (CSV or Excel). Columns: subBrand, scope, matchKeyJson, markupPct OR markupFlat, priority, isActive."
          >
            <Upload size={14} /> Import CSV/Excel
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            onChange={importCsv}
            style={{ display: "none" }}
            aria-label="Upload markup rules CSV or Excel file"
          />
          {!showForm && (
            <button type="button" onClick={() => { setAdding(true); setEditingId(null); setForm(blankForm); }} style={primaryBtn}>
              <Plus size={14} /> Add rule
            </button>
          )}
        </div>
      </div>

      <div style={filterRow}>
        <Filter size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <select value={filterSubBrand} onChange={(e) => setFilterSubBrand(e.target.value)} style={selectStyle} aria-label="Filter rules by sub-brand">
          <option value="">All sub-brands</option>
          {SUB_BRANDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={filterScope} onChange={(e) => setFilterScope(e.target.value)} style={selectStyle} aria-label="Filter rules by scope">
          <option value="">All scopes</option>
          {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={filterActive} onChange={(e) => setFilterActive(e.target.value)} style={selectStyle} aria-label="Filter rules by active state">
          <option value="">Active + inactive</option>
          <option value="true">Active only</option>
          <option value="false">Inactive only</option>
        </select>
      </div>

      {showForm && (
        <div style={formBox}>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}>
            {lockedBrand ? (
              <input
                type="text"
                value={subBrandShortLabel(form.subBrand)}
                readOnly
                disabled
                aria-label="Sub-brand (locked to your assigned brand)"
                style={{ ...input, opacity: 0.7, cursor: "not-allowed" }}
              />
            ) : (
              <select
                value={form.subBrand}
                onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                style={input}
                disabled={editingId != null}
                aria-label="Sub-brand"
              >
                {myBrands.map((b) => <option key={b} value={b}>{subBrandShortLabel(b)}</option>)}
              </select>
            )}
            <select
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
              style={input}
              aria-label="Scope"
            >
              {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select
              value={form.markupType}
              onChange={(e) => setForm({ ...form, markupType: e.target.value })}
              style={input}
              aria-label="Markup type"
            >
              <option value="pct">% markup</option>
              <option value="flat">Flat ₹</option>
            </select>
            <input
              type="number"
              step={form.markupType === "pct" ? "0.0001" : "0.01"}
              min="0"
              placeholder={form.markupType === "pct" ? "e.g. 0.15 for 15%" : "e.g. 500"}
              value={form.markupValue}
              onChange={(e) => setForm({ ...form, markupValue: e.target.value })}
              style={input}
              aria-label="Markup value"
            />
            <input
              type="number"
              min="0"
              placeholder="priority (lower = first)"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              style={input}
              aria-label="Priority"
            />
          </div>
          <textarea
            placeholder='matchKeyJson — e.g. {"city":"Makkah"} or {"route":"DEL-JED"}'
            value={form.matchKeyJson}
            onChange={(e) => setForm({ ...form, matchKeyJson: e.target.value })}
            style={{ ...input, marginTop: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, minHeight: 60 }}
            aria-label="Match key JSON"
            spellCheck={false}
          />
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button type="button" onClick={save} style={primaryBtn}>
              <Save size={14} /> {editingId ? "Save changes" : "Create"}
            </button>
            <button type="button" onClick={cancelEdit} style={secondaryBtn}>
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      <div style={tableWrap}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : rules.length === 0 ? (
          <div style={empty}>No markup rules yet. Add one above.</div>
        ) : (
          <TopScrollSync>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Sub-brand</th>
                <th style={th}>Scope</th>
                <th style={th}>Match key</th>
                <th style={th}>Markup</th>
                <th style={th}>Priority</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 100 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={{ ...trStyle, opacity: r.isActive ? 1 : 0.5 }}>
                  <td style={td}><span style={brandBadge}>{r.subBrand}</span></td>
                  <td style={td}>{r.scope}</td>
                  <td style={td}><code style={{ fontSize: 11 }}>{r.matchKeyJson}</code></td>
                  <td style={td}>{formatMarkup(r)}</td>
                  <td style={td}>{r.priority}</td>
                  <td style={td}>
                    <button type="button" onClick={() => toggleActive(r)} style={iconBtn} aria-label={`Toggle active for rule ${r.id}`}>
                      {r.isActive
                        ? <ToggleRight size={20} style={{ color: "var(--success-color)" }} />
                        : <ToggleLeft size={20} />}
                    </button>
                  </td>
                  <td style={td}>
                    <button type="button" onClick={() => startEdit(r)} style={iconBtn} aria-label={`Edit rule ${r.id}`}>
                      <Edit2 size={16} />
                    </button>
                    <button type="button" onClick={() => remove(r)} style={iconBtn} aria-label={`Delete rule ${r.id}`}>
                      <Trash2 size={16} style={{ color: "var(--danger-color)" }} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </div>
    </section>
  );
}

// ─── Shared styles (parallel to CostMaster.jsx) ──────────────────────

const card = {
  background: "var(--surface-color)",
  borderRadius: 12,
  border: "1px solid var(--border-color)",
  padding: 16,
};
const sectionHeader = {
  display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12,
};
const sectionTitle = { margin: 0, fontSize: 18, display: "flex", alignItems: "center" };
const countBadge = {
  marginLeft: 8, padding: "2px 8px", borderRadius: 10,
  fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg)", color: "var(--text-secondary)",
};
const filterRow = {
  display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
  padding: 12, marginBottom: 12,
  background: "var(--subtle-bg)", borderRadius: 8,
  border: "1px solid var(--border-color)",
};
const formBox = {
  background: "var(--bg-color)", padding: 12, borderRadius: 8,
  border: "1px solid var(--border-color)", marginBottom: 12,
};
const tableWrap = {
  background: "var(--surface-color)", borderRadius: 8,
  border: "1px solid var(--border-color)", overflow: "visible",
};
const selectStyle = {
  padding: "6px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  minWidth: 140, fontSize: 13,
};
const input = {
  padding: "8px 10px", borderRadius: 6, width: "100%", boxSizing: "border-box",
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
const trStyle = { borderTop: "1px solid var(--border-light)" };
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
  padding: 4, borderRadius: 4, marginRight: 4,
  background: "transparent", color: "var(--text-secondary)",
  border: "none", cursor: "pointer",
};
const backLink = {
  display: "inline-flex", alignItems: "center", gap: 4,
  fontSize: 13, color: "var(--text-secondary)",
  textDecoration: "none", padding: "6px 12px", borderRadius: 6,
  border: "1px solid var(--border-color)",
};
