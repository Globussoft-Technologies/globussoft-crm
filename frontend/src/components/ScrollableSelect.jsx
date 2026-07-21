import { useState, useRef, useEffect } from "react";
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
export default function ScrollableSelect({ value, onChange, options, placeholder, maxVisibleRows = 5, width = 170, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);

  const ROW_HEIGHT = 34;

  const computePos = () => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.bottom + 4,
      width: Math.max(width, rect.width),
      maxHeight: ROW_HEIGHT * maxVisibleRows,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = options.find((o) => o.value === value);

  const handleSelect = (val) => {
    onChange?.(val);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="input-field"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        style={{
          width,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.4rem",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? selected.label : (placeholder || "Select…")}
        </span>
        <ChevronDown size={14} style={{ flexShrink: 0, color: "var(--text-secondary)" }} />
      </button>

      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: "fixed",
            left: popoverPos.left,
            top: popoverPos.top,
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
          {options.map((o) => (
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
        </div>,
        document.body,
      )}
    </div>
  );
}
