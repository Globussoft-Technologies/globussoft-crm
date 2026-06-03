import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { dropdownMenuStyle, dropdownItemStyle } from "./styles";

// Pagination footer — Prev / numbered pages (windowed) / Next + items-per-
// page selector. Rendered below the table so it's always reachable even
// with a tall list. Hides itself when total fits within a single page.
export default function PatientPager({ total, page, pageSize, onPageChange, onPageSizeChange, isCustomPageSize, setIsCustomPageSize, customPageSize, setCustomPageSize }) {
  const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
  const safePage = Math.min(page, pageCount);
  // Custom dropdown for the page-size selector — matches the Export
  // Selected menu shape (button + absolute popup) so the surface looks
  // theme-consistent across both verticals. Native <select> rendered the
  // <option> popup with the OS palette regardless of how the trigger was
  // styled, which clashed with the dark wellness theme.
  const [pageSizeMenuOpen, setPageSizeMenuOpen] = useState(false);
  const pageSizeMenuRef = useRef(null);
  const [hoveredOption, setHoveredOption] = useState(null);
  useEffect(() => {
    if (!pageSizeMenuOpen) return undefined;
    const onDocClick = (e) => {
      if (pageSizeMenuRef.current && !pageSizeMenuRef.current.contains(e.target)) {
        setPageSizeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pageSizeMenuOpen]);
  const pages = useMemo(() => {
    // Compact window: always show 1, the current page ±2, and pageCount,
    // with ellipses where there's a gap. Keeps the bar narrow on long
    // lists (e.g. 600+ patients = 13+ pages of 50).
    const out = new Set([1, pageCount, safePage]);
    for (let i = Math.max(2, safePage - 2); i <= Math.min(pageCount - 1, safePage + 2); i++) {
      out.add(i);
    }
    const sorted = Array.from(out).sort((a, b) => a - b);
    const withGaps = [];
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 1) withGaps.push("…");
      withGaps.push(p);
    });
    return withGaps;
  }, [pageCount, safePage]);

  if (total === 0) return null;
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);

  const pillBtn = (active, disabled) => ({
    minWidth: 32, height: 32, padding: "0 0.5rem",
    background: active ? "var(--primary-color, var(--accent-color))" : "transparent",
    color: active ? "#fff" : "var(--text-primary)",
    border: "1px solid var(--border-color, rgba(255,255,255,0.18))",
    borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "0.85rem", display: "inline-flex", alignItems: "center", justifyContent: "center",
    opacity: disabled ? 0.4 : 1,
  });

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center", justifyContent: "space-between", padding: "0.85rem 1rem", borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))", fontSize: "0.85rem" }}>
      <div style={{ color: "var(--text-secondary)" }}>
        Showing <strong style={{ color: "var(--text-primary)" }}>{start}–{end}</strong> of <strong style={{ color: "var(--text-primary)" }}>{total}</strong> patients
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
        <label style={{ color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          Per page:
          {isCustomPageSize ? (
            <>
              <input
                type="number"
                min="1"
                max="200"
                value={customPageSize}
                onChange={(e) => {
                  // Backend caps ?limit at 200; clamp the input to the same
                  // range so a typo can't fire a request that gets silently
                  // truncated server-side.
                  const raw = parseInt(e.target.value, 10);
                  const val = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : '';
                  setCustomPageSize(val);
                  if (val) onPageSizeChange(val);
                }}
                placeholder="1-200"
                autoFocus
                title="Enter a number between 1 and 200"
                style={{ width: 80, padding: "0.3rem 0.5rem", borderRadius: 6, border: "1px solid var(--border-color, rgba(255,255,255,0.18))", background: "var(--surface-color, rgba(255,255,255,0.04))", color: "var(--text-primary)" }}
              />
              <button
                type="button"
                onClick={() => { setIsCustomPageSize(false); setCustomPageSize(''); }}
                style={{ padding: "0.3rem 0.55rem", borderRadius: 6, border: "1px solid var(--border-color, rgba(255,255,255,0.18))", background: "var(--surface-color, rgba(255,255,255,0.04))", color: "var(--text-primary)", cursor: "pointer", fontSize: "0.85rem" }}
              >
                Back
              </button>
            </>
          ) : (
            <div ref={pageSizeMenuRef} style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setPageSizeMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={pageSizeMenuOpen}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  padding: "0.3rem 0.55rem",
                  borderRadius: 6,
                  border: "1px solid var(--border-color, rgba(255,255,255,0.18))",
                  background: "var(--surface-color, rgba(255,255,255,0.04))",
                  color: "var(--text-primary)",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                  minWidth: 70,
                }}
              >
                <span>{[10, 20, 50].includes(pageSize) ? pageSize : 'Custom'}</span>
                <ChevronDown size={12} style={{ opacity: 0.7 }} />
              </button>
              {pageSizeMenuOpen && (
                <div
                  role="menu"
                  style={{
                    ...dropdownMenuStyle,
                    // Pager lives at the bottom of the table, so open the menu
                    // upward to avoid clipping below the viewport. Anchored to
                    // the trigger button's left edge.
                    top: "auto",
                    bottom: "calc(100% + 4px)",
                    right: "auto",
                    left: 0,
                    minWidth: 110,
                  }}
                >
                  {[10, 20, 50].map((n) => {
                    const active = pageSize === n;
                    const hovered = hoveredOption === String(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        role="menuitem"
                        onClick={() => { onPageSizeChange(n); setPageSizeMenuOpen(false); }}
                        onMouseEnter={() => setHoveredOption(String(n))}
                        onMouseLeave={() => setHoveredOption(null)}
                        style={{
                          ...dropdownItemStyle,
                          background: active
                            ? "var(--primary-color, var(--accent-color))"
                            : hovered
                              ? "var(--surface-color, rgba(255,255,255,0.06))"
                              : "transparent",
                          color: active ? "#fff" : "var(--text-primary, inherit)",
                        }}
                      >
                        {n}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setIsCustomPageSize(true); setCustomPageSize(''); setPageSizeMenuOpen(false); }}
                    onMouseEnter={() => setHoveredOption('custom')}
                    onMouseLeave={() => setHoveredOption(null)}
                    style={{
                      ...dropdownItemStyle,
                      background: hoveredOption === 'custom'
                        ? "var(--surface-color, rgba(255,255,255,0.06))"
                        : "transparent",
                    }}
                  >
                    Custom
                  </button>
                </div>
              )}
            </div>
          )}
        </label>
        <button
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={safePage <= 1}
          aria-label="Previous page"
          style={pillBtn(false, safePage <= 1)}
        >
          <ChevronLeft size={14} />
        </button>
        {pages.map((p, i) => (
          p === "…"
            ? <span key={`gap-${i}`} style={{ color: "var(--text-secondary)", padding: "0 0.2rem" }}>…</span>
            : <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                aria-current={p === safePage ? "page" : undefined}
                style={pillBtn(p === safePage, false)}
              >
                {p}
              </button>
        ))}
        <button
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={safePage >= pageCount}
          aria-label="Next page"
          style={pillBtn(false, safePage >= pageCount)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
