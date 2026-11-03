import { useState, useRef, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

// ── ScrollableSelect — single-select dropdown capped to ~5 visible rows ──
//
// A plain native <select> can't have its OPEN dropdown's height capped in a
// cross-browser way — the browser renders the full option list regardless
// of how many options there are. This is a drop-in single-select
// replacement: same value/onChange contract as a controlled <select>, but
// the open popover is height-capped (via ROW_HEIGHT * maxVisibleRows) and
// scrolls for anything beyond that, so a long staff/agent list doesn't
// dump 50 rows onto the page at once.
//
// options: [{ value: string, label: string }, ...] — value "" is treated
// as the default option and is NOT count against maxVisibleRows scrolling
// (it renders like any other row; callers wanting an "All X" default just
// include it as the first option, same as they would with <option value="">).
export default function ScrollableSelect({
  value,
  onChange,
  options,
  placeholder,
  maxVisibleRows = 5,
  width = 170,
  ariaLabel,
  disabled = false,
  compact = false,
  className = "",
  searchable = false,
  searchPlaceholder = "Search options…",
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [popoverPos, setPopoverPos] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const listboxId = useId();

  const ROW_HEIGHT = 34;

  const computePos = () => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const desiredHeight = ROW_HEIGHT * maxVisibleRows;
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding - 4;
    const availableAbove = rect.top - viewportPadding - 4;
    const openUp = availableBelow < desiredHeight && availableAbove > availableBelow;
    const availableHeight = openUp ? availableAbove : availableBelow;
    const minimumWidth = typeof width === "number" ? width : rect.width;
    const menuWidth = Math.min(
      Math.max(minimumWidth, rect.width),
      Math.max(0, window.innerWidth - (viewportPadding * 2)),
    );
    return {
      left: Math.max(
        viewportPadding,
        Math.min(rect.left, window.innerWidth - menuWidth - viewportPadding),
      ),
      top: openUp ? undefined : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : undefined,
      width: menuWidth,
      maxHeight: Math.max(ROW_HEIGHT, Math.min(desiredHeight, availableHeight)),
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
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        setSearchQuery("");
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleOptions = searchable && normalizedSearch
    ? options.filter((option) => option.label.toLowerCase().includes(normalizedSearch))
    : options;

  const handleSelect = (val) => {
    onChange?.(val);
    setOpen(false);
    setSearchQuery("");
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const triggerStyle = {
    width,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.4rem",
    textAlign: "left",
    opacity: disabled ? 0.7 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    ...(compact ? {
      minHeight: 26,
      height: 26,
      padding: "0.2rem 0.35rem",
      borderRadius: 6,
      fontSize: "0.7rem",
    } : {}),
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block", minWidth: 0, maxWidth: "100%" }}>
      {open && searchable ? (
        <input
          ref={triggerRef}
          type="search"
          role="combobox"
          autoFocus
          className={`input-field ${className}`.trim()}
          aria-label={`Search ${ariaLabel || "options"}`}
          aria-controls={listboxId}
          aria-expanded="true"
          aria-haspopup="listbox"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          style={{ ...triggerStyle, cursor: "text" }}
        />
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setSearchQuery("");
            setOpen((current) => !current);
          }}
          className={`input-field ${className}`.trim()}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-label={ariaLabel}
          disabled={disabled}
          style={triggerStyle}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selected ? selected.label : (placeholder || "Select…")}
          </span>
          <ChevronDown size={14} style={{ flexShrink: 0, color: "var(--text-secondary)" }} />
        </button>
      )}

      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: "fixed",
            left: popoverPos.left,
            top: popoverPos.top,
            bottom: popoverPos.bottom,
            width: popoverPos.width,
            maxHeight: popoverPos.maxHeight,
            overflowY: "auto",
            zIndex: 1100,
            background: "var(--bg-color, #fff)",
            border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
            borderRadius: 8,
            boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
          }}
        >
          {visibleOptions.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => handleSelect(o.value)}
              style={{
                width: "100%",
                display: "block",
                textAlign: "left",
                padding: "0.5rem 0.75rem",
                fontSize: "0.875rem",
                background: o.value === value ? "var(--surface-hover, rgba(255,255,255,0.06))" : "transparent",
                fontWeight: o.value === value ? 600 : 400,
                border: "none",
                borderBottom: "1px solid var(--border-color)",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              {o.label}
            </button>
          ))}
          {visibleOptions.length === 0 && (
            <div style={{ padding: "0.75rem", color: "var(--text-secondary)", fontSize: "0.875rem" }}>
              No matching options
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
