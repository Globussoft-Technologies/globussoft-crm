import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { useProductTour } from "../tours/useProductTour";
import { categoryForTour, TOUR_CATEGORIES, tourStatus } from "../tours/tourCatalogue";

const STATUS_SYMBOL = {
  Completed: "✓",
  "In progress": "◷",
  Skipped: "»",
  Available: "○",
};

export default function TourCatalogue({ onClose }) {
  const { availableTours, effectiveEnabled, progress, startTour } = useProductTour();
  const location = useLocation();
  const dialogRef = useRef(null);
  const grouped = useMemo(() => TOUR_CATEGORIES.map((category) => ({
    category,
    tours: availableTours.filter((tour) => categoryForTour(tour) === category),
  })).filter((group) => group.tours.length), [availableTours]);
  const completed = availableTours.filter((tour) => tourStatus(tour, progress) === "Completed").length;
  const percentage = availableTours.length ? Math.round((completed / availableTours.length) * 100) : 0;
  const statusCounts = ["Available", "Completed", "In progress", "Skipped"].map((status) => ({
    status,
    count: availableTours.filter((tour) => tourStatus(tour, progress) === status).length,
  }));

  useEffect(() => {
    const previous = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll("button:not([disabled]), [href], input:not([disabled])"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 10020, background: "rgba(5,8,20,.68)", display: "grid", placeItems: "center", padding: 16 }}>
      <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="tour-catalogue-title" data-testid="tour-catalogue" style={{ width: "min(920px, 100%)", maxHeight: "min(820px, calc(100vh - 32px))", overflow: "auto", background: "var(--surface-color, #fff)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: 16, boxShadow: "0 24px 72px rgba(0,0,0,.4)", padding: "clamp(18px, 3vw, 28px)" }}>
        <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
          <div>
            <h2 id="tour-catalogue-title" style={{ margin: 0 }}>Tour catalogue</h2>
            <p style={{ color: "var(--text-secondary)", margin: "6px 0 0" }}>Choose a walkthrough and continue where you stopped.</p>
          </div>
          <button type="button" className="btn-secondary" aria-label="Close tour catalogue" onClick={onClose}>×</button>
        </header>
        <div style={{ margin: "20px 0 24px", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center" }}>
          <div aria-label={`${percentage}% of tours completed`} style={{ height: 10, borderRadius: 999, background: "var(--border-color)", overflow: "hidden" }}>
            <div style={{ width: `${percentage}%`, height: "100%", background: "var(--primary-color, var(--accent-color))" }} />
          </div>
          <strong>{percentage}% · {completed}/{availableTours.length}</strong>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          {statusCounts.map(({ status, count }) => <span key={status} style={{ padding: "6px 10px", border: "1px solid var(--border-color)", borderRadius: 999, fontSize: 13 }}><strong>{count}</strong> {status}</span>)}
        </div>
        {grouped.map(({ category, tours }) => (
          <section key={category} aria-labelledby={`tour-category-${category}`} style={{ marginTop: 22 }}>
            <h3 id={`tour-category-${category}`} style={{ margin: "0 0 10px", fontSize: 16 }}>{category}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 10 }}>
              {tours.map((tour) => {
                const status = tourStatus(tour, progress);
                const onMatchingPage = !tour.pattern || tour.pattern.test(location.pathname);
                const canStart = effectiveEnabled && (!!tour.path || onMatchingPage);
                return (
                  <article key={tour.id} style={{ minWidth: 0, border: "1px solid var(--border-color)", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span aria-hidden="true">{STATUS_SYMBOL[status]}</span><strong style={{ minWidth: 0 }}>{tour.label}</strong></div>
                    <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{status}</span>
                    <button type="button" className={status === "Completed" || status === "Skipped" ? "btn-secondary" : "btn-primary"} disabled={!canStart} title={!canStart ? !effectiveEnabled ? "Product tours are disabled" : "Open the related record first" : undefined} onClick={() => { if (startTour(tour.id, { restart: status !== "In progress" })) onClose(); }} style={{ marginTop: "auto" }}>
                      {status === "In progress" ? "Continue" : status === "Available" ? "Start" : "Restart"}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </section>
    </div>,
    document.body,
  );
}
