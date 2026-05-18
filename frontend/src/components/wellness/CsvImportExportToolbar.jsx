// Issue #816 — Reusable CSV Import / Export toolbar for wellness list pages.
//
// Renders two header-level buttons:
//   ⬇ Export CSV  →  GET /api/wellness/csv/:entity/export?<filters>
//                    Downloads the filtered current view as CSV.
//   ⬆ Import CSV  →  opens a modal with: template download, file picker,
//                    client-side preview, validation, error report.
//
// Props:
//   entity     — string (services | packages | products | customers | bookings)
//   filters    — object whose keys become querystring params on /export.
//                Mirrors whatever the parent page already filters by.
//   label      — optional plain-English entity label for the modal header
//                (defaults to titlecased entity name).
//   onImported — optional () => void callback fired AFTER a successful sync
//                import completes, so the parent can refresh its list.
//
// Auth: piggy-backs on fetchApi's Bearer-token plumbing. Export uses a manual
// fetch to honour the Authorization header on the blob download; the
// "<a href=…>" path would skip the header and 401.

import { useEffect, useRef, useState } from "react";
import { Upload, Download, X, FileText, AlertTriangle, CheckCircle2 } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const ENTITY_LABELS = {
  services: "Services",
  packages: "Packages",
  products: "Drugs / Products",
  customers: "Patients",
  bookings: "Bookings",
};

export default function CsvImportExportToolbar({
  entity,
  filters = {},
  label = null,
  onImported = null,
}) {
  const notify = useNotify();
  const [exporting, setExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const displayLabel = label || ENTITY_LABELS[entity] || entity;

  const buildQueryString = () => {
    const parts = [];
    for (const [k, v] of Object.entries(filters || {})) {
      if (v === null || v === undefined || v === "") continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    return parts.length ? `?${parts.join("&")}` : "";
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const url = `/api/wellness/csv/${entity}/export${buildQueryString()}`;
      const token = getAuthToken();
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        notify.error(body.error || `Export failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${entity}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      notify.success(`Exported ${displayLabel}`);
    } catch (e) {
      notify.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          type="button"
          onClick={doExport}
          disabled={exporting}
          aria-label={`Export ${displayLabel} as CSV`}
          style={secondaryBtnStyle}
        >
          <Download size={14} /> {exporting ? "Exporting…" : "Export CSV"}
        </button>
        <button
          type="button"
          onClick={() => setShowImport(true)}
          aria-label={`Import ${displayLabel} from CSV`}
          style={secondaryBtnStyle}
        >
          <Upload size={14} /> Import CSV
        </button>
      </div>

      {showImport && (
        <ImportModal
          entity={entity}
          label={displayLabel}
          onClose={() => setShowImport(false)}
          onImported={(result) => {
            // Only refresh the parent's list if at least one row landed.
            if (onImported && (result?.inserted || result?.updated)) onImported(result);
          }}
        />
      )}
    </>
  );
}

// ── Import modal ──────────────────────────────────────────────────

function ImportModal({ entity, label, onClose, onImported }) {
  const notify = useNotify();
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [previewRows, setPreviewRows] = useState([]);
  const [previewHeaders, setPreviewHeaders] = useState([]);
  const [previewError, setPreviewError] = useState(null);
  const [thresholds, setThresholds] = useState({ rows: 5000, bytes: 5 * 1024 * 1024 });
  const [expectedHeaders, setExpectedHeaders] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [jobId, setJobId] = useState(null);

  // Pull entity meta so we can show the column list pre-upload + know the
  // async thresholds.
  useEffect(() => {
    fetchApi(`/api/wellness/csv/${entity}`, { silent: true })
      .then((meta) => {
        setExpectedHeaders(meta.headers || []);
        if (meta.thresholds) setThresholds(meta.thresholds);
      })
      .catch(() => { /* gate denied — submit will show the real error */ });
  }, [entity]);

  const downloadTemplate = async () => {
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/wellness/csv/${entity}/template`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        notify.error(body.error || `Template download failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${entity}-template.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch (e) {
      notify.error(`Template download failed: ${e.message}`);
    }
  };

  const handleFile = async (f) => {
    setFile(f);
    setResult(null);
    setJobId(null);
    setPreviewError(null);
    setPreviewRows([]);
    setPreviewHeaders([]);
    if (!f) return;
    try {
      const text = await f.text();
      const { headers, rows } = parseCsvClient(text);
      setPreviewHeaders(headers);
      setPreviewRows(rows.slice(0, 10));
      const missing = expectedHeaders.filter((h) => !headers.includes(h));
      if (missing.length) {
        setPreviewError(`Missing required column(s): ${missing.join(", ")}`);
      }
    } catch (e) {
      setPreviewError(e.message || "Failed to parse CSV");
    }
  };

  const doImport = async () => {
    if (!file) return;
    setSubmitting(true);
    setResult(null);
    setJobId(null);

    const tooBig = file.size > thresholds.bytes;
    const tooLong = previewRows.length === 10 && file.size > 100 * 1024; // heuristic; the row count is properly checked server-side

    const useAsync = tooBig || tooLong;
    const endpoint = useAsync
      ? `/api/wellness/csv/${entity}/import/async`
      : `/api/wellness/csv/${entity}/import`;

    try {
      const fd = new FormData();
      fd.append("file", file);
      const token = getAuthToken();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        notify.error(body.error || `Import failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      if (useAsync) {
        setJobId(body.jobId);
        notify.info("Large file queued — you'll be emailed when it finishes.");
      } else {
        setResult(body);
        if (body.inserted || body.updated) {
          notify.success(
            `Imported: ${body.inserted} new, ${body.updated} updated${body.errors?.length ? `, ${body.errors.length} errors` : ""}`,
          );
          onImported(body);
        } else if (body.errors?.length) {
          notify.error(`Import had ${body.errors.length} row error(s).`);
        }
      }
    } catch (e) {
      notify.error(`Import failed: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // Async job polling.
  useEffect(() => {
    if (!jobId) return undefined;
    const tick = async () => {
      const j = await fetchApi(`/api/wellness/csv/jobs/${jobId}`, { silent: true })
        .catch(() => null);
      if (!j) return;
      if (j.status === "done" || j.status === "failed") {
        setResult(j.result || { errors: [{ row: 0, column: "(job)", value: "", message: j.error || "Job failed" }], inserted: 0, updated: 0, skipped: 0 });
        setJobId(null);
        if (j.status === "done" && (j.result?.inserted || j.result?.updated)) onImported(j.result);
      }
    };
    const id = setInterval(tick, 1500);
    tick();
    return () => clearInterval(id);
  }, [jobId, onImported]);

  const downloadErrorReport = () => {
    if (!result?.errors?.length) return;
    const headers = ["row", "column", "value", "message"];
    const lines = [headers.join(",")];
    for (const e of result.errors) {
      const cells = headers.map((h) => csvCell(e[h]));
      lines.push(cells.join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${entity}-import-errors-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="csv-import-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="glass"
        style={{
          maxWidth: 720,
          width: "92%",
          maxHeight: "90vh",
          overflow: "auto",
          padding: "2rem",
          position: "relative",
          background: "var(--bg-elev, #1e293b)",
          color: "var(--text-primary, #f1f5f9)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: "1rem",
            right: "1rem",
            background: "transparent",
            border: "none",
            fontSize: "1.5rem",
            cursor: "pointer",
            color: "inherit",
          }}
        >
          <X size={20} />
        </button>

        <h2 id="csv-import-title" style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Upload size={20} /> Import {label} from CSV
        </h2>

        <p style={{ color: "var(--text-secondary)", marginBottom: "1rem" }}>
          Upload a CSV with these columns:{" "}
          <code style={{ fontSize: "0.85em" }}>{expectedHeaders.join(", ") || "(loading…)"}</code>.
          Extra columns are ignored. Files over {Math.round(thresholds.bytes / (1024 * 1024))}MB or {thresholds.rows.toLocaleString()} rows are processed in the background and emailed when done.
        </p>

        <div style={{ marginBottom: "1rem" }}>
          <button type="button" onClick={downloadTemplate} style={linkBtnStyle}>
            <FileText size={14} /> Download CSV template
          </button>
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => handleFile(e.target.files?.[0] || null)}
            style={{ width: "100%" }}
            aria-label="Select CSV file"
          />
        </div>

        {previewError && (
          <div role="alert" style={{ ...alertStyle, background: "rgba(239,68,68,0.15)", borderColor: "#ef4444" }}>
            <AlertTriangle size={16} style={{ verticalAlign: "middle", marginRight: 6 }} /> {previewError}
          </div>
        )}

        {previewRows.length > 0 && !result && (
          <div style={{ marginBottom: "1rem" }}>
            <h3 style={{ fontSize: "0.95rem", marginBottom: "0.4rem" }}>Preview (first {previewRows.length} rows)</h3>
            <div style={{ maxHeight: 200, overflow: "auto", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                <thead>
                  <tr>
                    {previewHeaders.map((h) => (
                      <th key={h} style={{ padding: "0.4rem", borderBottom: "1px solid rgba(255,255,255,0.08)", textAlign: "left", background: "rgba(255,255,255,0.04)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i}>
                      {previewHeaders.map((h) => (
                        <td key={h} style={{ padding: "0.4rem", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>{String(r[h] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {result && (
          <div style={{ marginBottom: "1rem" }}>
            <div role="status" style={{ ...alertStyle, background: result.errors?.length ? "rgba(245,158,11,0.15)" : "rgba(16,185,129,0.15)", borderColor: result.errors?.length ? "#f59e0b" : "#10b981" }}>
              <CheckCircle2 size={16} style={{ verticalAlign: "middle", marginRight: 6 }} />
              Inserted <strong>{result.inserted ?? 0}</strong>, updated <strong>{result.updated ?? 0}</strong>, skipped <strong>{result.skipped ?? 0}</strong>{result.errors?.length ? `, errors ${result.errors.length}` : ""}
            </div>

            {result.errors?.length > 0 && (
              <>
                <h3 style={{ fontSize: "0.95rem", margin: "0.6rem 0 0.4rem" }}>Row-level errors</h3>
                <div style={{ maxHeight: 240, overflow: "auto", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 6 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                    <thead>
                      <tr>
                        {["row", "column", "value", "message"].map((h) => (
                          <th key={h} style={{ padding: "0.4rem", borderBottom: "1px solid rgba(255,255,255,0.08)", textAlign: "left", background: "rgba(239,68,68,0.10)" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.errors.slice(0, 200).map((e, i) => (
                        <tr key={i}>
                          <td style={{ padding: "0.4rem", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>{e.row}</td>
                          <td style={{ padding: "0.4rem", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>{e.column}</td>
                          <td style={{ padding: "0.4rem", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>{String(e.value ?? "")}</td>
                          <td style={{ padding: "0.4rem", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>{e.message}</td>
                        </tr>
                      ))}
                      {result.errors.length > 200 && (
                        <tr>
                          <td colSpan={4} style={{ padding: "0.4rem", color: "var(--text-secondary)", textAlign: "center" }}>
                            … {result.errors.length - 200} more — download the error report for the full list.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <button type="button" onClick={downloadErrorReport} style={{ ...secondaryBtnStyle, marginTop: "0.6rem" }}>
                  <Download size={14} /> Download error report (CSV)
                </button>
              </>
            )}
          </div>
        )}

        {jobId && !result && (
          <div role="status" style={{ ...alertStyle, background: "rgba(99,102,241,0.15)", borderColor: "#6366f1" }}>
            Background job <code>{jobId}</code> queued. You&apos;ll be emailed when it finishes; this dialog will update too.
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1rem" }}>
          <button type="button" onClick={onClose} style={secondaryBtnStyle}>
            {result ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button
              type="button"
              disabled={!file || submitting || !!previewError}
              onClick={doImport}
              style={{ ...primaryBtnStyle, opacity: !file || submitting || previewError ? 0.5 : 1 }}
            >
              {submitting ? "Importing…" : "Confirm import"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Inline tiny CSV utilities for the preview pane ───────────────
//
// Mirrors backend/lib/csvIO.js's parse contract for the bits we need on the
// client (header detection + first-10-row preview). Kept self-contained so
// the toolbar component is drop-in without a separate utils file.

function parseCsvClient(text) {
  if (!text) return { headers: [], rows: [] };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; continue; }
        inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"' && field.length === 0) { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r" || c === "\n") {
      row.push(field); field = "";
      records.push(row); row = [];
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      continue;
    }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); records.push(row); }
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === "") records.pop();
    else break;
  }
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map((h) => String(h).trim());
  const rows = records.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = idx < cells.length ? cells[idx] : ""; });
    return obj;
  });
  return { headers, rows };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ── Styles ─────────────────────────────────────────────────────────

const secondaryBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.5rem 0.9rem",
  background: "transparent",
  color: "var(--text-primary, inherit)",
  border: "1px solid var(--border-soft, rgba(255,255,255,0.18))",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: "0.85rem",
};

const primaryBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.5rem 1rem",
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: "0.9rem",
};

const linkBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: 0,
  background: "transparent",
  border: "none",
  color: "var(--primary-color, var(--accent-color))",
  cursor: "pointer",
  fontSize: "0.9rem",
  textDecoration: "underline",
};

const alertStyle = {
  padding: "0.6rem 0.8rem",
  borderRadius: 6,
  border: "1px solid",
  marginBottom: "0.8rem",
  fontSize: "0.9rem",
};
