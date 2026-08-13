import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Filter, X, ChevronLeft, Plus, Search } from "lucide-react";
import { fetchApi } from "../utils/api";
import CalendarRangePicker from "./CalendarRangePicker";

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
}) {
  const isSingleFieldMode = Boolean(fieldKey);
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
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const autoOpenOnceRef = useRef(false);

  const closePanel = useCallback(() => {
    setOpen(false);
    setActiveField(null);
    onClose?.();
  }, [onClose]);

  const chooseField = useCallback(
    async (field, meta = {}) => {
      const chosenKind =
        meta.kind || fields.find((f) => f.field === field)?.kind || "text";
      setActiveField(field);
      // A date field is picked on a calendar, so it opens on `between` rather
      // than the substring/checkbox operators the other kinds default to.
      setOperator(chosenKind === "date" ? "between" : "contains");
      setChecked([]);
      setValueSearch("");
      setDateRange({ from: "", to: "" });
      // Date fields never show a value list â€” there is nothing to fetch.
      if (chosenKind === "date") return;
      if (valuesByField[field]) return;
      setValuesLoading(true);
      try {
        const data = await fetchApi(valuesUrl(field), { silent: true });
        setValuesByField((prev) => ({ ...prev, [field]: data.values || [] }));
      } catch {
        setValuesByField((prev) => ({ ...prev, [field]: [] }));
      } finally {
        setValuesLoading(false);
      }
    },
    [fields, valuesByField, valuesUrl],
  );

  const openFieldPicker = useCallback(() => {
    setOpen(true);
    if (isSingleFieldMode) {
      chooseField(fieldKey, { kind: fieldKind });
      return;
    }
    setActiveField(null);
    setFieldSearch("");
  }, [chooseField, fieldKey, fieldKind, isSingleFieldMode]);

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

  // Apply stays disabled until the chosen operator actually has an input:
  // checkbox operators need a tick, `between` needs at least one end of the
  // range. The empty/not-empty operators need neither.
  const applyDisabled =
    (needsValues && checked.length === 0) ||
    (needsRange && !dateRange.from && !dateRange.to);

  const applyFilter = () => {
    if (!activeField) return;
    if (needsValues && checked.length === 0) return;
    if (needsRange && !dateRange.from && !dateRange.to) return;
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
              background: buttonActive
                ? "var(--surface-hover, rgba(0,0,0,0.04))"
                : "var(--surface-color, #fff)",
              border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
              borderRadius: 8,
              color: buttonActive
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
              {/* Dim backdrop — click-through to the outside-click handler above,
                but visually grounds the drawer as an overlay the way the
                Freshsales reference UI dims the page behind the panel. */}
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  zIndex: 1099,
                  background: "rgba(0,0,0,0.15)",
                }}
              />
              <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
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
                {!isSingleFieldMode && activeField === null ? (
                  <>
                    <div
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
                        placeholder="Search fields…"
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
                        return visibleFields.map((f) => {
                          const active = filters.some(
                            (flt) => flt.field === f.field,
                          );
                          return (
                            <button
                              key={f.field}
                              type="button"
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
                        });
                      })()}
                    </div>
                  </>
                ) : (
                  <>
                    <div
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
          onClick={openFieldPicker}
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
