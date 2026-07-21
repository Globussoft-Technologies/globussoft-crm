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
import { Plus, Trash2, Loader, ListChecks, ArrowUp, ArrowDown, Pencil, Check, X } from "lucide-react";
import { AuthContext } from "../../App";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { EmptyState, FormField } from "../../components/ui";
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
  // Editing options (add/rename/remove choices) for a dropdown/radio/
  // multiselect field. Renaming or removing a choice that's already stored
  // on some lead's value doesn't retroactively fix that lead's data (the
  // stored string just stops matching any option) — surfaced as a one-time
  // warning on save rather than blocked outright, since adding options is
  // always safe and blocking the whole editor would punish the safe case too.
  const [editingOptionsId, setEditingOptionsId] = useState(null);
  const [editingOptionsText, setEditingOptionsText] = useState("");
  const [savingOptions, setSavingOptions] = useState(false);

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
    if (isWellness || isTravel) return; // gated below anyway; skip the fetch
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Generic-vertical-only feature — redirect wellness/travel tenants away
  // rather than rendering an inapplicable admin page for them.
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

  // Swaps this field's displayOrder with its neighbour in `direction`
  // (-1 = up, +1 = down). No bulk /reorder endpoint exists for this
  // resource (unlike Pipeline Stages), so this swaps the two rows'
  // displayOrder via two calls to the existing per-field PUT — fine at the
  // scale a settings page like this operates at (a handful of fields).
  // Optimistic UI update first so the row visibly moves immediately;
  // reload() on failure undoes it and surfaces the error.
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

  const openOptionsEditor = (field) => {
    setEditingOptionsId(field.id);
    setEditingOptionsText(Array.isArray(field.options) ? field.options.join(", ") : "");
  };

  const cancelOptionsEditor = () => {
    setEditingOptionsId(null);
    setEditingOptionsText("");
  };

  const handleSaveOptions = async (field) => {
    const newOpts = editingOptionsText.split(",").map((o) => o.trim()).filter(Boolean);
    if (!newOpts.length) {
      notify.error("Enter at least one option, separated by commas");
      return;
    }
    const oldOpts = Array.isArray(field.options) ? field.options : [];
    const removedOrRenamed = oldOpts.filter((o) => !newOpts.includes(o));
    if (removedOrRenamed.length) {
      const ok = await notify.confirm({
        title: "Some existing choices are being removed",
        message: `"${removedOrRenamed.join('", "')}" ${removedOrRenamed.length > 1 ? "are" : "is"} no longer in the list. Any lead that already has one of these values saved will keep showing it, but it won't match any selectable option going forward. Continue?`,
        confirmText: "Save anyway",
        destructive: true,
      });
      if (!ok) return;
    }
    setSavingOptions(true);
    try {
      await fetchApi(`/api/lead-custom-fields/${field.id}`, {
        method: "PUT",
        body: JSON.stringify({ options: newOpts }),
      });
      notify.success("Options updated");
      cancelOptionsEditor();
      await load();
    } catch (err) {
      notify.error(err?.message || "Failed to update options");
    } finally {
      setSavingOptions(false);
    }
  };

  return (
    <div style={{ padding: "2rem", maxWidth: "860px", margin: "0 auto", animation: "fadeIn 0.3s ease" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "0.25rem" }}>Lead Fields</h1>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
        Add extra fields to your Leads. Once created, a field appears on every lead&rsquo;s create/edit form and detail view for your organization only.
      </p>

      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: "1.5rem" }}>
        <div style={{ padding: "1.25rem 1.25rem 0" }}>
          <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Existing Fields</h3>
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
        ) : (
          <div style={{ marginTop: "0.75rem" }}>
          <TopScrollSync>
            <table className="stable-table" style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr style={{ background: "var(--subtle-bg)" }}>
                  <th style={{ ...th, width: "72px" }}>Order</th>
                  <th style={th}>Label</th>
                  <th style={th}>Type</th>
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
                    <td style={{ ...td, color: "var(--text-secondary)" }}>
                      {editingOptionsId === f.id ? (
                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                          <input
                            type="text"
                            className="input-field"
                            value={editingOptionsText}
                            onChange={(e) => setEditingOptionsText(e.target.value)}
                            placeholder="Comma-separated options"
                            style={{ minWidth: "220px", padding: "0.4rem 0.6rem", fontSize: "0.85rem" }}
                            autoFocus
                          />
                          <button
                            onClick={() => handleSaveOptions(f)}
                            disabled={savingOptions}
                            aria-label="Save options"
                            title="Save"
                            style={{ ...iconBtn, color: "var(--success-color, #22c55e)" }}
                          >
                            {savingOptions ? <Loader size={14} className="spin" /> : <Check size={14} />}
                          </button>
                          <button
                            onClick={cancelOptionsEditor}
                            disabled={savingOptions}
                            aria-label="Cancel editing options"
                            title="Cancel"
                            style={iconBtn}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : FIELD_TYPES_WITH_OPTIONS.has(f.fieldType) ? (
                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                          <span>{Array.isArray(f.options) ? f.options.join(", ") : "—"}</span>
                          <button
                            onClick={() => openOptionsEditor(f)}
                            aria-label={`Edit options for ${f.label}`}
                            title="Edit options"
                            style={iconBtn}
                          >
                            <Pencil size={12} />
                          </button>
                        </div>
                      ) : (
                        "—"
                      )}
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
                      <button
                        onClick={() => handleDelete(f)}
                        disabled={deletingId === f.id}
                        aria-label={`Delete ${f.label}`}
                        title="Delete field"
                        style={{ ...iconBtn, color: "var(--danger-color, #ef4444)" }}
                      >
                        {deletingId === f.id ? <Loader size={14} className="spin" /> : <Trash2 size={14} />}
                      </button>
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
                {savingNew ? "Saving…" : "Save Field"}
              </button>
              <button onClick={resetCreateForm} disabled={savingNew} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
