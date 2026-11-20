import { formatDateTime } from '../../utils/date';
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
import { Upload, Download, X, FileText, AlertTriangle, CheckCircle2, ChevronDown, Eye, EyeOff } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { sanitizeGenericCrmPhoneInput, validateGenericCrmPhone } from "../../utils/genericCrmPhoneValidation";

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

const DROPDOWN_VIEWPORT_GUTTER = 8;
const DROPDOWN_GAP = 4;

const getViewportDropdownPosition = (anchorRef, preferredWidth) => {
  if (typeof window === "undefined" || !anchorRef?.current) return null;
  const rect = anchorRef.current.getBoundingClientRect();
  const viewportWidth = document.documentElement?.clientWidth || window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(
    preferredWidth,
    Math.max(0, viewportWidth - DROPDOWN_VIEWPORT_GUTTER * 2),
  );
  const left = Math.max(
    DROPDOWN_VIEWPORT_GUTTER,
    Math.min(
      rect.right - width,
      viewportWidth - width - DROPDOWN_VIEWPORT_GUTTER,
    ),
  );
  const estimatedHeight = 84;
  const spaceBelow = viewportHeight - rect.bottom - DROPDOWN_GAP - DROPDOWN_VIEWPORT_GUTTER;
  const spaceAbove = rect.top - DROPDOWN_GAP - DROPDOWN_VIEWPORT_GUTTER;
  const openAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;

  return {
    position: "fixed",
    left,
    top: openAbove ? undefined : rect.bottom + DROPDOWN_GAP,
    bottom: openAbove ? viewportHeight - rect.top + DROPDOWN_GAP : undefined,
    width,
    maxWidth: `calc(100vw - ${DROPDOWN_VIEWPORT_GUTTER * 2}px)`,
    boxSizing: "border-box",
  };
};

const modalCloseButtonStyle = {
  width: 38,
  height: 38,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  border: "1px solid rgba(148, 163, 184, 0.45)",
  borderRadius: 10,
  background: "#e5e7eb",
  color: "#1f2937",
  cursor: "pointer",
  padding: 0,
  boxShadow: "0 1px 3px rgba(15, 23, 42, 0.16)",
};

const IMPORT_FIELD_TYPE_OPTIONS = [
  { value: "text", label: "Text field" },
  { value: "textarea", label: "Textarea" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "dropdown", label: "Dropdown" },
  { value: "radio", label: "Radio" },
  { value: "multiselect", label: "Multi-select" },
  { value: "checkbox", label: "Checkbox" },
  { value: "url", label: "URL" },
];

const AUTOMATIC_CRM_FIELD_KEYS = new Set([
  "pageUrl",
  "pageTitle",
  "pageSource",
  "referrerUrl",
  "landingPageUrl",
  "currentDomain",
  "formName",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "fbc",
  "fbp",
  "submittedAt",
  "browser",
  "operatingSystem",
  "deviceType",
  "createdAt",
  "lastUpdated",
  "webForm",
  "actions",
  "campaign",
  "callStatus",
  "callifiedAi",
  "callifiedScore",
]);

const normalizeFieldType = (fieldType) => (
  IMPORT_FIELD_TYPE_OPTIONS.some((option) => option.value === fieldType) ? fieldType : "text"
);

// Keep this in sync with backend/routes/lead_custom_fields.js. Generic lead
// imports create a custom field for an unmapped spreadsheet header, so a
// header such as "12006225923" must be rejected before that API call rather
// than surfacing the backend's less actionable INVALID_FIELD_KEY response.
const canDeriveLeadFieldKey = (label) => {
  const normalizedLabel = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  // These headers are native CRM aliases. If an exact native field is not
  // available in the mapping catalog, leave them unchecked rather than
  // proposing a custom field that would shadow the native import mapping.
  if (["mobile", "mobilenumber", "mobilephone", "workphone", "workmobile", "phonenumber", "jobtitle"].includes(normalizedLabel)) return false;
  const key = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return /^[a-z][a-z0-9_]{0,49}$/.test(key);
};

const normalizeMappingIdentity = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/^cf_/, "")
  .replace(/[^a-z0-9]+/g, "");

const parseCsvReport = (text) => {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value || row.length) {
    row.push(value);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""])));
};

const normalizeImportErrorRows = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const makeStableImportHeaders = (rawHeaders, rows) => {
  const used = new Set();
  return rawHeaders.map((rawHeader, index) => {
    const hasValue = rows.some((cells) => String(cells?.[index] ?? '').trim() !== '');
    const base = String(rawHeader || '').trim() || (hasValue ? `Unnamed: ${index + 1}` : '');
    if (!base) return '';
    let header = base;
    let suffix = 2;
    while (used.has(header)) header = `${base} (${suffix++})`;
    used.add(header);
    return header;
  });
};

const buildAvailableMappingFields = (mappingFields, dynamicLeadFields, includeAutomaticFields = false) => {
  const fields = [
    // Built-in tracking columns are system-populated and are not valid CSV
    // import destinations. Tenant-defined lead fields are different: even if
    // an admin gave one an automatic-looking key such as "utm_term", it is a
    // real LeadCustomFieldDefinition and must remain selectable so imports can
    // reuse it instead of trying to create a duplicate field.
    ...(includeAutomaticFields
      ? mappingFields
      : mappingFields.filter((field) => !AUTOMATIC_CRM_FIELD_KEYS.has(field.fieldKey || field.key || field.id))),
    ...dynamicLeadFields,
  ];
  const byIdentity = new Map();
  fields.forEach((field) => {
    const rawIdentity = field.fieldKey || field.key || field.id;
    const identity = String(rawIdentity).replace(/^cf_/, "");
    if (!identity) return;
    const existing = byIdentity.get(identity);
    // The live custom-field response contains the authoritative field type.
    // Keep catalog labels/keys, but let that response fill or replace stale
    // metadata instead of allowing a catalog fallback of `text` to win.
    byIdentity.set(identity, existing
      ? {
          ...existing,
          ...field,
          fieldKey: existing.fieldKey || field.fieldKey,
          key: existing.key || field.key,
          fieldType: field.fieldType || existing.fieldType,
        }
      : field);
  });
  return [...byIdentity.values()];
};

const findAvailableMappingField = (fields, value) => {
  const normalized = normalizeMappingIdentity(value);
  if (!normalized) return null;
  const canonicalAliases = {
    mobile: "phone",
    mobilenumber: "phone",
    mobilephone: "phone",
    workphone: "phone",
    workmobile: "phone",
    phonenumber: "phone",
    jobtitle: "title",
  };
  const canonicalKey = canonicalAliases[normalized];
  if (canonicalKey) {
    const canonicalField = fields.find(
      (field) => normalizeMappingIdentity(field.fieldKey || field.key || field.id) === canonicalKey,
    );
    if (canonicalField) return canonicalField;
  }
  return fields.find((field) => {
    const key = normalizeMappingIdentity(field.fieldKey || field.key || field.id);
    const label = normalizeMappingIdentity(field.label || field.name || field.fieldKey || field.key);
    return key === normalized || label === normalized;
  }) || null;
};

const findExactMappingField = (fields, value) => {
  const normalized = normalizeMappingIdentity(value);
  if (!normalized) return null;
  return fields.find((field) => (
    normalizeMappingIdentity(field.fieldKey || field.key || field.id) === normalized
      || normalizeMappingIdentity(field.label || field.name || field.fieldKey || field.key) === normalized
  )) || null;
};

const getMappingFieldLabel = (field) => String(field?.label || field?.name || field?.fieldKey || field?.key || field?.id || "");

function SearchableMappingFieldSelect({ value, options, onChange, ariaLabel, title, triggerLabel = "", highlightEmpty = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);
  const selected = options.find((field) => (field.fieldKey || field.key || field.id) === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = options.filter((field) => {
    if (!normalizedQuery) return true;
    const key = String(field.fieldKey || field.key || field.id || "").toLowerCase();
    return getMappingFieldLabel(field).toLowerCase().includes(normalizedQuery) || key.includes(normalizedQuery);
  });
  const emptyLabel = triggerLabel ? "Choose CRM field" : "Select CRM field";

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  const choose = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={rootRef} data-proposed-field={triggerLabel ? "true" : undefined} style={{ position: "relative", minWidth: 0 }}>
      <select
        value={value}
        aria-label={ariaLabel}
        onChange={(event) => choose(event.target.value)}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        tabIndex={-1}
      >
        <option value="">{emptyLabel}</option>
        <option value="__add_new_field__">＋ Add new field</option>
        {options.map((field) => <option key={field.id || field.fieldKey || field.key} value={field.fieldKey || field.key}>{getMappingFieldLabel(field)}</option>)}
      </select>
      <button
        type="button"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={{ width: "100%", height: 36, minHeight: 0, padding: "0.4rem 0.65rem", border: `1px solid ${highlightEmpty && !value ? "var(--accent-color)" : "var(--border-color)"}`, borderRadius: 8, background: highlightEmpty && !value ? "var(--accent-bg, #eef2ff)" : "#fff", color: "inherit", font: "inherit", fontWeight: highlightEmpty && !value ? 600 : "inherit", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, cursor: "pointer" }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{triggerLabel || getMappingFieldLabel(selected) || emptyLabel}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div role="listbox" aria-label={`${ariaLabel} options`} style={{ position: "absolute", zIndex: 100, top: "calc(100% + 4px)", left: 0, right: 0, minWidth: 220, maxHeight: 280, overflowY: "auto", padding: 6, border: "1px solid var(--border-color)", borderRadius: 8, background: "#fff", opacity: 1, boxShadow: "0 12px 28px rgba(0,0,0,.18)" }}>
          <input
            type="search"
            autoFocus
            className="input-field"
            placeholder="Search fields"
            aria-label={`${ariaLabel} search`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ width: "100%", boxSizing: "border-box", marginBottom: 6, minHeight: 32, height: 32 }}
          />
          <button type="button" role="option" aria-selected={!value} onClick={() => choose("")} style={{ width: "100%", padding: "0.45rem 0.5rem", border: 0, background: !value ? "var(--accent-bg, #eef2ff)" : "transparent", color: "inherit", textAlign: "left", cursor: "pointer" }}>{emptyLabel}</button>
          <button type="button" role="option" aria-selected={value === "__add_new_field__"} onClick={() => choose("__add_new_field__")} style={{ width: "100%", padding: "0.45rem 0.5rem", border: 0, background: value === "__add_new_field__" ? "var(--accent-bg, #eef2ff)" : "transparent", color: "inherit", textAlign: "left", cursor: "pointer" }}>＋ Add new field</button>
          {filteredOptions.map((field) => {
            const fieldValue = field.fieldKey || field.key || field.id;
            return <button key={field.id || fieldValue} type="button" role="option" aria-selected={fieldValue === value} onClick={() => choose(fieldValue)} style={{ width: "100%", padding: "0.45rem 0.5rem", border: 0, background: fieldValue === value ? "var(--accent-bg, #eef2ff)" : "transparent", color: "inherit", textAlign: "left", cursor: "pointer" }}>{getMappingFieldLabel(field)}</button>;
          })}
          {!filteredOptions.length && <div style={{ padding: "0.5rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>No CRM fields found</div>}
        </div>
      )}
    </div>
  );
}

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
  genericCrm = false,
  mappingFields = [],
  combinedMenu = false,
}) {
  const notify = useNotify();
  const [exporting, setExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [exportMenuPos, setExportMenuPos] = useState(null);
  const [importMenuPos, setImportMenuPos] = useState(null);
  const [recentImport, setRecentImport] = useState(() => {
    if (typeof window === "undefined") return null;
    try { return JSON.parse(window.sessionStorage.getItem("generic-crm-latest-import") || "null"); } catch { return null; }
  });
  const [showRecentImport, setShowRecentImport] = useState(false);
  const [showImportHistory, setShowImportHistory] = useState(false);
  const [contactsImport, setContactsImport] = useState(null);
  const [errorsImport, setErrorsImport] = useState(null);
  const [actionImport, setActionImport] = useState(null);
  const [importHistory, setImportHistory] = useState(() => {
    return [];
  });
  const exportMenuRef = useRef(null);
  const importMenuRef = useRef(null);
  const exportMenuContentRef = useRef(null);
  const importMenuContentRef = useRef(null);
  const displayLabel = label || ENTITY_LABELS[entity] || entity;
  const safeEndpoints = endpoints || {};
  const toolbarButtonStyle = compact ? compactSecondaryBtnStyle : secondaryBtnStyle;

  useEffect(() => {
    if (!genericLeadWizard) return;
    fetchApi("/api/csv/contacts/import-history", { silent: true })
      .then((rows) => setImportHistory(Array.isArray(rows) ? rows : []))
      .catch(() => setImportHistory([]));
  }, [genericLeadWizard]);

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

  const downloadImportReport = async (item, format, scope = "successful") => {
    try {
      const token = getAuthToken();
      const response = await fetch(`/api/csv/contacts/import-history/${item.id}/report?format=${format}&scope=${scope}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error("Failed to download import report");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${String(item.fileName || "import").replace(/\.[^.]+$/, "")}-${scope === "successful" ? "created-updated" : "import-report"}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      notify.error(error?.message || "Failed to download import report");
    }
  };

  const viewImportErrors = async (item) => {
    try {
      const token = getAuthToken();
      const response = await fetch(`/api/csv/contacts/import-history/${item.id}/report?format=csv`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error("Failed to load import errors");
      setErrorsImport({ fileName: item.fileName, rows: parseCsvReport(await response.text()) });
    } catch (error) {
      notify.error(error?.message || "Failed to load import errors");
    }
  };

  const viewImportAction = (item, action) => {
    const contacts = item.contacts || [];
    const hasActionDetails = contacts.some((contact) => contact.action);
    const actionCount = action === "created" ? item.inserted : action === "updated" ? item.updated : item[action];
    const errorRows = normalizeImportErrorRows(item.errorRows);
    const storedRows = action === "skipped" || action === "errors"
      ? errorRows.map((row) => ({ ...row.data, rowNumber: row.rowNumber, field: row.field || "row", reason: row.reason || "Import failed", action: action === "errors" ? "error" : "skipped" }))
      : (hasActionDetails ? contacts : []).filter((contact) => contact.action === action);
    const rows = storedRows.length || !actionCount ? storedRows : [{
      rowNumber: "—",
      field: "Unavailable",
      reason: `${actionCount} ${action} record(s) from this older import do not have stored row details.`,
      action,
    }];
    setActionImport({ fileName: item.fileName, action, rows, expectedCount: actionCount });
  };

  const doExport = async (format = "csv") => {
    setExporting(true);
    setExportMenuOpen(false);
    setExportMenuPos(null);
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
    const anchor = combinedMenu ? importMenuRef : exportMenuRef;
    const recompute = () => {
      setExportMenuPos(getViewportDropdownPosition(anchor, 180));
    };
    recompute();
    const onDocClick = (e) => {
      if (
        anchor.current &&
        !anchor.current.contains(e.target) &&
        !exportMenuContentRef.current?.contains(e.target)
      ) {
        setExportMenuOpen(false);
        setExportMenuPos(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [exportMenuOpen, combinedMenu]);

  useEffect(() => {
    if (!importMenuOpen) return undefined;
    const recompute = () => {
      setImportMenuPos(getViewportDropdownPosition(importMenuRef, 220));
    };
    recompute();
    const onDocClick = (event) => {
      if (
        importMenuRef.current &&
        !importMenuRef.current.contains(event.target) &&
        !importMenuContentRef.current?.contains(event.target)
      ) {
        setImportMenuOpen(false);
        setImportMenuPos(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [importMenuOpen]);

  const toggleExportMenu = () => {
    if (exportMenuOpen) {
      setExportMenuOpen(false);
      setExportMenuPos(null);
      return;
    }
    setImportMenuOpen(false);
    setImportMenuPos(null);
    setExportMenuPos(getViewportDropdownPosition(exportMenuRef, 180));
    setExportMenuOpen(true);
  };

  const toggleImportMenu = () => {
    if (importMenuOpen) {
      setImportMenuOpen(false);
      setImportMenuPos(null);
      return;
    }
    setExportMenuOpen(false);
    setExportMenuPos(null);
    setImportMenuPos(getViewportDropdownPosition(importMenuRef, 220));
    setImportMenuOpen(true);
  };

  const actionEye = (item, action, label) => (
    <button type="button" aria-label={`View ${label} import data`} title={`View ${label} import data`} disabled={!(action === "created" ? item.inserted : action === "updated" ? item.updated : item[action])} onClick={() => viewImportAction(item, action)} style={{ border: 0, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", padding: 2, verticalAlign: "middle", opacity: (action === "created" ? item.inserted : action === "updated" ? item.updated : item[action]) ? 1 : 0.35 }}>
      <Eye size={14} aria-hidden="true" />
    </button>
  );

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
        {combinedMenu && (allowImport || showExport) && <div ref={importMenuRef}><button type="button" className="btn-secondary" style={toolbarButtonStyle} aria-label="Import & export" aria-haspopup="menu" aria-expanded={importMenuOpen} onClick={toggleImportMenu}><Upload size={14} /> Import & export <ChevronDown size={12} /></button></div>}
        {!combinedMenu && (showExport && multiFormat ? (
          <div ref={exportMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={toggleExportMenu}
              disabled={exporting}
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              aria-label={`Export ${displayLabel}`}
              style={toolbarButtonStyle}
            >
              <Upload size={14} /> {exporting ? "Exporting..." : "Export"}
              <ChevronDown size={12} style={{ marginLeft: "0.15rem" }} />
            </button>
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
        ) : null)}
        {!combinedMenu && (allowImport && genericLeadWizard ? (
          <div ref={importMenuRef} style={{ position: "relative", display: "inline-flex" }}>
            <button type="button" onClick={() => { setImportMenuOpen(false); setImportMenuPos(null); setShowImport(true); }} aria-label={`Import ${displayLabel}`} style={{ ...toolbarButtonStyle, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
              <Download size={14} /> Import {displayLabel}
            </button>
            <button type="button" onClick={toggleImportMenu} aria-label={`Import ${displayLabel} options`} aria-haspopup="menu" aria-expanded={importMenuOpen} style={{ ...toolbarButtonStyle, borderLeft: "1px solid var(--border-color)", borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingLeft: "0.45rem", paddingRight: "0.45rem" }}>
              <ChevronDown size={13} />
            </button>
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
        ) : null)}
      </div>

      {exportMenuOpen && exportMenuPos && createPortal(
        <div
          ref={exportMenuContentRef}
          role="menu"
          aria-label={`Export ${displayLabel} format`}
          style={{ ...dropdownMenuStyle, ...exportMenuPos, zIndex: 1200 }}
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
        </div>,
        document.body,
      )}

      {importMenuOpen && importMenuPos && createPortal(
        <div
          ref={importMenuContentRef}
          role="menu"
          aria-label={combinedMenu ? 'Import & export actions' : `Import ${displayLabel} options`}
          style={{ ...dropdownMenuStyle, ...importMenuPos, zIndex: 1200 }}
        >
          {combinedMenu && allowImport && <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); setShowImport(true); }} style={dropdownItemStyle}><Download size={14} /> Import contacts</button>}
          {combinedMenu && showExport && <button type="button" role="menuitem" disabled={exporting} onClick={() => { setImportMenuOpen(false); setExportMenuPos(getViewportDropdownPosition(importMenuRef, 180)); setExportMenuOpen(true); }} style={dropdownItemStyle}><Upload size={14} /> Export leads</button>}
          <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); setImportMenuPos(null); setShowRecentImport(true); }} style={dropdownItemStyle}><Eye size={14} aria-hidden="true" /> View recent import status</button>
          <button type="button" role="menuitem" onClick={() => { setImportMenuOpen(false); setImportMenuPos(null); setShowImportHistory(true); }} style={dropdownItemStyle}><Eye size={14} aria-hidden="true" /> View import history</button>
        </div>,
        document.body,
      )}

      {showRecentImport && (
        <div role="dialog" aria-modal="true" aria-labelledby="recent-import-title" style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(15, 23, 42, 0.58)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "grid", placeItems: "center", padding: 16 }} onClick={() => setShowRecentImport(false)}>
          <div className="glass" style={{ width: "min(380px, 100%)", padding: 16, background: "var(--modal-bg, #fff)", opacity: 1, backdropFilter: "none", WebkitBackdropFilter: "none", border: "1px solid var(--border-color)", borderRadius: 10, boxShadow: "var(--shadow-lg, 0 18px 45px rgba(0,0,0,.2))" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><h2 id="recent-import-title" style={{ margin: 0, fontSize: "1rem" }}>Your recent import</h2><button type="button" aria-label="Close recent import" onClick={() => setShowRecentImport(false)} style={modalCloseButtonStyle}><X size={18} strokeWidth={2.25} aria-hidden="true" /></button></div>
            {recentImport ? (
              <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 14 }}>
                <strong style={{ display: "block", marginBottom: 10, overflowWrap: "anywhere" }}>{recentImport.fileName}</strong>
                <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginBottom: 12 }}>{formatDateTime(recentImport.completedAt)}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, textAlign: "center" }}>{[["Created", recentImport.inserted], ["Updated", recentImport.updated], ["Skipped", recentImport.skipped], ["Errors", recentImport.errors]].map(([labelText, value]) => <div key={labelText}><div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{labelText}</div><strong>{value}</strong></div>)}</div>
              </div>
            ) : <p style={{ margin: 0, color: "var(--text-secondary)" }}>No imports completed yet.</p>}
          </div>
        </div>
      )}

      {showImportHistory && (
        <div role="dialog" aria-modal="true" aria-labelledby="import-history-title" style={{ position: "fixed", inset: 0, zIndex: 1100, background: genericCrm ? "rgba(0, 0, 0, 0.6)" : "rgba(15, 23, 42, 0.58)", opacity: 1, backdropFilter: genericCrm ? "blur(8px)" : "blur(6px)", WebkitBackdropFilter: genericCrm ? "blur(8px)" : "blur(6px)", display: "grid", placeItems: "center", padding: 16, ...(genericCrm ? { boxSizing: "border-box", overflow: "hidden", isolation: "isolate" } : {}) }} onClick={() => setShowImportHistory(false)}>
          <div className="glass" style={{ width: "min(1500px, calc(100vw - 32px))", maxHeight: "90vh", overflow: genericCrm ? "hidden" : "auto", padding: 20, background: genericCrm ? "#fff" : "var(--modal-bg, #fff)", opacity: 1, backdropFilter: "none", WebkitBackdropFilter: "none", border: "1px solid var(--border-color)", borderRadius: 10, boxShadow: "var(--shadow-lg, 0 18px 45px rgba(0,0,0,.2))", ...(genericCrm ? { boxSizing: "border-box", height: "calc(100% - 32px)", maxHeight: "calc(100% - 32px)", display: "flex", flexDirection: "column" } : {}) }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, ...(genericCrm ? { flex: "0 0 auto" } : {}) }}><h2 id="import-history-title" style={{ margin: 0, fontSize: "1.05rem" }}>Past imports</h2><button type="button" aria-label="Close import history" onClick={() => setShowImportHistory(false)} style={modalCloseButtonStyle}><X size={18} strokeWidth={2.25} aria-hidden="true" /></button></div>
            {importHistory.length ? (
              <div style={{ overflowX: "auto", ...(genericCrm ? { overflowY: "auto", flex: "1 1 auto", minHeight: 0 } : {}) }}>
                <table style={{ width: "100%", minWidth: 1280, borderCollapse: "collapse", fontSize: "0.82rem" }}>
                  <thead><tr>{["Import label", "Created", "Updated", "Skipped", "Errors", "Status", "Imported at", "Contacts"].map((heading) => <th key={heading} style={{ textAlign: "left", padding: "0.7rem", borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)", whiteSpace: "nowrap", ...(heading === "Contacts" ? { position: "sticky", right: 0, zIndex: 2, minWidth: 280, background: genericCrm ? "#fff" : "var(--modal-bg, #fff)" } : {}) }}>{heading}</th>)}</tr></thead>
                  <tbody>{importHistory.map((item) => <tr key={item.id}>
                    <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", fontWeight: 600, minWidth: 180, maxWidth: 280, overflowWrap: "anywhere" }}><div>{item.fileName}</div>{(Number(item.inserted || 0) + Number(item.updated || 0)) > 0 && <button type="button" className="btn-secondary" title="Download created and updated records" aria-label={`Download created and updated records from ${item.fileName}`} onClick={() => downloadImportReport(item, "csv")} style={{ marginTop: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, minWidth: 112, padding: "0.45rem 0.7rem" }}><Download size={14} /> Download</button>}</td>
                    <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", whiteSpace: "nowrap" }}>{item.inserted} {actionEye(item, "created", "created")}</td>
                    <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", whiteSpace: "nowrap" }}>{item.updated} {actionEye(item, "updated", "updated")}</td>
                    <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", whiteSpace: "nowrap" }}>{item.skipped} {actionEye(item, "skipped", "skipped")}</td>
                    <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", color: item.errors ? "var(--danger-color, #dc2626)" : "inherit", whiteSpace: "nowrap" }}>{item.errors} {actionEye(item, "errors", "error")}</td>
                    <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", minWidth: 150 }}><span style={{ color: item.errors ? "#d97706" : "#059669", fontWeight: 600 }}>{item.errors ? "Completed, with errors" : "Completed"}</span></td>
                    <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", whiteSpace: "nowrap", minWidth: 190 }}>{formatDateTime(item.completedAt)}</td>
                    <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", minWidth: 140, whiteSpace: "nowrap", position: "sticky", right: 0, zIndex: 1, background: "var(--modal-bg, #fff)", boxShadow: "-8px 0 12px -12px rgba(15, 23, 42, 0.45)" }}><button type="button" className="btn-secondary" disabled={!item.contacts?.length} onClick={() => setContactsImport(item)}>{item.contacts?.length ? "View contacts" : "No contacts"}</button></td>
                  </tr>)}</tbody>
                </table>
              </div>
            ) : <p style={{ margin: 0, color: "var(--text-secondary)" }}>No imports completed yet.</p>}
          </div>
        </div>
      )}

      {contactsImport && (
        <div role="dialog" aria-modal="true" aria-labelledby="import-contacts-title" style={{ position: "fixed", inset: 0, zIndex: 1150, background: "rgba(15, 23, 42, 0.58)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "grid", placeItems: "center", padding: 16, ...(genericCrm ? { boxSizing: "border-box", overflow: "hidden" } : {}) }} onClick={() => setContactsImport(null)}>
          <div className="glass" style={{ width: "min(1000px, 100%)", maxHeight: "85vh", overflow: genericCrm ? "hidden" : "auto", padding: 16, background: "var(--modal-bg, #fff)", opacity: 1, backdropFilter: "none", WebkitBackdropFilter: "none", border: "1px solid var(--border-color)", borderRadius: 10, ...(genericCrm ? { boxSizing: "border-box", height: "calc(100% - 32px)", maxHeight: "calc(100% - 32px)", display: "flex", flexDirection: "column" } : {}) }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><h2 id="import-contacts-title" style={{ margin: 0, fontSize: "1.05rem" }}>Contacts from {contactsImport.fileName}</h2><button type="button" aria-label="Close imported contacts" onClick={() => setContactsImport(null)} style={modalCloseButtonStyle}><X size={18} strokeWidth={2.25} aria-hidden="true" /></button></div>
            <div style={{ overflowX: "auto", ...(genericCrm ? { overflowY: "auto", flex: "1 1 auto", minHeight: 0 } : {}) }}><table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontSize: "0.82rem" }}><thead><tr>{["Name", "Email", "Phone", "Company", "Title", "Status", "Source"].map((heading) => <th key={heading} style={{ textAlign: "left", padding: "0.7rem", borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)" }}>{heading}</th>)}</tr></thead><tbody>{contactsImport.contacts.map((contact) => <tr key={contact.id}>{[contact.name, contact.email, contact.phone, contact.company, contact.title, contact.status, contact.source].map((value, index) => <td key={index} style={{ padding: "0.7rem", borderBottom: "1px solid var(--border-color)" }}>{value || "—"}</td>)}</tr>)}</tbody></table></div>
          </div>
        </div>
      )}

      {actionImport && (
        <div role="dialog" aria-modal="true" aria-labelledby="import-action-title" style={{ position: "fixed", inset: 0, zIndex: 1150, background: "rgba(15, 23, 42, 0.58)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "grid", placeItems: "center", padding: 16, ...(genericCrm ? { boxSizing: "border-box", overflow: "hidden" } : {}) }} onClick={() => setActionImport(null)}>
          <div className="glass" style={{ width: "min(1200px, 100%)", maxHeight: "85vh", overflow: genericCrm ? "hidden" : "auto", padding: 16, background: "var(--modal-bg, #fff)", opacity: 1, backdropFilter: "none", WebkitBackdropFilter: "none", border: "1px solid var(--border-color)", borderRadius: 10, ...(genericCrm ? { boxSizing: "border-box", height: "calc(100% - 32px)", maxHeight: "calc(100% - 32px)", display: "flex", flexDirection: "column" } : {}) }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><h2 id="import-action-title" style={{ margin: 0, fontSize: "1.05rem" }}>{actionImport.action === "errors" ? "Errors" : `${actionImport.action[0].toUpperCase()}${actionImport.action.slice(1)} records`} from {actionImport.fileName}</h2><button type="button" aria-label="Close import action data" onClick={() => setActionImport(null)} style={modalCloseButtonStyle}><X size={18} strokeWidth={2.25} aria-hidden="true" /></button></div>
            {actionImport.rows.length ? <div style={{ overflowX: "auto", maxWidth: "100%", ...(genericCrm ? { overflowY: "auto", flex: "1 1 auto", minHeight: 0 } : {}) }}><table className="csv-import-data-table" style={{ width: "max-content", minWidth: "100%", tableLayout: "auto", borderCollapse: "collapse", fontSize: "0.82rem" }}><thead><tr>{Object.keys(actionImport.rows[0]).map((heading) => <th key={heading} style={{ textAlign: "left", padding: "0.7rem", borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)", whiteSpace: "nowrap", minWidth: heading === "reason" ? 260 : 120 }}>{heading}</th>)}</tr></thead><tbody>{actionImport.rows.map((row, index) => <tr key={`${row.id || row.rowNumber || "row"}-${index}`} style={{ color: actionImport.action === "skipped" || actionImport.action === "errors" ? "#dc2626" : actionImport.action === "updated" ? "#b45309" : "inherit" }}>{Object.keys(actionImport.rows[0]).map((heading) => <td key={heading} style={{ padding: "0.7rem", borderBottom: "1px solid var(--border-color)", verticalAlign: "top", whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: heading === "reason" ? 260 : 120 }}>{row[heading] || "—"}</td>)}</tr>)}</tbody></table></div> : <p style={{ margin: 0, color: "var(--text-secondary)" }}>{actionImport.expectedCount ? "Detailed row data was not stored for this older import." : "No records in this category."}</p>}
          </div>
        </div>
      )}

      {errorsImport && (
        <div role="dialog" aria-modal="true" aria-labelledby="import-errors-title" style={{ position: "fixed", inset: 0, zIndex: 1150, background: "rgba(15, 23, 42, 0.58)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "grid", placeItems: "center", padding: 16, ...(genericCrm ? { boxSizing: "border-box", overflow: "hidden" } : {}) }} onClick={() => setErrorsImport(null)}>
          <div className="glass" style={{ width: "min(1200px, 100%)", maxHeight: "85vh", overflow: genericCrm ? "hidden" : "auto", padding: 16, background: "var(--modal-bg, #fff)", opacity: 1, backdropFilter: "none", WebkitBackdropFilter: "none", border: "1px solid var(--border-color)", borderRadius: 10, ...(genericCrm ? { boxSizing: "border-box", height: "calc(100% - 32px)", maxHeight: "calc(100% - 32px)", display: "flex", flexDirection: "column" } : {}) }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><h2 id="import-errors-title" style={{ margin: 0, fontSize: "1.05rem" }}>Import errors from {errorsImport.fileName}</h2><button type="button" aria-label="Close import errors" onClick={() => setErrorsImport(null)} style={modalCloseButtonStyle}><X size={18} strokeWidth={2.25} aria-hidden="true" /></button></div>
            {errorsImport.rows.length ? <div style={{ overflowX: "auto", maxWidth: "100%", ...(genericCrm ? { overflowY: "auto", flex: "1 1 auto", minHeight: 0 } : {}) }}><table className="csv-import-data-table" style={{ width: "max-content", minWidth: "100%", tableLayout: "auto", borderCollapse: "collapse", fontSize: "0.82rem" }}><thead><tr>{Object.keys(errorsImport.rows[0]).map((heading) => <th key={heading} style={{ textAlign: "left", padding: "0.7rem", borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)", whiteSpace: "nowrap", minWidth: heading === "reason" ? 260 : 120 }}>{heading}</th>)}</tr></thead><tbody>{errorsImport.rows.map((row, index) => <tr key={`${row.rowNumber || "row"}-${index}`}>{Object.keys(errorsImport.rows[0]).map((heading) => <td key={heading} style={{ padding: "0.7rem", borderBottom: "1px solid var(--border-color)", verticalAlign: "top", whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: heading === "reason" ? 260 : 120 }}>{row[heading] || "—"}</td>)}</tr>)}</tbody></table></div> : <p style={{ margin: 0, color: "var(--text-secondary)" }}>No error details were recorded for this import.</p>}
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
          refreshImportHistory={() => fetchApi("/api/csv/contacts/import-history", { silent: true })
            .then((rows) => setImportHistory(Array.isArray(rows) ? rows : []))
            .catch(() => {})}
          onImported={(result) => {
            if (genericLeadWizard) {
              const latest = { fileName: result.fileName || "Uploaded contacts file", completedAt: new Date().toISOString(), inserted: result.inserted || 0, updated: result.updated || 0, skipped: result.skipped || 0, errors: result.errors?.length || 0, contacts: result.importedContacts || [] };
              setRecentImport(latest);
              setImportHistory((history) => {
                const next = [{ ...latest, id: `${latest.completedAt}-${latest.fileName}` }, ...history].slice(0, 20);
                return next;
              });
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
  refreshImportHistory = null,
}) {
  const notify = useNotify();
  const fileInputRef = useRef(null);
  // Retain all parsed values for option inference; the ten-row preview is
  // presentation only and must not define the imported field's option set.
  const importRowsRef = useRef([]);
  const [file, setFile] = useState(null);
  const [previewRows, setPreviewRows] = useState([]);
  const [previewHeaders, setPreviewHeaders] = useState([]);
  const [excludedHeaders, setExcludedHeaders] = useState([]);
  const [mappingSelections, setMappingSelections] = useState({});
  const [mappingFieldTypes, setMappingFieldTypes] = useState({});
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
  const [staffMembers, setStaffMembers] = useState([]);
  const [staffLoaded, setStaffLoaded] = useState(false);
  const [showAddField, setShowAddField] = useState(false);
  const [addingFieldFor, setAddingFieldFor] = useState("");
  const [fieldEditorMode, setFieldEditorMode] = useState("add");
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [newFieldType, setNewFieldType] = useState("text");
  const [newFieldOptions, setNewFieldOptions] = useState("");
  const [newFieldRequired, setNewFieldRequired] = useState(false);
  const [savingNewField, setSavingNewField] = useState(false);
  const [showOwnerWarning, setShowOwnerWarning] = useState(false);
  const [showInlineStaffModal, setShowInlineStaffModal] = useState(false);
  const [showInlineStaffPassword, setShowInlineStaffPassword] = useState(false);
  const [inlineStaffSaving, setInlineStaffSaving] = useState(false);
  const [inlineStaffRoles, setInlineStaffRoles] = useState([]);
  const [inlineStaffDraft, setInlineStaffDraft] = useState({
    name: "",
    email: "",
    password: "",
    jobTitle: "",
    workNumber: "",
    mobileNumber: "",
    reportingTo: "",
    rbacRoleId: "",
  });

  const optionFieldTypes = new Set(["dropdown", "radio", "multiselect"]);
  const displayedPreviewHeaders = previewHeaders.length ? previewHeaders : expectedHeaders;
  const visibleDataPreviewHeaders = genericLeadWizard
    ? previewHeaders.filter((header) => !excludedHeaders.includes(header))
    : previewHeaders;

  const availableMappingFields = buildAvailableMappingFields(mappingFields, dynamicLeadFields, genericLeadWizard);
  const sortedMappingFields = [...availableMappingFields].sort((left, right) => (
    getMappingFieldLabel(left).localeCompare(getMappingFieldLabel(right), undefined, { sensitivity: "base" })
  ));

  const findMappingField = (value) => {
    return findAvailableMappingField(availableMappingFields, value);
  };

  const initializeMapping = (headers) => {
    const selections = {};
    const types = {};
    const unmatched = [];
    headers.forEach((header) => {
      const field = genericLeadWizard ? findExactMappingField(availableMappingFields, header) : findMappingField(header);
      if (!field) {
        if (genericLeadWizard) unmatched.push(header);
        return;
      }
      const key = field.fieldKey || field.key || field.id;
      selections[header] = key;
      types[header] = normalizeFieldType(field.fieldType);
    });
    setMappingSelections(selections);
    setMappingFieldTypes(types);
    // Unmapped columns are opt-in: keep them visible for review, but do not
    // import them until the user maps them to a CRM field.
    if (genericLeadWizard) setExcludedHeaders(unmatched);
  };

  const openAddFieldFor = (header, mode = "add") => {
    setAddingFieldFor(header);
    setFieldEditorMode(mode);
    setNewFieldLabel(header);
    setShowAddField(true);
  };

  const updateMappingFor = (header, value) => {
    if (value === "__add_new_field__") {
      openAddFieldFor(header, "add");
      return;
    }
    const selectedField = availableMappingFields.find(
      (field) => (field.fieldKey || field.key || field.id) === value,
    );
    setMappingSelections((current) => ({ ...current, [header]: value }));
    if (genericLeadWizard && value) {
      setExcludedHeaders((current) => current.filter((item) => item !== header));
    }
    setMappingFieldTypes((current) => ({
      ...current,
      [header]: normalizeFieldType(selectedField?.fieldType || current[header]),
    }));
  };

  const resetAddField = () => {
    setShowAddField(false);
    setAddingFieldFor("");
    setFieldEditorMode("add");
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
      if (addingFieldFor) {
        setMappingSelections((current) => ({ ...current, [addingFieldFor]: createdField.fieldKey || createdField.key || createdField.id }));
        setMappingFieldTypes((current) => ({ ...current, [addingFieldFor]: normalizeFieldType(createdField.fieldType || newFieldType) }));
      }
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

  useEffect(() => {
    if (!genericLeadWizard) return undefined;
    setStaffLoaded(false);
    fetchApi("/api/staff", { silent: true })
      .then((data) => setStaffMembers(Array.isArray(data) ? data : []))
      .catch(() => setStaffMembers([]))
      .finally(() => setStaffLoaded(true));
    return undefined;
  }, [genericLeadWizard]);

  const unmatchedSalesOwners = (() => {
    if (!genericLeadWizard || !previewHeaders.length || !staffLoaded) return [];
    const ownerHeader = previewHeaders.find((header) => {
      const target = mappingSelections[header];
      return target === "assignedTo";
    });
    if (!ownerHeader) return [];
    const knownOwners = new Set(
      staffMembers.flatMap((member) => [member.id, member.email, member.name]
        .filter((value) => value !== null && value !== undefined && String(value).trim() !== "")
        .map((value) => normalizeMappingIdentity(value))),
    );
    return [...new Set(importRowsRef.current
      .map((row) => String(row?.[ownerHeader] ?? "").trim())
      .filter(Boolean)
      .filter((value) => !knownOwners.has(normalizeMappingIdentity(value))))];
  })();

  const openInlineStaffModal = async () => {
    setShowInlineStaffPassword(false);
    setInlineStaffDraft({
      name: unmatchedSalesOwners[0] || "",
      email: "",
      password: "",
      jobTitle: "",
      workNumber: "",
      mobileNumber: "",
      reportingTo: "",
      rbacRoleId: "",
    });
    setShowInlineStaffModal(true);
    try {
      const response = await fetchApi("/api/roles", { silent: true });
      const roles = Array.isArray(response?.roles)
        ? response.roles.filter((role) => (!role.userType || role.userType === "STAFF") && role.isActive !== false)
        : [];
      setInlineStaffRoles(roles);
    } catch {
      setInlineStaffRoles([]);
    }
  };

  const saveInlineStaff = async () => {
    const name = inlineStaffDraft.name.trim();
    const email = inlineStaffDraft.email.trim();
    if (!name) return notify.error("Please enter the staff member's name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return notify.error("Please enter a valid work email address.");
    if (inlineStaffDraft.password.length < 6) return notify.error("Password must be at least 6 characters.");
    const workNumberError = validateGenericCrmPhone(inlineStaffDraft.workNumber, "Work number");
    if (workNumberError) return notify.error(workNumberError);
    const mobileNumberError = validateGenericCrmPhone(inlineStaffDraft.mobileNumber, "Mobile number");
    if (mobileNumberError) return notify.error(mobileNumberError);
    if (!inlineStaffDraft.rbacRoleId) return notify.error("Please choose a role.");
    const selectedRole = inlineStaffRoles.find((role) => String(role.id) === String(inlineStaffDraft.rbacRoleId));
    const accessTier = ["ADMIN", "MANAGER", "USER"].includes(String(selectedRole?.key || "").toUpperCase())
      ? String(selectedRole.key).toUpperCase()
      : "USER";
    setInlineStaffSaving(true);
    try {
      await fetchApi("/api/staff", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          password: inlineStaffDraft.password,
          role: accessTier,
          jobTitle: inlineStaffDraft.jobTitle,
          workNumber: inlineStaffDraft.workNumber,
          mobileNumber: inlineStaffDraft.mobileNumber,
          reportingToId: inlineStaffDraft.reportingTo || null,
          rbacRoleId: Number(inlineStaffDraft.rbacRoleId),
        }),
      });
      notify.success(`${name} added to the team.`);
      setShowInlineStaffModal(false);
      const staff = await fetchApi("/api/staff", { silent: true });
      setStaffMembers(Array.isArray(staff) ? staff : []);
    } catch (error) {
      if (!error.status) notify.error(error.message || "Failed to add staff member.");
    } finally {
      setInlineStaffSaving(false);
    }
  };

  useEffect(() => {
    if (!genericLeadWizard || !showOwnerWarning) return undefined;
    const refreshStaff = () => {
      fetchApi("/api/staff", { silent: true })
        .then((data) => setStaffMembers(Array.isArray(data) ? data : []))
        .catch(() => {});
    };
    const intervalId = setInterval(refreshStaff, 1500);
    return () => clearInterval(intervalId);
  }, [genericLeadWizard, showOwnerWarning]);

  useEffect(() => {
    if (showOwnerWarning && staffLoaded && unmatchedSalesOwners.length === 0) {
      setShowOwnerWarning(false);
    }
  }, [showOwnerWarning, staffLoaded, unmatchedSalesOwners.length]);

  // The custom-field request and spreadsheet parsing run independently. If
  // the file is parsed first, rematch its still-unmapped headers as soon as
  // the saved database fields arrive. Preserve every manual mapping the user
  // has already chosen.
  useEffect(() => {
    if (!genericLeadWizard || !previewHeaders.length) return;
    const fields = buildAvailableMappingFields(mappingFields, dynamicLeadFields, genericLeadWizard);
    setMappingSelections((current) => {
      const next = { ...current };
      let changed = false;
      for (const header of previewHeaders) {
        if (next[header]) continue;
        const field = findExactMappingField(fields, header);
        if (!field) continue;
        next[header] = field.fieldKey || field.key || field.id;
        changed = true;
      }
      return changed ? next : current;
    });
    setMappingFieldTypes((current) => {
      const next = { ...current };
      let changed = false;
      for (const header of previewHeaders) {
        if (mappingSelections[header] || next[header]) continue;
        const field = findExactMappingField(fields, header);
        if (!field) continue;
        next[header] = normalizeFieldType(field.fieldType);
        changed = true;
      }
      return changed ? next : current;
    });
    setExcludedHeaders((current) => {
      const next = current.filter((header) => !findExactMappingField(fields, header) && !mappingSelections[header]);
      const excluded = new Set(next);
      for (const header of previewHeaders) {
        if (!mappingSelections[header] && !findExactMappingField(fields, header) && !canDeriveLeadFieldKey(header)) excluded.add(header);
      }
      return next.length === current.length && excluded.size === current.length
        ? current
        : [...excluded];
    });
  }, [dynamicLeadFields, genericLeadWizard, mappingFields, mappingSelections, previewHeaders]);

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
    importRowsRef.current = [];
    setFile(f);
    setResult(null);
    setJobId(null);
    setPreviewError(null);
    setPreviewRows([]);
    setPreviewHeaders([]);
    setExcludedHeaders([]);
    setMappingSelections({});
    setMappingFieldTypes({});
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
        const rawHeaders = (rows[0] || []).map((header) => String(header).trim());
        const stableHeaders = makeStableImportHeaders(rawHeaders, rows.slice(1));
        const headers = stableHeaders.filter(Boolean);
        const records = rows.slice(1).map((cells) => Object.fromEntries(
          stableHeaders.flatMap((header, index) => header ? [[header, cells[index] ?? ""]] : []),
        ));
        importRowsRef.current = records;
        setPreviewHeaders(headers);
        initializeMapping(headers);
        setPreviewRows(records.slice(0, 10));
      } catch (e) {
        setPreviewError(e.message || "Failed to read Excel file");
      }
      return;
    }
    try {
      const text = await f.text();
      const { headers, rows } = parseCsvClient(text, genericLeadWizard);
      importRowsRef.current = rows;
      setPreviewHeaders(headers);
      initializeMapping(headers);
      setPreviewRows(rows.slice(0, 10));
      // Generic CRM has a dedicated mapping step where arbitrary spreadsheet
      // columns can be mapped to an existing field or turned into a new custom
      // field. Requiring the template's literal header names before that step
      // defeats the mapper (for example, "First name" can be mapped instead
      // of requiring a column literally named "name"). Other verticals keep
      // the existing strict template validation.
      if (!genericLeadWizard) {
        const optional = new Set(optionalHeaders);
        const missing = expectedHeaders.filter((h) => !headers.includes(h) && !optional.has(h));
        if (missing.length) {
          setPreviewError(`Missing required column(s): ${missing.join(", ")}`);
        }
      }
    } catch (e) {
      setPreviewError(e.message || "Failed to parse CSV");
    }
  };

  const goToFinalize = () => {
    if (!file) return;

    if (unmatchedSalesOwners.length) {
      setShowOwnerWarning(true);
      return;
    }

    if (genericLeadWizard) {
      const invalidHeaders = previewHeaders
        .filter((header) => {
        if (excludedHeaders.includes(header)) return false;
        if (mappingSelections[header] || findExactMappingField(availableMappingFields, header)) return false;
        return !canDeriveLeadFieldKey(header);
      });
      if (invalidHeaders.length) {
        const message = `Invalid or missing column headers: ${invalidHeaders.slice(0, 5).join(", ")}. The first row must contain column names (for example: name, email, phone). Download the Excel template and copy your data below its header row.`;
        setPreviewError(message);
        notify.error(message);
        return;
      }
    }

    setWizardStep(4);
  };

  const doImport = async () => {
    if (!file) return;

    if (unmatchedSalesOwners.length) {
      setShowOwnerWarning(true);
      return;
    }

    if (genericLeadWizard) {
      const invalidHeaders = previewHeaders
        .filter((header) => {
        if (excludedHeaders.includes(header)) return false;
        if (mappingSelections[header] || findExactMappingField(availableMappingFields, header)) return false;
        return !canDeriveLeadFieldKey(header);
      });
      if (invalidHeaders.length) {
        const message = `Invalid or missing column headers: ${invalidHeaders.slice(0, 5).join(", ")}. The first row must contain column names (for example: name, email, phone). Download the Excel template and copy your data below its header row.`;
        setPreviewError(message);
        notify.error(message);
        return;
      }
    }

    setSubmitting(true);
    if (genericLeadWizard) setWizardStep(4);
    setResult(null);
    setJobId(null);

    const tooBig = file.size > thresholds.bytes;
    const tooLong = previewRows.length === 10 && file.size > 100 * 1024; // heuristic; the row count is properly checked server-side

    // Generic Leads has a synchronous contacts importer, but no Wellness-style
    // job endpoint. Keep its large uploads on the contacts route instead of
    // falling back to /api/wellness/csv/contacts/import/async.
    const useAsync = !genericLeadWizard && !forceSync && (tooBig || tooLong);
    const endpoint = useAsync ?
      (importAsyncUrl || `/api/wellness/csv/${entity}/import/async`)
      : (importUrl || `/api/wellness/csv/${entity}/import`);

    try {
      let resolvedMappings = Object.fromEntries(
        Object.entries(mappingSelections).filter(([header]) => !excludedHeaders.includes(header)),
      );
      let resolvedFieldTypes = Object.fromEntries(
        Object.entries(mappingFieldTypes).filter(([header]) => !excludedHeaders.includes(header)),
      );
      const fieldsCreatedDuringImport = [];

      if (genericLeadWizard) {
        // These are Generic CRM system fields, not custom fields. Keep them
        // out of the auto-create-field path so every import uses the same
        // status/lifecycle mapping even when the UI payload is stale.
        for (const header of previewHeaders) {
          if (excludedHeaders.includes(header)) continue;
          const normalizedHeader = String(header || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "");
          if (normalizedHeader === "status") {
            resolvedMappings[header] = "status";
            resolvedFieldTypes[header] = "text";
          } else if (normalizedHeader === "lifecyclestage" || normalizedHeader === "lifecyclestagekey") {
            resolvedMappings[header] = "lifecycleStageKey";
            resolvedFieldTypes[header] = "dropdown";
          }
        }
        let knownFields = [...availableMappingFields];
        for (const header of previewHeaders) {
          if (excludedHeaders.includes(header)) continue;
          if (!String(header || "").trim()) continue;
          if (resolvedMappings[header]) continue;

          let field = findExactMappingField(knownFields, header);
          if (!field) {
            const fieldType = normalizeFieldType(resolvedFieldTypes[header]);
            const payload = {
              label: header,
              fieldType,
              isRequired: false,
            };
            if (optionFieldTypes.has(fieldType)) {
              const options = [...new Set(
                importRowsRef.current
                  .map((row) => String(row?.[header] ?? "").trim())
                  .filter(Boolean),
              )];
              if (!options.length) {
                throw new Error(`Add at least one option for the ${header} field before importing.`);
              }
              if (options.length > 50) {
                throw new Error(`The ${header} column has more than 50 options. Choose a text field or reduce its distinct values before importing.`);
              }
              payload.options = options;
            }

            try {
              field = await fetchApi("/api/lead-custom-fields", {
                method: "POST",
                body: JSON.stringify(payload),
              });
              field = field?.field || field;
              fieldsCreatedDuringImport.push(field);
            } catch (error) {
              // Another tab or a previous import may have created the same
              // field after this modal loaded. Reload and reuse it rather
              // than failing the import with DUPLICATE_FIELD_KEY.
              if (error?.code !== "DUPLICATE_FIELD_KEY" && error?.status !== 409) throw error;
              const latest = await fetchApi("/api/lead-custom-fields", { silent: true });
              const latestFields = Array.isArray(latest) ? latest : (latest?.fields || latest?.customFields || []);
              knownFields = buildAvailableMappingFields(mappingFields, latestFields, genericLeadWizard);
              field = findExactMappingField(knownFields, header);
              if (!field) throw error;
            }
          }

          const fieldKey = field.fieldKey || field.key || field.id;
          resolvedMappings[header] = fieldKey;
          resolvedFieldTypes[header] = normalizeFieldType(field.fieldType || resolvedFieldTypes[header]);
          if (!knownFields.some((item) => (item.fieldKey || item.key || item.id) === fieldKey)) {
            knownFields.push(field);
          }
        }

        if (fieldsCreatedDuringImport.length) {
          setDynamicLeadFields((current) => [...current, ...fieldsCreatedDuringImport]);
        }
        setMappingSelections(resolvedMappings);
        setMappingFieldTypes(resolvedFieldTypes);
      }

      // Generic CRM uses the synchronous contacts endpoint. Split large demo
      // imports into bounded requests so one slow/invalid row cannot time out
      // the whole file or prevent later rows from being checked.
      const genericRows = importRowsRef.current;
      const genericChunkSize = 250;
      if (genericLeadWizard && genericRows.length > genericChunkSize) {
        const aggregate = {
          imported: 0,
          updated: 0,
          skipped: 0,
          errors: [],
          importedContacts: [],
        };
        const headers = previewHeaders.filter((header) => !excludedHeaders.includes(header));

        for (let offset = 0; offset < genericRows.length; offset += genericChunkSize) {
          const chunkRows = genericRows.slice(offset, offset + genericChunkSize);
          const csv = [
            headers.map(csvCell).join(","),
            ...chunkRows.map((row) => headers.map((header) => csvCell(row?.[header])).join(",")),
          ].join("\n");
          const chunkFile = new File([csv], file.name.replace(/\.(xlsx?|xls)$/i, ".csv"), { type: "text/csv" });
          const chunkForm = new FormData();
          chunkForm.append("file", chunkFile);
          chunkForm.append("mapping", JSON.stringify(resolvedMappings));
          chunkForm.append("mappingFieldTypes", JSON.stringify(resolvedFieldTypes));

          try {
            const token = getAuthToken();
            const chunkResponse = await fetch(endpoint, {
              method: "POST",
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              body: chunkForm,
            });
            const chunkBody = await chunkResponse.json().catch(() => ({}));
            if (!chunkResponse.ok) {
              const reason = chunkBody.error || chunkBody.message || `Import chunk failed (${chunkResponse.status})`;
              chunkRows.forEach((row, index) => {
                aggregate.errors.push({
                  row: offset + index + 2,
                  column: "row",
                  value: "",
                  message: reason,
                  data: row,
                });
              });
              aggregate.skipped += chunkRows.length;
              continue;
            }
            aggregate.imported += Number(chunkBody.imported ?? chunkBody.inserted ?? 0);
            aggregate.updated += Number(chunkBody.updated ?? 0);
            aggregate.skipped += Number(chunkBody.skipped ?? 0);
            aggregate.importedContacts.push(...(chunkBody.importedContacts || []));
            aggregate.errors.push(...(chunkBody.errors || []).map((error) => ({
              ...error,
              row: Number(error.row ?? error.rowNumber ?? 0) + offset,
              column: error.column ?? error.field ?? "",
              value: error.value ?? "",
              message: error.message ?? error.reason ?? "Invalid row",
            })));
          } catch (error) {
            chunkRows.forEach((row, index) => {
              aggregate.errors.push({
                row: offset + index + 2,
                column: "row",
                value: "",
                message: error.message || "Import chunk failed",
                data: row,
              });
            });
            aggregate.skipped += chunkRows.length;
          }
        }

        const normalizedResult = {
          ...aggregate,
          createdFields: fieldsCreatedDuringImport,
          inserted: aggregate.imported,
        };
        setResult(normalizedResult);
        if (normalizedResult.imported || normalizedResult.updated) {
          notify.success(
            `Imported: ${normalizedResult.imported} new, ${normalizedResult.updated} updated${normalizedResult.errors.length
              ? `, ${normalizedResult.errors.length} errors`
              : ""
            }`,
          );
          onImported({ ...normalizedResult, fileName: file.name });
          onClose();
        } else if (normalizedResult.errors.length) {
          notify.error(`Import had ${normalizedResult.errors.length} row error(s).`);
        }
      }

      const fd = new FormData();
      // Send the checked columns only. This is important for generic imports:
      // the backend also performs automatic header detection, so merely
      // omitting an unchecked column from the mapping would still allow it to
      // be detected from the original spreadsheet.
      const uploadFile = genericLeadWizard
        ? new File([
          [
            previewHeaders.filter((header) => !excludedHeaders.includes(header)).map(csvCell).join(","),
            ...genericRows.map((row) => previewHeaders
              .filter((header) => !excludedHeaders.includes(header))
              .map((header) => csvCell(row?.[header]))
              .join(",")),
          ].join("\n"),
        ], file.name.replace(/\.(xlsx?|xls)$/i, ".csv"), { type: "text/csv" })
        : file;
      fd.append("file", uploadFile);
      if (genericLeadWizard) {
        fd.append("mapping", JSON.stringify(resolvedMappings));
        fd.append("mappingFieldTypes", JSON.stringify(resolvedFieldTypes));
      }
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
          createdFields: fieldsCreatedDuringImport,
          inserted: normalizedBody.inserted ?? normalizedBody.imported ?? 0,
          updated: normalizedBody.updated ?? 0,
          skipped: normalizedBody.skipped ?? 0,
          errors: normalizedBody.errors || [],
        };
        setResult(normalizedResult);

          // The history dialog is kept mounted outside the import modal. Pull
          // the just-written history row immediately so it cannot display a
          // stale older import that only has an error count.
          if (genericLeadWizard && refreshImportHistory) refreshImportHistory();

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
      {showOwnerWarning && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="missing-sales-owner-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            background: "rgba(15, 23, 42, 0.35)",
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            style={{
              width: "min(520px, 100%)",
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              padding: "1.25rem 1.35rem",
              border: "1px solid #f59e0b",
              borderRadius: 12,
              background: "#fff7ed",
              color: "#9a3412",
              boxShadow: "0 20px 50px rgba(15, 23, 42, 0.28)",
            }}
          >
            <AlertTriangle size={25} aria-hidden="true" style={{ flex: "0 0 auto", color: "#d97706", marginTop: 2 }} />
            <div style={{ flex: 1, lineHeight: 1.5 }}>
              <strong id="missing-sales-owner-title" style={{ display: "block", marginBottom: 4 }}>
                Sales owner(s) not found in Staff
              </strong>
              <div>Create these staff accounts before importing:</div>
              <div style={{ marginTop: 4, fontWeight: 700 }}>{unmatchedSalesOwners.join(", ")}</div>
              {genericLeadWizard && (
                <button
                  type="button"
                  onClick={() => {
                    openInlineStaffModal();
                  }}
                  style={{
                    marginTop: 12,
                    padding: "0.4rem 0.7rem",
                    border: "1px solid #d97706",
                    borderRadius: 6,
                    background: "#ffffff",
                    color: "#9a3412",
                    fontSize: "0.8rem",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Add staff
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label="Close warning"
              onClick={() => setShowOwnerWarning(false)}
              style={{
                flex: "0 0 auto",
                border: 0,
                background: "transparent",
                color: "#9a3412",
                fontSize: "1.25rem",
                lineHeight: 1,
                cursor: "pointer",
                padding: "0 0.15rem",
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {genericLeadWizard && showInlineStaffModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="inline-add-staff-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1300,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            background: "rgba(15, 23, 42, 0.45)",
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            style={{
              width: "min(660px, 100%)",
              maxHeight: "90vh",
              overflowY: "auto",
              padding: "1.5rem 1.75rem",
              borderRadius: 14,
              background: "#ffffff",
              color: "var(--text-primary, #172033)",
              boxShadow: "0 20px 55px rgba(15, 23, 42, 0.3)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <h2 id="inline-add-staff-title" style={{ margin: 0, fontSize: "1.1rem" }}>Add staff member</h2>
              <button type="button" aria-label="Close" onClick={() => setShowInlineStaffModal(false)} style={{ border: 0, background: "transparent", cursor: "pointer", fontSize: "1.4rem", color: "var(--text-secondary)" }}>×</button>
            </div>
            <p style={{ margin: "0.35rem 0 1rem", color: "var(--text-secondary)", fontSize: "0.82rem" }}>
              Add the missing staff account without leaving the import page.
            </p>
            <div style={{ display: "grid", gap: "0.75rem" }}>
              <label>Working name<input className="input-field" autoFocus value={inlineStaffDraft.name} onChange={(event) => setInlineStaffDraft((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Jane Smith" /></label>
              <label>Work email <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>(not a personal address)</span><input className="input-field" type="email" value={inlineStaffDraft.email} onChange={(event) => setInlineStaffDraft((current) => ({ ...current, email: event.target.value }))} placeholder="name@yourcompany.com" /></label>
              <label>Temporary password <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>(min 6 characters)</span><div style={{ position: "relative", marginTop: "0.25rem" }}><input className="input-field" type={showInlineStaffPassword ? "text" : "password"} value={inlineStaffDraft.password} onChange={(event) => setInlineStaffDraft((current) => ({ ...current, password: event.target.value }))} placeholder="Share securely with the new staff member" style={{ width: "100%", paddingRight: "2.5rem" }} /><button type="button" onClick={() => setShowInlineStaffPassword((current) => !current)} aria-label={showInlineStaffPassword ? "Hide password" : "Show password"} title={showInlineStaffPassword ? "Hide password" : "Show password"} style={{ position: "absolute", right: "0.65rem", top: "50%", transform: "translateY(-50%)", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "none", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", padding: 0 }}>{showInlineStaffPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
              <label>Job title<input className="input-field" value={inlineStaffDraft.jobTitle} onChange={(event) => setInlineStaffDraft((current) => ({ ...current, jobTitle: event.target.value }))} placeholder="e.g. SDR" /></label>
              <label>Work number<input className="input-field" inputMode="tel" pattern="[+0-9\s().-]+" aria-label="Work number" value={inlineStaffDraft.workNumber} onChange={(event) => setInlineStaffDraft((current) => ({ ...current, workNumber: sanitizeGenericCrmPhoneInput(event.target.value) }))} onBlur={() => { const error = validateGenericCrmPhone(inlineStaffDraft.workNumber, "Work number"); if (error) notify.error(error); }} placeholder="Staff official contact number" /></label>
              <label>Mobile number<input className="input-field" inputMode="tel" pattern="[+0-9\s().-]+" aria-label="Mobile number" value={inlineStaffDraft.mobileNumber} onChange={(event) => setInlineStaffDraft((current) => ({ ...current, mobileNumber: sanitizeGenericCrmPhoneInput(event.target.value) }))} onBlur={() => { const error = validateGenericCrmPhone(inlineStaffDraft.mobileNumber, "Mobile number"); if (error) notify.error(error); }} placeholder="Staff personal mobile number" /></label>
              <label>Reporting to<select className="input-field" value={inlineStaffDraft.reportingTo} onChange={(event) => setInlineStaffDraft((current) => ({ ...current, reportingTo: event.target.value }))}><option value="">Click to select</option>{staffMembers.filter((member) => member.role === "MANAGER" || member.role === "ADMIN").map((member) => <option key={member.id} value={member.id}>{member.name || member.email}</option>)}</select></label>
              <label>Role<select className="input-field" value={inlineStaffDraft.rbacRoleId} onChange={(event) => setInlineStaffDraft((current) => ({ ...current, rbacRoleId: event.target.value }))}><option value="">— Select a role —</option>{inlineStaffRoles.map((role) => <option key={role.id} value={role.id}>{role.name || role.key}</option>)}</select></label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "1.25rem" }}>
              <button type="button" onClick={() => setShowInlineStaffModal(false)} disabled={inlineStaffSaving} style={secondaryBtnStyle}>Cancel</button>
              <button type="button" onClick={saveInlineStaff} disabled={inlineStaffSaving} style={primaryBtnStyle}>{inlineStaffSaving ? "Adding…" : "Add staff member"}</button>
            </div>
          </div>
        </div>
      )}
      <div
        className={`glass${genericLeadWizard ? " generic-import-wizard" : ""}`}
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
          <div style={{ display: "flex", position: "relative", justifyContent: "space-between", marginBottom: "1.5rem", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
            <div aria-hidden="true" style={{ position: "absolute", top: 15, left: "12.5%", right: "12.5%", height: 2, background: "var(--border-color, #d8dee9)" }} />
            { ["File info", "Upload file", "Review mapping", "Finalize import"].map((step, index) => {
              const stepNumber = index + 1;
              const completed = wizardStep > stepNumber;
              const current = wizardStep === stepNumber;
              return <div key={step} style={{ flex: 1, display: "flex", position: "relative", zIndex: 1, flexDirection: "column", alignItems: "center", gap: 7, textAlign: "center", fontWeight: current || completed ? 700 : 500, color: current || completed ? "var(--accent-color)" : "var(--text-secondary)" }}>
                <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: "50%", border: `2px solid ${current || completed ? "var(--accent-color)" : "var(--border-color, #d8dee9)"}`, background: completed ? "var(--accent-color)" : "#ffffff", color: completed ? "#ffffff" : current ? "var(--accent-color)" : "var(--text-secondary)", fontWeight: 700 }}>{completed ? "✓" : stepNumber}</span>
                <span>{step}</span>
              </div>;
            })}
          </div>
        )}
        {genericLeadWizard && wizardStep === 1 && (
          <div className="generic-import-step-overlay" style={{ position: "absolute", inset: 0, zIndex: 5, background: "#ffffff", padding: "5.5rem 2rem 3rem", textAlign: "center", borderRadius: "inherit" }}>
            <h2 style={{ marginTop: 0 }}>Tell us what your file contains</h2>
            <div style={{ display: "flex", justifyContent: "center", gap: "1rem", margin: "2rem 0" }}>
              {["leads"].map((mode) => {
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
          <div className="generic-import-step-overlay" style={{ position: "absolute", inset: 0, zIndex: 5, background: "#ffffff", padding: "1.5rem 2rem 1.5rem", borderRadius: "inherit", boxSizing: "border-box", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <h2 style={{ margin: 0, textAlign: "center" }}>Review the mapping of your fields</h2>
            <p style={{ textAlign: "center", color: "var(--text-secondary)", marginBottom: "1.5rem" }}>We've mapped the columns in your file to CRM fields — take a look</p>
            <div style={{ border: "1px solid var(--border-color)", borderRadius: 10, overflowY: "auto", overflowX: "hidden", flex: "1 1 auto", minHeight: 0 }}>
              <div style={{ position: "sticky", top: 0, zIndex: 2, display: "grid", gridTemplateColumns: "70px minmax(120px, 1fr) 100px minmax(180px, 1.3fr) minmax(100px, 1fr)", gap: 10, padding: "0.8rem", background: "#eef2f7", opacity: 1, fontWeight: 700, fontSize: "0.8rem", minWidth: 620, borderBottom: "1px solid var(--border-color)", boxShadow: "0 1px 0 #eef2f7" }}><span>Import</span><span>CSV column</span><span>Mapped</span><span>CRM field</span><span>Field type</span></div>
              {displayedPreviewHeaders.map((header) => {
                const sampleValue = previewRows[0]?.[header];
                const hasSampleValue = sampleValue !== undefined && sampleValue !== null && String(sampleValue) !== "";
                const displayedSampleValue = hasSampleValue ? expandScientificNotation(sampleValue) : "";
                const isSalesOwnerColumn = mappingSelections[header] === "assignedTo";
                return (
                <div key={header} style={{ display: "grid", gridTemplateColumns: "70px minmax(120px, 1fr) 100px minmax(180px, 1.3fr) minmax(100px, 1fr)", gap: 10, alignItems: "center", padding: "0.8rem", borderTop: "1px solid var(--border-color)", fontSize: "0.85rem", minWidth: 620 }}>
                  <input
                    type="checkbox"
                    checked={!excludedHeaders.includes(header)}
                    onChange={(event) => setExcludedHeaders((current) => (
                      event.target.checked
                        ? current.filter((item) => item !== header)
                        : [...current, header]
                    ))}
                    aria-label={`Import ${header}`}
                  />
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{header}</strong>
                    {hasSampleValue && (
                      <span
                        data-testid={`import-sample-${header}`}
                        title={displayedSampleValue}
                        style={{ display: "block", marginTop: 4, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {displayedSampleValue}
                      </span>
                    )}
                    {isSalesOwnerColumn && unmatchedSalesOwners.length > 0 && (
                      <span
                        role="alert"
                        style={{ display: "block", marginTop: 5, color: "#b45309", fontSize: "0.75rem", lineHeight: 1.35 }}
                      >
                        <AlertTriangle size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
                        Not in Staff: {unmatchedSalesOwners.join(", ")}
                      </span>
                    )}
                  </div>
                  {mappingSelections[header] ? (
                    <CheckCircle2 size={18} aria-label={`Mapped ${header}`} style={{ color: "#059669" }} />
                  ) : (
                    <AlertTriangle size={18} aria-label={`Unmapped ${header}`} style={{ color: "#d97706" }} />
                  )}
                  {!mappingSelections[header] ? (
                    <div data-proposed-field={canDeriveLeadFieldKey(header) ? "true" : undefined} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <SearchableMappingFieldSelect
                        value=""
                        options={sortedMappingFields}
                        ariaLabel={`CRM field for ${header}`}
                        title="Choose an existing CRM field or add a new one"
                        triggerLabel={`＋ ${header} (new field)`}
                        highlightEmpty
                        onChange={(value) => updateMappingFor(header, value || "")}
                      />
                      {canDeriveLeadFieldKey(header) && (
                        <button type="button" aria-label={`Edit proposed CRM field ${header}`} title={`Edit proposed CRM field ${header}`} onClick={() => openAddFieldFor(header, "edit")} style={{ ...secondaryBtnStyle, flex: "0 0 auto", minHeight: 36, padding: "0.35rem 0.55rem", whiteSpace: "nowrap" }}>Edit</button>
                      )}
                    </div>
                  ) : (
                    <SearchableMappingFieldSelect
                      value={mappingSelections[header]}
                      options={sortedMappingFields}
                      ariaLabel={`CRM field for ${header}`}
                      title="Choose an existing CRM field"
                      onChange={(value) => updateMappingFor(header, value)}
                    />
                  )}
                  <select className="input-field" style={{ height: 36, minHeight: 0, padding: "0.4rem 0.65rem" }} value={normalizeFieldType(mappingFieldTypes[header] || findMappingField(mappingSelections[header])?.fieldType)} aria-label={`Field type for ${header}`} onChange={(event) => setMappingFieldTypes((current) => ({ ...current, [header]: event.target.value }))}>
                    {IMPORT_FIELD_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: "0.75rem", marginTop: "1.25rem", paddingBottom: "0.5rem" }}><button type="button" onClick={() => setWizardStep(2)} style={secondaryBtnStyle}>Back</button><button type="button" onClick={goToFinalize} disabled={submitting || !file} style={primaryBtnStyle}>Go to next page to see preview</button></div>
          </div>
        )}
        {genericLeadWizard && showAddField && (
          <div className="generic-import-step-overlay generic-import-add-field" role="dialog" aria-modal="true" aria-labelledby="add-lead-field-title" style={{ position: "absolute", top: "6.5rem", right: "2rem", zIndex: 50, width: "min(360px, calc(100% - 4rem))", background: "var(--surface-color, #fff)", opacity: 1, padding: "1.25rem", borderRadius: 12, border: "1px solid var(--border-color)", boxShadow: "0 18px 42px rgba(0,0,0,.35)" }}>
            <div className="generic-import-add-field-surface" aria-hidden="true" />
            <div className="generic-import-add-field-content">
              <h2 id="add-lead-field-title" style={{ marginTop: 0 }}>{fieldEditorMode === "edit" ? "Edit field" : "Add new field"}</h2>
              <div style={{ display: "grid", gap: "0.85rem" }}>
                <label>Label *<input className="input-field" aria-label="New CRM field label" value={newFieldLabel} onChange={(event) => setNewFieldLabel(event.target.value)} autoFocus /></label>
                <label>Field type<select className="input-field" value={newFieldType} onChange={(event) => setNewFieldType(event.target.value)}><option value="text">Text</option><option value="textarea">Textarea</option><option value="number">Number</option><option value="date">Date</option><option value="dropdown">Dropdown</option><option value="radio">Radio</option><option value="multiselect">Multi-select</option></select></label>
                {optionFieldTypes.has(newFieldType) && <label>Options *<input className="input-field" placeholder="Option 1, Option 2" value={newFieldOptions} onChange={(event) => setNewFieldOptions(event.target.value)} /></label>}
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><input type="checkbox" checked={newFieldRequired} onChange={(event) => setNewFieldRequired(event.target.checked)} /> Required field</label>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}><button type="button" onClick={resetAddField} style={secondaryBtnStyle}>Cancel</button><button type="button" onClick={createField} disabled={savingNewField} style={primaryBtnStyle}>{savingNewField ? "Saving…" : fieldEditorMode === "edit" ? "Save field" : "Create field"}</button></div>
            </div>
          </div>
        )}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: "1rem",
            right: "1rem",
            width: 36,
            height: 36,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
            background: "transparent",
            border: "none",
            fontSize: "1.6rem",
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
          {forceSync || genericLeadWizard ? (
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
                    {visibleDataPreviewHeaders.map((h) => (
                      <th key={h} style={tableHeaderCellStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i}>
                      {visibleDataPreviewHeaders.map((h) => (
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
              {submitting ? "Importing..." : genericLeadWizard && wizardStep === 4 ? "Import" : "Confirm import"}
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

function parseCsvClient(text, preserveUnnamed = false) {
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
  const rawHeaders = records[0].map((h) => String(h).trim());
  const stableHeaders = preserveUnnamed
    ? makeStableImportHeaders(rawHeaders, records.slice(1))
    : rawHeaders;
  const headers = stableHeaders.filter(Boolean);
  const rows = records.slice(1).map((cells) => {
    const obj = {};
    stableHeaders.forEach((h, idx) => { if (h) obj[h] = idx < cells.length ? cells[idx] : ""; });
    return obj;
  });
  return { headers, rows };
}

// Spreadsheet exports sometimes serialize long identifiers as scientific
// notation. Expand only the review-stage sample; keep the original cell value
// untouched so the import payload remains exactly as uploaded.
function expandScientificNotation(value) {
  const raw = String(value);
  const match = raw.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return raw;

  const [, sign, integerPart, fractionPart = "", exponentText] = match;
  const digits = integerPart + fractionPart;
  const decimalIndex = integerPart.length + Number(exponentText);
  if (decimalIndex <= 0) return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
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
  position: "fixed",
  minWidth: 0,
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

