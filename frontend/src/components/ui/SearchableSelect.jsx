import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check, X } from "lucide-react";

/**
 * frontend/src/components/ui/SearchableSelect.jsx
 *
 * Single-select combobox: a native <input> trigger that doubles as the
 * search box, plus a portal-rendered option list.
 *
 * Why this exists: a native <select> gives no way to search. On lists that
 * grow with the tenant's catalogue (wellness services — several hundred
 * rows — or the doctor roster) the patient has to scroll a 300-row popup
 * to find "Advanced Acne Facial". This is the searchable equivalent, with
 * the same `value` / `onChange(value)` contract as a controlled <select>
 * so it drops into existing form state untouched.
 *
 * The trigger is a real <input>, NOT a styled <button>. That is deliberate:
 * every vertical theme (wellness/travel) styles `input, select, textarea`
 * with `!important`, so an <input> inherits the exact chrome of the native
 * selects sitting next to it in the same form — in light AND dark mode —
 * without this component shipping any theme-specific CSS.
 *
 * Popover colours use only theme-neutral tokens (--modal-bg is opaque in
 * both modes; the active-row highlight is a grey wash + accent bar rather
 * than an accent fill, which would be unreadable against wellness gold on
 * dark). Nothing here assumes a light or a dark background.
 *
 * options: [{ value, label, hint?, keywords?, disabled? }]
 *   hint     — muted trailing text (e.g. "(On Leave)", "₹9999")
 *   keywords — extra searchable text not shown in the label (e.g. specialty)
 */

const MAX_POPOVER_HEIGHT = 280;
const ROW_HEIGHT = 38;

// Every whitespace-separated token must appear somewhere in the option's
// searchable text, so "acne facial" matches "Advanced Acne Facial" and
// "kumar arjun" matches "Dr. ARJUN KUMAR" regardless of word order.
function matches(option, query) {
  if (!query) return true;
  const haystack = `${option.label || ""} ${option.hint || ""} ${
    option.keywords || ""
  }`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export default function SearchableSelect({
  value,
  onChange,
  options = [],
  placeholder = "Select…",
  emptyLabel = "No matches",
  disabled = false,
  allowClear = true,
  ariaLabel,
  id,
  className = "input-field",
  style,
  wrapperStyle,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [pos, setPos] = useState(null);

  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const popRef = useRef(null);

  const selected = useMemo(
    () => options.find((o) => String(o.value) === String(value ?? "")),
    [options, value],
  );

  const filtered = useMemo(
    () => options.filter((o) => matches(o, query)),
    [options, query],
  );

  // Fixed-position coordinates from the trigger's rect, flipping upward when
  // the field sits low in the viewport (the booking form's Service select is
  // near the fold on a laptop, so a downward-only popover would be clipped).
  const computePos = () => {
    const el = wrapRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const flipUp = below < Math.min(MAX_POPOVER_HEIGHT, 180) && above > below;
    const maxHeight = Math.max(
      120,
      Math.min(MAX_POPOVER_HEIGHT, flipUp ? above : below),
    );
    return {
      left: rect.left,
      width: rect.width,
      maxHeight,
      ...(flipUp
        ? { bottom: window.innerHeight - rect.top + 4 }
        : { top: rect.bottom + 4 }),
    };
  };

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    if (!open) return undefined;
    setPos(computePos());
    const recompute = () => setPos(computePos());
    const onDocDown = (e) => {
      const inWrap = wrapRef.current && wrapRef.current.contains(e.target);
      const inPop = popRef.current && popRef.current.contains(e.target);
      if (!inWrap && !inPop) close();
    };
    document.addEventListener("mousedown", onDocDown);
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  // Keep the keyboard-highlighted row inside the scroll viewport.
  useEffect(() => {
    if (!open || !popRef.current) return;
    const row = popRef.current.querySelector(`[data-idx="${activeIndex}"]`);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const openList = () => {
    if (disabled) return;
    setQuery("");
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((o) => String(o.value) === String(value ?? "")),
      ),
    );
    setOpen(true);
  };

  const pick = (option) => {
    if (!option || option.disabled) return;
    onChange?.(option.value);
    close();
    inputRef.current?.blur();
  };

  // Move the highlight to the next non-disabled row in `dir` (+1 / -1).
  const move = (dir) => {
    if (!filtered.length) return;
    let next = activeIndex;
    for (let i = 0; i < filtered.length; i++) {
      next = (next + dir + filtered.length) % filtered.length;
      if (!filtered[next]?.disabled) break;
    }
    setActiveIndex(next);
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openList();
      else move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      // The combobox usually lives inside a <form>; a bare Enter here would
      // submit the booking rather than choose the highlighted option.
      if (open) {
        e.preventDefault();
        pick(filtered[activeIndex]);
      }
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab" && open) close();
  };

  const displayValue = open ? query : selected ? selected.label : "";
  // Closed, the field reads like a <select> (the selected label). Open, it
  // IS the search box, so `placeholder` doubles as the search prompt.
  const displayPlaceholder = placeholder;

  // A caller may include an empty-value row ("— None —") as a real option;
  // that is the *unset* state, so it must not offer a Clear affordance.
  const showClear =
    allowClear && !disabled && !!selected && String(value ?? "") !== "";

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: "100%", ...wrapperStyle }}
    >
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        className={className}
        value={displayValue}
        placeholder={displayPlaceholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
          if (!open) setOpen(true);
        }}
        onMouseDown={() => {
          if (!open) openList();
        }}
        onFocus={() => {
          if (!open) openList();
        }}
        onKeyDown={onKeyDown}
        style={{
          width: "100%",
          cursor: disabled ? "not-allowed" : "text",
          ...style,
          paddingRight: showClear ? "3.6rem" : "2.2rem",
        }}
      />

      {showClear && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Clear selection"
          title="Clear selection"
          onClick={() => {
            onChange?.("");
            close();
          }}
          style={{
            position: "absolute",
            right: "1.9rem",
            top: "50%",
            transform: "translateY(-50%)",
            background: "transparent",
            border: "none",
            padding: 2,
            display: "inline-flex",
            cursor: "pointer",
            color: "var(--text-secondary)",
          }}
        >
          <X size={14} />
        </button>
      )}
      <ChevronDown
        size={16}
        aria-hidden="true"
        style={{
          position: "absolute",
          right: "0.7rem",
          top: "50%",
          transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
          transition: "transform 0.15s ease",
          color: "var(--text-secondary)",
          pointerEvents: "none",
        }}
      />

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              bottom: pos.bottom,
              width: pos.width,
              maxHeight: pos.maxHeight,
              overflowY: "auto",
              zIndex: 1200,
              // --modal-bg is the one surface token that is opaque in both
              // light (#fff) and dark (#1a1c22); --surface-color carries
              // glass alpha and would let the page bleed through.
              background: "var(--modal-bg, var(--bg-color, #fff))",
              border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
              borderRadius: 8,
              boxShadow: "var(--glass-shadow, 0 12px 32px rgba(0,0,0,0.25))",
              padding: "0.25rem 0",
            }}
          >
            {filtered.length === 0 && (
              <div
                style={{
                  padding: "0.75rem 0.9rem",
                  fontSize: "0.85rem",
                  color: "var(--text-secondary)",
                }}
              >
                {emptyLabel}
              </div>
            )}
            {filtered.map((o, idx) => {
              const isSelected = String(o.value) === String(value ?? "");
              const isActive = idx === activeIndex;
              return (
                <button
                  key={`${o.value}`}
                  type="button"
                  role="option"
                  data-idx={idx}
                  aria-selected={isSelected}
                  disabled={o.disabled}
                  onMouseEnter={() => !o.disabled && setActiveIndex(idx)}
                  onClick={() => pick(o)}
                  style={{
                    width: "100%",
                    minHeight: ROW_HEIGHT,
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    textAlign: "left",
                    padding: "0.5rem 0.75rem",
                    // Grey wash + accent bar rather than an accent fill:
                    // readable on white and on near-black alike, and it
                    // doesn't fight the wellness gold accent.
                    background: isActive
                      ? "rgba(128,128,128,0.20)"
                      : "transparent",
                    borderWidth: 0,
                    borderLeftWidth: 3,
                    borderLeftStyle: "solid",
                    borderLeftColor: isActive
                      ? "var(--accent-color, #3b82f6)"
                      : "transparent",
                    color: o.disabled
                      ? "var(--text-secondary)"
                      : "var(--text-primary)",
                    fontSize: "0.875rem",
                    fontWeight: isSelected ? 600 : 400,
                    opacity: o.disabled ? 0.6 : 1,
                    cursor: o.disabled ? "not-allowed" : "pointer",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {o.label}
                    {o.hint ? (
                      <span
                        style={{
                          color: "var(--text-secondary)",
                          fontWeight: 400,
                          marginLeft: "0.35rem",
                        }}
                      >
                        {o.hint}
                      </span>
                    ) : null}
                  </span>
                  {isSelected && (
                    <Check
                      size={14}
                      style={{
                        flexShrink: 0,
                        color: "var(--accent-color, #3b82f6)",
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
