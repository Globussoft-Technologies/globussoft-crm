import { useState, useRef, useEffect, createPortal } from "react";
import { ChevronDown, X } from "lucide-react";

const modalInputStyle = {
  width: "100%",
  padding: "0.6rem 0.8rem",
  background: "var(--surface-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontSize: "0.92rem",
  outline: "none",
  boxSizing: "border-box",
};

// ── MultiSelectDropdown — trigger button + checkbox-list popover ───
// Open/close is local state; close on outside-click / Esc. Optional
// `searchable` adds a filter input on top of the list (used by Tags).
// `chipColours` renders a small color dot next to each option (used by
// Tags so the user can recognise their own labels visually).
//
// The popover renders with `position: fixed` and coordinates computed
// from the trigger's bounding rect. Two reasons:
//   1. The dropdown lives inside a modal whose body has `overflow:auto`
//      — with `position:absolute` the popover gets clipped at the
//      modal's bottom edge (the user had to scroll inside the modal
//      to reveal the Tags list).
//   2. The popover auto-flips upward when there's not enough room
//      below the trigger — so the last filter in the modal can show
//      its full list without forcing the modal to scroll at all.
export default function MultiSelectDropdown({ options, selected, onChange, placeholder, searchable = false, chipColours = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [popoverPos, setPopoverPos] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  // The popover is rendered via createPortal to document.body (see the
  // big comment near the popover render). It is therefore NOT a DOM
  // descendant of wrapRef, so the outside-click handler needs its own
  // ref to recognise clicks-on-popover as "inside".
  const popoverRef = useRef(null);

  // Compute fixed-positioned coordinates from the trigger's rect.
  //
  // Auto-flip heuristic (revised):
  //   * Open UPWARD if the trigger's vertical center sits in the
  //     bottom ~45% of the viewport AND there's at least POPOVER_MIN
  //     room above.
  //   * Otherwise open downward.
  //
  // The previous heuristic ("only flip up when spaceBelow < 160px")
  // didn't work inside a modal — the popover can flow outside the
  // modal into the dim backdrop area, so `spaceBelow` was always
  // plenty even when the popover ended up visually awkward (cut off
  // at the modal bottom edge / overlapping the page below). Biasing
  // by trigger position relative to the viewport gives the result
  // the user expects: a filter at the bottom of the modal opens up.
  //
  // maxHeight is clamped to the available space minus 12 px viewport
  // breathing room so the popover never bleeds past the viewport.
  const POPOVER_DESIRED = 320;
  const POPOVER_MIN = 160;
  const computePos = () => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const vpH = window.innerHeight;
    const spaceBelow = vpH - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const triggerCenterY = rect.top + rect.height / 2;
    const inLowerHalf = triggerCenterY > vpH * 0.55;
    const openUp = inLowerHalf && spaceAbove >= POPOVER_MIN;
    const available = openUp ? spaceAbove : spaceBelow;
    const maxH = Math.max(POPOVER_MIN, Math.min(available, POPOVER_DESIRED));
    if (openUp) {
      return {
        left: rect.left,
        bottom: vpH - rect.top + 6,
        width: rect.width,
        maxHeight: maxH,
      };
    }
    return {
      left: rect.left,
      top: rect.bottom + 6,
      width: rect.width,
      maxHeight: maxH,
    };
  };

  useEffect(() => {
    if (!open) return undefined;
    setPopoverPos(computePos());
    const recompute = () => setPopoverPos(computePos());
    const onDoc = (e) => {
      // Popover is portalled to document.body, so it's NOT a DOM
      // descendant of wrapRef. Check both refs.
      const insideWrap = wrapRef.current && wrapRef.current.contains(e.target);
      const insidePopover = popoverRef.current && popoverRef.current.contains(e.target);
      if (!insideWrap && !insidePopover) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", recompute);
    // Capture-phase scroll listener catches ANY scroll — page, modal
    // body, any nested overflow:auto container — and keeps the popover
    // glued to the trigger as it moves.
    window.addEventListener("scroll", recompute, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [open]);

  const toggle = (value) => {
    if (selected.includes(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  };

  // Summary shown inside the trigger.
  let summary;
  if (selected.length === 0) {
    summary = <span style={{ color: "var(--text-tertiary, var(--text-secondary))" }}>{placeholder}</span>;
  } else if (selected.length === 1) {
    const lone = options.find((o) => o.value === selected[0]);
    summary = lone ? lone.label : "1 selected";
  } else {
    summary = `${selected.length} selected`;
  }

  const filtered = searchable && search.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          ...modalInputStyle,
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          cursor: "pointer",
          textAlign: "left",
          minHeight: 42,
          padding: "0.55rem 0.8rem",
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </span>
        {selected.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange([]); } }}
            aria-label="Clear selection"
            title="Clear selection"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0.15rem",
              borderRadius: 999,
              background: "var(--subtle-bg, rgba(0,0,0,0.04))",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            <X size={12} />
          </span>
        )}
        <ChevronDown size={14} style={{ color: "var(--text-secondary)", transition: "transform 0.12s ease", transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          role="listbox"
          style={{
            position: "fixed",
            ...popoverPos,
            // Above the modal overlay (z=1000). Portalled to document.body
            // (see comment at the top of the component) so it escapes the
            // modal's `.glass` backdrop-filter — that backdrop-filter
            // creates a containing block for position:fixed descendants
            // per CSS spec, which is why the previous in-place render
            // came out invisible / off-screen.
            zIndex: 1100,
            // IMPORTANT: --bg-color (not --surface-color). In dark
            // wellness, --surface-color is rgba(30,38,40,0.6) — 60%
            // transparent — which makes the popover see-through and
            // illegible against the modal's form fields behind it.
            // --bg-color is opaque in BOTH themes.
            background: "var(--bg-color, #fff)",
            border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
            borderRadius: 10,
            boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {searchable && (
            <div style={{ padding: "0.5rem 0.6rem", borderBottom: "1px solid var(--border-color, rgba(0,0,0,0.08))" }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                aria-label="Search options"
                style={{
                  width: "100%",
                  padding: "0.35rem 0.55rem",
                  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
                  borderRadius: 6,
                  background: "var(--surface-color, #fff)",
                  color: "var(--text-primary)",
                  fontSize: "0.85rem",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}
          <div style={{ overflowY: "auto", padding: "0.25rem 0", flex: 1, minHeight: 0 }}>
            {filtered.length === 0 && (
              <div style={{ padding: "0.6rem 0.8rem", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                {searchable && search.trim() ? "No matches." : "No options."}
              </div>
            )}
            {filtered.map((opt) => {
              const isSelected = selected.includes(opt.value);
              return (
                <label
                  key={opt.value}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.55rem",
                    padding: "0.45rem 0.8rem",
                    cursor: "pointer",
                    fontSize: "0.88rem",
                    color: "var(--text-primary)",
                    background: isSelected ? "var(--subtle-bg, rgba(0,0,0,0.04))" : "transparent",
                    transition: "background 0.1s ease",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(opt.value)}
                    aria-label={opt.label}
                  />
                  {chipColours && opt.color && (
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: opt.color, flexShrink: 0 }} />
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt.label}</span>
                </label>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
