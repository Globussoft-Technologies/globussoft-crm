import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, Search, GripVertical, Trash2 } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

const EMPTY_HIDDEN_COLUMN_KEYS = Object.freeze([]);

// ── ColumnPicker — "Customize table" column-visibility popover ─────
//
// Generic-vertical-only feature (Settings > Lead Fields' sibling — this is
// the "which columns show" picker, Freshsales-style). Backed by
// GET/PUT /api/table-column-prefs/:tableKey. Personal per-user preference
// — every user picks their own layout, nothing here is admin-gated.
//
// Structurally mirrors MultiSelectDropdown.jsx's portal + fixed-position +
// outside-click pattern, but with its own Apply/Reset footer (rather than
// live-apply-on-toggle) so a user can freely check/uncheck several columns
// before committing — matches the reference screenshot's "Apply" button.
//
// tableKey: "leads" | "contacts". onColumnsChange(visibleKeys: string[])
// fires after a successful save, so the parent table re-renders with the
// new column set immediately (no extra round-trip — the parent already
// has availableColumns cached from the initial GET this component does).
export default function ColumnPicker({
  tableKey,
  onColumnsChange,
  onAvailableColumnsChange,
  hiddenColumnKeys = EMPTY_HIDDEN_COLUMN_KEYS,
  deletableColumns = [],
  onFieldDeleted,
  triggerLabel = 'Customize table',
  density,
  onDensityChange,
  onManageFields,
}) {
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [available, setAvailable] = useState([]); // [{key, label}]
  const [draftVisible, setDraftVisible] = useState([]); // working set while the popover is open
  const [popoverPos, setPopoverPos] = useState(null);
  const [draggedKey, setDraggedKey] = useState(null);
  const [dropKey, setDropKey] = useState(null);
  const [deletingKey, setDeletingKey] = useState(null);
  const [selectedDeleteKeys, setSelectedDeleteKeys] = useState([]);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const loadedOnce = useRef(false);
  // Generic Leads reset matches the first-load calling-focused layout.
  // Every other catalog column remains available as an opt-in choice.
  const leadsDefaultColumns = [
    "name",
    "phone",
    "email",
    "campaign",
    "callStatus",
    "callifiedAi",
    "callifiedScore",
    "source",
    "webForm",
    "createdAt",
    "lastUpdated",
    "actions",
  ];

  // Name identifies each row and Actions contains the row controls, so both
  // are structural columns rather than reorderable fields. Keep them at the
  // edges everywhere, including for preferences saved by older versions.
  const normalizeColumnOrder = (keys, columns = available) => {
    const availableKeys = new Set(columns.map((column) => column.key));
    const unique = [];
    for (const rawKey of Array.isArray(keys) ? keys : []) {
      const key = tableKey === "leads" && rawKey === "description"
        ? "note"
        : rawKey;
      if ((!columns.length || availableKeys.has(key)) && !unique.includes(key)) {
        unique.push(key);
      }
    }
    if (!columns.length) return unique;
    const first = availableKeys.has("name") ? ["name"] : [];
    const middle = unique.filter((key) => key !== "name" && key !== "actions");
    const actions = availableKeys.has("actions") ? ["actions"] : [];
    return [...first, ...middle, ...actions];
  };

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchApi(`/api/table-column-prefs/${tableKey}`);
      // A well-formed response always has both fields as arrays (see
      // backend/routes/table_column_preferences.js's GET handler). If the
      // response is malformed/unexpected (e.g. an error body, or `null`),
      // fail safe by leaving the parent's default column set alone —
      // do NOT call onColumnsChange with an empty array, which would
      // silently hide every optional column instead of just falling back.
      if (!Array.isArray(data?.visible)) {
        loadedOnce.current = true;
        return;
      }
      const availableColumns = (Array.isArray(data.availableColumns) ? data.availableColumns : [])
        .map((column) => tableKey === "leads" && column.key === "lifecycleStage"
          ? { ...column, label: "Status" }
          : column);
      const pickerColumns = availableColumns.filter(
        (column) => !hiddenColumnKeys.includes(column.key),
      );
      setAvailable(pickerColumns);
      onAvailableColumnsChange?.(availableColumns);
      const normalizedVisible = normalizeColumnOrder(data.visible, pickerColumns);
      setDraftVisible(normalizedVisible);
      onColumnsChange?.(normalizedVisible);
      loadedOnce.current = true;
    } catch (_err) {
      // Best-effort — a failed load just means the table falls back to
      // whatever the parent's default column set is; not worth a toast for
      // a preference-loading hiccup.
    } finally {
      setLoading(false);
    }
  };

  // Load once on mount so the parent table gets the saved column set
  // immediately, even before the user ever opens the picker.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenColumnKeys, tableKey]);

  useEffect(() => {
    if (!open) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const onOpenColumnPicker = (event) => {
      const targetTableKey = event?.detail?.tableKey;
      if (targetTableKey && targetTableKey !== tableKey) return;
      setOpen(true);
    };
    window.addEventListener("globuscrm:open-table-column-picker", onOpenColumnPicker);
    return () => {
      window.removeEventListener("globuscrm:open-table-column-picker", onOpenColumnPicker);
    };
  }, [tableKey]);

  useEffect(() => {
    if (!open) {
      setDraggedKey(null);
      setDropKey(null);
    }
  }, [open]);

  const computePos = () => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const gutter = 12;
    const gap = 6;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(320, Math.max(0, viewportWidth - gutter * 2));
    const preferredHeight = Math.min(density ? 600 : 420, Math.max(0, viewportHeight - gutter * 2));
    const spaceBelow = viewportHeight - rect.bottom - gap - gutter;
    const spaceAbove = rect.top - gap - gutter;
    const minUsefulHeight = Math.min(240, preferredHeight);
    const useViewport = Math.max(spaceAbove, spaceBelow) < minUsefulHeight;
    const openAbove = !useViewport && spaceBelow < minUsefulHeight && spaceAbove > spaceBelow;
    const maxHeight = useViewport ? preferredHeight : openAbove
      ? Math.min(preferredHeight, spaceAbove)
      : Math.min(preferredHeight, spaceBelow);
    return {
      left: Math.max(gutter, Math.min(rect.right - width, viewportWidth - width - gutter)),
      top: useViewport ? gutter : openAbove ? rect.top - gap - maxHeight : rect.bottom + gap,
      width,
      maxHeight,
    };
  };

  useEffect(() => {
    if (!open) return undefined;
    setPopoverPos(computePos());
    const recompute = () => setPopoverPos(computePos());
    const onDoc = (e) => {
      const insideWrap = wrapRef.current && wrapRef.current.contains(e.target);
      const insidePopover = popoverRef.current && popoverRef.current.contains(e.target);
      if (!insideWrap && !insidePopover) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  const toggleColumn = (key) => {
    setDraftVisible((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      return normalizeColumnOrder(next);
    });
  };

  const moveVisibleColumn = (fromKey, toKey = null) => {
    setDraftVisible((prev) => {
      const fromIndex = prev.indexOf(fromKey);
      if (fromIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      // A locked edge column is a visual drop zone, not a valid destination.
      // Dropping onto Name inserts immediately after it; dropping onto
      // Actions inserts immediately before it.
      if (!toKey || toKey === "actions") {
        const actionsIndex = next.indexOf("actions");
        next.splice(actionsIndex < 0 ? next.length : actionsIndex, 0, moved);
        return normalizeColumnOrder(next);
      }
      if (toKey === "name") {
        next.splice(next.indexOf("name") + 1, 0, moved);
        return normalizeColumnOrder(next);
      }
      const toIndex = next.indexOf(toKey);
      if (toIndex < 0) {
        const actionsIndex = next.indexOf("actions");
        next.splice(actionsIndex < 0 ? next.length : actionsIndex, 0, moved);
        return normalizeColumnOrder(next);
      }
      // A downward drop should occupy the target row's original position.
      // Since removing the source shifts that target up by one slot, insert
      // after it; upward drops continue to insert before the target.
      next.splice(fromIndex < prev.indexOf(toKey) ? toIndex + 1 : toIndex, 0, moved);
      return normalizeColumnOrder(next);
    });
  };

  const handleDragStart = (key) => (event) => {
    if (!draftVisible.includes(key)) return;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", key);
      } catch (_err) {
        // jsdom and some browsers may not allow writing arbitrary payloads;
        // the component keeps the dragged key in React state as the source of truth.
      }
    }
    setDraggedKey(key);
    setDropKey(key);
  };

  const handleDragOver = (key = null) => (event) => {
    if (!draggedKey) return;
    if (key === null && event.target !== event.currentTarget) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setDropKey(key);
  };

  const handleDrop = (key = null) => (event) => {
    if (key === null && event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    if (draggedKey) {
      moveVisibleColumn(draggedKey, key);
    }
    setDraggedKey(null);
    setDropKey(null);
  };

  const handleDragEnd = () => {
    setDraggedKey(null);
    setDropKey(null);
  };

  const handleApply = async () => {
    setSaving(true);
    try {
      const data = await fetchApi(`/api/table-column-prefs/${tableKey}`, {
        method: "PUT",
        body: JSON.stringify({ visible: normalizeColumnOrder(draftVisible) }),
      });
      const saved = normalizeColumnOrder(
        Array.isArray(data.visible) ? data.visible : draftVisible,
      );
      setDraftVisible(saved);
      onColumnsChange?.(saved);
      setOpen(false);
    } catch (err) {
      notify.error(err?.message || "Failed to save column preferences");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (tableKey === "leads") {
      setDraftVisible(
        normalizeColumnOrder(
          leadsDefaultColumns.filter((key) => available.some((column) => column.key === key)),
        ),
      );
      return;
    }
    // Other tables keep the previous behaviour: every builtin column
    // visible, custom-field columns opt-in.
    setDraftVisible(
      normalizeColumnOrder(available.filter((c) => !c.key.startsWith("cf_")).map((c) => c.key)),
    );
  };

  const handleDeleteField = async (column) => {
    const definition = deletableColumns.find((item) => item.key === column.key);
    if (!definition?.id) return;
    const confirmed = await notify.confirm({
      title: "Delete this field?",
      message: `The "${column.label}" field will be removed, along with any values stored for it on existing leads. This cannot be undone.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!confirmed) return;

    setDeletingKey(column.key);
    try {
      await fetchApi(`/api/lead-custom-fields/${definition.id}`, {
        method: "DELETE",
      });
      setAvailable((current) => current.filter((item) => item.key !== column.key));
      setDraftVisible((current) => current.filter((key) => key !== column.key));
      setSelectedDeleteKeys((current) => current.filter((key) => key !== column.key));
      onFieldDeleted?.(definition);
      notify.success("Field deleted");
    } catch (err) {
      notify.error(err?.message || "Failed to delete field");
    } finally {
      setDeletingKey(null);
    }
  };

  const handleDeleteSelected = async () => {
    const selected = available.filter((column) => selectedDeleteKeys.includes(column.key));
    const definitions = selected
      .map((column) => ({ column, definition: deletableColumns.find((item) => item.key === column.key) }))
      .filter(({ definition }) => definition?.id);
    if (!definitions.length) return;

    const confirmed = await notify.confirm({
      title: `Delete ${definitions.length} fields?`,
      message: `These fields and their stored values will be removed from existing leads. This cannot be undone.`,
      confirmText: "Delete fields",
      destructive: true,
    });
    if (!confirmed) return;

    setDeletingKey("__multiple__");
    try {
      await Promise.all(definitions.map(({ definition }) => fetchApi(`/api/lead-custom-fields/${definition.id}`, { method: "DELETE" })));
      const deletedKeys = new Set(definitions.map(({ column }) => column.key));
      setAvailable((current) => current.filter((item) => !deletedKeys.has(item.key)));
      setDraftVisible((current) => current.filter((key) => !deletedKeys.has(key)));
      setSelectedDeleteKeys([]);
      definitions.forEach(({ definition }) => onFieldDeleted?.(definition));
      notify.success(`${definitions.length} fields deleted`);
    } catch (err) {
      notify.error(err?.message || "Failed to delete selected fields");
    } finally {
      setDeletingKey(null);
    }
  };

  const filtered = search.trim()
    ? available.filter((c) => c.label.toLowerCase().includes(search.trim().toLowerCase()))
    : available;

  const availableByKey = new Map(available.map((c) => [c.key, c]));
  const searchTerm = search.trim().toLowerCase();
  const isLockedFn = (column) => column.key === "name" || Boolean(column.lockedVisible);
  const matchesSearch = (column) =>
    !searchTerm || column.label.toLowerCase().includes(searchTerm);
  const normalizedDraftVisible = normalizeColumnOrder(draftVisible);
  const shownKeys = new Set(normalizedDraftVisible);
  // Locked columns (identity `name`, always-on `actions`) are always shown —
  // merge them in so older saved preferences that predate the key still
  // display them as fixed instead of dropping them into "not shown".
  for (const c of available) {
    if (c.lockedVisible) shownKeys.add(c.key);
  }
  if (availableByKey.has("name")) shownKeys.add("name");
  const shown = normalizeColumnOrder([...shownKeys])
    .map((key) => availableByKey.get(key))
    .filter(Boolean)
    .filter(matchesSearch);
  const hidden = filtered.filter((c) => !shownKeys.has(c.key));
  const deletableHidden = hidden.filter((column) => deletableColumns.some((item) => item.key === column.key));
  const hasSelectedDeleteFields = selectedDeleteKeys.length > 0;
  const showGenericLeadClearSelection = tableKey === "leads" && Boolean(density);

  return (
    <div ref={wrapRef} className={`column-picker-control${density ? ' leads-view-control' : ''}`} style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-secondary"
        disabled={loading}
        aria-haspopup="true"
        aria-expanded={open}
        style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}
      >
        <SlidersHorizontal size={15} /> {triggerLabel}
      </button>
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Customize table columns"
          style={{
            position: "fixed",
            ...popoverPos,
            zIndex: 1100,
            background: "var(--bg-color, #fff)",
            border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
            borderRadius: 10,
            boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
            display: "flex",
            flexDirection: "column",
            boxSizing: "border-box",
          }}
        >
          {density && <div style={{ padding: '14px 14px 8px' }}><p style={{ fontSize: '.65rem', letterSpacing: '.06em', color: 'var(--text-secondary)', margin: '0 0 9px' }}>ROW DENSITY</p><div style={{ display: 'flex', gap: 8 }}>{['comfortable', 'compact'].map((value) => <button key={value} type="button" className="btn-secondary" aria-pressed={density === value} onClick={() => onDensityChange?.(value)} style={{ flex: 1, borderRadius: 999, fontSize: '.75rem', padding: '7px 12px', borderColor: density === value ? 'var(--primary-color, var(--accent-color))' : undefined, color: density === value ? 'var(--primary-color, var(--accent-color))' : undefined }}>{value === 'compact' ? 'Compact' : 'Comfortable'}</button>)}</div></div>}
          <div style={{ padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--border-color)" }}>
            <div style={{ position: "relative" }}>
              <Search size={14} style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary)" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fields"
                aria-label="Search columns"
                className="input-field"
                style={{ width: "100%", minWidth: 0, boxSizing: "border-box", padding: "0.4rem 0.6rem 0.4rem 1.9rem", fontSize: "0.85rem" }}
              />
            </div>
          </div>
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "0.5rem 0" }}>
            {available.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.1rem 0.75rem 0.4rem", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                Fields visible in table
                <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-secondary)", background: "var(--surface-hover)", borderRadius: 6, padding: "0.1rem 0.45rem" }}>
                  {draftVisible.length}/{available.length}
                </span>
              </div>
            )}
            {shown.length > 0 && (
              <>
                <div style={{ padding: "0.3rem 0.75rem", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Shown in table
                </div>
                <div
                  onDragOver={handleDragOver(null)}
                  onDrop={handleDrop(null)}
                  style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}
                >
                {shown.map((c) => {
                  const isLocked = isLockedFn(c);
                  const isDropTarget = dropKey === c.key && draggedKey !== c.key;
                  return (
                    <div
                      key={c.key}
                      data-column-row={c.key}
                      onDragOver={handleDragOver(c.key)}
                      onDrop={handleDrop(c.key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.55rem",
                        padding: "0.35rem 0.5rem 0.35rem 0.6rem",
                        margin: "0 0.35rem",
                        borderRadius: 8,
                        fontSize: "0.88rem",
                        cursor: isLocked ? "default" : "grab",
                        opacity: isLocked ? 0.7 : 1,
                        background: isDropTarget ? "rgba(99, 102, 241, 0.08)" : "transparent",
                        outline: isDropTarget ? "1px solid var(--accent-color)" : "1px solid transparent",
                        transition: "background 120ms ease, outline-color 120ms ease",
                      }}
                    >
                      <button
                        type="button"
                        draggable={!isLocked}
                        onDragStart={handleDragStart(c.key)}
                        onDragEnd={handleDragEnd}
                        disabled={isLocked}
                        aria-label={`Drag ${c.label} column`}
                        title={isLocked ? `${c.label} is fixed` : `Drag to reorder ${c.label}`}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--text-secondary)",
                          padding: 0,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: isLocked ? "not-allowed" : "grab",
                          flexShrink: 0,
                        }}
                      >
                        <GripVertical size={15} />
                      </button>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.55rem",
                          minWidth: 0,
                          flex: 1,
                          cursor: isLocked ? "default" : "pointer",
                        }}
                      >
                        <input type="checkbox" checked disabled={isLocked} onChange={() => toggleColumn(c.key)} />
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.label}
                        </span>
                      </label>
                      {deletableColumns.some((item) => item.key === c.key) && (
                        <>
                          <input
                            type="checkbox"
                            checked={selectedDeleteKeys.includes(c.key)}
                            onChange={() => setSelectedDeleteKeys((current) => current.includes(c.key) ? current.filter((key) => key !== c.key) : [...current, c.key])}
                            aria-label={`Select ${c.label} field for deletion`}
                            title={`Select ${c.label} field for deletion`}
                          />
                          <button
                            type="button"
                            onClick={() => handleDeleteField(c)}
                            disabled={deletingKey === c.key || deletingKey === "__multiple__"}
                            aria-label={`Delete ${c.label} field`}
                            title={`Delete ${c.label} field`}
                            style={{
                              background: "transparent",
                              border: "none",
                              color: "var(--danger-color, #dc2626)",
                              padding: "0.2rem",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              cursor: deletingKey === c.key ? "wait" : "pointer",
                              opacity: deletingKey === c.key ? 0.55 : 1,
                              flexShrink: 0,
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
                </div>
              </>
            )}
            {hidden.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", padding: "0.6rem 0.75rem 0.3rem" }}>
                  <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Fields not shown in table
                  </div>
                  {deletableHidden.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedDeleteKeys(hasSelectedDeleteFields ? [] : deletableHidden.map((column) => column.key))}
                      className="btn-secondary"
                      aria-label={hasSelectedDeleteFields ? "Clear field deletion selection" : "Select all hidden fields for deletion"}
                      style={{ fontSize: "0.7rem", padding: "0.2rem 0.45rem" }}
                    >
                      {hasSelectedDeleteFields ? "Clear selection" : "Select all"}
                    </button>
                  )}
                </div>
                {hidden.map((c) => (
                  <div
                    key={c.key}
                    style={{ display: "flex", alignItems: "center", gap: "0.55rem", padding: "0.4rem 0.75rem", fontSize: "0.88rem", cursor: "pointer" }}
                  >
                    <label style={{ display: "flex", alignItems: "center", gap: "0.55rem", minWidth: 0, flex: 1, cursor: "pointer" }}>
                      <input type="checkbox" checked={false} onChange={() => toggleColumn(c.key)} />
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.label}
                      </span>
                    </label>
                    {deletableColumns.some((item) => item.key === c.key) && (
                      <>
                        <input
                          type="checkbox"
                          checked={selectedDeleteKeys.includes(c.key)}
                          onChange={() => setSelectedDeleteKeys((current) => current.includes(c.key) ? current.filter((key) => key !== c.key) : [...current, c.key])}
                          aria-label={`Select ${c.label} field for deletion`}
                          title={`Select ${c.label} field for deletion`}
                        />
                        <button
                          type="button"
                          onClick={() => handleDeleteField(c)}
                          disabled={deletingKey === c.key || deletingKey === "__multiple__"}
                          aria-label={`Delete ${c.label} field`}
                          title={`Delete ${c.label} field`}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--danger-color, #dc2626)",
                            padding: "0.2rem",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: deletingKey === c.key ? "wait" : "pointer",
                            opacity: deletingKey === c.key ? 0.55 : 1,
                            flexShrink: 0,
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </>
            )}
            {filtered.length === 0 && (
              <div style={{ padding: "0.75rem", fontSize: "0.85rem", color: "var(--text-secondary)" }}>No matching fields.</div>
            )}
          </div>
          {(onManageFields || showGenericLeadClearSelection) && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", padding: "0 0.75rem", borderTop: "1px solid var(--border-color)" }}>
              {onManageFields
                ? <button type="button" onClick={() => { setOpen(false); onManageFields(); }} style={{ textAlign: 'left', padding: '12px 4px', border: 0, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '.78rem' }}>Add lead field</button>
                : <span />}
              {showGenericLeadClearSelection && hasSelectedDeleteFields && (
                <button
                  type="button"
                  onClick={() => setSelectedDeleteKeys([])}
                  className="btn-secondary"
                  aria-label="Clear selected fields for deletion"
                  style={{ fontSize: "0.7rem", padding: "0.2rem 0.45rem" }}
                >
                  Clear selection
                </button>
              )}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", padding: "0.6rem 0.75rem", borderTop: "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <button type="button" onClick={handleReset} disabled={saving} className="btn-secondary" style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}>
                Reset
              </button>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {selectedDeleteKeys.length > 0 && (
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  disabled={deletingKey !== null}
                  className="btn-secondary"
                  style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem", color: "var(--danger-color, #dc2626)", borderColor: "var(--danger-color, #dc2626)" }}
                >
                  {deletingKey === "__multiple__" ? "Deleting fields…" : `Delete selected (${selectedDeleteKeys.length})`}
                </button>
              )}
              <button type="button" onClick={handleApply} disabled={saving || deletingKey !== null} className="btn-primary" style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}>
                {saving ? "Saving…" : "Apply"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
