/**
 * /settings/lead-fields — Lead Custom Fields admin page.
 *
 * Backend: /api/lead-custom-fields (routes/lead_custom_fields.js).
 * ADMIN-only page (RoleGuard wrap at the App.jsx route). Generic and Travel
 * only — wellness/travel tenants never see this page's Settings link, and
 * the route itself is additionally guarded here so a direct URL visit from
 * a non-generic tenant is redirected rather than rendering.
 *
 * Lets an ADMIN define extra fields that then appear on every Lead's
 * create/edit form + detail view (Leads.jsx, ContactDetail.jsx) for THIS
 * tenant only. Field type (text/number/dropdown/date/checkbox) is chosen
 * once at creation time and cannot be changed afterward — see the backend
 * route's comment for why (it would orphan/misinterpret already-stored
 * values).
 *
 * Styling mirrors the app's real shared design system (.card / .btn-primary
 * / .btn-secondary / .input-field / .stable-table / EmptyState / FormField)
 * rather than hand-rolled inline styles — see Currencies.jsx for the sibling
 * settings-CRUD page this pattern was pulled from.
 */

import { useContext, useEffect, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { Plus, Trash2, Loader, ListChecks, ArrowLeft, ArrowUp, ArrowDown, Pencil, GripVertical, Search, Folder, ChevronDown, Info, Type, Hash, Link2, AlignLeft, List } from "lucide-react";
import { DndContext, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AuthContext } from "../../App";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { EmptyState, FormField } from "../../components/ui";
import TopScrollSync from "../../components/TopScrollSync";
import "./FieldConfig.css";

const FIELD_TYPE_OPTIONS = [
  { value: "text", label: "Text field" },
  { value: "textarea", label: "Text area" },
  { value: "number", label: "Number" },
  { value: "dropdown", label: "Dropdown" },
  { value: "radio", label: "Radio button" },
  { value: "date", label: "Date picker" },
  { value: "url", label: "URL" },
  { value: "checkbox", label: "Checkbox (Yes/No)" },
  { value: "multiselect", label: "Multiselect" },
];

const FIELD_TYPES_WITH_OPTIONS = new Set(["dropdown", "radio", "multiselect"]);
const LEAD_FIELDS_PAGE_SIZE = 10;
const FIELD_CONFIG_SETTING_KEY = "generic.fieldConfig";
const QUICK_ADD_SYSTEM_FIELD_IDS = new Set([
  "name",
  "email",
  "company",
  "title",
  "phone",
  "website",
  "source",
]);
const LOCKED_QUICK_ADD_FIELD_IDS = new Set(["name", "email"]);
const COLLAPSED_GROUPS_STORAGE_PREFIX = "generic-field-config.collapsed-groups.v1";
const DEFAULT_FIELD_CONFIG = {
  fieldOverrides: {},
  groupOrder: ["Basic Information", "Telephone Numbers", "Lead Details", "Callified Details", "Web Form & Attribution", "UTM Tracker", "Attribution Tracking", "Table Controls", "Custom Fields"],
  groupNames: {},
  customGroups: [],
  customFieldGroups: {},
  fieldOrder: {},
};

function readCollapsedConfigGroups(storageKey) {
  if (!storageKey || typeof window === "undefined") return new Set();
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
    return new Set(Array.isArray(saved) ? saved.filter((groupKey) => typeof groupKey === "string") : []);
  } catch {
    return new Set();
  }
}

const SYSTEM_FIELD_GROUPS = [
  {
    name: "Basic Information",
    fields: [
      { id: "email", label: "Email", fieldType: "text", required: true, quickAdd: true, unique: true },
      { id: "name", label: "Full name", fieldType: "text", quickAdd: true },
      { id: "company", label: "Company", fieldType: "text", quickAdd: true },
      { id: "title", label: "Job title", fieldType: "text", quickAdd: true },
    ],
  },
  {
    name: "Telephone Numbers",
    fields: [
      { id: "phone", label: "Mobile", fieldType: "text", quickAdd: true },
      { id: "whatsappPhone", label: "WhatsApp phone", fieldType: "text" },
    ],
  },
  {
    name: "Lead Details",
    fields: [
      { id: "owner", label: "Sales owner", fieldType: "dropdown", options: ["CRM users"] },
      { id: "source", label: "Source", fieldType: "dropdown", options: ["Organic", "Website", "Referral", "Campaign"] },
      { id: "medium", label: "Medium", fieldType: "text" },
      { id: "status", label: "Status", fieldType: "dropdown", options: ["Lead", "Prospect", "Customer", "Churned"] },
      { id: "website", label: "Website URL", fieldType: "url" },
      { id: "industry", label: "Industry", fieldType: "text" },
      { id: "companySize", label: "Company size", fieldType: "number" },
    ],
  },
  {
    name: "UTM Tracker",
    fields: [
      { id: "utm_medium", label: "UTM Medium", fieldType: "text", readOnly: true },
      { id: "utm_source", label: "UTM Source", fieldType: "text", readOnly: true },
      { id: "utm_lander", label: "UTM Lander", fieldType: "url", readOnly: true },
      { id: "utm_campaign", label: "UTM Campaign", fieldType: "text", readOnly: true },
      { id: "utm_keyword", label: "UTM Keyword", fieldType: "text", readOnly: true },
      { id: "utm_id", label: "UTM ID", fieldType: "text", readOnly: true },
      { id: "utm_term", label: "UTM Term", fieldType: "text", readOnly: true },
      { id: "utm_click_id", label: "UTM Click ID", fieldType: "text", readOnly: true },
      { id: "utm_content", label: "UTM Content", fieldType: "text", readOnly: true },
      { id: "metaEventId", label: "Meta Event ID", fieldType: "text", readOnly: true },
      { id: "fbp", label: "FBP", fieldType: "text", readOnly: true },
      { id: "fbc", label: "FBC", fieldType: "text", readOnly: true },
      { id: "clientIp", label: "Client IP", fieldType: "text", readOnly: true },
      { id: "userAgent", label: "User Agent", fieldType: "text", readOnly: true },
      { id: "eventSourceUrl", label: "Event Source URL", fieldType: "url", readOnly: true },
      { id: "gclid", label: "Google Click ID", fieldType: "text", readOnly: true },
      { id: "gbraid", label: "Google Braid ID", fieldType: "text", readOnly: true },
      { id: "wbraid", label: "Google Wbraid ID", fieldType: "text", readOnly: true },
      { id: "fbclid", label: "Meta Click ID", fieldType: "text", readOnly: true },
    ],
  },
  {
    name: "Attribution Tracking",
    fields: [
      { id: "firstTouchSource", label: "First touch source", fieldType: "text" },
      { id: "lastTouchSource", label: "Last touch source", fieldType: "text" },
      { id: "tags", label: "Tags", fieldType: "multiselect", options: ["Tenant-defined tags"] },
    ],
  },
];

const SYSTEM_FIELD_METADATA = new Map(
  SYSTEM_FIELD_GROUPS.flatMap((group) => group.fields).map((field) => [field.id, field]),
);
const UTM_FIELD_KEYS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_id", "utm_term", "utm_content",
  "gclid", "gbraid", "wbraid", "fbclid", "fbc", "fbp", "campaign_id", "adset_id",
  "ad_id", "campaign_name", "adset_name", "ad_name", "placement", "site_source_name",
]);
const WEB_ATTRIBUTION_FIELD_KEYS = new Set([
  "webForm", "pageUrl", "pageTitle", "pageSource",
  "referrerUrl", "landingPageUrl", "currentDomain", "formName", "submittedAt", "browser",
  "operatingSystem", "deviceType",
]);
const CALLIFIED_FIELD_KEYS = new Set(["campaign", "callStatus", "callifiedAi", "callifiedScore"]);
const LEAD_DETAIL_FIELD_KEYS = new Set([
  "aiScore", "source", "status", "lifecycleStage", "medium", "location", "pickupLocation",
  "plotAssign", "overallPickupStatus", "tags", "assignedTo", "createdAt", "lastUpdated",
]);
const TABLE_CONTROL_FIELD_KEYS = new Set(["actions"]);
const TELEPHONE_FIELD_KEYS = new Set(["phone", "whatsappPhone"]);
const ATTRIBUTION_FIELD_KEYS = new Set(["firstTouchSource", "lastTouchSource"]);
const NUMBER_FIELD_KEYS = new Set(["aiScore", "companySize", "callifiedScore"]);
const DATE_FIELD_KEYS = new Set(["createdAt", "lastUpdated", "submittedAt", "birthDate", "anniversary"]);
const URL_FIELD_KEYS = new Set(["website", "linkedin", "pageUrl", "referrerUrl", "landingPageUrl"]);
const OPTION_FIELD_KEYS = new Set(["source", "status", "lifecycleStage", "assignedTo"]);
const AUTOMATIC_FIELD_KEYS = new Set([
  ...UTM_FIELD_KEYS,
  ...WEB_ATTRIBUTION_FIELD_KEYS,
  ...CALLIFIED_FIELD_KEYS,
  "aiScore", "createdAt", "lastUpdated", "location", "pickupLocation", "plotAssign",
  "overallPickupStatus", "actions",
]);

function systemFieldGroupForKey(key) {
  if (UTM_FIELD_KEYS.has(key)) return "UTM Tracker";
  if (TELEPHONE_FIELD_KEYS.has(key)) return "Telephone Numbers";
  if (ATTRIBUTION_FIELD_KEYS.has(key)) return "Attribution Tracking";
  if (WEB_ATTRIBUTION_FIELD_KEYS.has(key)) return "Web Form & Attribution";
  if (CALLIFIED_FIELD_KEYS.has(key)) return "Callified Details";
  if (TABLE_CONTROL_FIELD_KEYS.has(key)) return "Table Controls";
  if (LEAD_DETAIL_FIELD_KEYS.has(key)) return "Lead Details";
  return "Basic Information";
}

function inferSystemFieldType(key) {
  if (NUMBER_FIELD_KEYS.has(key)) return "number";
  if (DATE_FIELD_KEYS.has(key)) return "date";
  if (URL_FIELD_KEYS.has(key)) return "url";
  if (OPTION_FIELD_KEYS.has(key)) return "dropdown";
  if (key === "tags") return "multiselect";
  if (key === "description") return "textarea";
  return "text";
}

function sortFieldsBySavedOrder(fields, savedOrder) {
  if (!Array.isArray(savedOrder) || savedOrder.length === 0) return [...fields];
  const order = new Map(savedOrder.map((fieldId, index) => [String(fieldId), index]));
  return [...fields].sort((left, right) => {
    const leftIndex = order.has(String(left.id)) ? order.get(String(left.id)) : Number.MAX_SAFE_INTEGER;
    const rightIndex = order.has(String(right.id)) ? order.get(String(right.id)) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function buildSystemFieldGroups(columnCatalog, fieldOrder = {}) {
  if (!Array.isArray(columnCatalog) || columnCatalog.length === 0) {
    return SYSTEM_FIELD_GROUPS.map((group) => ({
      ...group,
      fields: sortFieldsBySavedOrder(group.fields, fieldOrder[group.name]),
    }));
  }
  const grouped = new Map();
  for (const column of columnCatalog) {
    if (!column?.key || String(column.key).startsWith("cf_")) continue;
    const metadata = SYSTEM_FIELD_METADATA.get(column.key) || {};
    const groupName = systemFieldGroupForKey(column.key);
    const fields = grouped.get(groupName) || [];
    fields.push({
      ...metadata,
      id: column.key,
      label: column.label || metadata.label || column.key,
      fieldType: metadata.fieldType || inferSystemFieldType(column.key),
      readOnly: metadata.readOnly || AUTOMATIC_FIELD_KEYS.has(column.key),
      lockedVisible: Boolean(column.lockedVisible),
    });
    grouped.set(groupName, fields);
  }
  return DEFAULT_FIELD_CONFIG.groupOrder
    .filter((name) => name !== "Custom Fields")
    .filter((name) => grouped.has(name))
    .map((name) => ({ name, fields: sortFieldsBySavedOrder(grouped.get(name), fieldOrder[name]) }));
}

const FIELD_TYPE_LABELS = Object.fromEntries(FIELD_TYPE_OPTIONS.map((o) => [o.value, o.label]));

const th = {
  padding: "0.75rem 1rem",
  fontSize: "0.78rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
  fontWeight: 600,
  textAlign: "left",
  // Theme-driven, not a fixed dark hex. --subtle-bg composites over the
  // table body's --bg-color to sit a shade apart from the rows in BOTH
  // themes (white 5% over near-black in dark, black 4% over #f0f2f5 in
  // light). A hardcoded #23262d kept the header dark under the light
  // theme while the text colours followed the theme and went dark too,
  // leaving the labels unreadable.
  background: "var(--subtle-bg)",
  boxShadow: "inset 0 -1px 0 var(--border-color)",
};
const td = { padding: "0.75rem 1rem", fontSize: "0.9rem" };
const iconBtn = { background: "var(--subtle-bg)", border: "1px solid var(--border-color)", borderRadius: 6, padding: "0.375rem 0.5rem", cursor: "pointer", display: "inline-flex", alignItems: "center" };

function FieldTypeGlyph({ fieldType }) {
  if (fieldType === "number") return <Hash size={21} />;
  if (fieldType === "url") return <Link2 size={20} />;
  if (["dropdown", "radio", "multiselect"].includes(fieldType)) return <List size={21} />;
  if (fieldType === "textarea") return <AlignLeft size={21} />;
  return <Type size={21} />;
}

function normalizeFieldOrder(list, displayOrderOffset = 0) {
  return list.map((field, index) => ({ ...field, displayOrder: displayOrderOffset + index }));
}

function SortableLeadFieldRow({
  field,
  index,
  total,
  indexOffset = 0,
  reordering,
  onMove,
  onEdit,
  onDelete,
  onToggleRequired,
  deletingId,
}) {
  const absoluteIndex = indexOffset + index;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: String(field.id) });

  return (
    <tr
      ref={setNodeRef}
      style={{
        borderTop: "1px solid var(--border-color)",
        display: "table",
        width: "100%",
        tableLayout: "fixed",
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.88 : 1,
        boxShadow: isDragging ? "0 10px 22px rgba(0, 0, 0, 0.22)" : "none",
        background: isDragging ? "rgba(37, 99, 235, 0.06)" : "transparent",
      }}>
      <td style={{ ...td, display: "flex", gap: "0.15rem", alignItems: "center" }}>
        <button
          type="button"
          aria-label={`Drag ${field.label} to reorder`}
          title="Drag to reorder"
          disabled={reordering}
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: "none",
            border: "1px solid transparent",
            padding: "0.2rem",
            color: reordering ? "var(--border-color)" : "var(--text-secondary)",
            cursor: reordering ? "not-allowed" : "grab",
            touchAction: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <GripVertical size={14} />
        </button>
        <button
          type="button"
          onClick={() => onMove(index, -1)}
          disabled={absoluteIndex === 0 || reordering}
          aria-label={`Move ${field.label} up`}
          title="Move up"
          style={{
            background: "none",
            border: "none",
            padding: "0.2rem",
            color: absoluteIndex === 0 ? "var(--border-color)" : "var(--text-secondary)",
            cursor: absoluteIndex === 0 ? "default" : "pointer",
          }}
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          onClick={() => onMove(index, 1)}
          disabled={absoluteIndex === total - 1 || reordering}
          aria-label={`Move ${field.label} down`}
          title="Move down"
          style={{
            background: "none",
            border: "none",
            padding: "0.2rem",
            color: absoluteIndex === total - 1 ? "var(--border-color)" : "var(--text-secondary)",
            cursor: absoluteIndex === total - 1 ? "default" : "pointer",
          }}
        >
          <ArrowDown size={14} />
        </button>
      </td>
      <td style={{ ...td, fontWeight: 500 }}>{field.label}</td>
      <td style={td}>{FIELD_TYPE_LABELS[field.fieldType] || field.fieldType}</td>
      <td title={`cf_${field.fieldKey}`} style={{ ...td, fontFamily: "monospace", color: "var(--text-secondary)", whiteSpace: "normal", wordBreak: "break-word", overflowWrap: "anywhere", minWidth: "170px" }}>{`cf_${field.fieldKey}`}</td>
      <td style={{ ...td, color: "var(--text-secondary)" }}>
        {FIELD_TYPES_WITH_OPTIONS.has(field.fieldType) ? (Array.isArray(field.options) ? field.options.join(", ") : "") : ""}
      </td>
      <td style={td}>
        <input
          type="checkbox"
          checked={Boolean(field.isRequired)}
          onChange={() => onToggleRequired(field)}
          style={{ cursor: "pointer" }}
        />
      </td>
      <td style={td}>
        <div style={{ display: "inline-flex", gap: "0.4rem" }}>
          <button
            type="button"
            onClick={() => onEdit(field)}
            aria-label={`Edit ${field.label}`}
            title="Edit field"
            style={iconBtn}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(field)}
            disabled={deletingId === field.id}
            aria-label={`Delete ${field.label}`}
            title="Delete field"
            style={{ ...iconBtn, color: "var(--danger-color, #ef4444)" }}
          >
            {deletingId === field.id ? <Loader size={14} className="spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      </td>
    </tr>
  );
}

function getOptionsText(options) {
  return Array.isArray(options) ? options.join(", ") : "";
}

function renderFieldPreview(field, optionsText) {
  const previewOptions = optionsText.split(",").map((o) => o.trim()).filter(Boolean);
  const sharedProps = {
    className: "input-field",
    disabled: true,
    placeholder: field.placeholder || "",
    style: { width: "100%" },
  };

  if (field.fieldType === "textarea") {
    return <textarea {...sharedProps} rows={4} />;
  }
  if (field.fieldType === "number") {
    return <input {...sharedProps} type="number" />;
  }
  if (field.fieldType === "date") {
    return <input {...sharedProps} type="date" />;
  }
  if (field.fieldType === "url") {
    return <input {...sharedProps} type="url" />;
  }
  if (field.fieldType === "checkbox") {
    return (
      <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", color: "var(--text-secondary)" }}>
        <input type="checkbox" disabled />
        Yes / No
      </label>
    );
  }
  if (field.fieldType === "dropdown") {
    return (
      <select {...sharedProps} defaultValue="">
        <option value="">{field.placeholder || "Select an option"}</option>
        {previewOptions.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }
  if (field.fieldType === "multiselect") {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        {previewOptions.length ? previewOptions.map((option) => (
          <span
            key={option}
            style={{
              padding: "0.3rem 0.6rem",
              borderRadius: 999,
              background: "var(--subtle-bg)",
              border: "1px solid var(--border-color)",
              color: "var(--text-secondary)",
              fontSize: "0.85rem",
            }}
          >
            {option}
          </span>
        )) : <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Add options to preview this field.</span>}
      </div>
    );
  }
  if (field.fieldType === "radio") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {previewOptions.length ? previewOptions.map((option) => (
          <label key={option} style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", color: "var(--text-secondary)" }}>
            <input type="radio" disabled name={`preview-radio-${field.id}`} />
            {option}
          </label>
        )) : <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Add options to preview this field.</span>}
      </div>
    );
  }
  return <input {...sharedProps} type="text" />;
}

function FieldTypeSelect({ value, onChange }) {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, FIELD_TYPE_OPTIONS.findIndex((option) => option.value === value)),
  );
  const [menuStyle, setMenuStyle] = useState(null);
  const menuId = "lead-field-type-options";

  useEffect(() => {
    if (!open) return undefined;

    const positionMenu = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 4;
      const viewportPadding = 8;
      const rowHeight = 24;
      const menuHeight = FIELD_TYPE_OPTIONS.length * rowHeight;
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - viewportPadding);
      const above = Math.max(0, rect.top - gap - viewportPadding);
      const openBelow = below >= menuHeight || below >= above;
      const availableHeight = openBelow ? below : above;
      const height = Math.min(menuHeight, availableHeight);
      const width = Math.min(rect.width, window.innerWidth - viewportPadding * 2);
      const triggerStyle = window.getComputedStyle(triggerRef.current);

      setMenuStyle({
        position: "fixed",
        left: Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding)),
        top: openBelow ? rect.bottom + gap : Math.max(viewportPadding, rect.top - height - gap),
        width,
        maxHeight: height,
        zIndex: 1400,
        fontFamily: triggerStyle.fontFamily,
        fontSize: triggerStyle.fontSize,
        fontWeight: triggerStyle.fontWeight,
        lineHeight: triggerStyle.lineHeight,
      });
    };

    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    const closeOnOutsideClick = (event) => {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      document.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${menuId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open, menuId]);

  const selectOption = (option) => {
    onChange(option.value);
    setActiveIndex(FIELD_TYPE_OPTIONS.indexOf(option));
    setOpen(false);
  };

  const handleKeyDown = (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setActiveIndex(Math.max(0, FIELD_TYPE_OPTIONS.findIndex((option) => option.value === value)));
        setOpen(true);
      } else {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => (
          current + direction + FIELD_TYPE_OPTIONS.length
        ) % FIELD_TYPE_OPTIONS.length);
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!open) return;
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : FIELD_TYPE_OPTIONS.length - 1);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      selectOption(FIELD_TYPE_OPTIONS[activeIndex]);
    }
  };

  return (
    <>
      <select
        ref={triggerRef}
        id="lf-new-type"
        className="input-field lead-field-type-select"
        role="combobox"
        aria-label="Field Type"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-activedescendant={open ? `${menuId}-${activeIndex}` : undefined}
        value={value}
        onPointerDown={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
          setActiveIndex(Math.max(0, FIELD_TYPE_OPTIONS.findIndex((option) => option.value === value)));
          setOpen((current) => !current);
        }}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      >
        {FIELD_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {open && menuStyle && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="listbox"
          aria-label="Field Type options"
          className="lead-field-type-menu"
          style={menuStyle}
        >
          {FIELD_TYPE_OPTIONS.map((option, index) => (
            <button
              key={option.value}
              id={`${menuId}-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={value === option.value}
              className="lead-field-type-option"
              data-active={activeIndex === index}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectOption(option)}
            >
              {option.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export default function LeadFields({
  pageTitle = "Lead Fields",
  pageDescription = "Add extra fields to your Leads. Once created, a field appears on every lead’s create/edit form and detail view for your organization only.",
  showSystemFields = false,
}) {
  const { tenant } = useContext(AuthContext) || {};
  const isWellness = tenant?.vertical === "wellness";
  const collapsedGroupsStorageKey = showSystemFields && tenant?.vertical === "generic"
    ? `${COLLAPSED_GROUPS_STORAGE_PREFIX}.${tenant?.id || tenant?.tenantId || "tenant"}`
    : null;

  const notify = useNotify();
  const [fields, setFields] = useState([]);
  const [page, setPage] = useState(1);
  const [totalFields, setTotalFields] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newFieldType, setNewFieldType] = useState("text");
  const [newOptionsText, setNewOptionsText] = useState("");
  const [newTooltip, setNewTooltip] = useState("");
  const [newPlaceholder, setNewPlaceholder] = useState("");
  const [newRequired, setNewRequired] = useState(false);
  const [newFieldGroup, setNewFieldGroup] = useState("Custom Fields");
  const [savingNew, setSavingNew] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [reordering, setReordering] = useState(false);
  // Field type stays immutable after creation, but the remaining attributes
  // can be managed here. Removing a stored choice requires confirmation
  // because existing leads retain the old value.
  const [editingField, setEditingField] = useState(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [editingTooltip, setEditingTooltip] = useState("");
  const [editingPlaceholder, setEditingPlaceholder] = useState("");
  const [editingOptionsText, setEditingOptionsText] = useState("");
  const [editingRequired, setEditingRequired] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [fieldSearch, setFieldSearch] = useState("");
  const [expandedConfigRow, setExpandedConfigRow] = useState(null);
  const [collapsedConfigGroups, setCollapsedConfigGroups] = useState(() => readCollapsedConfigGroups(collapsedGroupsStorageKey));
  const [fieldConfig, setFieldConfig] = useState(DEFAULT_FIELD_CONFIG);
  const [tableColumnCatalog, setTableColumnCatalog] = useState([]);
  const [configSaving, setConfigSaving] = useState(false);
  const [configDialog, setConfigDialog] = useState(null);
  const [configDialogSaving, setConfigDialogSaving] = useState(false);
  const [draggedConfigField, setDraggedConfigField] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = async ({ silent = false, pageToLoad = page } = {}) => {
    if (!silent) setLoading(true);
    try {
      const pageSize = showSystemFields ? 100 : LEAD_FIELDS_PAGE_SIZE;
      const offset = Math.max(pageToLoad - 1, 0) * pageSize;
      const requestedPage = showSystemFields ? 1 : pageToLoad;
      const requestedOffset = showSystemFields ? 0 : offset;
      const response = await fetchApi(`/api/lead-custom-fields?page=${requestedPage}&offset=${requestedOffset}&limit=${pageSize}`);
      let data = Array.isArray(response) ? response : (Array.isArray(response?.data) ? response.data : []);
      const total = Number.isFinite(Number(response?.total)) ? Number(response.total) : data.length;
      if (showSystemFields && total > data.length) {
        const remainingRequests = [];
        for (let nextOffset = pageSize; nextOffset < total; nextOffset += pageSize) {
          const nextPage = Math.floor(nextOffset / pageSize) + 1;
          remainingRequests.push(fetchApi(`/api/lead-custom-fields?page=${nextPage}&offset=${nextOffset}&limit=${pageSize}`));
        }
        const remainingResponses = await Promise.all(remainingRequests);
        data = [
          ...data,
          ...remainingResponses.flatMap((result) => Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : [])),
        ];
      }
      if (!data.length && pageToLoad > 1 && total > 0) {
        setPage((current) => Math.max(1, current - 1));
        return;
      }
      setFields(data);
      setTotalFields(total);
      setPageOffset(showSystemFields ? 0 : (Number.isFinite(Number(response?.offset)) ? Number(response.offset) : offset));
      setPage(showSystemFields ? 1 : pageToLoad);
    } catch (err) {
      notify.error(err?.message || "Failed to load lead fields");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (isWellness) return; // gated below anyway; skip the fetch
    load({ pageToLoad: page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, isWellness, showSystemFields]);

  useEffect(() => {
    if (!showSystemFields || isWellness) return;
    let active = true;
    Promise.all([
      fetchApi(`/api/tenant-settings/${encodeURIComponent(FIELD_CONFIG_SETTING_KEY)}`, { silent: true }),
      fetchApi("/api/table-column-prefs/leads", { silent: true }).catch(() => ({ availableColumns: [] })),
    ])
      .then(([response, columnsResponse]) => {
        if (!active) return;
        setTableColumnCatalog(Array.isArray(columnsResponse?.availableColumns) ? columnsResponse.availableColumns : []);
        if (!response?.value) return;
        const parsed = JSON.parse(response.value);
        if (parsed && typeof parsed === "object") {
          setFieldConfig({
            ...DEFAULT_FIELD_CONFIG,
            ...parsed,
            fieldOverrides: parsed.fieldOverrides || {},
            groupNames: parsed.groupNames || {},
            customGroups: Array.isArray(parsed.customGroups) ? parsed.customGroups : [],
            customFieldGroups: parsed.customFieldGroups || {},
            fieldOrder: parsed.fieldOrder || {},
          });
        }
      })
      .catch(() => notify.error("Could not load the saved field layout."));
    return () => { active = false; };
  }, [isWellness, notify, showSystemFields]);

  // Lead fields are supported by Generic and Travel CRM. Wellness uses its
  // own patient-field model and must stay outside this shared definition UI.
  if (isWellness) return <Navigate to="/settings" replace />;

  const resetCreateForm = () => {
    setCreating(false);
    setNewLabel("");
    setNewFieldType("text");
    setNewOptionsText("");
    setNewTooltip("");
    setNewPlaceholder("");
    setNewRequired(false);
    setNewFieldGroup("Custom Fields");
  };

  const handleCreate = async () => {
    const trimmedLabel = newLabel.trim();
    if (!trimmedLabel) {
      notify.error("Label is required");
      return;
    }
    if (FIELD_TYPES_WITH_OPTIONS.has(newFieldType)) {
      const opts = newOptionsText.split(",").map((o) => o.trim()).filter(Boolean);
      if (!opts.length) {
        notify.error("Enter at least one option, separated by commas");
        return;
      }
    }
    setSavingNew(true);
    try {
      const body = {
        label: trimmedLabel,
        fieldType: newFieldType,
        isRequired: newRequired,
      };
      if (FIELD_TYPES_WITH_OPTIONS.has(newFieldType)) {
        body.options = newOptionsText.split(",").map((o) => o.trim()).filter(Boolean);
      }
      const tooltip = newTooltip.trim();
      const placeholder = newPlaceholder.trim();
      if (tooltip) body.tooltip = tooltip;
      if (placeholder) body.placeholder = placeholder;
      const created = await fetchApi("/api/lead-custom-fields", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (showSystemFields && created?.id && newFieldGroup !== "Custom Fields") {
        await persistFieldConfig({
          ...fieldConfig,
          customFieldGroups: {
            ...fieldConfig.customFieldGroups,
            [created.id]: newFieldGroup,
          },
        });
      }
      notify.success("Field created");
      resetCreateForm();
      await load({ silent: true });
    } catch (err) {
      notify.error(err?.message || "Failed to create field");
    } finally {
      setSavingNew(false);
    }
  };

  const handleDelete = async (field) => {
    const ok = await notify.confirm({
      title: "Delete this field?",
      message: `The "${field.label}" field will be removed, along with any values stored for it on existing leads. This cannot be undone.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(field.id);
    try {
      await fetchApi(`/api/lead-custom-fields/${field.id}`, { method: "DELETE" });
      notify.success("Field deleted");
      await load({ silent: true });
    } catch (err) {
      notify.error(err?.message || "Failed to delete field");
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleRequired = async (field) => {
    try {
      await fetchApi(`/api/lead-custom-fields/${field.id}`, {
        method: "PUT",
        body: JSON.stringify({ isRequired: !field.isRequired }),
      });
      await load({ silent: true });
    } catch (err) {
      notify.error(err?.message || "Failed to update field");
    }
  };

  // Reorder rows already loaded on the current page through the existing
  // per-field PUT contract. Page-boundary moves use the atomic server endpoint
  // below because the adjacent definition is not present in this page slice.
  const syncFieldOrder = async (nextFields) => {
    if (!Array.isArray(nextFields) || !nextFields.length || reordering) return;
    const orderedFields = normalizeFieldOrder(nextFields, pageOffset);
    setFields(orderedFields);
    setReordering(true);
    try {
      await Promise.all(
        orderedFields.map((field) =>
          fetchApi(`/api/lead-custom-fields/${field.id}`, {
            method: "PUT",
            body: JSON.stringify({ displayOrder: field.displayOrder }),
          }),
        ),
      );
      await load({ silent: true });
    } catch (err) {
      notify.error(err?.message || "Failed to reorder fields");
      await load({ silent: true });
    } finally {
      setReordering(false);
    }
  };

  const handleMoveField = async (index, direction) => {
    const swapIndex = index + direction;
    if (reordering) return;
    if (swapIndex >= 0 && swapIndex < fields.length) {
      await syncFieldOrder(arrayMove(fields, index, swapIndex));
      return;
    }

    const absoluteIndex = pageOffset + index;
    const targetAbsoluteIndex = absoluteIndex + direction;
    if (targetAbsoluteIndex < 0 || targetAbsoluteIndex >= totalFields) return;

    setReordering(true);
    try {
      await fetchApi(`/api/lead-custom-fields/${fields[index].id}/move`, {
        method: "POST",
        body: JSON.stringify({ direction: direction < 0 ? "up" : "down" }),
      });
      await load({ silent: true });
    } catch (err) {
      notify.error(err?.message || "Failed to reorder fields");
      await load({ silent: true });
    } finally {
      setReordering(false);
    }
  };

  const handleDragEnd = async ({ active, over }) => {
    if (!over || active.id === over.id || reordering) return;
    const oldIndex = fields.findIndex((field) => String(field.id) === String(active.id));
    const newIndex = fields.findIndex((field) => String(field.id) === String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    await syncFieldOrder(arrayMove(fields, oldIndex, newIndex));
  };

  const openEditModal = (field) => {
    setEditingField(field);
    setEditingLabel(field.label || "");
    setEditingTooltip(field.tooltip || "");
    setEditingPlaceholder(field.placeholder || "");
    setEditingOptionsText(Array.isArray(field.options) ? field.options.join(", ") : "");
    setEditingRequired(Boolean(field.isRequired));
  };

  const cancelFieldEditor = () => {
    setEditingField(null);
    setEditingLabel("");
    setEditingTooltip("");
    setEditingPlaceholder("");
    setEditingOptionsText("");
    setEditingRequired(false);
  };

  const handleSaveField = async () => {
    if (!editingField) return;
    const label = editingLabel.trim();
    if (!label) {
      notify.error("Label is required");
      return;
    }
    const body = {
      label,
      tooltip: editingTooltip.trim(),
      placeholder: editingPlaceholder.trim(),
      isRequired: editingRequired,
    };
    if (FIELD_TYPES_WITH_OPTIONS.has(editingField.fieldType)) {
      const newOptions = editingOptionsText.split(",").map((option) => option.trim()).filter(Boolean);
      if (!newOptions.length) {
        notify.error("Enter at least one option, separated by commas");
        return;
      }
      const oldOptions = Array.isArray(editingField.options) ? editingField.options : [];
      const removedOrRenamed = oldOptions.filter((option) => !newOptions.includes(option));
      if (removedOrRenamed.length) {
        const ok = await notify.confirm({
          title: "Some existing choices are being removed",
          message: `"${removedOrRenamed.join('", "')}" ${removedOrRenamed.length > 1 ? "are" : "is"} no longer in the list. Any lead that already has one of these values saved will keep showing it, but it won't match any selectable option going forward. Continue?`,
          confirmText: "Save anyway",
          destructive: true,
        });
        if (!ok) return;
      }
      body.options = newOptions;
    }
    setSavingEdit(true);
    try {
      await fetchApi(`/api/lead-custom-fields/${editingField.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      notify.success("Field updated");
      cancelFieldEditor();
      await load({ silent: true });
    } catch (err) {
      notify.error(err?.message || "Failed to update field");
    } finally {
      setSavingEdit(false);
    }
  };

  const normalizedSearch = fieldSearch.trim().toLowerCase();
  const systemFieldGroups = buildSystemFieldGroups(tableColumnCatalog, fieldConfig.fieldOrder);
  const visibleSystemGroups = systemFieldGroups.map((group) => {
    const groupMatchesSearch = normalizedSearch
      && (fieldConfig.groupNames?.[group.name] || group.name).toLowerCase().includes(normalizedSearch);
    return {
      ...group,
      fields: group.fields.map((field) => ({
        ...field,
        ...(fieldConfig.fieldOverrides?.[field.id] || {}),
      })).filter((field) =>
        !normalizedSearch
        || groupMatchesSearch
        || field.label.toLowerCase().includes(normalizedSearch)
        || field.fieldType.toLowerCase().includes(normalizedSearch)),
    };
  }).filter((group) => group.fields.length > 0);
  const visibleFields = normalizedSearch
    ? fields.filter((field) => [field.label, field.fieldType, field.fieldKey]
      .some((value) => String(value || "").toLowerCase().includes(normalizedSearch)))
    : fields;

  const persistFieldConfig = async (nextConfig, successMessage) => {
    const previous = fieldConfig;
    const normalizedNextConfig = {
      ...nextConfig,
      fieldOverrides: {
        ...(nextConfig.fieldOverrides || {}),
        name: { ...(nextConfig.fieldOverrides?.name || {}), quickAdd: true },
        email: { ...(nextConfig.fieldOverrides?.email || {}), quickAdd: true },
      },
    };
    setFieldConfig(normalizedNextConfig);
    setConfigSaving(true);
    try {
      await fetchApi(`/api/tenant-settings/${encodeURIComponent(FIELD_CONFIG_SETTING_KEY)}`, {
        method: "PUT",
        body: JSON.stringify({ value: JSON.stringify(normalizedNextConfig), category: "fields" }),
      });
      if (successMessage) notify.success(successMessage);
    } catch (error) {
      setFieldConfig(previous);
      notify.error(error?.message || "Could not save field configuration");
    } finally {
      setConfigSaving(false);
    }
  };

  const updateFieldOverride = (fieldId, patch, successMessage) => {
    const current = fieldConfig.fieldOverrides?.[fieldId] || {};
    return persistFieldConfig({
      ...fieldConfig,
      fieldOverrides: {
        ...fieldConfig.fieldOverrides,
        [fieldId]: { ...current, ...patch },
      },
    }, successMessage);
  };

  if (showSystemFields) {
    const moveConfigField = async (targetField, { custom, groupKey, groupFields }) => {
      const dragged = draggedConfigField;
      setDraggedConfigField(null);
      if (!dragged || dragged.custom !== custom || dragged.groupKey !== groupKey || dragged.field.id === targetField.id) return;
      if (custom) {
        const sourceIndex = fields.findIndex((field) => field.id === dragged.field.id);
        const targetIndex = fields.findIndex((field) => field.id === targetField.id);
        if (sourceIndex < 0 || targetIndex < 0) return;
        const direction = targetIndex < sourceIndex ? "up" : "down";
        setReordering(true);
        try {
          for (let index = 0; index < Math.abs(targetIndex - sourceIndex); index += 1) {
            await fetchApi(`/api/lead-custom-fields/${dragged.field.id}/move`, {
              method: "POST",
              body: JSON.stringify({ direction }),
            });
          }
          await load({ silent: true });
          notify.success("Field order updated");
        } catch (error) {
          notify.error(error?.message || "Failed to reorder field");
        } finally {
          setReordering(false);
        }
        return;
      }
      const orderedIds = groupFields.map((field) => field.id);
      const sourceIndex = orderedIds.indexOf(dragged.field.id);
      const targetIndex = orderedIds.indexOf(targetField.id);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const nextOrder = [...orderedIds];
      const [moved] = nextOrder.splice(sourceIndex, 1);
      nextOrder.splice(targetIndex, 0, moved);
      await persistFieldConfig({
        ...fieldConfig,
        fieldOrder: { ...fieldConfig.fieldOrder, [groupKey]: nextOrder },
      }, "Field order updated");
    };

    const toggleConfigGroup = (name) => {
      setCollapsedConfigGroups((current) => {
        const next = new Set(current);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        if (collapsedGroupsStorageKey) {
          try {
            window.localStorage.setItem(collapsedGroupsStorageKey, JSON.stringify([...next]));
          } catch {
            // Field Config remains usable when browser storage is unavailable.
          }
        }
        return next;
      });
    };

    const renderConfigRow = (field, { custom = false, groupKey, groupFields } = {}) => {
      const rowId = custom ? `custom-${field.id}` : `system-${field.id}`;
      const overrideId = custom ? `custom:${field.id}` : field.id;
      const configuredField = { ...field, ...(fieldConfig.fieldOverrides?.[overrideId] || {}) };
      const quickAddEligible = !configuredField.readOnly && (custom || QUICK_ADD_SYSTEM_FIELD_IDS.has(field.id));
      const quickAddLocked = quickAddEligible && !custom && LOCKED_QUICK_ADD_FIELD_IDS.has(field.id);
      const isExpanded = expandedConfigRow === rowId;
      const options = Array.isArray(configuredField.options) ? configuredField.options : [];
      const editTooltip = () => setConfigDialog({ kind: "tooltip", title: `Tooltip for ${configuredField.label}`, field, custom, overrideId, value: configuredField.tooltip || "" });
      const editChoices = () => custom && setConfigDialog({ kind: "choices", title: `Choices for ${configuredField.label}`, field, value: options.join(", ") });
      const viewChoices = () => !custom && setConfigDialog({ kind: "viewChoices", title: `Choices for ${configuredField.label}`, options });
      const editCustomField = () => custom && setConfigDialog({ kind: "field", title: `Edit ${configuredField.label}`, field, label: configuredField.label, tooltip: configuredField.tooltip || "" });
      return (
        <div
          className={`field-config-row${isExpanded ? " is-expanded" : ""}`}
          key={rowId}
          onDragOver={(event) => {
            if (!normalizedSearch && draggedConfigField?.custom === custom && draggedConfigField?.groupKey === groupKey) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            moveConfigField(field, { custom, groupKey, groupFields });
          }}
        >
          <div className="field-config-row-main">
            <button
              type="button"
              className="field-config-drag"
              draggable={!normalizedSearch && !reordering && !configSaving}
              disabled={Boolean(normalizedSearch) || reordering || configSaving}
              aria-label={`Drag ${configuredField.label} to move up or down`}
              title={normalizedSearch ? "Clear search to reorder fields" : "Drag to move field up or down"}
              onDragStart={() => setDraggedConfigField({ field, custom, groupKey })}
              onDragEnd={() => setDraggedConfigField(null)}
            ><GripVertical size={18} /></button>
            <span className="field-config-type-icon" aria-hidden="true"><FieldTypeGlyph fieldType={configuredField.fieldType} /></span>
            <button type="button" className="field-config-name" onClick={() => setExpandedConfigRow(isExpanded ? null : rowId)}>{configuredField.label}</button>
            <label className="field-config-check">
              <input
                type="checkbox"
                checked={Boolean(configuredField.isRequired ?? configuredField.required)}
                disabled={configSaving || configuredField.readOnly}
                onChange={() => custom
                  ? handleToggleRequired(field)
                  : updateFieldOverride(overrideId, { required: !configuredField.required })}
              />
              <span>Required</span>
            </label>
            <label className="field-config-check">
              <input
                type="checkbox"
                checked={quickAddLocked || (quickAddEligible && Boolean(configuredField.quickAdd))}
                disabled={configSaving || !quickAddEligible || quickAddLocked}
                onChange={() => updateFieldOverride(overrideId, { quickAdd: !configuredField.quickAdd })}
              />
              <span>Quick-add</span>
            </label>
            <div className="field-config-meta">
              {options.length > 0 ? (
                <>
                  <span className="field-config-chip"><List size={14} /> {options.length} {options.length === 1 ? "choice" : "choices"} added</span>
                  {custom ? <button type="button" className="field-config-inline-action" onClick={editChoices}>Add/Edit choices</button> : <button type="button" className="field-config-inline-action" onClick={viewChoices}>View choices</button>}
                </>
              ) : (
                <>
                  <span className="field-config-chip is-muted"><Info size={14} /> {configuredField.tooltip ? "Tooltip added" : "Tooltip not added"}</span>
                  <button type="button" className="field-config-inline-action" onClick={editTooltip}>{configuredField.tooltip ? "Edit tooltip" : "Add tooltip"}</button>
                </>
              )}
            </div>
            <button
              type="button"
              className="field-config-chevron"
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${configuredField.label}`}
              aria-expanded={isExpanded}
              onClick={() => setExpandedConfigRow(isExpanded ? null : rowId)}
            >
              <ChevronDown size={17} />
            </button>
          </div>
          {isExpanded && (
            <div className="field-config-row-details">
              <div>
                <span className="field-config-detail-label">Field key</span>
                <code>{custom ? `cf_${field.fieldKey}` : field.id}</code>
                {field.unique ? <span className="field-config-unique">Unique</span> : null}
              </div>
              <div className="field-config-row-actions">
                {custom ? (
                  <>
                    <label className="field-config-group-select">
                      Group
                      <select
                        value={fieldConfig.customFieldGroups?.[field.id] || "Custom Fields"}
                        onChange={(event) => persistFieldConfig({
                          ...fieldConfig,
                          customFieldGroups: { ...fieldConfig.customFieldGroups, [field.id]: event.target.value },
                        }, "Field moved")}
                      >
                        <option value="Custom Fields">Custom Fields</option>
                        {fieldConfig.customGroups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
                      </select>
                    </label>
                    <button type="button" className="field-config-button" onClick={editCustomField}><Pencil size={15} /> Edit field</button>
                    <button type="button" className="field-config-button" onClick={() => handleDelete(field)} disabled={deletingId === field.id}><Trash2 size={15} /> Delete field</button>
                    <button type="button" className="field-config-button" onClick={() => handleMoveField(fields.findIndex((item) => item.id === field.id), -1)} disabled={reordering}><ArrowUp size={15} /> Move up</button>
                    <button type="button" className="field-config-button" onClick={() => handleMoveField(fields.findIndex((item) => item.id === field.id), 1)} disabled={reordering}><ArrowDown size={15} /> Move down</button>
                  </>
                ) : <span className="field-config-system-note">{configuredField.readOnly ? "Captured automatically from lead attribution and stored as read-only tracking data." : "Required, Quick-add and tooltip settings are saved for this generic CRM tenant."}</span>}
              </div>
            </div>
          )}
        </div>
      );
    };

    const moveConfigGroup = (groupKey, direction) => {
      const available = [
        ...systemFieldGroups.map((group) => group.name),
        "Custom Fields",
        ...fieldConfig.customGroups.map((group) => group.id),
      ];
      const ordered = [...new Set([...(fieldConfig.groupOrder || []), ...available])].filter((key) => available.includes(key));
      const index = ordered.indexOf(groupKey);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) return;
      [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
      persistFieldConfig({ ...fieldConfig, groupOrder: ordered }, "Group order updated");
    };

    const renameConfigGroup = (groupKey, currentName, customGroup = false) => setConfigDialog({ kind: "renameGroup", title: "Rename group", groupKey, customGroup, value: currentName });

    const deleteConfigGroup = async (groupKey, displayName) => {
      const assignedFields = fields.filter((field) => fieldConfig.customFieldGroups?.[field.id] === groupKey);
      if (assignedFields.length) {
        await notify.confirm({
          title: "Move fields before deleting this group",
          message: `The "${displayName}" group contains ${assignedFields.length} ${assignedFields.length === 1 ? "field" : "fields"}. Move ${assignedFields.length === 1 ? "it" : "them"} to another group using the Group selector, then delete this group.`,
          confirmText: "Got it",
          destructive: true,
        });
        return;
      }

      const ok = await notify.confirm({
        title: "Delete this group?",
        message: `Are you sure you want to delete the empty "${displayName}" group? This cannot be undone.`,
        confirmText: "Delete group",
        destructive: true,
      });
      if (!ok) return;

      await persistFieldConfig({
        ...fieldConfig,
        customGroups: fieldConfig.customGroups.filter((group) => group.id !== groupKey),
        groupOrder: fieldConfig.groupOrder.filter((key) => key !== groupKey),
        customFieldGroups: Object.fromEntries(Object.entries(fieldConfig.customFieldGroups)
          .map(([fieldId, assigned]) => [fieldId, assigned === groupKey ? "Custom Fields" : assigned])),
      }, "Group deleted");
    };

    const renderConfigGroup = (name, groupFields, { custom = false, groupKey = name, customGroup = false } = {}) => {
      const isCollapsed = collapsedConfigGroups.has(groupKey);
      const displayName = customGroup ? name : (fieldConfig.groupNames?.[groupKey] || name);
      return (
        <section className="field-config-group" key={groupKey} aria-label={displayName}>
          <div className="field-config-group-header">
            <button type="button" className="field-config-group-title" onClick={() => toggleConfigGroup(groupKey)} aria-expanded={!isCollapsed}>
              <Folder size={23} />
              <strong>{displayName}</strong>
              <ChevronDown size={17} className={isCollapsed ? "is-collapsed" : ""} />
            </button>
            <div className="field-config-group-actions">
              <button type="button" className="field-config-icon-button" onClick={() => moveConfigGroup(groupKey, -1)} aria-label={`Move ${displayName} up`}><ArrowUp size={16} /></button>
              <button type="button" className="field-config-icon-button" onClick={() => moveConfigGroup(groupKey, 1)} aria-label={`Move ${displayName} down`}><ArrowDown size={16} /></button>
              <button type="button" className="field-config-icon-button" aria-label={`Edit ${displayName}`} onClick={() => renameConfigGroup(groupKey, displayName, customGroup)}><Pencil size={15} /></button>
              {customGroup ? <button type="button" className="field-config-icon-button" aria-label={`Delete ${displayName}`} onClick={() => deleteConfigGroup(groupKey, displayName)} disabled={configSaving}><Trash2 size={15} /></button> : null}
              {custom ? <button type="button" className="field-config-button" onClick={() => openCreateField(groupKey)}><Plus size={16} /> Add field</button> : null}
            </div>
          </div>
          {!isCollapsed && (
            <div className="field-config-rows">
              {groupFields.length ? groupFields.map((field) => renderConfigRow(field, { custom, groupKey, groupFields })) : (
                <div className="field-config-empty">No fields match your search.</div>
              )}
            </div>
          )}
        </section>
      );
    };

    const addConfigGroup = () => setConfigDialog({ kind: "addGroup", title: "Add group", value: "" });

    const openCreateField = (groupKey = "Custom Fields") => {
      setNewFieldGroup(groupKey);
      setCreating(true);
    };

    const customFieldsSource = normalizedSearch && "custom fields".includes(normalizedSearch) ? fields : visibleFields;
    const defaultCustomFields = customFieldsSource.filter((field) => {
      const assigned = fieldConfig.customFieldGroups?.[field.id];
      return !assigned || assigned === "Custom Fields" || !fieldConfig.customGroups.some((group) => group.id === assigned);
    });
    const groupEntries = [
      ...visibleSystemGroups.map((group) => ({ key: group.name, name: group.name, fields: group.fields })),
      { key: "Custom Fields", name: "Custom Fields", fields: defaultCustomFields, custom: true },
      ...fieldConfig.customGroups.map((group) => ({
        key: group.id,
        name: group.name,
        fields: (normalizedSearch && group.name.toLowerCase().includes(normalizedSearch) ? fields : visibleFields)
          .filter((field) => fieldConfig.customFieldGroups?.[field.id] === group.id),
        custom: true,
        customGroup: true,
      })),
    ];
    const groupOrder = [...new Set([...(fieldConfig.groupOrder || []), ...groupEntries.map((group) => group.key)])];
    groupEntries.sort((a, b) => groupOrder.indexOf(a.key) - groupOrder.indexOf(b.key));

    const submitConfigDialog = async () => {
      if (!configDialog) return;
      setConfigDialogSaving(true);
      try {
        if (configDialog.kind === "tooltip") {
          if (configDialog.custom) {
            await fetchApi(`/api/lead-custom-fields/${configDialog.field.id}`, { method: "PUT", body: JSON.stringify({ tooltip: configDialog.value }) });
            await load({ silent: true });
          } else {
            await updateFieldOverride(configDialog.overrideId, { tooltip: configDialog.value });
          }
          notify.success("Tooltip updated");
        } else if (configDialog.kind === "choices") {
          const options = configDialog.value.split(",").map((option) => option.trim()).filter(Boolean);
          if (!options.length) throw new Error("Enter at least one choice");
          await fetchApi(`/api/lead-custom-fields/${configDialog.field.id}`, { method: "PUT", body: JSON.stringify({ options }) });
          await load({ silent: true });
          notify.success("Choices updated");
        } else if (configDialog.kind === "field") {
          const label = configDialog.label.trim();
          if (!label) throw new Error("Field label is required");
          await fetchApi(`/api/lead-custom-fields/${configDialog.field.id}`, { method: "PUT", body: JSON.stringify({ label, tooltip: configDialog.tooltip }) });
          await load({ silent: true });
          notify.success("Field updated");
        } else if (configDialog.kind === "addGroup") {
          const name = configDialog.value.trim();
          if (!name) throw new Error("Group name is required");
          const id = `group-${Date.now()}`;
          await persistFieldConfig({ ...fieldConfig, customGroups: [...fieldConfig.customGroups, { id, name }], groupOrder: [...fieldConfig.groupOrder, id] });
          notify.success("Group added");
        } else if (configDialog.kind === "renameGroup") {
          const name = configDialog.value.trim();
          if (!name) throw new Error("Group name is required");
          if (configDialog.customGroup) {
            await persistFieldConfig({ ...fieldConfig, customGroups: fieldConfig.customGroups.map((group) => group.id === configDialog.groupKey ? { ...group, name } : group) });
          } else {
            await persistFieldConfig({ ...fieldConfig, groupNames: { ...fieldConfig.groupNames, [configDialog.groupKey]: name } });
          }
          notify.success("Group renamed");
        }
        setConfigDialog(null);
      } catch (error) {
        notify.error(error?.message || "Could not save changes");
      } finally {
        setConfigDialogSaving(false);
      }
    };

    return (
      <div className="field-config-page">
        <h1 className="sr-only">{pageTitle}</h1>
        <div className="field-config-toolbar">
          <label className="field-config-search">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">Search fields</span>
            <input type="search" value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} placeholder="Search fields" aria-label="Search fields" />
          </label>
          <div className="field-config-toolbar-actions">
            <button type="button" className="field-config-button" onClick={() => openCreateField()}><Plus size={16} /> Add field</button>
            <button type="button" className="field-config-button" onClick={addConfigGroup}><Plus size={16} /> Add group</button>
          </div>
        </div>

        {loading ? (
          <div className="field-config-loading"><Loader size={18} className="spin" /> Loading fields…</div>
        ) : groupEntries.map((group) => renderConfigGroup(group.name, group.fields, { custom: group.custom, groupKey: group.key, customGroup: group.customGroup }))}

        {creating && (
          <section className="field-config-create" aria-label="Add field">
            <div className="field-config-create-heading">
              <div><Plus size={18} /><strong>Add field</strong></div>
              <button type="button" className="field-config-icon-button" onClick={resetCreateForm} aria-label="Close add field">×</button>
            </div>
            <div className="field-config-create-grid">
              <FormField label="Label" htmlFor="fc-new-label"><input id="fc-new-label" className="input-field" value={newLabel} onChange={(event) => setNewLabel(event.target.value)} placeholder="e.g. Referral Source" maxLength={80} /></FormField>
              <FormField label="Field type" htmlFor="fc-new-type"><select id="fc-new-type" className="input-field" value={newFieldType} onChange={(event) => setNewFieldType(event.target.value)}>{FIELD_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField>
              <FormField label="Group" htmlFor="fc-new-group"><select id="fc-new-group" className="input-field" value={newFieldGroup} onChange={(event) => setNewFieldGroup(event.target.value)}><option value="Custom Fields">Custom Fields</option>{fieldConfig.customGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></FormField>
              {FIELD_TYPES_WITH_OPTIONS.has(newFieldType) ? <FormField label="Choices" htmlFor="fc-new-options"><input id="fc-new-options" className="input-field" value={newOptionsText} onChange={(event) => setNewOptionsText(event.target.value)} placeholder="Google, Referral, Event" /></FormField> : null}
              <FormField label="Tooltip" htmlFor="fc-new-tooltip"><input id="fc-new-tooltip" className="input-field" value={newTooltip} onChange={(event) => setNewTooltip(event.target.value)} placeholder="Explain what this field captures" maxLength={255} /></FormField>
              <FormField label="Placeholder" htmlFor="fc-new-placeholder"><input id="fc-new-placeholder" className="input-field" value={newPlaceholder} onChange={(event) => setNewPlaceholder(event.target.value)} placeholder="Hint shown inside the field" maxLength={255} /></FormField>
              <label className="field-config-create-required"><input type="checkbox" checked={newRequired} onChange={(event) => setNewRequired(event.target.checked)} /> Required</label>
            </div>
            <div className="field-config-create-actions">
              <button type="button" className="field-config-button" onClick={resetCreateForm}>Cancel</button>
              <button type="button" className="btn-primary" onClick={handleCreate} disabled={savingNew}>{savingNew ? "Saving…" : "Save field"}</button>
            </div>
          </section>
        )}
        {configDialog && (
          <div className="field-config-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !configDialogSaving) setConfigDialog(null); }}>
            <section className="field-config-create" role="dialog" aria-modal="true" aria-labelledby="field-config-dialog-title">
              <div className="field-config-create-heading">
                <div><Pencil size={18} /><strong id="field-config-dialog-title">{configDialog.title}</strong></div>
                <button type="button" className="field-config-icon-button" onClick={() => setConfigDialog(null)} disabled={configDialogSaving} aria-label="Close dialog">×</button>
              </div>
              <div className="field-config-dialog-fields">
                {configDialog.kind === "viewChoices" ? (
                  <div aria-label={configDialog.title} style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    {configDialog.options.map((option) => <span className="field-config-chip" key={option}>{option}</span>)}
                  </div>
                ) : configDialog.kind === "field" ? (
                  <>
                    <FormField label="Field label" htmlFor="fc-dialog-label"><input id="fc-dialog-label" className="input-field" value={configDialog.label} onChange={(event) => setConfigDialog((current) => ({ ...current, label: event.target.value }))} autoFocus /></FormField>
                    <FormField label="Tooltip" htmlFor="fc-dialog-tooltip"><textarea id="fc-dialog-tooltip" className="input-field" rows={3} value={configDialog.tooltip} onChange={(event) => setConfigDialog((current) => ({ ...current, tooltip: event.target.value }))} /></FormField>
                  </>
                ) : (
                  <FormField label={configDialog.kind === "choices" ? "Choices (comma-separated)" : configDialog.kind.includes("Group") ? "Group name" : "Tooltip"} htmlFor="fc-dialog-value">
                    {configDialog.kind === "choices" || configDialog.kind === "tooltip"
                      ? <textarea id="fc-dialog-value" className="input-field" rows={4} value={configDialog.value} onChange={(event) => setConfigDialog((current) => ({ ...current, value: event.target.value }))} autoFocus />
                      : <input id="fc-dialog-value" className="input-field" value={configDialog.value} onChange={(event) => setConfigDialog((current) => ({ ...current, value: event.target.value }))} autoFocus />}
                  </FormField>
                )}
              </div>
              <div className="field-config-create-actions">
                {configDialog.kind === "viewChoices" ? (
                  <button type="button" className="btn-primary" onClick={() => setConfigDialog(null)}>Close</button>
                ) : (
                  <>
                    <button type="button" className="field-config-button" onClick={() => setConfigDialog(null)} disabled={configDialogSaving}>Cancel</button>
                    <button type="button" className="btn-primary" onClick={submitConfigDialog} disabled={configDialogSaving}>{configDialogSaving ? "Saving…" : "Save"}</button>
                  </>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={tenant?.vertical === "travel" ? "lead-fields-page" : undefined}
      style={{ padding: "2rem", paddingBottom: "3rem", maxWidth: showSystemFields ? "1180px" : "860px", margin: "0 auto", animation: "fadeIn 0.3s ease" }}
    >
      {tenant?.vertical === "travel" && (
        <Link to="/leads" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: 13, textDecoration: "none", marginBottom: 16 }}>
          <ArrowLeft size={16} /> Back to Leads
        </Link>
      )}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", margin: "0 0 0.25rem" }}>{pageTitle}</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
            {pageDescription}
          </p>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: "1.5rem" }}>
        <div style={{ padding: "1.25rem 1.25rem 0", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Existing Fields</h3>
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              className="btn-primary"
              style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}
            >
              <Plus size={16} /> Add Field
            </button>
          )}
        </div>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-secondary)", padding: "1.5rem" }}>
            <Loader size={16} className="spin" /> Loading…
          </div>
        ) : fields.length === 0 ? (
          <EmptyState
            icon={<ListChecks size={40} />}
            heading="No custom fields yet"
            body="Add your first field below to start capturing extra details on every lead."
          />
        ) : visibleFields.length === 0 ? (
          <div style={{ padding: "1.5rem", color: "var(--text-secondary)" }}>No custom fields match your search.</div>
        ) : (
          <div style={{ marginTop: "0.75rem", paddingBottom: "0.5rem" }}>
            <TopScrollSync>
              <div style={{ background: "var(--bg-color)" }}>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <table className="stable-table" style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", tableLayout: "fixed" }}>
                    <thead>
                      <tr style={{ background: "var(--subtle-bg)", display: "table", width: "100%", tableLayout: "fixed" }}>
                        <th scope="col" style={th}>Order</th>
                        <th scope="col" style={th}>Label</th>
                        <th scope="col" style={th}>Type</th>
                        <th scope="col" style={th}>Key</th>
                        <th scope="col" style={th}>Options</th>
                        <th scope="col" style={th}>Required</th>
                        <th scope="col" style={th}>Action</th>
                      </tr>
                    </thead>
                    <SortableContext items={visibleFields.map((field) => String(field.id))} strategy={verticalListSortingStrategy}>
                      <tbody style={{ display: "block", maxHeight: "clamp(280px, calc(100vh - 430px), 720px)", overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain" }}>
                        {visibleFields.map((field) => (
                          <SortableLeadFieldRow
                            key={field.id}
                            field={field}
                            index={fields.findIndex((item) => item.id === field.id)}
                            total={totalFields}
                            indexOffset={pageOffset}
                            reordering={reordering}
                            onMove={handleMoveField}
                            onEdit={openEditModal}
                            onDelete={handleDelete}
                            onToggleRequired={handleToggleRequired}
                            deletingId={deletingId}
                          />
                        ))}
                      </tbody>
                    </SortableContext>
                  </table>
                </DndContext>
              </div>
            </TopScrollSync>
            {totalFields > 0 ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", padding: "0.75rem 1rem 0", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                <span>{pageOffset + 1}-{Math.min(pageOffset + fields.length, totalFields)} of {totalFields}</span>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button type="button" className="btn-secondary" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
                  <button type="button" className="btn-secondary" disabled={page >= Math.ceil(totalFields / LEAD_FIELDS_PAGE_SIZE) || loading} onClick={() => setPage((current) => current + 1)}>Next</button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {creating && (
        <div className="card" style={{ padding: "1.25rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
            <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>New Field</h3>

            <FormField label="Label" htmlFor="lf-new-label">
              <input
                id="lf-new-label"
                type="text"
                className="input-field"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Referral Source"
                maxLength={80}
              />
            </FormField>

            <FormField label="Field Type" htmlFor="lf-new-type">
              <FieldTypeSelect value={newFieldType} onChange={setNewFieldType} />
            </FormField>

            {FIELD_TYPES_WITH_OPTIONS.has(newFieldType) && (
              <FormField label="Options" hint="Comma-separated, e.g. Google, Referral, Event" htmlFor="lf-new-options">
                <input
                  id="lf-new-options"
                  type="text"
                  className="input-field"
                  value={newOptionsText}
                  onChange={(e) => setNewOptionsText(e.target.value)}
                  placeholder="Google, Referral, Event"
                />
              </FormField>
            )}

            <FormField label="Tooltip" hint="Shown near the input to explain what this field is for" htmlFor="lf-new-tooltip">
              <input
                id="lf-new-tooltip"
                type="text"
                className="input-field"
                value={newTooltip}
                onChange={(e) => setNewTooltip(e.target.value)}
                placeholder="e.g. Where did this lead first hear about us?"
                maxLength={255}
              />
            </FormField>

            <FormField label="Placeholder" hint="Hint text shown inside the input when empty" htmlFor="lf-new-placeholder">
              <input
                id="lf-new-placeholder"
                type="text"
                className="input-field"
                value={newPlaceholder}
                onChange={(e) => setNewPlaceholder(e.target.value)}
                placeholder="e.g. Enter referral source"
                maxLength={255}
              />
            </FormField>

            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", color: "var(--text-primary)" }}>
              <input
                type="checkbox"
                checked={newRequired}
                onChange={(e) => setNewRequired(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              Required
            </label>

            <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.25rem" }}>
              <button onClick={handleCreate} disabled={savingNew} className="btn-primary">
                {savingNew ? "Saving…" : "Save Field"}
              </button>
              <button onClick={resetCreateForm} disabled={savingNew} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {editingField && (
        <div
          className="field-config-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingEdit) cancelFieldEditor();
          }}
        >
          <section
            className="field-config-create"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lead-field-edit-title"
          >
            <div className="field-config-create-heading">
              <div>
                <Pencil size={18} />
                <strong id="lead-field-edit-title">Edit {editingField.label}</strong>
              </div>
              <button
                type="button"
                className="field-config-icon-button"
                onClick={cancelFieldEditor}
                disabled={savingEdit}
                aria-label="Close edit field"
              >
                &times;
              </button>
            </div>
            <div className="field-config-dialog-fields">
              <FormField label="Label" htmlFor="lf-edit-label">
                <input
                  id="lf-edit-label"
                  className="input-field"
                  value={editingLabel}
                  onChange={(event) => setEditingLabel(event.target.value)}
                  maxLength={80}
                  autoFocus
                />
              </FormField>
              <FormField label="Field type" hint="Field type cannot be changed after creation" htmlFor="lf-edit-type">
                <input
                  id="lf-edit-type"
                  className="input-field"
                  value={FIELD_TYPE_LABELS[editingField.fieldType] || editingField.fieldType}
                  readOnly
                />
              </FormField>
              {FIELD_TYPES_WITH_OPTIONS.has(editingField.fieldType) && (
                <FormField label="Options" hint="Comma-separated choices" htmlFor="lf-edit-options">
                  <input
                    id="lf-edit-options"
                    className="input-field"
                    value={editingOptionsText}
                    onChange={(event) => setEditingOptionsText(event.target.value)}
                    placeholder="Google, Referral, Event"
                  />
                </FormField>
              )}
              <FormField label="Tooltip" htmlFor="lf-edit-tooltip">
                <textarea
                  id="lf-edit-tooltip"
                  className="input-field"
                  rows={3}
                  value={editingTooltip}
                  onChange={(event) => setEditingTooltip(event.target.value)}
                  maxLength={255}
                />
              </FormField>
              <FormField label="Placeholder" htmlFor="lf-edit-placeholder">
                <input
                  id="lf-edit-placeholder"
                  className="input-field"
                  value={editingPlaceholder}
                  onChange={(event) => setEditingPlaceholder(event.target.value)}
                  maxLength={255}
                />
              </FormField>
              <label className="field-config-create-required">
                <input
                  type="checkbox"
                  checked={editingRequired}
                  onChange={(event) => setEditingRequired(event.target.checked)}
                />
                Required
              </label>
            </div>
            <div className="field-config-create-actions">
              <button type="button" className="field-config-button" onClick={cancelFieldEditor} disabled={savingEdit}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={handleSaveField} disabled={savingEdit}>
                {savingEdit ? "Saving..." : "Save changes"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
