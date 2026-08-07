// Travel CRM - TMC School Term Calendar admin.
//
// Captures each school's term / holiday / exam-blackout windows so the
// booking flow can warn when a trip lands in term-time or exams. Operators
// can now manage the data through 3 paths on the same page:
//   1. Manual row entry
//   2. CSV / Excel import
//   3. PDF / image upload of the school's published calendar
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, Trash2, Plus, Search, Upload, FileSpreadsheet, FileText, Download, ExternalLink } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
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
const PAGE_SIZE = 20;
const BLANK = { schoolName: "", board: "", kind: "holiday", label: "", startDate: "", endDate: "" };
const BLANK_UPLOAD_META = { schoolName: "", board: "", label: "" };

function fmt(d) {
  if (!d) return "-";
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return String(d);
  }
}

export default function SchoolTermCalendar() {
  const notify = useNotify();
  const [rows, setRows] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingUploads, setLoadingUploads] = useState(true);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [checkDate, setCheckDate] = useState("");
  const [checkSchool, setCheckSchool] = useState("");
  const [checkResult, setCheckResult] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [uploadMeta, setUploadMeta] = useState(BLANK_UPLOAD_META);
  const [calendarFile, setCalendarFile] = useState(null);
  const [uploadingCalendar, setUploadingCalendar] = useState(false);
  const listRef = useRef(null);
  const rowsRef = useRef([]);
  const loadingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const importInputRef = useRef(null);
  const uploadInputRef = useRef(null);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);

  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const loadRows = useCallback(async ({ reset = false } = {}) => {
    const startOffset = reset ? 0 : offsetRef.current;

    if (reset) {
      setLoading(true);
      setLoadingMore(false);
      setRows([]);
      rowsRef.current = [];
      setOffset(0);
      setHasMore(true);
      offsetRef.current = 0;
      hasMoreRef.current = true;
      if (listRef.current) listRef.current.scrollTop = 0;
    } else {
      if (loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) return;
      setLoadingMore(true);
    }

    const qs = new URLSearchParams({ isActive: "true", limit: String(PAGE_SIZE) });
    if (startOffset > 0) qs.set("offset", String(startOffset));

    try {
      const d = await fetchApi(`/api/travel-school-terms?${qs.toString()}`);
      const nextRows = Array.isArray(d) ? d : [];
      const mergedRows = reset ? nextRows : [...rowsRef.current, ...nextRows];
      const nextOffset = startOffset + nextRows.length;
      const nextHasMore = nextRows.length === PAGE_SIZE;

      rowsRef.current = mergedRows;
      setRows(mergedRows);
      setOffset(nextOffset);
      setHasMore(nextHasMore);
      offsetRef.current = nextOffset;
      hasMoreRef.current = nextHasMore;
    } catch (e) {
      notify.error(e?.message || "Failed to load term calendar");
      if (reset) {
        setRows([]);
        rowsRef.current = [];
        setOffset(0);
        setHasMore(false);
        offsetRef.current = 0;
        hasMoreRef.current = false;
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [notify]);

  const loadUploads = () => {
    setLoadingUploads(true);
    fetchApi("/api/travel-school-terms/uploads")
      .then((d) => setUploads(Array.isArray(d?.uploads) ? d.uploads : []))
      .catch((e) => notify.error(e?.message || "Failed to load uploaded calendars"))
      .finally(() => setLoadingUploads(false));
  };

  useEffect(() => {
    loadRows({ reset: true });
    loadUploads();
  }, [loadRows]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || loading || loadingMore || !hasMore) return;
    if (el.scrollHeight <= el.clientHeight + 72) loadRows({ reset: false });
  }, [rows, hasMore, loading, loadingMore, loadRows]);

  const handleRowsScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (!el || loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 72) {
      loadRows({ reset: false });
    }
  }, [loadRows]);

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
      loadRows({ reset: true });
    } catch (err) {
      notify.error(err?.message || "Failed to add window");
    } finally {
      setSaving(false);
    }
  };

  const removeRow = async (id) => {
    if (!(await notify.confirm("Remove this term window?"))) return;
    try {
      await fetchApi(`/api/travel-school-terms/${id}`, { method: "DELETE" });
      loadRows({ reset: true });
    } catch (err) {
      notify.error(err?.message || "Failed to remove");
    }
  };

  // Local calendar day as YYYY-MM-DD — drives the date input's `min` so past
  // days aren't offerable in the picker. Built from local parts rather than
  // toISOString(), which converts to UTC first and would hand back yesterday
  // for anyone sitting east of UTC late in the day.
  const todayIso = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  const runCheck = async () => {
    if (!checkDate) {
      notify.error("Pick a date to check");
      return;
    }
    // `min` on the input stops the picker, but a typed date bypasses it.
    if (checkDate < todayIso) {
      notify.error("Pick today or a future date - past dates can't be scheduled.");
      return;
    }
    try {
      const qs = new URLSearchParams({ date: checkDate });
      if (checkSchool.trim()) qs.set("schoolName", checkSchool.trim());
      const res = await fetchApi(`/api/travel-school-terms/check?${qs.toString()}`);
      setCheckResult(res);
    } catch (err) {
      notify.error(err?.message || "Check failed");
    }
  };

  const downloadTemplate = async (format) => {
    try {
      const token = getAuthToken();
      const response = await fetch(`/api/travel-school-terms/template?format=${format}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) throw new Error("Failed to download template");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = format === "xlsx" ? "travel-school-terms-template.xlsx" : "travel-school-terms-template.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      notify.error(err?.message || "Failed to download template");
    }
  };

  const handleImport = async () => {
    if (!importFile) {
      notify.error("Choose a CSV or Excel file first");
      return;
    }
    setImporting(true);
    try {
      const token = getAuthToken();
      const formData = new FormData();
      formData.append("file", importFile);
      const response = await fetch("/api/travel-school-terms/import", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Import failed");
      setImportResult(payload);
      setImportFile(null);
      if (importInputRef.current) importInputRef.current.value = "";
      loadRows({ reset: true });
      notify.success(`Imported ${payload.imported || 0}, updated ${payload.updated || 0}, skipped ${payload.skipped || 0}`);
    } catch (err) {
      notify.error(err?.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleCalendarUpload = async () => {
    if (!calendarFile) {
      notify.error("Choose a PDF or image first");
      return;
    }
    setUploadingCalendar(true);
    try {
      const token = getAuthToken();
      const formData = new FormData();
      formData.append("file", calendarFile);
      if (uploadMeta.schoolName.trim()) formData.append("schoolName", uploadMeta.schoolName.trim());
      if (uploadMeta.board.trim()) formData.append("board", uploadMeta.board.trim());
      if (uploadMeta.label.trim()) formData.append("label", uploadMeta.label.trim());
      const response = await fetch("/api/travel-school-terms/uploads", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Upload failed");
      setCalendarFile(null);
      setUploadMeta(BLANK_UPLOAD_META);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      loadUploads();
      notify.success("Calendar file uploaded");
    } catch (err) {
      notify.error(err?.message || "Upload failed");
    } finally {
      setUploadingCalendar(false);
    }
  };

  const removeUpload = async (uploadId) => {
    if (!(await notify.confirm("Delete this uploaded calendar file?"))) return;
    try {
      await fetchApi(`/api/travel-school-terms/uploads/${uploadId}`, { method: "DELETE" });
      loadUploads();
    } catch (err) {
      notify.error(err?.message || "Failed to delete upload");
    }
  };

  return (
    <div style={{ padding: 24, width: "100%", maxWidth: 1480, margin: "0 auto", boxSizing: "border-box", animation: "fadeIn 0.4s ease-out" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: "1.75rem", fontWeight: 600 }}>
          <CalendarDays size={26} aria-hidden /> School Term Calendar
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
          Term / holiday / exam windows per school, so trips avoid term-time and exams. Use manual entry, CSV/Excel import, or upload the school&apos;s published calendar for reference.
        </p>
      </header>

      <div className="glass" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <Search size={16} aria-hidden style={{ color: "var(--text-secondary)" }} />
        <input type="date" value={checkDate} min={todayIso} onChange={(e) => setCheckDate(e.target.value)} style={inp} aria-label="Date to check" />
        <input type="text" placeholder="School (optional)" value={checkSchool} onChange={(e) => setCheckSchool(e.target.value)} style={inp} />
        <button type="button" onClick={runCheck} style={btn}>Check date</button>
        {checkResult && (() => {
          // Three outcomes, not two — see the /check route. A date with no
          // window on file used to render the same green "OK to schedule"
          // as a real holiday, which read as a confirmation the calendar
          // could not actually give.
          const tone = {
            clear: { bg: "rgba(16,185,129,0.12)", fg: "#059669" },
            blocked: { bg: "rgba(239,68,68,0.12)", fg: "#ef4444" },
            unknown: { bg: "rgba(245,158,11,0.12)", fg: "#b45309" },
          }[checkResult.status] || { bg: "rgba(245,158,11,0.12)", fg: "#b45309" };
          let text;
          if (checkResult.status === "blocked") {
            text = `Avoid - ${checkResult.blocking.map((b) => b.label).join(", ")}`;
          } else if (checkResult.status === "clear") {
            text = `OK to schedule - ${checkResult.matches.map((m) => m.label).join(", ")}`;
          } else {
            text = "No calendar data for this date";
          }
          return (
            <span
              title={checkResult.status === "unknown"
                ? "No term, holiday or exam window on file covers this date, so this is not a confirmation - add the school's windows below to get a definite answer."
                : undefined}
              style={{
                padding: "4px 12px", borderRadius: 999, fontWeight: 700, fontSize: 13,
                background: tone.bg, color: tone.fg,
              }}
            >
              {text}
            </span>
          );
        })()}
      </div>

      <div className="glass" style={{ padding: 14, marginBottom: 16, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
          <FileSpreadsheet size={16} aria-hidden /> Import CSV / Excel
        </div>
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          Download the template, fill it in, then import rows in bulk.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => downloadTemplate("csv")} style={secondaryBtn}><Download size={14} aria-hidden /> CSV template</button>
          <button type="button" onClick={() => downloadTemplate("xlsx")} style={secondaryBtn}><Download size={14} aria-hidden /> XLSX template</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, alignItems: "end" }}>
          <Field label="Spreadsheet file">
            <input ref={importInputRef} type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setImportFile(e.target.files?.[0] || null)} style={inp} />
          </Field>
          <button type="button" onClick={handleImport} disabled={importing || !importFile} style={{ ...btn, opacity: importing || !importFile ? 0.6 : 1 }}>
            <Upload size={14} aria-hidden /> {importing ? "Importing..." : "Import rows"}
          </button>
        </div>
        {importResult && (
          <div style={infoBox}>
            <strong>Last import:</strong> imported {importResult.imported || 0}, updated {importResult.updated || 0}, skipped {importResult.skipped || 0} of {importResult.total || 0}
            {Array.isArray(importResult.errors) && importResult.errors.length > 0 && (
              <div style={{ marginTop: 8, color: "var(--text-secondary)" }}>
                {importResult.errors.slice(0, 5).map((err) => (
                  <div key={`${err.rowNumber}-${err.label}`}>Row {err.rowNumber}: {err.reason}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="glass" style={{ padding: 14, marginBottom: 16, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
          <FileText size={16} aria-hidden /> Upload school calendar PDF / image
        </div>
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          Save the school&apos;s published calendar for reference while you enter or import rows.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}>
          <Field label="School"><input type="text" value={uploadMeta.schoolName} onChange={(e) => setUploadMeta({ ...uploadMeta, schoolName: e.target.value })} style={inp} placeholder="DPS Bangalore" /></Field>
          <Field label="Board"><input type="text" value={uploadMeta.board} onChange={(e) => setUploadMeta({ ...uploadMeta, board: e.target.value })} style={inp} placeholder="CBSE" /></Field>
          <Field label="Label"><input type="text" value={uploadMeta.label} onChange={(e) => setUploadMeta({ ...uploadMeta, label: e.target.value })} style={inp} placeholder="Academic Calendar 2027" /></Field>
          <Field label="File"><input ref={uploadInputRef} type="file" accept=".pdf,image/png,image/jpeg,image/webp" onChange={(e) => setCalendarFile(e.target.files?.[0] || null)} style={inp} /></Field>
          <button type="button" onClick={handleCalendarUpload} disabled={uploadingCalendar || !calendarFile} style={{ ...btn, opacity: uploadingCalendar || !calendarFile ? 0.6 : 1 }}>
            <Upload size={14} aria-hidden /> {uploadingCalendar ? "Uploading..." : "Upload file"}
          </button>
        </div>
      </div>

      <form onSubmit={addRow} className="glass" style={{ padding: 14, marginBottom: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, alignItems: "end" }}>
        <Field label="School (blank = all schools)"><input type="text" value={form.schoolName} onChange={(e) => setForm({ ...form, schoolName: e.target.value })} style={inp} placeholder="DPS Bangalore" /></Field>
        <Field label="Board"><input type="text" value={form.board} onChange={(e) => setForm({ ...form, board: e.target.value })} style={inp} placeholder="CBSE" /></Field>
        <Field label="Type"><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={inp}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
        <Field label="Label *"><input type="text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={inp} placeholder="Summer Break 2027" /></Field>
        <Field label="Start *"><input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} style={inp} /></Field>
        <Field label="End *"><input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} style={inp} /></Field>
        <button type="submit" disabled={saving} style={{ ...btn, opacity: saving ? 0.6 : 1 }}><Plus size={14} aria-hidden /> {saving ? "Adding..." : "Add window"}</button>
      </form>

      <div className="glass" style={{ padding: 0, overflow: "hidden", marginBottom: 16, background: "var(--surface-color)" }}>
        {loading ? (
          <div style={empty}>Loading...</div>
        ) : rows.length === 0 ? (
          <div style={empty}>No term windows yet - add one above, import a spreadsheet, or upload a school calendar.</div>
        ) : (
          <TopScrollSync>
            <div
              ref={listRef}
              data-testid="school-terms-table-scroll"
              onScroll={handleRowsScroll}
              style={{ maxHeight: "60vh", overflowY: "auto", overflowX: "hidden" }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, position: "sticky", top: 0, zIndex: 2, background: "var(--bg-color, #f8fafc)" }}>School</th>
                    <th style={{ ...th, position: "sticky", top: 0, zIndex: 2, background: "var(--bg-color, #f8fafc)" }}>Board</th>
                    <th style={{ ...th, position: "sticky", top: 0, zIndex: 2, background: "var(--bg-color, #f8fafc)" }}>Type</th>
                    <th style={{ ...th, position: "sticky", top: 0, zIndex: 2, background: "var(--bg-color, #f8fafc)" }}>Label</th>
                    <th style={{ ...th, position: "sticky", top: 0, zIndex: 2, background: "var(--bg-color, #f8fafc)" }}>From</th>
                    <th style={{ ...th, position: "sticky", top: 0, zIndex: 2, background: "var(--bg-color, #f8fafc)" }}>To</th>
                    <th style={{ ...th, position: "sticky", top: 0, zIndex: 2, background: "var(--bg-color, #f8fafc)" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                      <td style={td}>{r.schoolName || <em style={{ color: "var(--text-secondary)" }}>All schools</em>}</td>
                      <td style={td}>{r.board || "-"}</td>
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
              {loadingMore && (
                <div style={{ padding: 12, textAlign: "center", color: "var(--text-secondary)", borderTop: "1px solid var(--border-color)" }}>
                  Loading more...
                </div>
              )}
            </div>
          </TopScrollSync>
        )}
      </div>

      <div className="glass" style={{ padding: 0, overflow: "visible" }}>
        {loadingUploads ? (
          <div style={empty}>Loading uploaded calendars...</div>
        ) : uploads.length === 0 ? (
          <div style={empty}>No uploaded school calendars yet.</div>
        ) : (
          <TopScrollSync>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>School</th><th style={th}>Board</th><th style={th}>Label</th><th style={th}>File</th><th style={th}>Uploaded</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {uploads.map((u) => (
                  <tr key={u.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                    <td style={td}>{u.schoolName || "-"}</td>
                    <td style={td}>{u.board || "-"}</td>
                    <td style={td}>{u.label || "-"}</td>
                    <td style={td}>
                      <a href={u.fileUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-color)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <ExternalLink size={14} aria-hidden /> {u.originalName}
                      </a>
                    </td>
                    <td style={td}>{fmt(u.createdAt)}</td>
                    <td style={td}>
                      <button type="button" onClick={() => removeUpload(u.id)} aria-label={`Delete ${u.originalName}`} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer" }}>
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
const btn = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13, background: "var(--primary-color, var(--accent-color))", color: "#fff", border: "none", cursor: "pointer" };
const secondaryBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13, background: "transparent", color: "var(--text-primary)", border: "1px solid var(--border-color)", cursor: "pointer" };
const th = { textAlign: "left", padding: "10px 12px", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)", background: "var(--subtle-bg)", fontWeight: 600 };
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const badge = { display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 700, textTransform: "capitalize" };
const infoBox = { padding: 12, borderRadius: 8, border: "1px solid var(--border-color)", background: "var(--subtle-bg)", fontSize: 13, color: "var(--text-primary)" };
