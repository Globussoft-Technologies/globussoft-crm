
// Issue #816 - Reusable CSV import / export toolbar for wellness list pages.

// Renders two header-level buttons:
//   Export CSV -> GET /api/wellness/csv/:entity/export<filters>
//                    Downloads the filtered current view as CSV.
//   Import CSV -> opens a modal with: template download, file picker,
//                    client-side preview, validation, error report.

// Props:
//   entity     - string (services | packages | products | customers | bookings)
//   filters    - object whose keys become querystring params on /export.
//                Mirrors whatever the parent page already filters by.
//   label      - optional plain-English entity label for the modal header
//                (defaults to titlecased entity name).
//   onImported - optional () => void callback fired AFTER a successful sync
//                import completes, so the parent can refresh its list.

// Auth: piggy-backs on fetchApi's Bearer-token plumbing. Export uses a manual
// fetch to honor the Authorization header on the blob download; the
// "<a href=...>" path would skip the header and 401.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Upload, Download, X, FileText, AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const ENTITY_LABELS = {
  services: "Services",
  packages: "Packages",
  products: "Drugs / Products",
  "product-categories": "Product Categories",
  "inventory-products": "Products",
  "auto-consumption-rules": "Auto-consumption rules",
  customers: "Patients",
  bookings: "Bookings",
};

// Mime + extension lookup for the supported formats.
const FORMAT_META = {
  csv: { label: "CSV", ext: "csv" },
  xlsx: { label: "Excel (XLSX)", ext: "xlsx" },
};

export default function CsvImportExportToolbar({
  entity,
  filters = {},
  label = null,
  onImported = null,
  // Patient-list opt-in: when caller passes ['csv','xlsx'] the export button
  // becomes a dropdown and the Import modal offers both template formats.
  // Other entities keep the default single-CSV UX.
  formats = ["csv"],
  // Optional endpoint overrides - Patients routes to the new
  // /api/wellness/patients/{export,import-template} routes that understand
  // the source/gender/tags/dates filters; other entities stay on the
  // generic /api/wellness/csv/:entity/{export,template} pipeline.
  endpoints = null,
}) {
  const notify = useNotify();
  const [exporting, setExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef(null);
  const displayLabel = label || ENTITY_LABELS[entity] || entity;
  const safeEndpoints = endpoints || {};

  const exportUrl = safeEndpoints.export || `/api/wellness/csv/${entity}/export`;
  const templateUrl = safeEndpoints.template || `/api/wellness/csv/${entity}/template`;
  const metaUrl = safeEndpoints.meta || `/api/wellness/csv/${entity}`;
  const importUrl = safeEndpoints.import || `/api/wellness/csv/${entity}/import`;
  const importAsyncUrl = safeEndpoints.importAsync || `/api/wellness/csv/${entity}/import/async`;
  const jobUrl = safeEndpoints.job || ((jobId) => `/api/wellness/csv/jobs/${jobId}`);

  const buildQueryString = (extra = {}) => {
    const parts = [];
    const merged = { ...filters, ...extra };
    for (const [k, v] of Object.entries(merged)) {
      if (v === null || v === undefined || v === "") continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item === null || item === undefined || item === "") continue;
          parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
        }
      } else {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
    }
    return parts.length ? `?${parts.join("&")}` : "";
  };

  const doExport = async (format = "csv") => {
    setExporting(true);
    setExportMenuOpen(false);
    try {
      const qs = formats.length > 1 ? buildQueryString({ format }) : buildQueryString();
      const url = `${exportUrl}${qs}`;
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
      const ext = FORMAT_META[format].ext || "csv";
      a.download = `${entity}-${new Date().toISOString().slice(0, 10)}.${ext}`;
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

  // Close the export dropdown on outside click.
  useEffect(() => {
    if (!exportMenuOpen) return undefined;
    const onDocClick = (e) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [exportMenuOpen]);

  const multiFormat = formats.length > 1;

  return (
    <>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        {multiFormat ? (
          <div ref={exportMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={exporting}
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              aria-label={`Export ${displayLabel}`}
              style={secondaryBtnStyle}
            >
              <Download size={14} /> {exporting ? "Exporting..." : "Export"}
              <ChevronDown size={12} style={{ marginLeft: "0.15rem" }} />
            </button>
            {exportMenuOpen && (
              <div
                role="menu"
                aria-label={`Export ${displayLabel} format`}
                style={dropdownMenuStyle}
              >
                {formats.map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="menuitem"
                    onClick={() => doExport(f)}
                    style={dropdownItemStyle}
                  >
                    {FORMAT_META[f].label || f.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => doExport("csv")}
            disabled={exporting}
            aria-label={`Export ${displayLabel} as CSV`}
            style={secondaryBtnStyle}
          >
            <Download size={14} /> {exporting ? "Exporting..." : "Export CSV"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowImport(true)}
          aria-label={`Import ${displayLabel}`}
          style={secondaryBtnStyle}
        >
          <Upload size={14} /> {multiFormat ? "Import" : "Import CSV"}
        </button>
      </div>

      {showImport && (
        <ImportModal
          entity={entity}
          label={displayLabel}
          formats={formats}
          templateUrl={templateUrl}
          metaUrl={metaUrl}
          importUrl={importUrl}
          importAsyncUrl={importAsyncUrl}
          jobUrl={jobUrl}
          onClose={() => setShowImport(false)}
          onImported={(result) => {
            // Only refresh the parent's list if at least one row landed.
            if (onImported && (result.inserted || result.imported || result.updated)) onImported(result);
          }}
        />
      )}
    </>
  );
}

// -- Import modal --------------------------------------------------

function ImportModal({
  entity,
  label,
  onClose,
  onImported,
  formats = ["csv"],
  templateUrl = null,
  metaUrl = null,
  importUrl = null,
  importAsyncUrl = null,
  jobUrl = null,
}) {
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
    fetchApi(metaUrl || `/api/wellness/csv/${entity}`, { silent: true })
      .then((meta) => {
        setExpectedHeaders(meta.headers || []);
        if (meta.thresholds) setThresholds(meta.thresholds);
      })
      .catch(() => { /* gate denied - submit will show the real error */ });
  }, [entity, metaUrl]);

  const downloadTemplate = async (format = "csv") => {
    try {
      const token = getAuthToken();
      const base = templateUrl || `/api/wellness/csv/${entity}/template`;
      // Multi-format template endpoints accept format=csv|xlsx. The legacy
      // single-format endpoint ignores the param (always returns CSV) - fine.
      const url = formats.length > 1 ? `${base}?format=${encodeURIComponent(format)}` : base;
      const res = await fetch(url, {
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
      const ext = FORMAT_META[format].ext || "csv";
      a.download = `${entity}-template.${ext}`;
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
    // XLSX is binary - we don't ship a SheetJS bundle to the client just for
    // preview. The header + per-row validation still runs server-side on
    // submit, and any errors come back in the result.errors[] envelope.
    const looksXlsx = /\.xlsx$/i.test(f.name || "")
      || f.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      || f.type === "application/vnd.ms-excel";
    if (looksXlsx) return;
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
    const endpoint = useAsync ?
      (importAsyncUrl || `/api/wellness/csv/${entity}/import/async`)
      : (importUrl || `/api/wellness/csv/${entity}/import`);

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
        notify.info("Large file queued - you'll be emailed when it finishes.");
      } else {
        setResult(body);
        if (body.inserted || body.updated) {
          notify.success(
            `Imported: ${body.inserted} new, ${body.updated} updated${body.errors.length ? `, ${body.errors.length} errors` : ""}`,
          );
          onImported(body);
        } else if (body.errors.length) {
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
      const url = typeof jobUrl === "function" ? jobUrl(jobId) : `/api/wellness/csv/jobs/${jobId}`;
      const j = await fetchApi(url, { silent: true })
        .catch(() => null);
      if (!j) return;
      if (j.status === "done" || j.status === "failed") {
        setResult(j.result || { errors: [{ row: 0, column: "(job)", value: "", message: j.error || "Job failed" }], inserted: 0, updated: 0, skipped: 0 });
        setJobId(null);
        if (j.status === "done" && (j.result.inserted || j.result.updated)) onImported(j.result);
      }
    };
    const id = setInterval(tick, 1500);
    tick();
    return () => clearInterval(id);
  }, [jobId, jobUrl, onImported]);

  const downloadErrorReport = () => {
    if (!result.errors.length) return;
    const headers = ["row", "column", "value", "message"];
    const lines = [headers.join(",")];
    for (const e of result.errors) {
      const cells = headers.map((h) => csvCell(e[h]));
      lines.push(cells.join(","));
    }
    const blob = new Blob(["" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${entity}-import-errors-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  // Portal to <body> so the modal's `position: fixed` is anchored to the
  // viewport, not to an ancestor with backdrop-filter / transform / filter.
  // PageHeader's `.glass` class applies backdrop-filter, which would
  // otherwise contain `position: fixed` inside the header's bounding box
  // - the modal's `inset: 0` would cover only the header rectangle, the
  // dark backdrop wouldn't span the page, and the Cancel / Confirm buttons
  // would sit over the search-bar row and have their clicks intercepted.
  // (#1120)
  return createPortal(
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
          background: "var(--surface-color, rgba(250, 246, 237, 0.95))",
          color: "var(--text-primary, inherit)",
          border: "1px solid var(--border-color, rgba(0,0,0,0.1))",
          boxShadow: "var(--shadow-lg, 0 24px 60px rgba(0,0,0,0.25))",
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
          <Upload size={20} /> Import {label} from {formats.length > 1 ? "CSV / Excel" : "CSV"}
        </h2>

        <p style={{ color: "var(--text-secondary)", marginBottom: "1rem" }}>
          Upload a {formats.length > 1 ? "CSV or Excel (XLSX) file" : "CSV"} with these columns:{" "}
          <code style={codePillStyle}>{expectedHeaders.join(", ") || "(loading...)"}</code>.
          Extra columns are ignored. Files over {Math.round(thresholds.bytes / (1024 * 1024))}MB or {thresholds.rows.toLocaleString()} rows are processed in the background and emailed when done.
        </p>

        <div style={{ marginBottom: "1rem", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          {formats.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => downloadTemplate(f)}
              style={templateBtnStyle}
            >
              <FileText size={14} /> Download {FORMAT_META[f].label || f.toUpperCase()} template
            </button>
          ))}
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <input
            ref={fileInputRef}
            type="file"
            accept={formats.length > 1
              ? ".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : ".csv,text/csv"}
            onChange={(e) => handleFile(e.target.files[0] || null)}
            style={{ display: "none" }}
            aria-label={formats.length > 1 ? "Select CSV or Excel file" : "Select CSV file"}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={filePickerBtnStyle}
          >
            <Upload size={14} />
            {file ? "Change file" : (formats.length > 1 ? "Choose CSV or Excel file" : "Choose CSV file")}
          </button>
          <div style={fileMetaStyle}>
            <span>{file ? `Selected: ${file.name}` : "No file selected yet."}</span>
            <span>{formats.length > 1 ? "Accepted: CSV, XLSX" : "Accepted: CSV"}</span>
          </div>
          {file && /\.xlsx$/i.test(file.name || "") && !result && (
            <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", marginTop: "0.4rem" }}>
              Excel file selected - column + row validation runs on the server when you click Confirm.
            </p>
          )}
        </div>

        {previewError && (
          <div role="alert" style={getAlertStyle("error")}>
            <AlertTriangle size={16} style={{ verticalAlign: "middle", marginRight: 6 }} /> {previewError}
          </div>
        )}

        {previewRows.length > 0 && !result && (
          <div style={{ marginBottom: "1rem" }}>
            <h3 style={{ fontSize: "0.95rem", marginBottom: "0.4rem" }}>Preview (first {previewRows.length} rows)</h3>
            <div style={{ ...panelStyle, maxHeight: 200, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", color: "var(--text-primary, inherit)" }}>
                <thead>
                  <tr>
                    {previewHeaders.map((h) => (
                      <th key={h} style={tableHeaderCellStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i}>
                      {previewHeaders.map((h) => (
                        <td key={h} style={tableCellStyle}>{String(r[h] || "")}</td>
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
            <div role="status" style={getAlertStyle(result.errors.length ? "warning" : "success")}>
              <CheckCircle2 size={16} style={{ verticalAlign: "middle", marginRight: 6 }} />
              Inserted <strong>{result.inserted ?? result.imported ?? 0}</strong>, updated <strong>{result.updated ?? 0}</strong>, skipped <strong>{result.skipped ?? 0}</strong>{result.errors.length ? `, errors ${result.errors.length}` : ""}
            </div>

            {result.errors.length > 0 && (
              <>
                <h3 style={{ fontSize: "0.95rem", margin: "0.6rem 0 0.4rem" }}>Row-level errors</h3>
                <div style={{ ...panelStyle, maxHeight: 240, overflow: "auto", borderColor: "rgba(168, 50, 63, 0.35)" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", color: "var(--text-primary, inherit)" }}>
                    <thead>
                      <tr>
                        {["row", "column", "value", "message"].map((h) => (
                          <th key={h} style={{ ...tableHeaderCellStyle, background: "rgba(168, 50, 63, 0.12)" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.errors.slice(0, 200).map((e, i) => (
                        <tr key={i}>
                          <td style={tableCellStyle}>{e.row}</td>
                          <td style={tableCellStyle}>{e.column}</td>
                          <td style={tableCellStyle}>{String(e.value || "")}</td>
                          <td style={tableCellStyle}>{e.message}</td>
                        </tr>
                      ))}
                      {result.errors.length > 200 && (
                        <tr>
                          <td colSpan={4} style={{ padding: "0.4rem", color: "var(--text-secondary)", textAlign: "center" }}>
                            ... {result.errors.length - 200} more - download the error report for the full list.
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
          <div role="status" style={getAlertStyle("info")}>
            Background job <code style={codePillStyle}>{jobId}</code> queued. You'll be emailed when it finishes; this dialog will update too.
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
              {submitting ? "Importing..." : "Confirm import"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// -- Inline tiny CSV utilities for the preview pane ---------------
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

// -- Styles ---------------------------------------------------------

const themedBorder = "1px solid var(--border-color, rgba(0,0,0,0.14))";

const secondaryBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.5rem 0.9rem",
  background: "var(--surface-color, rgba(255,255,255,0.9))",
  color: "var(--text-primary, inherit)",
  border: themedBorder,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: "0.85rem",
  fontWeight: 600,
};

const primaryBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.55rem 1rem",
  background: "linear-gradient(135deg, var(--accent-peach, var(--accent-color, #C9A063)) 0%, var(--accent-color, #C9A063) 100%)",
  color: "var(--accent-text, #fff)",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: "0.9rem",
  fontWeight: 700,
  boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.12))",
};

const linkBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.55rem 0.8rem",
  background: "var(--surface-color, rgba(255,255,255,0.9))",
  border: themedBorder,
  borderRadius: 8,
  color: "var(--accent-color, var(--text-primary))",
  cursor: "pointer",
  fontSize: "0.85rem",
  fontWeight: 600,
  textDecoration: "none",
};

const templateBtnStyle = linkBtnStyle;

const filePickerBtnStyle = {
  width: "100%",
  padding: "0.75rem 0.9rem",
  borderRadius: 8,
  border: "2px dashed var(--border-color, rgba(0,0,0,0.18))",
  background: "var(--surface-color, rgba(255,255,255,0.9))",
  color: "var(--accent-color, var(--text-primary))",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  fontSize: "0.95rem",
  fontWeight: 600,
};

const fileMetaStyle = {
  display: "flex",
  gap: "0.5rem",
  justifyContent: "space-between",
  flexWrap: "wrap",
  marginTop: "0.45rem",
  color: "var(--text-secondary)",
  fontSize: "0.82rem",
};

const codePillStyle = {
  display: "inline-block",
  padding: "0.1rem 0.35rem",
  borderRadius: 6,
  border: themedBorder,
  background: "var(--subtle-bg, rgba(0,0,0,0.03))",
  color: "var(--text-primary, inherit)",
  fontSize: "0.85em",
};

const alertStyle = {
  padding: "0.6rem 0.8rem",
  borderRadius: 8,
  border: themedBorder,
  marginBottom: "0.8rem",
  fontSize: "0.9rem",
  color: "var(--text-primary, inherit)",
  background: "var(--subtle-bg, rgba(0,0,0,0.03))",
};

const alertVariants = {
  error: {
    background: "rgba(168, 50, 63, 0.12)",
    borderColor: "rgba(168, 50, 63, 0.45)",
  },
  warning: {
    background: "rgba(212, 146, 59, 0.12)",
    borderColor: "rgba(212, 146, 59, 0.45)",
  },
  success: {
    background: "rgba(74, 124, 89, 0.12)",
    borderColor: "rgba(74, 124, 89, 0.45)",
  },
  info: {
    background: "rgba(99, 102, 241, 0.12)",
    borderColor: "rgba(99, 102, 241, 0.45)",
  },
};

function getAlertStyle(variant) {
  return { ...alertStyle, ...(alertVariants[variant] || {}) };
}

const panelStyle = {
  border: themedBorder,
  borderRadius: 8,
  background: "var(--surface-color, rgba(255,255,255,0.9))",
  overflow: "hidden",
};

const tableHeaderCellStyle = {
  padding: "0.4rem",
  borderBottom: themedBorder,
  textAlign: "left",
  background: "var(--subtle-bg, rgba(0,0,0,0.03))",
  color: "var(--text-primary, inherit)",
  fontWeight: 600,
};

const tableCellStyle = {
  padding: "0.4rem",
  borderBottom: "1px solid var(--border-light, rgba(0,0,0,0.06))",
  color: "var(--text-primary, inherit)",
};

const dropdownMenuStyle = {
  position: "absolute",
  top: "calc(100% + 4px)",
  right: 0,
  minWidth: 160,
  // --bg-color: opaque in both themes. (--surface-color is rgba(...,0.6)
  // in dark wellness, which makes menu items hard to read against the
  // page behind them.)
  background: "var(--bg-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
  borderRadius: 8,
  boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
  padding: "0.25rem",
  zIndex: 100,
  display: "flex",
  flexDirection: "column",
};

const dropdownItemStyle = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  background: "transparent",
  color: "var(--text-primary, inherit)",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
};


