import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { srOnly } from './shared';
import TreatmentCard from './TreatmentCard';

const PAGE_SIZE = 12;

export default function ActiveTreatmentsTab({ treatments, loading, onChanged, onSelectTreatment }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const scrollRef = useRef(null);
  const displayedTreatments = useMemo(
    () => treatments.slice(0, Math.min(visibleCount, treatments.length)),
    [treatments, visibleCount],
  );

  useEffect(() => {
    setVisibleCount(Math.min(PAGE_SIZE, treatments.length));
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [treatments.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || loading) return;
    if (visibleCount >= treatments.length) return;
    if (el.scrollHeight <= 0 || el.clientHeight <= 0) return;
    if (el.scrollHeight <= el.clientHeight + 8) {
      setVisibleCount((current) => Math.min(current + PAGE_SIZE, treatments.length));
    }
  }, [loading, treatments.length, visibleCount, displayedTreatments.length]);

  const handleScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (!el) return;
    const threshold = 72;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
    if (!nearBottom) return;
    if (visibleCount >= treatments.length) return;
    setVisibleCount((current) => Math.min(current + PAGE_SIZE, treatments.length));
  }, [treatments.length, visibleCount]);

  return (
    <>
      <h2 style={srOnly}>Active treatment plans</h2>
      {loading && <div>Loading treatment plansâ€¦</div>}
      {!loading && treatments.length === 0 && (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
          No active treatment plans yet.
        </div>
      )}
      <div
        className="glass"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          padding: '1rem',
          minHeight: 0,
        }}
      >
        <div
          ref={scrollRef}
          data-testid="active-treatments-scroll"
          onScroll={handleScroll}
          style={{
            display: 'block',
            maxHeight: 'calc(100dvh - 280px)',
            overflowY: 'auto',
            overflowX: 'hidden',
            paddingRight: '0.25rem',
            scrollbarWidth: 'thin',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
            {displayedTreatments.map((t) => (
              <TreatmentCard key={t.id} treatment={t} onChanged={onChanged} onSelect={onSelectTreatment} />
            ))}
          </div>

          {!loading && displayedTreatments.length < treatments.length && (
            <div
              data-testid="active-treatments-scroll-sentinel"
              aria-hidden="true"
              style={{ height: 1 }}
            />
          )}
        </div>
      </div>
    </>
  );
}
