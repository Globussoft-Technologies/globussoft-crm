import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { fetchApi } from "../utils/api";

const LEAD_CUSTOM_FIELD_TYPE_OPTIONS = [
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

const LEAD_CUSTOM_FIELD_TYPES_WITH_OPTIONS = new Set([
  "dropdown",
  "radio",
  "multiselect",
]);

function normalizeFieldIdentity(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
}

export default function LeadFieldCreateModal({ onClose, onCreated, notify, existingFields = [], reservedFields = [] }) {
  const [label, setLabel] = useState("");
  const [fieldType, setFieldType] = useState("text");
  const [optionsText, setOptionsText] = useState("");
  const [tooltip, setTooltip] = useState("");
  const [placeholder, setPlaceholder] = useState("");
  const [isRequired, setIsRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [labelError, setLabelError] = useState("");

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  const validateLabel = () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setLabelError("Label is required.");
      return false;
    }
    const candidate = normalizeFieldIdentity(trimmedLabel);
    const duplicateExists = [...existingFields, ...reservedFields].some((field) => (
      [field?.fieldKey, field?.key, field?.value, field?.id, field?.label]
        .map(normalizeFieldIdentity)
        .filter(Boolean)
        .includes(candidate)
    ));
    setLabelError(duplicateExists ? "A field with this name already exists." : "");
    return !duplicateExists;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmedLabel = label.trim();
    if (!validateLabel()) return;

    const options = optionsText
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean);
    if (
      LEAD_CUSTOM_FIELD_TYPES_WITH_OPTIONS.has(fieldType) &&
      !options.length
    ) {
      notify.error("Enter at least one option, separated by commas");
      return;
    }

    setSaving(true);
    try {
      const body = {
        label: trimmedLabel,
        fieldType,
        isRequired,
      };
      if (LEAD_CUSTOM_FIELD_TYPES_WITH_OPTIONS.has(fieldType)) {
        body.options = options;
      }
      if (tooltip.trim()) body.tooltip = tooltip.trim();
      if (placeholder.trim()) body.placeholder = placeholder.trim();

      const created = await fetchApi("/api/lead-custom-fields", {
        method: "POST",
        body: JSON.stringify(body),
        silent: true,
      });
      notify.success("Field created");
      onCreated(created);
    } catch (err) {
      if (["DUPLICATE_FIELD_KEY", "RESERVED_FIELD_KEY"].includes(err?.code)) {
        setLabelError("A field with this name already exists.");
      } else {
        notify.error(err?.message || "Failed to create field");
      }
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        overflow: "hidden",
        background: "rgba(15, 23, 42, 0.48)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-field-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: "min(560px, calc(100vw - 2rem))",
          minWidth: 0,
          boxSizing: "border-box",
          maxHeight: "min(720px, calc(100vh - 2rem))",
          overflowY: "auto",
          overflowX: "hidden",
          padding: "1.5rem",
          borderRadius: 14,
          background: "var(--modal-bg, var(--surface-color, #ffffff))",
          color: "var(--text-primary)",
          boxShadow: "0 24px 64px rgba(15, 23, 42, 0.28)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            minWidth: 0,
            marginBottom: "1.25rem",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h2
              id="lead-field-modal-title"
              style={{ margin: 0, fontSize: "1.15rem" }}
            >
              Add Lead Field
            </h2>
            <p
              style={{
                margin: "0.35rem 0 0",
                color: "var(--text-secondary)",
                fontSize: "0.85rem",
              }}
            >
              Add a field for this organization&rsquo;s leads.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close Add Lead Field"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 6,
              border: "1px solid var(--border-color)",
              borderRadius: 7,
              background: "var(--surface-color)",
              color: "var(--text-secondary)",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            <X size={17} />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
            minWidth: 0,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem", minWidth: 0, fontSize: "0.85rem", fontWeight: 600 }}>
            Label
            <input
              id="lead-field-modal-label"
              type="text"
              className="input-field"
              value={label}
              onChange={(event) => { setLabel(event.target.value); if (labelError) setLabelError(""); }}
              onBlur={validateLabel}
              placeholder="e.g. Referral Source"
              maxLength={80}
              autoFocus
              aria-invalid={Boolean(labelError)}
              style={{ width: "100%", maxWidth: "100%", minWidth: 0 }}
            />
            {labelError ? <span role="alert" style={{ color: "var(--danger-color, #ef4444)", fontSize: "0.75rem", fontWeight: 400 }}>{labelError}</span> : null}
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem", minWidth: 0, fontSize: "0.85rem", fontWeight: 600 }}>
            Field Type
            <select
              className="input-field"
              value={fieldType}
              onChange={(event) => setFieldType(event.target.value)}
              style={{ width: "100%", maxWidth: "100%", minWidth: 0 }}
            >
              {LEAD_CUSTOM_FIELD_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {LEAD_CUSTOM_FIELD_TYPES_WITH_OPTIONS.has(fieldType) && (
            <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem", minWidth: 0, fontSize: "0.85rem", fontWeight: 600 }}>
              Options
              <span style={{ color: "var(--text-secondary)", fontSize: "0.78rem", fontWeight: 400 }}>
                Comma-separated, for example: Google, Referral, Event
              </span>
              <input
                type="text"
                className="input-field"
                value={optionsText}
                onChange={(event) => setOptionsText(event.target.value)}
                placeholder="Google, Referral, Event"
                style={{ width: "100%", maxWidth: "100%", minWidth: 0 }}
              />
            </label>
          )}

          <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem", minWidth: 0, fontSize: "0.85rem", fontWeight: 600 }}>
            Tooltip
            <span style={{ color: "var(--text-secondary)", fontSize: "0.78rem", fontWeight: 400 }}>
              Optional explanation shown near the field.
            </span>
            <input
              type="text"
              className="input-field"
              value={tooltip}
              onChange={(event) => setTooltip(event.target.value)}
              placeholder="e.g. Where did this lead hear about us?"
              maxLength={255}
              style={{ width: "100%", maxWidth: "100%", minWidth: 0 }}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem", minWidth: 0, fontSize: "0.85rem", fontWeight: 600 }}>
            Placeholder
            <span style={{ color: "var(--text-secondary)", fontSize: "0.78rem", fontWeight: 400 }}>
              Optional hint shown inside the field.
            </span>
            <input
              type="text"
              className="input-field"
              value={placeholder}
              onChange={(event) => setPlaceholder(event.target.value)}
              placeholder="e.g. Enter referral source"
              maxLength={255}
              style={{ width: "100%", maxWidth: "100%", minWidth: 0 }}
            />
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={isRequired}
              onChange={(event) => setIsRequired(event.target.checked)}
            />
            Required
          </label>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", flexWrap: "wrap", minWidth: 0, marginTop: "0.25rem" }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Saving..." : "Save Field"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
