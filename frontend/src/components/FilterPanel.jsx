import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Filter, X, ChevronLeft, Plus, Search } from "lucide-react";
import { fetchApi } from "../utils/api";
import CalendarRangePicker from "./CalendarRangePicker";
import "./FilterPanel.css";

// ── FilterPanel — Freshsales-style "Filter by" panel ───────────────────
// Trigger button opens a panel DOCKED TO THE RIGHT EDGE OF THE VIEWPORT
// (fixed top/right/bottom, not anchored under the trigger) — this mirrors
// the Freshsales reference UI, where "Filter by" always slides out as a
// tall right-hand drawer regardless of where the button sits on the page.
// First screen lists the filterable fields (fetched once from
// `fieldsUrl`); picking one shows a second screen with an operator
// dropdown (contains / does not contain / is empty / is not empty) and —
// for the two "contains"-family operators — a checkbox list of that
// field's distinct values (fetched lazily from `valuesUrl(field)` and
// cached per field for the life of the panel).
//
// Active filters are chips under the trigger button, each removable on its
// own; "Add filter" re-opens the field-picker screen. `onChange` receives
// the full filters array — `[{field, operator, values, label, valueLabels}]`
// — on every add/remove so the host page can refetch immediately.
//
// When the drawer is opened while filters already exist it lands directly
// on the applied fields' full option lists (one field → that field's
// options screen; several → a stacked summary of every applied field)
// with the checked values preserved. Back returns to the field list.
// Sentinel `activeField` value for the stacked "all applied filters" view.
// Never a real field key — `fieldsUrl`/`valuesUrl` are never called with it.
const SUMMARY_VIEW = "__applied_filters__";
const FRESHSALES_DEFAULT_FIELD_KEYS = ["source", "status", "assignedToId"];
const SEARCHABLE_VALUE_FIELD_KEYS = new Set([
  "name",
  "email",
  "phone",
  "whatsappPhone",
]);

export default function FilterPanel({
  fieldsUrl,
  valuesUrl,
  filters,
  onChange,
  fieldKey = null,
  fieldLabel = "",
  fieldKind = "text",
  triggerLabel = "Filter by",
  triggerIcon = <Filter size={14} />,
  showSelectedFilters = true,
  showCountBadge = true,
  compactTrigger = false,
  autoOpen = false,
  hideTrigger = false,
  buttonTitle,
  buttonAriaLabel,
  buttonStyle,
  onClose,
  layoutVariant = "default",
  clearSectionsOnReset = false,
  promoteAddedSections = false,
  pinSelectedValues = false,
}) {
  const isSingleFieldMode = Boolean(fieldKey);
  const isFreshsalesLayout = layoutVariant === "freshsales";
  const [open, setOpen] = useState(Boolean(autoOpen));
  const [fields, setFields] = useState([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [activeField, setActiveField] = useState(
    isSingleFieldMode ? fieldKey : null,
  ); // field key while on the operator/values screen
  const [operator, setOperator] = useState(
    fieldKind === "date" ? "between" : "contains",
  );
  const [checked, setChecked] = useState([]); // selected values for activeField, string[]
  const [valuesByField, setValuesByField] = useState({}); // cache: { [field]: [{value,label}] }
  const [valuesLoading, setValuesLoading] = useState(false);
  const [fieldSearch, setFieldSearch] = useState(""); // filters the field-picker list
  const [valueSearch, setValueSearch] = useState(""); // filters the checkbox-value list
  const [dateRange, setDateRange] = useState({ from: "", to: "" }); // date-kind fields only
  const [summaryDrafts, setSummaryDrafts] = useState({}); // stacked view: { [field]: { label, kind, operator, checked, dateRange } }
  const [summaryValueSearch, setSummaryValueSearch] = useState(""); // shared option search for the stacked view
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  const [expandedSummaryFields, setExpandedSummaryFields] = useState({});
  const [summaryFieldSearches, setSummaryFieldSearches] = useState({});
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const autoOpenOnceRef = useRef(false);
  const freshsalesFieldPickerRequestedRef = useRef(false);
  const freshsalesDefaultsSeededRef = useRef(false);

  const closePanel = useCallback(() => {
    setOpen(false);
    setActiveField(null);
    setSummaryDrafts({});
    setSummaryValueSearch("");
    setFieldPickerOpen(false);
    setExpandedSummaryFields({});
    setSummaryFieldSearches({});
    freshsalesFieldPickerRequestedRef.current = false;
    freshsalesDefaultsSeededRef.current = false;
    onClose?.();
  }, [onClose]);

  const fetchValuesFor = useCallback(
    async (field) => {
      setValuesLoading(true);
      try {
        const data = await fetchApi(valuesUrl(field), { silent: true });
        setValuesByField((prev) => ({
          ...prev,
          [field]: Array.isArray(data?.values) ? data.values : [],
        }));
      } catch {
        setValuesByField((prev) => ({ ...prev, [field]: [] }));
      } finally {
        setValuesLoading(false);
      }
    },
    [valuesUrl],
  );

  const chooseField = useCallback(
    async (field, meta = {}) => {
      const chosenKind =
        meta.kind || fields.find((f) => f.field === field)?.kind || "text";
      setActiveField(field);
      const existing = (filters || []).find((f) => f.field === field);
      // Restore the applied filter so the selection persists across
      // close/reopen until the user explicitly removes or replaces it.
      if (existing) {
        setOperator(
          existing.operator || (chosenKind === "date" ? "between" : "contains"),
        );
        setChecked(
          Array.isArray(existing.values) &&
            (existing.operator === "contains" ||
              existing.operator === "not_contains")
            ? [...existing.values]
            : [],
        );
        setDateRange(
          existing.operator === "between" && Array.isArray(existing.values)
            ? {
                from: existing.values[0] || "",
                to: existing.values[1] || "",
              }
            : { from: "", to: "" },
        );
      } else {
        // A date field is picked on a calendar, so it opens on `between` rather
        // than the substring/checkbox operators the other kinds default to.
        setOperator(chosenKind === "date" ? "between" : "contains");
        setChecked([]);
        setDateRange({ from: "", to: "" });
      }
      setValueSearch("");
      // Date fields never show a value list — there is nothing to fetch.
      if (chosenKind === "date") return;
      // Smart-open paths pass `force` because the open-effect clears the
      // value cache on every open — a stale closure hit would skip the
      // fetch and leave the options list empty.
      if (!meta.force && valuesByField[field]) return;
      await fetchValuesFor(field);
    },
    [fields, filters, valuesByField, fetchValuesFor],
  );

  // Stacked view for several applied filters: one draft per field, each
  // seeded from its applied filter so every option list opens with the
  // previously selected values still checked.
  const openSummary = useCallback(() => {
    const list = filters || [];
    const drafts = {};
    for (const f of list) {
      const op = f.operator || (f.kind === "date" ? "between" : "contains");
      drafts[f.field] = {
        label: f.label || f.field,
        kind: f.kind || "text",
        operator: op,
        checked:
          Array.isArray(f.values) &&
          (op === "contains" || op === "not_contains")
            ? [...f.values]
            : [],
        dateRange:
          op === "between" && Array.isArray(f.values)
            ? { from: f.values[0] || "", to: f.values[1] || "" }
            : { from: "", to: "" },
      };
    }
    setSummaryDrafts(drafts);
    setSummaryValueSearch("");
    setActiveField(SUMMARY_VIEW);
    setFieldSearch("");
    // Always refetch — the open-effect wipes the value cache, so a
    // closure-cache hit here would render an empty options list.
    for (const f of list) {
      if ((f.kind || "text") === "date") continue;
      fetchValuesFor(f.field);
    }
  }, [filters, fetchValuesFor]);

  const openFieldPicker = useCallback(() => {
    setOpen(true);
    setFieldPickerOpen(false);
    freshsalesFieldPickerRequestedRef.current = false;
    freshsalesDefaultsSeededRef.current = false;
    if (isSingleFieldMode) {
      chooseField(fieldKey, { kind: fieldKind });
      return;
    }
    const list = filters || [];
    // The reference layout always reopens applied filters in the summary so
    // its
    // header-level "Add filter" action stays available, even when only one
    // filter is active. Other layouts retain the direct single-field editor.
    if (isFreshsalesLayout && list.length > 0) {
      openSummary();
      return;
    }
    // Reopening with filters lands directly on the applied fields'
    // complete option lists instead of the field picker.
    if (list.length === 1) {
      setFieldSearch("");
      chooseField(list[0].field, { kind: list[0].kind, force: true });
      return;
    }
    if (list.length > 1) {
      openSummary();
      return;
    }
    // The reference layout opens on the filter stack, even before a
    // value has been applied. The field catalog loads immediately after the
    // drawer opens and seeds Source, Status, and Sales Owner as empty drafts.
    // Empty drafts never reach `onChange`, so this is presentation-only and
    // does not alter the lead query.
    if (isFreshsalesLayout) {
      setActiveField(SUMMARY_VIEW);
      setSummaryDrafts({});
      setSummaryValueSearch("");
      return;
    }
    setActiveField(null);
    setSummaryDrafts({});
    setFieldSearch("");
  }, [chooseField, fieldKey, fieldKind, filters, isFreshsalesLayout, isSingleFieldMode, openSummary]);

  // "Add filter" always starts from the full field list.
  const openFieldList = useCallback(() => {
    setOpen(true);
    freshsalesFieldPickerRequestedRef.current = true;
    if (isFreshsalesLayout) {
      setActiveField(SUMMARY_VIEW);
      setFieldPickerOpen(true);
    } else {
      setActiveField(null);
    }
    setFieldSearch("");
  }, [isFreshsalesLayout]);

  const addFieldToSummary = useCallback(
    (fieldMeta) => {
      const existing = (filters || []).find(
        (filter) => filter.field === fieldMeta.field,
      );
      setSummaryDrafts((prev) => {
        if (prev[fieldMeta.field]) return prev;
        const nextOperator =
          existing?.operator ||
          (fieldMeta.kind === "date" ? "between" : "contains");
        const draft = {
          label: existing?.label || fieldMeta.label || fieldMeta.field,
          kind: existing?.kind || fieldMeta.kind || "text",
          operator: nextOperator,
          checked:
            Array.isArray(existing?.values) &&
            (nextOperator === "contains" ||
              nextOperator === "not_contains")
              ? [...existing.values]
              : [],
          dateRange:
            nextOperator === "between" && Array.isArray(existing?.values)
              ? {
                  from: existing.values[0] || "",
                  to: existing.values[1] || "",
                }
              : { from: "", to: "" },
        };
        return promoteAddedSections
          ? { [fieldMeta.field]: draft, ...prev }
          : { ...prev, [fieldMeta.field]: draft };
      });
      setFieldPickerOpen(false);
      setActiveField(SUMMARY_VIEW);
      setFieldSearch("");
      setSummaryFieldSearches((prev) => ({
        ...prev,
        [fieldMeta.field]: "",
      }));
      if ((fieldMeta.kind || "text") !== "date") {
        fetchValuesFor(fieldMeta.field);
      }
    },
    [fetchValuesFor, filters, promoteAddedSections],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      const insideWrap = wrapRef.current && wrapRef.current.contains(e.target);
      const insidePanel =
        panelRef.current && panelRef.current.contains(e.target);
      if (!insideWrap && !insidePanel) {
        closePanel();
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        closePanel();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closePanel]);

  // Refetches on EVERY open — not just once per component lifetime. Both
  // the field list (has-data / has-custom-field gating) and each field's
  // value list are live snapshots of current data: a new Lead can arrive
  // with a value for a field that had none a minute ago, an admin can add
  // a custom field, or another user's edit can add a brand-new value.
  // Caching across opens showed a real stale-data bug — a field the
  // backend now correctly includes stayed invisible in an already-open
  // browser tab because the panel had cached its first (pre-fix) fetch
  // for the rest of the session. `valuesByField` is cleared on every open
  // for the same reason, so a stale per-field value list can't linger.
  useEffect(() => {
    if (!open || isSingleFieldMode) return;
    setFieldsLoading(true);
    setValuesByField({});
    fetchApi(fieldsUrl, { silent: true })
      .then((data) => setFields(data.fields || []))
      .catch(() => setFields([]))
      .finally(() => setFieldsLoading(false));
  }, [open, fieldsUrl, isSingleFieldMode]);

  // The reference layout starts with useful filter sections in view instead
  // of the field catalog. They remain drafts until the user selects values
  // and presses Apply, preserving the existing filter logic.
  useEffect(() => {
    if (
      !open ||
      !isFreshsalesLayout ||
      isSingleFieldMode ||
      clearSectionsOnReset ||
      activeField !== SUMMARY_VIEW ||
      (filters || []).length > 0 ||
      fields.length === 0 ||
      freshsalesFieldPickerRequestedRef.current ||
      freshsalesDefaultsSeededRef.current
    ) {
      return;
    }

    const defaults = FRESHSALES_DEFAULT_FIELD_KEYS.map((key) =>
      fields.find((field) => field.field === key),
    ).filter(Boolean);
    if (defaults.length === 0) return;

    freshsalesDefaultsSeededRef.current = true;
    setSummaryDrafts(
      Object.fromEntries(
        defaults.map((field) => [
          field.field,
          {
            label: field.label || field.field,
            kind: field.kind || "text",
            operator: field.kind === "date" ? "between" : "contains",
            checked: [],
            dateRange: { from: "", to: "" },
          },
        ]),
      ),
    );
    defaults.forEach((field) => {
      if ((field.kind || "text") !== "date") {
        fetchValuesFor(field.field);
      }
    });
  }, [
    activeField,
    clearSectionsOnReset,
    fields,
    filters,
    isFreshsalesLayout,
    isSingleFieldMode,
    open,
    fetchValuesFor,
  ]);

  useEffect(() => {
    if (!autoOpen || !isSingleFieldMode || autoOpenOnceRef.current) return;
    autoOpenOnceRef.current = true;
    openFieldPicker();
  }, [autoOpen, isSingleFieldMode, openFieldPicker]);

  const currentFieldMeta = (() => {
    if (!activeField) return null;
    if (isSingleFieldMode) {
      return {
        field: fieldKey,
        label: fieldLabel || fieldKey,
        kind: fieldKind || "text",
      };
    }
    return fields.find((f) => f.field === activeField) || null;
  })();
  const activeKind = currentFieldMeta?.kind || "text";
  const activeFieldLabel = currentFieldMeta?.label || activeField || "Filters";
  const isDateField = activeKind === "date";

  const toggleValue = (value) => {
    setChecked((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  };

  const needsValues =
    !isDateField && (operator === "contains" || operator === "not_contains");
  const needsRange = operator === "between";

  const existingFilter = activeField
    ? (filters || []).find((f) => f.field === activeField)
    : null;
  // Apply stays disabled until the chosen operator actually has an input:
  // checkbox operators need a tick, `between` needs at least one end of the
  // range. The empty/not-empty operators need neither. When the field already
  // has an applied filter, Apply stays enabled with empty input so unticking
  // everything removes that filter instead of dead-ending on a disabled button.
  const applyDisabled =
    ((needsValues && checked.length === 0) ||
      (needsRange && !dateRange.from && !dateRange.to)) &&
    !existingFilter;

  const applyFilter = () => {
    if (!activeField) return;
    if (
      (needsValues && checked.length === 0) ||
      (needsRange && !dateRange.from && !dateRange.to)
    ) {
      if (existingFilter) {
        onChange(filters.filter((f) => f.field !== activeField));
        setOpen(false);
        setActiveField(null);
        onClose?.();
      }
      return;
    }
    const fieldMeta =
      currentFieldMeta || fields.find((f) => f.field === activeField);
    const options = valuesByField[activeField] || [];
    const valueLabels = checked.map(
      (v) => options.find((o) => o.value === v)?.label || v,
    );
    const next = filters.filter((f) => f.field !== activeField);
    // `between` carries [from, to] POSITIONALLY — an omitted end stays as an
    // empty string rather than being dropped, so an open-ended range ("from
    // 1 Aug onwards") doesn't slide its `to` into the `from` slot.
    let values = [];
    let labels = [];
    if (needsRange) {
      values = [dateRange.from || "", dateRange.to || ""];
      labels = [[dateRange.from, dateRange.to].filter(Boolean).join(" → ")];
    } else if (needsValues) {
      values = checked;
      labels = valueLabels;
    }
    next.push({
      field: activeField,
      label: fieldMeta?.label || activeField,
      kind: fieldMeta?.kind || "text",
      operator,
      values,
      valueLabels: labels,
    });
    onChange(next);
    setOpen(false);
    setActiveField(null);
    onClose?.();
  };

  const removeFilter = (field) =>
    onChange(filters.filter((f) => f.field !== field));

  const toggleSummaryValue = (field, value) => {
    setSummaryDrafts((prev) => {
      const d = prev[field];
      if (!d) return prev;
      const has = d.checked.includes(value);
      return {
        ...prev,
        [field]: {
          ...d,
          checked: has
            ? d.checked.filter((v) => v !== value)
            : [...d.checked, value],
        },
      };
    });
  };

  const setSummaryOperator = (field, op) => {
    setSummaryDrafts((prev) =>
      prev[field] ? { ...prev, [field]: { ...prev[field], operator: op } } : prev,
    );
  };

  const setSummaryRange = (field, range) => {
    setSummaryDrafts((prev) =>
      prev[field]
        ? {
            ...prev,
            [field]: {
              ...prev[field],
              dateRange: { from: range?.from || "", to: range?.to || "" },
            },
          }
        : prev,
    );
  };

  const setSummaryFieldSearch = (field, value) => {
    setSummaryFieldSearches((prev) => ({ ...prev, [field]: value }));
  };

  const toggleSummaryExpanded = (field) => {
    setExpandedSummaryFields((prev) => ({
      ...prev,
      [field]: !prev[field],
    }));
  };

  const removeSummaryFilter = (field) => {
    onChange((filters || []).filter((f) => f.field !== field));
    setSummaryDrafts((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  // Applies every stacked draft at once. A draft cleared to no input is
  // dropped (same deselect-removes contract as the single-field Apply),
  // so unticking everything removes that filter.
  const applySummary = () => {
    const next = [];
    for (const [field, d] of Object.entries(summaryDrafts)) {
      const needsV =
        d.kind !== "date" &&
        (d.operator === "contains" || d.operator === "not_contains");
      const needsR = d.operator === "between";
      if (needsV && d.checked.length === 0) continue;
      if (needsR && !d.dateRange.from && !d.dateRange.to) continue;
      const options = valuesByField[field] || [];
      let values = [];
      let labels = [];
      if (needsR) {
        values = [d.dateRange.from || "", d.dateRange.to || ""];
        labels = [[d.dateRange.from, d.dateRange.to].filter(Boolean).join(" → ")];
      } else if (needsV) {
        values = d.checked;
        labels = d.checked.map(
          (v) => options.find((o) => o.value === v)?.label || v,
        );
      }
      next.push({
        field,
        label: d.label || field,
        kind: d.kind || "text",
        operator: d.operator,
        values,
        valueLabels: labels,
      });
    }
    onChange(next);
    setOpen(false);
    setActiveField(null);
    setSummaryDrafts({});
    setSummaryValueSearch("");
    setExpandedSummaryFields({});
    setSummaryFieldSearches({});
    onClose?.();
  };

  const resetSummary = () => {
    if (clearSectionsOnReset) {
      setSummaryDrafts({});
      setFieldPickerOpen(true);
      freshsalesFieldPickerRequestedRef.current = true;
      freshsalesDefaultsSeededRef.current = true;
    } else {
      setSummaryDrafts((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([field, draft]) => [
            field,
            {
              ...draft,
              operator: draft.kind === "date" ? "between" : "contains",
              checked: [],
              dateRange: { from: "", to: "" },
            },
          ]),
        ),
      );
      setFieldPickerOpen(false);
      freshsalesFieldPickerRequestedRef.current = false;
      freshsalesDefaultsSeededRef.current = false;
    }
    setSummaryValueSearch("");
    setSummaryFieldSearches({});
    setExpandedSummaryFields({});
    onChange([]);
  };

  const backToFieldList = () => setActiveField(null);

  // "contains" reads naturally for free-text fields (a substring match),
  // but is misleading for a checkbox-pick-exact-values field like Sales
  // Owner, Callified Campaign, Lead Score, or Created (a date) — those are
  // always exact-match against the selected checkboxes, never substring.
  // Labels are picked per the active field's `kind` (from /filter-fields).
  const TEXT_OPERATOR_LABELS = {
    contains: "contains",
    not_contains: "does not contain",
    is_empty: "is empty",
    is_not_empty: "is not empty",
  };
  const EXACT_OPERATOR_LABELS = {
    contains: "is any of",
    not_contains: "is none of",
    is_empty: "is empty",
    is_not_empty: "is not empty",
  };
  const operatorLabelsFor = (kind) =>
    kind === "text" ? TEXT_OPERATOR_LABELS : EXACT_OPERATOR_LABELS;

  const buttonActive = isSingleFieldMode
    ? filters.some((f) => f.field === fieldKey)
    : filters.length > 0;
  const useActiveButtonColors = buttonActive && !isFreshsalesLayout;
  const triggerText = isSingleFieldMode ? "" : triggerLabel;
  const triggerButtonTitle =
    buttonTitle ||
    (isSingleFieldMode ? `Filter ${fieldLabel || fieldKey}` : "Filter by");
  const triggerButtonAriaLabel = buttonAriaLabel || triggerButtonTitle;
  const renderSelectedFilters = showSelectedFilters && !isSingleFieldMode;
  const countBadgeValue = isSingleFieldMode
    ? filters.some((f) => f.field === fieldKey)
      ? 1
      : 0
    : filters.length;
  const showGenericEmptyState =
    isFreshsalesLayout &&
    clearSectionsOnReset &&
    Object.keys(summaryDrafts).length === 0;

  const renderFieldOptions = () => {
    const term = fieldSearch.trim().toLowerCase();
    const availableFields = isFreshsalesLayout
      ? fields.filter(
          (field) =>
            !summaryDrafts[field.field] &&
            !filters.some((filter) => filter.field === field.field),
        )
      : fields;
    const visibleFields = term
      ? availableFields.filter((field) =>
          `${field.label || ""} ${field.field || ""}`
            .toLowerCase()
            .includes(term),
        )
      : availableFields;
    if (
      !fieldsLoading &&
      availableFields.length > 0 &&
      visibleFields.length === 0
    ) {
      return (
        <div
          style={{
            padding: "0.6rem 0.9rem",
            fontSize: "0.85rem",
            color: "var(--text-secondary)",
          }}
        >
          No matching fields.
        </div>
      );
    }
    if (!fieldsLoading && availableFields.length === 0) {
      return (
        <div
          style={{
            padding: "0.75rem 0.9rem",
            fontSize: "0.85rem",
            color: "var(--text-secondary)",
          }}
        >
          All available filters have been added.
        </div>
      );
    }

    const renderFieldOption = (field) => {
      const active =
        filters.some((filter) => filter.field === field.field) ||
        Boolean(summaryDrafts[field.field]);
      return (
        <button
          key={field.field}
          type="button"
          className="filter-panel-field-option"
          onClick={() =>
            isFreshsalesLayout
              ? addFieldToSummary(field)
              : chooseField(field.field)
          }
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "0.55rem 0.9rem",
            background: active
              ? "var(--subtle-bg, rgba(0,0,0,0.04))"
              : "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: "0.87rem",
            color: "var(--text-primary)",
          }}
        >
          {field.label}
        </button>
      );
    };

    if (!isFreshsalesLayout || term) {
      return visibleFields.map(renderFieldOption);
    }
    const popularFieldKeys = new Set([
      "source",
      "status",
      "assignedToId",
      "territoryId",
    ]);
    const popularFields = visibleFields.filter((field) =>
      popularFieldKeys.has(field.field),
    );
    const otherFields = visibleFields.filter(
      (field) => !popularFieldKeys.has(field.field),
    );
    return (
      <>
        {popularFields.length > 0 && (
          <div className="filter-panel-field-group">
            <strong className="filter-panel-field-group-title">
              Popular filters
            </strong>
            {popularFields.map(renderFieldOption)}
          </div>
        )}
        {otherFields.length > 0 && (
          <div className="filter-panel-field-group">
            <strong className="filter-panel-field-group-title">
              Other filters
            </strong>
            {otherFields.map(renderFieldOption)}
          </div>
        )}
      </>
    );
  };

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        flexWrap: "wrap",
      }}
    >
      <div ref={wrapRef} style={{ position: "relative" }}>
        {!hideTrigger && (
          <button
            ref={triggerRef}
            type="button"
            onClick={() => (open ? closePanel() : openFieldPicker())}
            title={triggerButtonTitle}
            aria-label={triggerButtonAriaLabel}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: compactTrigger || !triggerText ? "0.2rem" : "0.4rem",
              padding:
                compactTrigger || !triggerText ? "0.35rem" : "0.5rem 0.85rem",
              background: useActiveButtonColors
                ? "var(--surface-hover, rgba(0,0,0,0.04))"
                : "var(--surface-color, #fff)",
              border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
              borderRadius: 8,
              color: useActiveButtonColors
                ? "var(--accent-color)"
                : "var(--text-primary)",
              fontSize: "0.85rem",
              cursor: "pointer",
              minWidth: compactTrigger || !triggerText ? 28 : undefined,
              lineHeight: 1,
              ...buttonStyle,
            }}
          >
            {triggerIcon}
            {triggerText ? <span>{triggerText}</span> : null}
            {showCountBadge && countBadgeValue > 0 && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 18,
                  height: 18,
                  padding: "0 4px",
                  borderRadius: 999,
                  background: "var(--accent-color)",
                  color: "#fff",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                }}
              >
                {countBadgeValue}
              </span>
            )}
          </button>
        )}

        {open &&
          createPortal(
            <>
              {/* The reference layout keeps the underlying list fully visible.
                The default reusable layout retains its dimmed treatment. */}
              <div
                className={
                  isFreshsalesLayout
                    ? "filter-panel-backdrop filter-panel-backdrop--freshsales"
                    : "filter-panel-backdrop"
                }
                onMouseDown={isFreshsalesLayout ? closePanel : undefined}
                style={{
                  position: "fixed",
                  inset: 0,
                  zIndex: 1099,
                  background: isFreshsalesLayout
                    ? "transparent"
                    : "rgba(0,0,0,0.15)",
                }}
              />
              <div
                ref={panelRef}
                className={
                  isFreshsalesLayout
                    ? "filter-panel-drawer filter-panel-drawer--freshsales"
                    : "filter-panel-drawer"
                }
                role="dialog"
                aria-modal="true"
                onMouseDown={(event) => {
                  if (!isFreshsalesLayout || !fieldPickerOpen) return;
                  if (
                    event.target.closest(".filter-panel-field-picker-popover") ||
                    event.target.closest(".filter-panel-add-filter")
                  ) {
                    return;
                  }
                  setFieldPickerOpen(false);
                  setFieldSearch("");
                }}
                aria-label={
                  isSingleFieldMode ? `${activeFieldLabel} filter` : "Filters"
                }
                style={{
                  position: "fixed",
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: 360,
                  maxWidth: "90vw",
                  zIndex: 1100,
                  background: "var(--bg-color, #fff)",
                  borderLeft: "1px solid var(--border-color, rgba(0,0,0,0.18))",
                  boxShadow: "var(--shadow-lg, -12px 0 32px rgba(0,0,0,0.25))",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                {!isSingleFieldMode && activeField === SUMMARY_VIEW ? (
                  <>
                    <div
                      className="filter-panel-header"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        padding: "0.7rem 0.9rem",
                        borderBottom:
                          "1px solid var(--border-color, rgba(0,0,0,0.1))",
                      }}
                    >
                      {!isFreshsalesLayout && (
                        <button
                          type="button"
                          onClick={backToFieldList}
                          aria-label="Back to field list"
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--text-secondary)",
                            display: "flex",
                          }}
                        >
                          <ChevronLeft size={16} />
                        </button>
                      )}
                      <strong style={{ fontSize: "1rem", flex: 1 }}>
                        Filters
                      </strong>
                      {isFreshsalesLayout && (
                        <button
                          type="button"
                          className="filter-panel-add-filter"
                          onClick={openFieldList}
                        >
                          <Plus size={14} /> Add filter
                        </button>
                      )}
                      <button
                        type="button"
                        className="filter-panel-icon-button"
                        onClick={closePanel}
                        aria-label="Close filters"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--text-secondary)",
                          display: "flex",
                        }}
                      >
                        <X size={18} />
                      </button>
                    </div>
                    {isFreshsalesLayout && fieldPickerOpen && (
                      <div className="filter-panel-field-picker-popover">
                        <div
                          className="filter-panel-field-search"
                          style={{ position: "relative" }}
                        >
                          <Search
                            size={14}
                            style={{
                              position: "absolute",
                              left: "1.4rem",
                              top: "50%",
                              transform: "translateY(-50%)",
                              color: "var(--text-secondary)",
                            }}
                          />
                          <input
                            autoFocus
                            value={fieldSearch}
                            onChange={(event) =>
                              setFieldSearch(event.target.value)
                            }
                            placeholder="Add a field to filter"
                            aria-label="Search fields"
                            style={{
                              width: "100%",
                              padding: "0.45rem 0.6rem 0.45rem 2rem",
                              boxSizing: "border-box",
                              border:
                                "1px solid var(--border-color, rgba(0,0,0,0.12))",
                              borderRadius: 6,
                              background: "var(--surface-color, #fff)",
                              color: "var(--text-primary)",
                              fontSize: "0.85rem",
                              outline: "none",
                            }}
                          />
                        </div>
                        <div className="filter-panel-field-list">
                          {fieldsLoading && (
                            <div
                              style={{
                                padding: "0.6rem 0.9rem",
                                fontSize: "0.85rem",
                                color: "var(--text-secondary)",
                              }}
                            >
                              Loading fieldsâ€¦
                            </div>
                          )}
                          {!fieldsLoading && fields.length === 0 && (
                            <div
                              style={{
                                padding: "0.6rem 0.9rem",
                                fontSize: "0.85rem",
                                color: "var(--text-secondary)",
                              }}
                            >
                              No filterable fields.
                            </div>
                          )}
                          {renderFieldOptions()}
                        </div>
                      </div>
                    )}
                    <div
                      className={
                        isFreshsalesLayout
                          ? "filter-panel-summary-search filter-panel-summary-search--hidden"
                          : "filter-panel-summary-search"
                      }
                      style={{
                        padding: "0.6rem 0.9rem",
                        borderBottom:
                          "1px solid var(--border-color, rgba(0,0,0,0.08))",
                        position: "relative",
                      }}
                    >
                      <Search
                        size={14}
                        style={{
                          position: "absolute",
                          left: "1.4rem",
                          top: "50%",
                          transform: "translateY(-50%)",
                          color: "var(--text-secondary)",
                        }}
                      />
                      <input
                        value={summaryValueSearch}
                        onChange={(e) => setSummaryValueSearch(e.target.value)}
                        placeholder="Search values…"
                        aria-label="Search values"
                        style={{
                          width: "100%",
                          padding: "0.45rem 0.6rem 0.45rem 2rem",
                          boxSizing: "border-box",
                          border:
                            "1px solid var(--border-color, rgba(0,0,0,0.12))",
                          borderRadius: 6,
                          background: "var(--surface-color, #fff)",
                          color: "var(--text-primary)",
                          fontSize: "0.85rem",
                          outline: "none",
                        }}
                      />
                    </div>
                    <div
                      className="filter-panel-sections"
                      style={{
                        overflowY: "auto",
                        flex: 1,
                        minHeight: 0,
                      }}
                    >
                      {showGenericEmptyState && (
                        <div
                          className="filter-panel-empty-state"
                          role="status"
                        >
                          <div className="filter-panel-empty-state-art" aria-hidden="true">
                            <Filter size={68} strokeWidth={1.25} />
                          </div>
                          <p>
                            Add filters to narrow down the contacts you want to
                            see.
                          </p>
                        </div>
                      )}
                      {Object.entries(summaryDrafts).map(([field, d]) => {
                        const labels = operatorLabelsFor(d.kind);
                        const isDate = d.kind === "date";
                        const isSearchableValueField =
                          SEARCHABLE_VALUE_FIELD_KEYS.has(field);
                        const showChecks =
                          !isDate &&
                          !isSearchableValueField &&
                          (d.operator === "contains" ||
                            d.operator === "not_contains");
                        const showSearchableValues =
                          !isDate &&
                          isSearchableValueField &&
                          (d.operator === "contains" ||
                            d.operator === "not_contains");
                        const showRange = d.operator === "between";
                        const term = summaryValueSearch.trim().toLowerCase();
                        const options = valuesByField[field] || [];
                        const visibleOptions = term
                          ? options.filter((o) =>
                              o.label.toLowerCase().includes(term),
                            )
                          : options;
                        const orderedVisibleOptions = pinSelectedValues
                          ? [
                              ...visibleOptions.filter((option) =>
                                d.checked.includes(option.value),
                              ),
                              ...visibleOptions.filter(
                                (option) =>
                                  !d.checked.includes(option.value),
                              ),
                            ]
                          : visibleOptions;
                        const displayedOptions =
                          isFreshsalesLayout &&
                          !expandedSummaryFields[field]
                            ? orderedVisibleOptions.slice(0, 3)
                            : orderedVisibleOptions;
                        const fieldQuery = String(
                          summaryFieldSearches[field] || "",
                        );
                        const normalizedFieldQuery = fieldQuery
                          .trim()
                          .toLowerCase();
                        const searchableMatches =
                          normalizedFieldQuery.length >= 2
                            ? options.filter(
                                (option) =>
                                  !d.checked.includes(option.value) &&
                                  option.label
                                    .toLowerCase()
                                    .includes(normalizedFieldQuery),
                              )
                            : [];
                        return (
                          <div
                            key={field}
                            className="filter-panel-section"
                            style={{
                              padding: "0.7rem 0.9rem",
                              borderBottom:
                                "1px solid var(--border-color, rgba(0,0,0,0.08))",
                            }}
                          >
                            <div
                              className="filter-panel-section-heading"
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.4rem",
                                marginBottom:
                                  showChecks || showSearchableValues || showRange
                                    ? "0.5rem"
                                    : 0,
                              }}
                            >
                              <strong
                                style={{ fontSize: "0.87rem", flex: 1 }}
                              >
                                {d.label}
                              </strong>
                              <select
                                className="filter-panel-operator"
                                value={d.operator}
                                onChange={(e) =>
                                  setSummaryOperator(field, e.target.value)
                                }
                                aria-label={`${d.label} operator`}
                                style={{
                                  padding: "0.3rem 0.5rem",
                                  borderRadius: 6,
                                  border:
                                    "1px solid var(--border-color, rgba(0,0,0,0.12))",
                                  background: "var(--surface-color, #fff)",
                                  color: "var(--accent-color)",
                                  fontSize: "0.82rem",
                                }}
                              >
                                {isDate ? (
                                  <option value="between">is between</option>
                                ) : (
                                  <>
                                    <option value="contains">
                                      {labels.contains}
                                    </option>
                                    <option value="not_contains">
                                      {labels.not_contains}
                                    </option>
                                  </>
                                )}
                                <option value="is_not_empty">
                                  {labels.is_not_empty} (has any value)
                                </option>
                                <option value="is_empty">
                                  {labels.is_empty}
                                </option>
                              </select>
                              <button
                                type="button"
                                className="filter-panel-remove-filter"
                                onClick={() => removeSummaryFilter(field)}
                                aria-label={`Remove ${d.label} filter`}
                                style={{
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  color: "var(--text-secondary)",
                                  display: "flex",
                                  padding: 0,
                                }}
                              >
                                <X size={12} />
                              </button>
                            </div>
                            {showRange && (
                              <CalendarRangePicker
                                value={d.dateRange}
                                onChange={(range) =>
                                  setSummaryRange(field, range)
                                }
                              />
                            )}
                            {showSearchableValues && (
                              <div className="filter-panel-typeahead">
                                <div className="filter-panel-typeahead-control">
                                  {d.checked.map((value) => {
                                    const label =
                                      options.find(
                                        (option) => option.value === value,
                                      )?.label || value;
                                    return (
                                      <span
                                        key={value}
                                        className="filter-panel-value-chip"
                                      >
                                        {label}
                                        <button
                                          type="button"
                                          onClick={() =>
                                            toggleSummaryValue(field, value)
                                          }
                                          aria-label={`Remove ${label}`}
                                        >
                                          <X size={13} />
                                        </button>
                                      </span>
                                    );
                                  })}
                                  <input
                                    value={fieldQuery}
                                    onChange={(event) =>
                                      setSummaryFieldSearch(
                                        field,
                                        event.target.value,
                                      )
                                    }
                                    aria-label={`Search ${d.label} values`}
                                  />
                                </div>
                                {valuesLoading && options.length === 0 ? (
                                  <div className="filter-panel-typeahead-menu">
                                    <div className="filter-panel-typeahead-message">
                                      Loading valuesâ€¦
                                    </div>
                                  </div>
                                ) : normalizedFieldQuery.length < 2 &&
                                  d.checked.length === 0 ? (
                                  <div className="filter-panel-typeahead-menu">
                                    <div className="filter-panel-typeahead-message">
                                      Please enter 2 or more characters
                                    </div>
                                  </div>
                                ) : normalizedFieldQuery.length >= 2 ? (
                                  <div className="filter-panel-typeahead-menu">
                                    {searchableMatches.length === 0 ? (
                                      <div className="filter-panel-typeahead-message">
                                        No matching values.
                                      </div>
                                    ) : (
                                      searchableMatches.map((option) => (
                                        <button
                                          key={option.value}
                                          type="button"
                                          onClick={() => {
                                            toggleSummaryValue(
                                              field,
                                              option.value,
                                            );
                                            setSummaryFieldSearch(field, "");
                                          }}
                                        >
                                          {option.label}
                                        </button>
                                      ))
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            )}
                            {showChecks && (
                              <>
                                {valuesLoading && options.length === 0 && (
                                  <div
                                    style={{
                                      padding: "0.4rem 0",
                                      fontSize: "0.85rem",
                                      color: "var(--text-secondary)",
                                    }}
                                  >
                                    Loading values…
                                  </div>
                                )}
                                {!valuesLoading && options.length === 0 && (
                                  <div
                                    style={{
                                      padding: "0.4rem 0",
                                      fontSize: "0.85rem",
                                      color: "var(--text-secondary)",
                                    }}
                                  >
                                    No values found.
                                  </div>
                                )}
                                {options.length > 0 &&
                                  visibleOptions.length === 0 && (
                                    <div
                                      style={{
                                        padding: "0.4rem 0",
                                        fontSize: "0.85rem",
                                        color: "var(--text-secondary)",
                                      }}
                                    >
                                      No matching values.
                                    </div>
                                  )}
                                {displayedOptions.map((opt) => (
                                  <label
                                    key={opt.value}
                                    className="filter-panel-value-option"
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "0.55rem",
                                      padding: "0.45rem 0",
                                      cursor: "pointer",
                                      fontSize: "0.87rem",
                                      color: "var(--text-primary)",
                                      background: d.checked.includes(opt.value)
                                        ? "var(--subtle-bg, rgba(0,0,0,0.04))"
                                        : "transparent",
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={d.checked.includes(opt.value)}
                                      onChange={() =>
                                        toggleSummaryValue(field, opt.value)
                                      }
                                    />
                                    <span
                                      style={{
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {opt.label}
                                    </span>
                                  </label>
                                ))}
                                {isFreshsalesLayout &&
                                  visibleOptions.length > 3 && (
                                    <button
                                      type="button"
                                      className="filter-panel-show-more"
                                      onClick={() =>
                                        toggleSummaryExpanded(field)
                                      }
                                    >
                                      {expandedSummaryFields[field]
                                        ? "Show less"
                                        : "Show more"}
                                    </button>
                                  )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div
                      className="filter-panel-footer"
                      style={{
                        padding: "0.6rem 0.9rem",
                        borderTop:
                          "1px solid var(--border-color, rgba(0,0,0,0.1))",
                        display: "flex",
                        justifyContent: isFreshsalesLayout
                          ? "space-between"
                          : "flex-end",
                      }}
                    >
                      {isFreshsalesLayout && (
                        <button
                          type="button"
                          className="filter-panel-reset"
                          onClick={resetSummary}
                        >
                          Reset
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={applySummary}
                        style={{
                          fontSize: "0.85rem",
                          padding: "0.4rem 0.9rem",
                        }}
                      >
                        Apply
                      </button>
                    </div>
                  </>
                ) : !isSingleFieldMode && activeField === null ? (
                  <>
                    <div
                      className="filter-panel-header"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0.9rem 1rem",
                        borderBottom:
                          "1px solid var(--border-color, rgba(0,0,0,0.1))",
                      }}
                    >
                      <strong style={{ fontSize: "1rem" }}>Filters</strong>
                      <button
                        type="button"
                        className="filter-panel-icon-button"
                        onClick={closePanel}
                        aria-label="Close filters"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--text-secondary)",
                          display: "flex",
                        }}
                      >
                        <X size={18} />
                      </button>
                    </div>
                    <div
                      className="filter-panel-field-search"
                      style={{
                        padding: "0.6rem 0.9rem",
                        borderBottom:
                          "1px solid var(--border-color, rgba(0,0,0,0.08))",
                        position: "relative",
                      }}
                    >
                      <Search
                        size={14}
                        style={{
                          position: "absolute",
                          left: "1.4rem",
                          top: "50%",
                          transform: "translateY(-50%)",
                          color: "var(--text-secondary)",
                        }}
                      />
                      <input
                        value={fieldSearch}
                        onChange={(e) => setFieldSearch(e.target.value)}
                        placeholder={
                          isFreshsalesLayout
                            ? "Add a field to filter"
                            : "Search fields…"
                        }
                        aria-label="Search fields"
                        style={{
                          width: "100%",
                          padding: "0.45rem 0.6rem 0.45rem 2rem",
                          boxSizing: "border-box",
                          border:
                            "1px solid var(--border-color, rgba(0,0,0,0.12))",
                          borderRadius: 6,
                          background: "var(--surface-color, #fff)",
                          color: "var(--text-primary)",
                          fontSize: "0.85rem",
                          outline: "none",
                        }}
                      />
                    </div>
                    <div
                      className="filter-panel-field-list"
                      style={{
                        overflowY: "auto",
                        padding: "0.3rem 0",
                        flex: 1,
                      }}
                    >
                      {fieldsLoading && (
                        <div
                          style={{
                            padding: "0.6rem 0.9rem",
                            fontSize: "0.85rem",
                            color: "var(--text-secondary)",
                          }}
                        >
                          Loading fields…
                        </div>
                      )}
                      {!fieldsLoading && fields.length === 0 && (
                        <div
                          style={{
                            padding: "0.6rem 0.9rem",
                            fontSize: "0.85rem",
                            color: "var(--text-secondary)",
                          }}
                        >
                          No filterable fields.
                        </div>
                      )}
                      {(() => {
                        const term = fieldSearch.trim().toLowerCase();
                        const visibleFields = term
                          ? fields.filter((f) =>
                              `${f.label || ""} ${f.field || ""}`
                                .toLowerCase()
                                .includes(term),
                            )
                          : fields;
                        if (
                          !fieldsLoading &&
                          fields.length > 0 &&
                          visibleFields.length === 0
                        ) {
                          return (
                            <div
                              style={{
                                padding: "0.6rem 0.9rem",
                                fontSize: "0.85rem",
                                color: "var(--text-secondary)",
                              }}
                            >
                              No matching fields.
                            </div>
                          );
                        }
                        const renderFieldOption = (f) => {
                          const active = filters.some(
                            (flt) => flt.field === f.field,
                          );
                          return (
                            <button
                              key={f.field}
                              type="button"
                              className="filter-panel-field-option"
                              onClick={() => chooseField(f.field)}
                              style={{
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                padding: "0.55rem 0.9rem",
                                background: active
                                  ? "var(--subtle-bg, rgba(0,0,0,0.04))"
                                  : "transparent",
                                border: "none",
                                cursor: "pointer",
                                fontSize: "0.87rem",
                                color: "var(--text-primary)",
                              }}
                            >
                              {f.label}
                            </button>
                          );
                        };
                        if (!isFreshsalesLayout || term) {
                          return visibleFields.map(renderFieldOption);
                        }
                        const popularFieldKeys = new Set([
                          "source",
                          "status",
                          "assignedToId",
                        ]);
                        const popularFields = visibleFields.filter((f) =>
                          popularFieldKeys.has(f.field),
                        );
                        const otherFields = visibleFields.filter(
                          (f) => !popularFieldKeys.has(f.field),
                        );
                        return (
                          <>
                            {popularFields.length > 0 && (
                              <div className="filter-panel-field-group">
                                <strong className="filter-panel-field-group-title">
                                  Popular filters
                                </strong>
                                {popularFields.map(renderFieldOption)}
                              </div>
                            )}
                            {otherFields.length > 0 && (
                              <div className="filter-panel-field-group">
                                <strong className="filter-panel-field-group-title">
                                  Other filters
                                </strong>
                                {otherFields.map(renderFieldOption)}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className="filter-panel-field-header"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        padding: "0.7rem 0.9rem",
                        borderBottom:
                          "1px solid var(--border-color, rgba(0,0,0,0.1))",
                      }}
                    >
                      {!isSingleFieldMode && (
                        <button
                          type="button"
                          onClick={backToFieldList}
                          aria-label="Back to field list"
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--text-secondary)",
                            display: "flex",
                          }}
                        >
                          <ChevronLeft size={16} />
                        </button>
                      )}
                      <strong style={{ fontSize: "0.9rem", flex: 1 }}>
                        {activeFieldLabel}
                      </strong>
                      {(() => {
                        const labels = operatorLabelsFor(activeKind);
                        return (
                          <select
                            className="filter-panel-operator"
                            value={operator}
                            onChange={(e) => setOperator(e.target.value)}
                            style={{
                              padding: "0.3rem 0.5rem",
                              borderRadius: 6,
                              border:
                                "1px solid var(--border-color, rgba(0,0,0,0.12))",
                              background: "var(--surface-color, #fff)",
                              color: "var(--accent-color)",
                              fontSize: "0.82rem",
                            }}
                          >
                            {/* A date is picked on a calendar, so substring
                            operators make no sense for it — it gets a range
                            instead, plus the empty/not-empty pair. */}
                            {isDateField ? (
                              <option value="between">is between</option>
                            ) : (
                              <>
                                <option value="contains">
                                  {labels.contains}
                                </option>
                                <option value="not_contains">
                                  {labels.not_contains}
                                </option>
                              </>
                            )}
                            <option value="is_not_empty">
                              {labels.is_not_empty} (has any value)
                            </option>
                            <option value="is_empty">{labels.is_empty}</option>
                          </select>
                        );
                      })()}
                    </div>
                    {needsRange && (
                      <div
                        style={{
                          padding: "0.9rem",
                          display: "grid",
                          gap: "0.6rem",
                        }}
                      >
                        <CalendarRangePicker
                          value={dateRange}
                          onChange={(next) =>
                            setDateRange({
                              from: next?.from || "",
                              to: next?.to || "",
                            })
                          }
                        />
                        <span
                          style={{
                            fontSize: "0.78rem",
                            color: "var(--text-secondary)",
                            lineHeight: 1.5,
                          }}
                        >
                          Pick one date for a single day, or two to cover a
                          range. Both ends are included.
                        </span>
                      </div>
                    )}
                    {needsValues && (
                      <>
                        <div
                          style={{
                            padding: "0.6rem 0.9rem",
                            borderBottom:
                              "1px solid var(--border-color, rgba(0,0,0,0.08))",
                            position: "relative",
                          }}
                        >
                          <Search
                            size={14}
                            style={{
                              position: "absolute",
                              left: "1.4rem",
                              top: "50%",
                              transform: "translateY(-50%)",
                              color: "var(--text-secondary)",
                            }}
                          />
                          <input
                            value={valueSearch}
                            onChange={(e) => setValueSearch(e.target.value)}
                            placeholder="Search values…"
                            aria-label="Search values"
                            style={{
                              width: "100%",
                              padding: "0.45rem 0.6rem 0.45rem 2rem",
                              boxSizing: "border-box",
                              border:
                                "1px solid var(--border-color, rgba(0,0,0,0.12))",
                              borderRadius: 6,
                              background: "var(--surface-color, #fff)",
                              color: "var(--text-primary)",
                              fontSize: "0.85rem",
                              outline: "none",
                            }}
                          />
                        </div>
                        <div
                          style={{
                            overflowY: "auto",
                            padding: "0.3rem 0",
                            flex: 1,
                            minHeight: 0,
                          }}
                        >
                          {valuesLoading && (
                            <div
                              style={{
                                padding: "0.6rem 0.9rem",
                                fontSize: "0.85rem",
                                color: "var(--text-secondary)",
                              }}
                            >
                              Loading values…
                            </div>
                          )}
                          {!valuesLoading &&
                            (valuesByField[activeField] || []).length === 0 && (
                              <div
                                style={{
                                  padding: "0.6rem 0.9rem",
                                  fontSize: "0.85rem",
                                  color: "var(--text-secondary)",
                                }}
                              >
                                No values found.
                              </div>
                            )}
                          {!valuesLoading &&
                            (() => {
                              const term = valueSearch.trim().toLowerCase();
                              const options = valuesByField[activeField] || [];
                              const visibleOptions = term
                                ? options.filter((o) =>
                                    o.label.toLowerCase().includes(term),
                                  )
                                : options;
                              if (
                                options.length > 0 &&
                                visibleOptions.length === 0
                              ) {
                                return (
                                  <div
                                    style={{
                                      padding: "0.6rem 0.9rem",
                                      fontSize: "0.85rem",
                                      color: "var(--text-secondary)",
                                    }}
                                  >
                                    No matching values.
                                  </div>
                                );
                              }
                              return visibleOptions.map((opt) => (
                                <label
                                  key={opt.value}
                                  className="filter-panel-value-option"
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.55rem",
                                    padding: "0.45rem 0.9rem",
                                    cursor: "pointer",
                                    fontSize: "0.87rem",
                                    color: "var(--text-primary)",
                                    background: checked.includes(opt.value)
                                      ? "var(--subtle-bg, rgba(0,0,0,0.04))"
                                      : "transparent",
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked.includes(opt.value)}
                                    onChange={() => toggleValue(opt.value)}
                                  />
                                  <span
                                    style={{
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {opt.label}
                                  </span>
                                </label>
                              ));
                            })()}
                        </div>
                      </>
                    )}
                    <div
                      className="filter-panel-footer"
                      style={{
                        padding: "0.6rem 0.9rem",
                        borderTop:
                          "1px solid var(--border-color, rgba(0,0,0,0.1))",
                        display: "flex",
                        justifyContent: "flex-end",
                      }}
                    >
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={applyFilter}
                        disabled={applyDisabled}
                        style={{
                          fontSize: "0.85rem",
                          padding: "0.4rem 0.9rem",
                          opacity: applyDisabled ? 0.5 : 1,
                        }}
                      >
                        Apply
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>,
            document.body,
          )}
      </div>

      {renderSelectedFilters &&
        filters.map((f) => (
          <span
            key={f.field}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.35rem 0.6rem",
              borderRadius: 999,
              background: "var(--subtle-bg, rgba(0,0,0,0.05))",
              border: "1px solid var(--border-color, rgba(0,0,0,0.1))",
              fontSize: "0.8rem",
              color: "var(--text-primary)",
            }}
          >
            <strong>{f.label}</strong> {operatorLabelsFor(f.kind)[f.operator]}
            {f.valueLabels && f.valueLabels.length > 0
              ? ` ${f.valueLabels.join(", ")}`
              : ""}
            <button
              type="button"
              onClick={() => removeFilter(f.field)}
              aria-label={`Remove ${f.label} filter`}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--text-secondary)",
                display: "flex",
                padding: 0,
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}

      {renderSelectedFilters && filters.length > 0 && (
          <button
            type="button"
            onClick={openFieldList}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            background: "none",
            border: "none",
            color: "var(--accent-color)",
            cursor: "pointer",
            fontSize: "0.8rem",
          }}
        >
          <Plus size={13} /> Add filter
        </button>
      )}
    </div>
  );
}
