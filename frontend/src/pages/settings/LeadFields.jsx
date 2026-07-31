/**
 * /settings/lead-fields — Lead Custom Fields admin page.
 *
 * Backend: /api/lead-custom-fields (routes/lead_custom_fields.js).
 * ADMIN-only page (RoleGuard wrap at the App.jsx route). Generic vertical
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

import { useContext, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Plus, Trash2, Loader, ListChecks, ArrowUp, ArrowDown, Pencil } from "lucide-react";
import { AuthContext } from "../../App";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { EmptyState, FormField, Modal } from "../../components/ui";
import TopScrollSync from "../../components/TopScrollSync";

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

const FIELD_TYPE_LABELS = Object.fromEntries(FIELD_TYPE_OPTIONS.map((o) => [o.value, o.label]));

const th = { padding: "0.75rem 1rem", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-secondary)", fontWeight: 600 };
const td = { padding: "0.75rem 1rem", fontSize: "0.9rem" };
const iconBtn = { background: "var(--subtle-bg)", border: "1px solid var(--border-color)", borderRadius: 6, padding: "0.375rem 0.5rem", cursor: "pointer", display: "inline-flex", alignItems: "center" };

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

export default function LeadFields() {
  const { tenant } = useContext(AuthContext) || {};
  const isWellness = tenant?.vertical === "wellness";
  const isTravel = tenant?.vertical === "travel";

  const notify = useNotify();
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newFieldType, setNewFieldType] = useState("text");
  const [newOptionsText, setNewOptionsText] = useState("");
  const [newTooltip, setNewTooltip] = useState("");
  const [newPlaceholder, setNewPlaceholder] = useState("");
  const [newRequired, setNewRequired] = useState(false);
  const [savingNew, setSavingNew] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [reordering, setReordering] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [editLabel, setEditLabel] = useState("");
  const [editOptionsText, setEditOptionsText] = useState("");
  const [editTooltip, setEditTooltip] = useState("");
  const [editPlaceholder, setEditPlaceholder] = useState("");
  const [editRequired, setEditRequired] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchApi("/api/lead-custom-fields");
      setFields(Array.isArray(data) ? data : []);
    } catch (err) {
      notify.error(err?.message || "Failed to load lead fields");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isWellness || isTravel) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isWellness || isTravel) {
    return <Navigate to="/settings" replace />;
  }

  const resetCreateForm = () => {
    setCreating(false);
    setNewLabel("");
    setNewFieldType("text");
    setNewOptionsText("");
    setNewTooltip("");
    setNewPlaceholder("");
    setNewRequired(false);
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
      await fetchApi("/api/lead-custom-fields", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success("Field created");
      resetCreateForm();
      await load();
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
      await load();
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
      await load();
    } catch (err) {
      notify.error(err?.message || "Failed to update field");
    }
  };

  const handleMoveField = async (index, direction) => {
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= fields.length || reordering) return;
    const a = fields[index];
    const b = fields[swapIndex];
    const reordered = [...fields];
    [reordered[index], reordered[swapIndex]] = [reordered[swapIndex], reordered[index]];
    setFields(reordered);
    setReordering(true);
    try {
      await Promise.all([
        fetchApi(`/api/lead-custom-fields/${a.id}`, { method: "PUT", body: JSON.stringify({ displayOrder: b.displayOrder }) }),
        fetchApi(`/api/lead-custom-fields/${b.id}`, { method: "PUT", body: JSON.stringify({ displayOrder: a.displayOrder }) }),
      ]);
      await load();
    } catch (err) {
      notify.error(err?.message || "Failed to reorder fields");
      await load();
    } finally {
      setReordering(false);
    }
  };

  const openEditModal = (field) => {
    setEditingField(field);
    setEditLabel(field.label || "");
    setEditOptionsText(getOptionsText(field.options));
    setEditTooltip(field.tooltip || "");
    setEditPlaceholder(field.placeholder || "");
    setEditRequired(Boolean(field.isRequired));
  };

  const closeEditModal = () => {
    if (savingEdit) return;
    setEditingField(null);
    setEditLabel("");
    setEditOptionsText("");
    setEditTooltip("");
    setEditPlaceholder("");
    setEditRequired(false);
  };

  const editOptions = editOptionsText.split(",").map((o) => o.trim()).filter(Boolean);

  const handleSaveEdit = async () => {
    if (!editingField) return;
    const trimmedLabel = editLabel.trim();
    if (!trimmedLabel) {
      notify.error("Label is required");
      return;
    }
    if (FIELD_TYPES_WITH_OPTIONS.has(editingField.fieldType) && !editOptions.length) {
      notify.error("Enter at least one option, separated by commas");
      return;
    }

    const oldOpts = Array.isArray(editingField.options) ? editingField.options : [];
    const removedOrRenamed = oldOpts.filter((option) => !editOptions.includes(option));
    if (FIELD_TYPES_WITH_OPTIONS.has(editingField.fieldType) && removedOrRenamed.length) {
      const ok = await notify.confirm({
        title: "Some existing choices are being removed",
        message: `"${removedOrRenamed.join('", "')}" ${removedOrRenamed.length > 1 ? "are" : "is"} no longer in the list. Any lead that already has one of these values saved will keep showing it, but it won't match any selectable option going forward. Continue?`,
        confirmText: "Save anyway",
        destructive: true,
      });
      if (!ok) return;
    }

    const body = {
      label: trimmedLabel,
      tooltip: editTooltip.trim(),
      placeholder: editPlaceholder.trim(),
      isRequired: editRequired,
    };
    if (FIELD_TYPES_WITH_OPTIONS.has(editingField.fieldType)) {
      body.options = editOptions;
    }

    setSavingEdit(true);
    try {
      await fetchApi(`/api/lead-custom-fields/${editingField.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      notify.success("Field updated");
      closeEditModal();
      await load();
    } catch (err) {
      notify.error(err?.message || "Failed to update field");
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div style={{ padding: "2rem", maxWidth: "860px", margin: "0 auto", animation: "fadeIn 0.3s ease" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "0.25rem" }}>Lead Fields</h1>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
        Add extra fields to your Leads. Once created, a field appears on every lead&apos;s create/edit form and detail view for your organization only.
      </p>

      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: "1.5rem" }}>
        <div style={{ padding: "1.25rem 1.25rem 0" }}>
          <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Existing Fields</h3>
        </div>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-secondary)", padding: "1.5rem" }}>
            <Loader size={16} className="spin" /> Loading...
          </div>
        ) : fields.length === 0 ? (
          <EmptyState
            icon={<ListChecks size={40} />}
            heading="No custom fields yet"
            body="Add your first field below to start capturing extra details on every lead."
          />
        ) : (
          <div style={{ marginTop: "0.75rem" }}>
            <TopScrollSync>
              <table className="stable-table" style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr style={{ background: "var(--subtle-bg)" }}>
                    <th style={{ ...th, width: "72px" }}>Order</th>
                    <th style={th}>Label</th>
                    <th style={th}>Type</th>
                    <th style={th}>Key</th>
                    <th style={th}>Options</th>
                    <th style={th}>Required</th>
                    <th style={{ ...th, textAlign: "right" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f, index) => (
                    <tr key={f.id} style={{ borderTop: "1px solid var(--border-color)" }}>
                      <td style={{ ...td, display: "flex", gap: "0.15rem" }}>
                        <button
                          onClick={() => handleMoveField(index, -1)}
                          disabled={index === 0 || reordering}
                          aria-label={`Move ${f.label} up`}
                          title="Move up"
                          style={{
                            background: "none",
                            border: "none",
                            padding: "0.2rem",
                            color: index === 0 ? "var(--border-color)" : "var(--text-secondary)",
                            cursor: index === 0 ? "default" : "pointer",
                          }}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          onClick={() => handleMoveField(index, 1)}
                          disabled={index === fields.length - 1 || reordering}
                          aria-label={`Move ${f.label} down`}
                          title="Move down"
                          style={{
                            background: "none",
                            border: "none",
                            padding: "0.2rem",
                            color: index === fields.length - 1 ? "var(--border-color)" : "var(--text-secondary)",
                            cursor: index === fields.length - 1 ? "default" : "pointer",
                          }}
                        >
                          <ArrowDown size={14} />
                        </button>
                      </td>
                      <td style={{ ...td, fontWeight: 500 }}>{f.label}</td>
                      <td style={td}>{FIELD_TYPE_LABELS[f.fieldType] || f.fieldType}</td>
                      <td title={`cf_${f.fieldKey}`} style={{ ...td, fontFamily: "monospace", color: "var(--text-secondary)", whiteSpace: "normal", wordBreak: "break-word", overflowWrap: "anywhere", minWidth: "170px" }}>{`cf_${f.fieldKey}`}</td>
                      <td style={{ ...td, color: "var(--text-secondary)" }}>
                        {FIELD_TYPES_WITH_OPTIONS.has(f.fieldType) ? (Array.isArray(f.options) ? f.options.join(", ") : "") : ""}
                      </td>
                      <td style={td}>
                        <input
                          type="checkbox"
                          checked={Boolean(f.isRequired)}
                          onChange={() => handleToggleRequired(f)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: "0.4rem" }}>
                          <button
                            onClick={() => openEditModal(f)}
                            aria-label={`Edit ${f.label}`}
                            title="Edit field"
                            style={iconBtn}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => handleDelete(f)}
                            disabled={deletingId === f.id}
                            aria-label={`Delete ${f.label}`}
                            title="Delete field"
                            style={{ ...iconBtn, color: "var(--danger-color, #ef4444)" }}
                          >
                            {deletingId === f.id ? <Loader size={14} className="spin" /> : <Trash2 size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TopScrollSync>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: "1.25rem" }}>
        {!creating ? (
          <button
            onClick={() => setCreating(true)}
            className="btn-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}
          >
            <Plus size={16} /> Add Field
          </button>
        ) : (
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
              <select
                id="lf-new-type"
                className="input-field"
                value={newFieldType}
                onChange={(e) => setNewFieldType(e.target.value)}
              >
                {FIELD_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
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
                {savingNew ? "Saving..." : "Save Field"}
              </button>
              <button onClick={resetCreateForm} disabled={savingNew} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={Boolean(editingField)}
        title={editingField ? `Edit ${editingField.label}` : "Edit field"}
        onClose={closeEditModal}
        size="large"
        footer={(
          <>
            <button onClick={closeEditModal} disabled={savingEdit} className="btn-secondary">
              Cancel
            </button>
            <button onClick={handleSaveEdit} disabled={savingEdit} className="btn-primary">
              {savingEdit ? "Saving..." : "Save Changes"}
            </button>
          </>
        )}
      >
        {editingField && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(260px, 1fr)", gap: "1.25rem" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <FormField label="Label" htmlFor="lf-edit-label">
                <input
                  id="lf-edit-label"
                  type="text"
                  className="input-field"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  maxLength={80}
                  autoFocus
                />
              </FormField>

              <FormField label="Field Type" htmlFor="lf-edit-type" hint="Field type cannot be changed after creation.">
                <input
                  id="lf-edit-type"
                  type="text"
                  className="input-field"
                  value={FIELD_TYPE_LABELS[editingField.fieldType] || editingField.fieldType}
                  disabled
                />
              </FormField>

              <FormField label="Stored Key" htmlFor="lf-edit-key" hint="This is the custom-field key used across lead records and table columns.">
                <input
                  id="lf-edit-key"
                  type="text"
                  className="input-field"
                  value={`cf_${editingField.fieldKey}`}
                  disabled
                />
              </FormField>

              {FIELD_TYPES_WITH_OPTIONS.has(editingField.fieldType) && (
                <FormField label="Options" hint="Comma-separated, e.g. Google, Referral, Event" htmlFor="lf-edit-options">
                  <textarea
                    id="lf-edit-options"
                    className="input-field"
                    value={editOptionsText}
                    onChange={(e) => setEditOptionsText(e.target.value)}
                    placeholder="Google, Referral, Event"
                    rows={4}
                  />
                </FormField>
              )}

              <FormField label="Tooltip" hint="Shown near the input to explain what this field is for" htmlFor="lf-edit-tooltip">
                <input
                  id="lf-edit-tooltip"
                  type="text"
                  className="input-field"
                  value={editTooltip}
                  onChange={(e) => setEditTooltip(e.target.value)}
                  maxLength={255}
                />
              </FormField>

              <FormField label="Placeholder" hint="Hint text shown inside the input when empty" htmlFor="lf-edit-placeholder">
                <input
                  id="lf-edit-placeholder"
                  type="text"
                  className="input-field"
                  value={editPlaceholder}
                  onChange={(e) => setEditPlaceholder(e.target.value)}
                  maxLength={255}
                />
              </FormField>

              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem", color: "var(--text-primary)" }}>
                <input
                  type="checkbox"
                  checked={editRequired}
                  onChange={(e) => setEditRequired(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                Required on lead create and edit forms
              </label>
            </div>

            <div
              style={{
                border: "1px solid var(--border-color)",
                borderRadius: 12,
                padding: "1rem",
                background: "var(--subtle-bg-2, rgba(255,255,255,0.02))",
                alignSelf: "start",
              }}
            >
              <div style={{ marginBottom: "0.75rem" }}>
                <div style={{ fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-secondary)", marginBottom: "0.35rem" }}>
                  Preview
                </div>
                <div style={{ fontSize: "0.95rem", fontWeight: 600 }}>
                  {editLabel.trim() || "Field label"}
                  {editRequired ? " *" : ""}
                </div>
                {editTooltip.trim() ? (
                  <div style={{ marginTop: "0.35rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                    {editTooltip.trim()}
                  </div>
                ) : null}
              </div>
              {renderFieldPreview(
                {
                  ...editingField,
                  placeholder: editPlaceholder.trim(),
                },
                editOptionsText,
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}




