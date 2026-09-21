
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
//   allowImport - default true. Pass false when the caller can read/export but
//                not write, so the toolbar renders export-only instead of an
//                Import button that would 403 on submit.

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
  forceSync = false,
  compact = false,
  // Patient-list opt-in: when caller passes ['csv','xlsx'] the export button
  // becomes a dropdown and the Import modal offers both template formats.
  // Other entities keep the default single-CSV UX.
  formats = ["csv"],
  // Optional endpoint overrides - Patients routes to the new
  // /api/wellness/patients/{export,import-template} routes that understand
  // the source/gender/tags/dates filters; other entities stay on the
  // generic /api/wellness/csv/:entity/{export,template} pipeline.
  endpoints = null,
  // Some vertical-specific import routes do not expose the wellness metadata
  // endpoint. The modal can still use the shared file/template flow without
  // making that optional metadata request.
  skipMeta = false,
  expectedHeaders = [],
  showExport = true,
  // Set false to render an export-only toolbar. Attendance uses this: the
  // dashboard is visible to MANAGERs, but the import endpoint is ADMIN-only
  // (it can overwrite existing rows), so managers must not see a button that
  // can only ever 403.
  allowImport = true,
  genericLeadWizard = false,
  mappingFields = [],
}) {
  const notify = useNotify();
  const [exporting, setExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [recentImport, setRecentImport] = useState(() => {
    if (typeof window === "undefined") return null;
    try { return JSON.parse(window.sessionStorage.getItem("generic-crm-latest-import") || "null"); } catch { return null; }
  });
  const [showRecentImport, setShowRecentImport] = useState(false);
  const [showImportHistory, setShowImportHistory] = useState(false);
  const [contactsImport, setContactsImport] = useState(null);
  const [importHistory, setImportHistory] = useState(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(window.sessionStorage.getItem("generic-crm-import-history") || "[]"); } catch { return []; }
  });
  const exportMenuRef = useRef(null);
  const importMenuRef = useRef(null);
  const displayLabel = label || ENTITY_LABELS[entity] || entity;
  const safeEndpoints = endpoints || {};
  const toolbarButtonStyle = compact ? compactSecondaryBtnStyle : secondaryBtnStyle;

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

  useEffect(() => {
    if (!importMenuOpen) return undefined;
    const onDocClick = (event) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target)) setImportMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [importMenuOpen]);

  const multiFormat = formats.length > 1;

  return (
    <>
      <div
        style={{
          display: "flex",
          gap: compact ? "0.35rem" : "0.5rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {showExport && multiFormat ? (
          <div ref={exportMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={exporting}
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              aria-label={`Export ${displayLabel}`}
              style={toolbarButtonStyle}
            >
              <Upload size={14} /> {exporting ? "Exporting..." : "Export"}
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
        ) : showExport ? (
          <button
            type="button"
            onClick={() => doExport("csv")}
            disabled={exporting}
            aria-label={`Export ${displayLabel} as CSV`}
            style={toolbarButtonStyle}
          >
            <Upload size={14} /> {exporting ? "Exporting..." : "Export CSV"}
          </button>
        ) : null}
        {allowImport && genericLeadWizard ? (
          <div ref={importMenuRef} style={{ position: "relative", display: "inline-flex" }}>
            <button type="button" onClick={() => setShowImport(true)} aria-label="Import contacts" style={{ ...toolbarButtonStyle, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
              <Download size={14} /> Import contacts
            </button>
            <button type="button" onClick={() => setImportMenuOpen((open) => !open)} aria-label="Import contacts options" aria-haspopup="menu" aria-expanded={importMenuOpen} style={{ ...toolbarButtonStyle, borderLeft: "1px solid var(--border-color)", borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingLeft: "0.45rem", paddingRight: "0.45rem" }}>
              <ChevronDown size={13} />
            </button>
            {importMenuOpen && (
              <div role="menu" aria-label="Import contacts options" style={{ ...dropdownMenuStyle, right: 0, left: "auto", minWidth: 190 }}>
                <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); setShowRecentImport(true); }} style={dropdownItemStyle}>View recent import status</button>
                <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); setShowImportHistory(true); }} style={dropdownItemStyle}>View import history</button>
              </div>
            )}
          </div>
        ) : allowImport ? (
          <button
            type="button"
            onClick={() => setShowImport(true)}
            aria-label={`Import ${displayLabel}`}
            style={toolbarButtonStyle}
          >
            <Download size={14} /> {multiFormat ? "Import" : "Import CSV"}
          </button>
        ) : null}
      </div>

      {showRecentImport && (
        <div role="dialog" aria-modal="true" aria-labelledby="recent-import-title" style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", padding: 16 }} onClick={() => setShowRecentImport(false)}>
          <div className="glass" style={{ width: "min(380px, 100%)", padding: 16, background: "var(--surface-color, #fff)", border: "1px solid var(--border-color)", borderRadius: 10, boxShadow: "var(--shadow-lg, 0 18px 45px rgba(0,0,0,.2))" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><h2 id="recent-import-title" style={{ margin: 0, fontSize: "1rem" }}>Your recent import</h2><button type="button" aria-label="Close recent import" onClick={() => setShowRecentImport(false)} style={{ border: 0, background: "transparent", cursor: "pointer", fontSize: "1.25rem" }}>×</button></div>
            {recentImport ? (
              <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 14 }}>
                <strong style={{ display: "block", marginBottom: 10, overflowWrap: "anywhere" }}>{recentImport.fileName}</strong>
                <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginBottom: 12 }}>{new Date(recentImport.completedAt).toLocaleString()}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, textAlign: "center" }}>{[["Created", recentImport.inserted], ["Updated", recentImport.updated], ["Skipped", recentImport.skipped], ["Errors", recentImport.errors]].map(([labelText, value]) => <div key={labelText}><div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{labelText}</div><strong>{value}</strong></div>)}</div>
              </div>
            ) : <p style={{ margin: 0, color: "var(--text-secondary)" }}>No imports completed yet.</p>}
          </div>
        </div>
      )}

      {showImportHistory && (
        <div role="dialog" aria-modal="true" aria-labelledby="import-history-title" style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", padding: 16 }} onClick={() => setShowImportHistory(false)}>
          <div className="glass" style={{ width: "min(980px, 100%)", maxHeight: "85vh", overflow: "auto", padding: 16, background: "var(--surface-color, #fff)", border: "1px solid var(--border-color)", borderRadius: 10, boxShadow: "var(--shadow-lg, 0 18px 45px rgba(0,0,0,.2))" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><h2 id="import-history-title" style={{ margin: 0, fontSize: "1.05rem" }}>Past imports</h2><button type="button" aria-label="Close import history" onClick={() => setShowImportHistory(false)} style={{ border: 0, background: "transparent", cursor: "pointer", fontSize: "1.25rem" }}>×</button></div>
            {importHistory.length ? (
              <div style={{ overflowX: "auto" }}><table style={{ width: "100%", minWidth: 860, borderCollapse: "collapse", fontSize: "0.82rem" }}><thead><tr>{["Import label", "Created", "Updated", "Skipped", "Errors", "Status", "Imported at", "Contacts"].map((heading) => <th key={heading} style={{ textAlign: "left", padding: "0.7rem", borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{heading}</th>)}</tr></thead><tbody>{importHistory.map((item) => <tr key={item.id}><td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", fontWeight: 600, maxWidth: 260, overflowWrap: "anywhere" }}>{item.fileName}</td><td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)" }}>{item.inserted}</td><td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)" }}>{item.updated}</td><td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)" }}>{item.skipped}</td><td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", color: item.errors ? "var(--danger-color, #dc2626)" : "inherit" }}>{item.errors}</td><td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)" }}><span style={{ color: item.errors ? "#d97706" : "#059669", fontWeight: 600 }}>{item.errors ? "Completed, with errors" : "Completed"}</span></td><td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", whiteSpace: "nowrap" }}>{new Date(item.completedAt).toLocaleString()}</td><td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)" }}><button type="button" className="btn-secondary" disabled={!item.contacts?.length} onClick={() => setContactsImport(item)}>{item.contacts?.length ? "View contacts" : "No contacts"}</button></td></tr>)}</tbody></table></div>
            ) : <p style={{ margin: 0, color: "var(--text-secondary)" }}>No imports completed yet.</p>}
          </div>
        </div>
      )}

      {contactsImport && (
        <div role="dialog" aria-modal="true" aria-labelledby="import-contacts-title" style={{ position: "fixed", inset: 0, zIndex: 1150, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "center", padding: 16 }} onClick={() => setContactsImport(null)}>
          <div className="glass" style={{ width: "min(1000px, 100%)", maxHeight: "85vh", overflow: "auto", padding: 16, background: "var(--surface-color, #fff)", border: "1px solid var(--border-color)", borderRadius: 10 }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><h2 id="import-contacts-title" style={{ margin: 0, fontSize: "1.05rem" }}>Contacts from {contactsImport.fileName}</h2><button type="button" aria-label="Close imported contacts" onClick={() => setContactsImport(null)} style={{ border: 0, background: "transparent", cursor: "pointer", fontSize: "1.25rem" }}>×</button></div>
            <div style={{ overflowX: "auto" }}><table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontSize: "0.82rem" }}><thead><tr>{["Name", "Email", "Phone", "Company", "Title", "Status", "Source"].map((heading) => <th key={heading} style={{ textAlign: "left", padding: "0.7rem", borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)" }}>{heading}</th>)}</tr></thead><tbody>{contactsImport.contacts.map((contact) => <tr key={contact.id}>{[contact.name, contact.email, contact.phone, contact.company, contact.title, contact.status, contact.source].map((value, index) => <td key={index} style={{ padding: "0.7rem", borderBottom: "1px solid var(--border-color)" }}>{value || "—"}</td>)}</tr>)}</tbody></table></div>
          </div>
        </div>
      )}

      {showImport && (
        <ImportModal
          entity={entity}
          label={displayLabel}
          formats={formats}
          forceSync={forceSync}
          templateUrl={templateUrl}
          metaUrl={metaUrl}
          importUrl={importUrl}
          importAsyncUrl={importAsyncUrl}
          jobUrl={jobUrl}
          skipMeta={skipMeta}
          initialExpectedHeaders={expectedHeaders}
          onClose={() => setShowImport(false)}
          genericLeadWizard={genericLeadWizard}
          mappingFields={mappingFields}
          onImported={(result) => {
            if (genericLeadWizard) {
              const latest = { fileName: result.fileName || "Uploaded contacts file", completedAt: new Date().toISOString(), inserted: result.inserted || 0, updated: result.updated || 0, skipped: result.skipped || 0, errors: result.errors?.length || 0, contacts: result.importedContacts || [] };
              setRecentImport(latest);
              setImportHistory((history) => {
                const next = [{ ...latest, id: `${latest.completedAt}-${latest.fileName}` }, ...history].slice(0, 20);
                try { window.sessionStorage.setItem("generic-crm-import-history", JSON.stringify(next)); } catch { /* storage unavailable */ }
                return next;
              });
              try { window.sessionStorage.setItem("generic-crm-latest-import", JSON.stringify(latest)); } catch { /* storage unavailable */ }
            }
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
  forceSync = false,
  formats = ["csv"],
  templateUrl = null,
  metaUrl = null,
  importUrl = null,
  importAsyncUrl = null,
  jobUrl = null,
  skipMeta = false,
  initialExpectedHeaders = [],
  genericLeadWizard = false,
  mappingFields = [],
}) {
  const notify = useNotify();
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [previewRows, setPreviewRows] = useState([]);
  const [previewHeaders, setPreviewHeaders] = useState([]);
  const [mappingSelections, setMappingSelections] = useState({});
  const [previewError, setPreviewError] = useState(null);
  const [thresholds, setThresholds] = useState({ rows: 5000, bytes: 5 * 1024 * 1024 });
  const [expectedHeaders, setExpectedHeaders] = useState(initialExpectedHeaders);
  // Columns the server accepts but doesn't require. Kept separate so the
  // preview only warns about genuinely missing columns.
  const [optionalHeaders, setOptionalHeaders] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [wizardStep, setWizardStep] = useState(genericLeadWizard ? 1 : 2);
  const [genericImportMode, setGenericImportMode] = useState("leads");
  const [dynamicLeadFields, setDynamicLeadFields] = useState([]);
  const [showAddField, setShowAddField] = useState(false);
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [newFieldType, setNewFieldType] = useState("text");
  const [newFieldOptions, setNewFieldOptions] = useState("");
  const [newFieldRequired, setNewFieldRequired] = useState(false);
  const [savingNewField, setSavingNewField] = useState(false);

  const optionFieldTypes = new Set(["dropdown", "radio", "multiselect"]);

  const resetAddField = () => {
    setShowAddField(false);
    setNewFieldLabel("");
    setNewFieldType("text");
    setNewFieldOptions("");
    setNewFieldRequired(false);
  };

  const createField = async () => {
    const labelText = newFieldLabel.trim();
    if (!labelText) {
      notify.error("Label is required");
      return;
    }
    const options = newFieldOptions.split(",").map((option) => option.trim()).filter(Boolean);
    if (optionFieldTypes.has(newFieldType) && !options.length) {
      notify.error("Enter at least one option, separated by commas");
      return;
    }
    setSavingNewField(true);
    try {
      const created = await fetchApi("/api/lead-custom-fields", {
        method: "POST",
        body: JSON.stringify({
          label: labelText,
          fieldType: newFieldType,
          isRequired: newFieldRequired,
          ...(optionFieldTypes.has(newFieldType) ? { options } : {}),
        }),
      });
      const createdField = created?.field || created;
      setDynamicLeadFields((fields) => [...fields, createdField]);
      notify.success("Field created");
      resetAddField();
    } catch (e) {
      notify.error(e?.message || "Failed to create field");
    } finally {
      setSavingNewField(false);
    }
  };

  // Pull entity meta so we can show the column list pre-upload + know the
  // async thresholds.
  useEffect(() => {
    if (skipMeta) return undefined;
    fetchApi(metaUrl || `/api/wellness/csv/${entity}`, { silent: true })
      .then((meta) => {
        setExpectedHeaders(meta.headers || []);
        setOptionalHeaders(meta.optionalHeaders || []);
        if (meta.thresholds) setThresholds(meta.thresholds);
      })
      .catch(() => { /* gate denied - submit will show the real error */ });
  }, [entity, metaUrl, skipMeta]);

  useEffect(() => {
    if (!genericLeadWizard) return undefined;
    fetchApi("/api/lead-custom-fields", { silent: true })
      .then((data) => setDynamicLeadFields(Array.isArray(data) ? data : (data?.fields || data?.customFields || [])))
      .catch(() => setDynamicLeadFields([]));
    return undefined;
  }, [genericLeadWizard]);

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
    setMappingSelections({});
    if (!f) return;
    if (genericLeadWizard) setWizardStep(3);
    // XLSX is binary - we don't ship a SheetJS bundle to the client just for
    // preview. The header + per-row validation still runs server-side on
    // submit, and any errors come back in the result.errors[] envelope.
    const looksXlsx = /\.xlsx$/i.test(f.name || "")
      || f.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      || f.type === "application/vnd.ms-excel";
    if (looksXlsx) {
      // The generic mapping wizard must show the actual workbook columns.
      // Wellness keeps its existing server-side XLSX preview behavior.
      if (!genericLeadWizard) return;
      try {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(await f.arrayBuffer(), { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
        const headers = (rows[0] || []).map((header) => String(header).trim()).filter(Boolean);
        setPreviewHeaders(headers);
        setMappingSelections(Object.fromEntries(headers.map((header) => [header, header])));
        setPreviewRows(rows.slice(1, 11));
      } catch (e) {
        setPreviewError(e.message || "Failed to read Excel file");
      }
      return;
    }
    try {
      const text = await f.text();
      const { headers, rows } = parseCsvClient(text);
      setPreviewHeaders(headers);
      setMappingSelections(Object.fromEntries(headers.map((header) => [header, header])));
      setPreviewRows(rows.slice(0, 10));
      const optional = new Set(optionalHeaders);
      const missing = expectedHeaders.filter((h) => !headers.includes(h) && !optional.has(h));
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
    if (genericLeadWizard) setWizardStep(4);
    setResult(null);
    setJobId(null);

    const tooBig = file.size > thresholds.bytes;
    const tooLong = previewRows.length === 10 && file.size > 100 * 1024; // heuristic; the row count is properly checked server-side

    const useAsync = !forceSync && (tooBig || tooLong);
    const endpoint = useAsync ?
      (importAsyncUrl || `/api/wellness/csv/${entity}/import/async`)
      : (importUrl || `/api/wellness/csv/${entity}/import`);

    try {
      const fd = new FormData();
      fd.append("file", file);
      if (genericLeadWizard) fd.append("mapping", JSON.stringify(mappingSelections));
      const token = getAuthToken();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      const normalizedBody = {
        ...body,
        errors: (body.errors || []).map((error) => ({
          ...error,
          row: error.row ?? error.rowNumber ?? '',
          column: error.column ?? '',
          value: error.value ?? '',
          message: error.message ?? error.reason ?? 'Invalid row',
        })),
      };
      if (!res.ok && res.status !== 202) {
        notify.error(body.error || `Import failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      if (useAsync) {
        setJobId(body.jobId);
        notify.info("Large file queued - you'll be emailed when it finishes.");
      } else {
        const normalizedResult = {
          ...normalizedBody,
          inserted: normalizedBody.inserted ?? normalizedBody.imported ?? 0,
          updated: normalizedBody.updated ?? 0,
          skipped: normalizedBody.skipped ?? 0,
          errors: normalizedBody.errors || [],
        };
        setResult(normalizedResult);

        if (normalizedResult.inserted || normalizedResult.updated) {
          notify.success(
            `Imported: ${normalizedResult.inserted} new, ${normalizedResult.updated} updated${normalizedResult.errors.length
              ? `, ${normalizedResult.errors.length} errors`
              : ""
            }`,
          );
          onImported({ ...normalizedResult, fileName: file.name });
          // Generic lead mapping is a review step, not a separate confirmation
          // step. Close it after the import so the refreshed Leads list is
          // visible immediately.
          if (genericLeadWizard) onClose();
        } else if (normalizedResult.errors.length) {
          notify.error(`Import had ${normalizedResult.errors.length} row error(s).`);
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
        if (j.status === "done" && (j.result.inserted || j.result.updated)) onImported({ ...j.result, fileName: file?.name });
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
          maxWidth: genericLeadWizard ? (wizardStep === 3 ? 920 : 620) : 720,
          width: genericLeadWizard ? `min(${wizardStep === 3 ? 920 : 620}px, 92%)` : "92%",
          maxHeight: "90vh",
          height: genericLeadWizard && wizardStep === 1 ? 540 : undefined,
          overflow: genericLeadWizard && wizardStep === 1 ? "hidden" : "auto",
          padding: "2rem",
          position: "relative",
          background: genericLeadWizard ? "#ffffff" : "var(--surface-color, rgba(250, 246, 237, 0.95))",
          color: "var(--text-primary, inherit)",
          border: "1px solid var(--border-color, rgba(0,0,0,0.1))",
          boxShadow: "var(--shadow-lg, 0 24px 60px rgba(0,0,0,0.25))",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {genericLeadWizard && (
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", marginBottom: "1.5rem", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
            {["File info", "Upload file", "Review mapping", "Finalize import"].map((step, index) => (
              <span key={step} style={{ flex: 1, textAlign: "center", fontWeight: wizardStep === index + 1 ? 700 : 500, color: wizardStep >= index + 1 ? "var(--accent-color)" : "var(--text-secondary)" }}>{step}</span>
            ))}
          </div>
        )}
        {genericLeadWizard && wizardStep === 1 && (
          <div style={{ position: "absolute", inset: 0, zIndex: 5, background: "#ffffff", padding: "5.5rem 2rem 3rem", textAlign: "center", borderRadius: "inherit" }}>
            <h2 style={{ marginTop: 0 }}>Tell us what your file contains</h2>
            <div style={{ display: "flex", justifyContent: "center", gap: "1rem", margin: "2rem 0" }}>
              {["leads", "leadsAccounts"].map((mode) => {
                const selected = genericImportMode === mode;
                return <button key={mode} type="button" onClick={() => setGenericImportMode(mode)} aria-pressed={selected} style={{ width: 210, minHeight: 190, padding: "2rem 1rem", border: `${selected ? 2 : 1}px solid ${selected ? "var(--accent-color)" : "var(--border-color)"}`, borderRadius: 12, background: selected ? "var(--accent-bg)" : "transparent", color: "inherit", cursor: "pointer" }}><FileText size={28} /><h3>{mode === "leads" ? "Leads" : "Leads and accounts"}</h3><p>{mode === "leads" ? "My file has information about people" : "My file has people and their companies"}</p></button>;
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: "0.75rem" }}>
              <button type="button" onClick={onClose} style={secondaryBtnStyle}>Back</button>
              <button type="button" onClick={() => setWizardStep(2)} style={primaryBtnStyle}>Next</button>
            </div>
          </div>
        )}
        {genericLeadWizard && wizardStep === 3 && (
          <div style={{ position: "absolute", inset: 0, zIndex: 5, background: "#ffffff", padding: "1.5rem 2rem 1.5rem", borderRadius: "inherit", boxSizing: "border-box", overflowY: "auto", overflowX: "hidden" }}>
            <h2 style={{ margin: 0, textAlign: "center" }}>Review the mapping of your fields</h2>
            <p style={{ textAlign: "center", color: "var(--text-secondary)", marginBottom: "1.5rem" }}>We've mapped the columns in your file to CRM fields — take a look</p>
            <div style={{ border: "1px solid var(--border-color)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "70px minmax(120px, 1fr) 100px minmax(180px, 1.3fr) minmax(100px, 1fr)", gap: 10, padding: "0.8rem", background: "var(--table-header-bg, #eef2f7)", fontWeight: 700, fontSize: "0.8rem", minWidth: 620 }}><span>Import</span><span>CSV column</span><span>Mapped</span><span>CRM field</span><span>Field type</span></div>
              {(previewHeaders.length ? previewHeaders : expectedHeaders).map((header) => (
                <div key={header} style={{ display: "grid", gridTemplateColumns: "70px minmax(120px, 1fr) 100px minmax(180px, 1.3fr) minmax(100px, 1fr)", gap: 10, alignItems: "center", padding: "0.8rem", borderTop: "1px solid var(--border-color)", fontSize: "0.85rem", minWidth: 620 }}>
                  <input type="checkbox" defaultChecked aria-label={`Import ${header}`} />
                  <strong>{header}</strong>
                  <span style={{ color: "#059669", fontSize: "1.1rem" }}>✓</span>
                  <select className="input-field" value={mappingSelections[header] || header} aria-label={`CRM field for ${header}`} onChange={(event) => { if (event.target.value === "__add_new_field__") { setShowAddField(true); return; } setMappingSelections((current) => ({ ...current, [header]: event.target.value })); }}>
                    <option value={header}>{header === "name" ? "First name" : header === "email" ? "Email (Primary)" : header === "role" ? "Job title" : header}</option>
                    {[...mappingFields, ...dynamicLeadFields].filter((field, index, fields) => fields.findIndex((item) => (item.fieldKey || item.key || item.id) === (field.fieldKey || field.key || field.id)) === index).map((field) => <option key={field.id || field.fieldKey || field.key} value={field.fieldKey || field.key}>{field.label || field.name || field.fieldKey || field.key}</option>)}
                    <option value="__add_new_field__">＋ Add new field</option>
                  </select>
                  <span style={{ color: "var(--text-secondary)" }}>Text field</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: "0.75rem", marginTop: "1.25rem", paddingBottom: "0.5rem" }}><button type="button" onClick={() => setWizardStep(2)} style={secondaryBtnStyle}>Back</button><button type="button" onClick={doImport} disabled={submitting || !file} style={primaryBtnStyle}>{submitting ? "Importing…" : "Import contact"}</button></div>
          </div>
        )}
        {genericLeadWizard && showAddField && (
          <div role="dialog" aria-modal="true" aria-labelledby="add-lead-field-title" style={{ position: "absolute", inset: 0, zIndex: 10, background: "var(--surface-color, #fff)", padding: "5.5rem 2rem 3rem", borderRadius: "inherit" }}>
            <h2 id="add-lead-field-title" style={{ marginTop: 0 }}>Add new field</h2>
            <div style={{ display: "grid", gap: "0.85rem" }}>
              <label>Label *<input className="input-field" value={newFieldLabel} onChange={(event) => setNewFieldLabel(event.target.value)} autoFocus /></label>
              <label>Field type<select className="input-field" value={newFieldType} onChange={(event) => setNewFieldType(event.target.value)}><option value="text">Text</option><option value="textarea">Textarea</option><option value="number">Number</option><option value="date">Date</option><option value="dropdown">Dropdown</option><option value="radio">Radio</option><option value="multiselect">Multi-select</option></select></label>
              {optionFieldTypes.has(newFieldType) && <label>Options *<input className="input-field" placeholder="Option 1, Option 2" value={newFieldOptions} onChange={(event) => setNewFieldOptions(event.target.value)} /></label>}
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><input type="checkbox" checked={newFieldRequired} onChange={(event) => setNewFieldRequired(event.target.checked)} /> Required field</label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}><button type="button" onClick={resetAddField} style={secondaryBtnStyle}>Cancel</button><button type="button" onClick={createField} disabled={savingNewField} style={primaryBtnStyle}>{savingNewField ? "Creating…" : "Create field"}</button></div>
          </div>
        )}
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
          <Download size={20} /> Import {label} from {formats.length > 1 ? "CSV / Excel" : "CSV"}
        </h2>

        <p style={{ color: "var(--text-secondary)", marginBottom: "1rem" }}>
          Upload a {formats.length > 1 ? "CSV or Excel (XLSX) file" : "CSV"} with these columns:{" "}
          <code style={codePillStyle}>{expectedHeaders.join(", ") || "(loading...)"}</code>.
          Extra columns are ignored.
          {forceSync ? (
            ' Imports are processed immediately on this page.'
          ) : (
            <> Files over {Math.round(thresholds.bytes / (1024 * 1024))}MB or {thresholds.rows.toLocaleString()} rows are processed in the background and emailed when done.</>
          )}
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
            <Download size={14} />
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
            Background job <code style={codePillStyle}>{jobId}</code> queued. You will be emailed when it finishes; this dialog will update too.
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1rem" }}>
          {genericLeadWizard && wizardStep > 1 && !result && (
            <button type="button" onClick={() => setWizardStep((step) => Math.max(1, step - 1))} style={secondaryBtnStyle}>
              Back
            </button>
          )}
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

const compactSecondaryBtnStyle = {
  ...secondaryBtnStyle,
  gap: "0.25rem",
  padding: "0.4rem 0.75rem",
  fontSize: "0.8rem",
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


