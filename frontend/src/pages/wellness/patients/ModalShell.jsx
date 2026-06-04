import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

// ── Modal shell (reused by both create + bulk-tag modals) ──────────
// Theme-adaptive: we let the `.glass` class supply the background
// (translucent white in light mode, translucent dark teal in dark
// mode — both already defined in [theme/wellness.css](src/theme/wellness.css))
// and never set an inline background or `color` here. Borders + the
// header/footer separators use `--border-color` which also adapts.
export default function ModalShell({ title, onClose, children, footer, width = 560 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Page-scroll lock while the modal is mounted.
  //
  // The app shell layout (components/Layout.jsx) uses
  //   .app-shell { overflow:hidden; height:100vh }
  //   <main>     { flex:1; overflowY:auto }   ← React inline style
  // — so the actual scrollable element is <main>, NOT <body>.
  //
  // IMPORTANT: we save/restore the LONGHAND properties (overflowY +
  // overflowX) rather than the `overflow` shorthand. Setting the
  // shorthand on a node whose inline style only has the longhand
  // (`overflowY:auto`) wipes that longhand when the shorthand is
  // cleared on cleanup — leaving <main> with no overflow rule at
  // all and the page stuck un-scrollable until refresh. Touching
  // longhands keeps the shorthand untouched and vice-versa.
  useEffect(() => {
    const mainEl = document.querySelector("main");
    const html = document.documentElement;
    const body = document.body;
    const targets = [mainEl, html, body].filter(Boolean);
    const prev = targets.map((el) => ({
      el,
      overflowY: el.style.overflowY,
      overflowX: el.style.overflowX,
    }));
    targets.forEach((el) => {
      el.style.overflowY = "hidden";
      el.style.overflowX = "hidden";
    });
    return () => {
      prev.forEach(({ el, overflowY, overflowX }) => {
        el.style.overflowY = overflowY;
        el.style.overflowX = overflowX;
      });
    };
  }, []);
  // Portal the modal out to document.body. The app's <main> element
  // gets `transform: translateY(0)` (from .animate-fade-in's `forwards`
  // fill-mode in index.css) which, per CSS spec, creates a containing
  // block for `position: fixed` descendants — so an in-place modal
  // gets positioned relative to <main>'s scrolled content, not the
  // viewport. When <main> is scrolled (e.g. user clicked Edit on a
  // row near the bottom of the list), the modal renders far above
  // the visible area and only the footer slice is visible.
  // Rendering through document.body escapes the transformed ancestor.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
    >
      <div
        className="glass"
        style={{
          width: "100%",
          maxWidth: width,
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: 14,
          // .glass already sets border + background; keep `border` here as a
          // no-op fallback so a future theme without .glass still renders.
          border: "1px solid var(--border-color, rgba(0,0,0,0.1))",
          boxShadow: "var(--shadow-lg, 0 24px 60px rgba(0,0,0,0.25))",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "1rem 1.25rem",
            borderBottom: "1px solid var(--border-color, rgba(0,0,0,0.08))",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600, color: "var(--text-primary)" }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: "0.25rem",
              display: "inline-flex",
            }}
          >
            <X size={18} />
          </button>
        </header>
        <div style={{ padding: "1.25rem", overflow: "auto", flex: 1, color: "var(--text-primary)" }}>{children}</div>
        {footer && (
          <footer
            style={{
              padding: "0.85rem 1.25rem",
              borderTop: "1px solid var(--border-color, rgba(0,0,0,0.08))",
              display: "flex",
              gap: "0.6rem",
              justifyContent: "flex-end",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
