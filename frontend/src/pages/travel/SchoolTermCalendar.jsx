// Travel CRM — TMC School Term Calendar admin (ADMIN-only).
//
// Consumes /api/travel-school-terms. Captures each school's term / holiday /
// exam-blackout windows so the booking flow can warn when a trip lands in
// term-time or exams. There is NO public API for per-school dates, so this is
// entered manually (ask the school); a baseline India set is seeded. A future
// "import from the school's website" feed would land rows with source=website.
import { useEffect, useState } from "react";
import { CalendarDays, Trash2, Plus, Search } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import TopScrollSync from "../../components/TopScrollSync";

const KINDS = [
  { value: "holiday", label: "Holiday / break (trips OK)" },
  { value: "term", label: "Term-time (avoid)" },
  { value: "exam-blackout", label: "Exam blackout (avoid)" },
];
const KIND_COLOR = {
  holiday: { bg: "rgba(16,185,129,0.12)", color: "#059669" },
  term: { bg: "rgba(245,158,11,0.14)", color: "#b45309" },
  "exam-blackout": { bg: "rgba(239,68,68,0.12)", color: "#ef4444" },
};

const BLANK = { schoolName: "", board: "", kind: "holiday", label: "", startDate: "", endDate: "" };

function fmt(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString(); } catch { return String(d); }
}

export default function SchoolTermCalendar() {
  const notify = useNotify();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [checkDate, setCheckDate] = useState("");
  const [checkSchool, setCheckSchool] = useState("");
  const [checkResult, setCheckResult] = useState(null);

  const load = () => {
    setLoading(true);
    fetchApi("/api/travel-school-terms?isActive=true")
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .catch((e) => notify.error(e?.message || "Failed to load term calendar"))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const addRow = async (e) => {
    e.preventDefault();
    if (!form.label || !form.startDate || !form.endDate) {
      notify.error("Label, start date and end date are required");
      return;
    }
    setSaving(true);
    try {
      await fetchApi("/api/travel-school-terms", { method: "POST", body: JSON.stringify(form) });
      notify.success("Term window added");
      setForm(BLANK);
      load();
    } catch (e) {
      notify.error(e?.message || "Failed to add window");
    } finally {
      setSaving(false);
    }
  };

  const removeRow = async (id) => {
    if (!(await notify.confirm("Remove this term window?"))) return;
    try {
      await fetchApi(`/api/travel-school-terms/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      notify.error(e?.message || "Failed to remove");
    }
  };

  const runCheck = async () => {
    if (!checkDate) { notify.error("Pick a date to check"); return; }
    try {
      const qs = new URLSearchParams({ date: checkDate });
      if (checkSchool.trim()) qs.set("schoolName", checkSchool.trim());
      const res = await fetchApi(`/api/travel-school-terms/check?${qs.toString()}`);
      setCheckResult(res);
    } catch (e) {
      notify.error(e?.message || "Check failed");
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto", animation: "fadeIn 0.4s ease-out" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: "1.75rem", fontWeight: 600 }}>
          <CalendarDays size={26} aria-hidden /> School Term Calendar
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
          Term / holiday / exam windows per school, so trips avoid term-time + exams. No public API exists — enter from the school (a baseline India set is seeded).
        </p>
      </header>

      {/* Date checker */}
      <div className="glass" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <Search size={16} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} style={inp} aria-label="Date to check" />
        <input type="text" placeholder="School (optional)" value={checkSchool} onChange={(e) => setCheckSchool(e.target.value)} style={inp} />
        <button type="button" onClick={runCheck} style={btn}>Check date</button>
        {checkResult && (
          <span style={{
            padding: "4px 12px", borderRadius: 999, fontWeight: 700, fontSize: 13,
            background: checkResult.ok ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)",
            color: checkResult.ok ? "#059669" : "#ef4444",
          }}>
            {checkResult.ok
              ? "✓ OK to schedule"
              : `⚠ Avoid — ${checkResult.blocking.map((b) => b.label).join(", ")}`}
          </span>
        )}
      </div>

      {/* Add form */}
      <form onSubmit={addRow} className="glass" style={{ padding: 14, marginBottom: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, alignItems: "end" }}>
        <Field label="School (blank = all schools)"><input type="text" value={form.schoolName} onChange={(e) => setForm({ ...form, schoolName: e.target.value })} style={inp} placeholder="DPS Bangalore" /></Field>
        <Field label="Board"><input type="text" value={form.board} onChange={(e) => setForm({ ...form, board: e.target.value })} style={inp} placeholder="CBSE" /></Field>
        <Field label="Type"><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={inp}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
        <Field label="Label *"><input type="text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={inp} placeholder="Summer Break 2026" /></Field>
        <Field label="Start *"><input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} style={inp} /></Field>
        <Field label="End *"><input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} style={inp} /></Field>
        <button type="submit" disabled={saving} style={{ ...btn, opacity: saving ? 0.6 : 1 }}><Plus size={14} aria-hidden /> {saving ? "Adding…" : "Add window"}</button>
      </form>

      {/* Table */}
      <div className="glass" style={{ padding: 0, overflow: "visible" }}>
        {loading ? (
          <div style={empty}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={empty}>No term windows yet — add one above, or run the school-terms seed.</div>
        ) : (
          <TopScrollSync>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>School</th><th style={th}>Board</th><th style={th}>Type</th><th style={th}>Label</th><th style={th}>From</th><th style={th}>To</th><th style={th}></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={td}>{r.schoolName || <em style={{ color: "var(--text-secondary)" }}>All schools</em>}</td>
                  <td style={td}>{r.board || "—"}</td>
                  <td style={td}><span style={{ ...badge, ...(KIND_COLOR[r.kind] || {}) }}>{r.kind}</span></td>
                  <td style={td}>{r.label}</td>
                  <td style={td}>{fmt(r.startDate)}</td>
                  <td style={td}>{fmt(r.endDate)}</td>
                  <td style={td}>
                    <button type="button" onClick={() => removeRow(r.id)} aria-label={`Remove ${r.label}`} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer" }}>
                      <Trash2 size={16} aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 }}>
      {label}
      {children}
    </label>
  );
}

const inp = { padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border-color)", background: "var(--surface-color)", color: "var(--text-primary)", fontSize: 13, width: "100%", boxSizing: "border-box" };
const btn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13, background: "var(--primary-color, var(--accent-color))", color: "#fff", border: "none", cursor: "pointer" };
const th = { textAlign: "left", padding: "10px 12px", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)", background: "var(--subtle-bg)", fontWeight: 600 };
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const badge = { display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 700, textTransform: "capitalize" };
