import { useState, useRef, useEffect } from "react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

// ── InlineCellEditor — click-to-add/edit/remove a single custom-field cell
// directly in a table row (Freshsales-style), instead of only being able to
// edit via a separate full Edit-Contact modal.
//
// Click the cell (whether it's empty — "+ Click to add" — or already has a
// value) to reveal the appropriate input for `field.fieldType`. Saves via
// PUT /api/contacts/:id with a body of ONLY { customFields: { [fieldKey]:
// value } } — the backend's writeLeadCustomFieldValues touches just that
// one field, leaving every other value on the contact untouched.
//
// Save behavior: text/textarea/number/url/date save on blur or Enter;
// Escape cancels without saving. dropdown/radio/checkbox save immediately
// on change (there's no "typing" to commit). multiselect stays open until
// the user clicks away (blur), same as a single-select's Escape/blur rule.
// An explicit "×" clears the value (writes null) without opening the editor.
//
// Props:
//   contactId, field ({ id, fieldKey, label, fieldType, options, tooltip,
//     placeholder }), value (the CURRENT raw value, already unwrapped from
//     contact.customFields[field.fieldKey]), onSaved(newValue) — called
//     after a successful save so the parent can update its local state
//     without a full page refetch.
export default function InlineCellEditor({ contactId, field, value, onSaved }) {
  const notify = useNotify();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const startEdit = () => {
    setDraft(field.fieldType === "multiselect" ? (Array.isArray(value) ? value : []) : (value ?? ""));
    setEditing(true);
  };

  const save = async (nextValue) => {
    setSaving(true);
    try {
      await fetchApi(`/api/contacts/${contactId}`, {
        method: "PUT",
        body: JSON.stringify({ customFields: { [field.fieldKey]: nextValue } }),
      });
      onSaved?.(nextValue);
      setEditing(false);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || `Failed to save ${field.label}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async (e) => {
    e.stopPropagation();
    await save(null);
  };

  if (!editing) {
    const isEmpty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    let display;
    if (isEmpty) {
      display = <span style={{ color: "var(--accent-color)", fontSize: "0.8rem" }}>+ Click to add</span>;
    } else if (field.fieldType === "checkbox") {
      display = value ? "Yes" : "No";
    } else if (field.fieldType === "multiselect") {
      display = Array.isArray(value) ? value.join(", ") : String(value);
    } else if (field.fieldType === "url") {
      display = (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "var(--accent-color)" }}>
          {String(value)}
        </a>
      );
    } else {
      display = String(value);
    }
    return (
      <div
        onClick={startEdit}
        title={field.tooltip || `Click to edit ${field.label}`}
        style={{
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.4rem",
          minHeight: "1.4rem",
          padding: "0.15rem 0.3rem",
          borderRadius: 4,
        }}
        className="inline-cell-editor-display"
      >
        <span>{display}</span>
        {!isEmpty && (
          <button
            type="button"
            onClick={handleClear}
            title={`Clear ${field.label}`}
            aria-label={`Clear ${field.label}`}
            style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.85rem", padding: "0 0.2rem", opacity: 0.6 }}
          >
            ×
          </button>
        )}
      </div>
    );
  }

  const commonProps = {
    ref: inputRef,
    disabled: saving,
    style: { width: "100%", padding: "0.3rem 0.4rem", fontSize: "0.85rem" },
    className: "input-field",
  };

  if (field.fieldType === "checkbox") {
    // No typing to commit — flip + save immediately, no separate blur step.
    return (
      <input
        ref={inputRef}
        type="checkbox"
        checked={Boolean(draft)}
        disabled={saving}
        onChange={(e) => save(e.target.checked)}
        onBlur={() => setEditing(false)}
      />
    );
  }

  if (field.fieldType === "dropdown" || field.fieldType === "radio") {
    return (
      <select
        {...commonProps}
        value={draft}
        onChange={(e) => save(e.target.value)}
        onBlur={() => setEditing(false)}
      >
        <option value="">Select…</option>
        {(field.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  }

  if (field.fieldType === "multiselect") {
    const selected = Array.isArray(draft) ? draft : [];
    return (
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", padding: "0.3rem", border: "1px solid var(--border-color)", borderRadius: 6, background: "var(--bg-color, #fff)" }}
        onBlur={(e) => {
          // Only commit+close when focus leaves the whole group, not when it
          // moves between checkboxes inside it.
          if (!e.currentTarget.contains(e.relatedTarget)) save(selected);
        }}
      >
        {(field.options || []).map((opt) => (
          <label key={opt} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.78rem" }}>
            <input
              type="checkbox"
              checked={selected.includes(opt)}
              disabled={saving}
              onChange={(e) => {
                const next = e.target.checked ? [...selected, opt] : selected.filter((s) => s !== opt);
                setDraft(next);
              }}
            />
            {opt}
          </label>
        ))}
      </div>
    );
  }

  const onKeyDown = (e) => {
    if (e.key === "Enter" && field.fieldType !== "textarea") { e.preventDefault(); save(draft); }
    if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
  };

  if (field.fieldType === "textarea") {
    return (
      <textarea
        {...commonProps}
        rows={2}
        value={draft}
        placeholder={field.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => save(draft)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setEditing(false); } }}
      />
    );
  }

  const inputType = field.fieldType === "date" ? "date" : field.fieldType === "number" ? "number" : field.fieldType === "url" ? "url" : "text";
  return (
    <input
      {...commonProps}
      type={inputType}
      value={draft}
      placeholder={field.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => save(draft)}
      onKeyDown={onKeyDown}
    />
  );
}
