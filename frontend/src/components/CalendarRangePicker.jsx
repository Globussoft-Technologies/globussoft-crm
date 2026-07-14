// frontend/src/components/CalendarRangePicker.jsx
//
// A single pill button showing the selected range (e.g. "Jul 1 - Jul 11")
// that opens a month-grid calendar popover — click a start date, then an
// end date, directly on the calendar (no separate From/To text inputs).
// No date library dependency — plain Date arithmetic, consistent with the
// rest of this codebase (no react-datepicker/date-fns/dayjs installed).
//
// Controlled component: parent owns { from, to } (YYYY-MM-DD strings, or
// null/empty for "no range set"). `onChange` fires with the same shape
// once both ends of a range are picked (or immediately for a single-day
// pick — "double-tap to pick one date").
//
//   <CalendarRangePicker
//     value={{ from: '2026-07-01', to: '2026-07-11' }}
//     onChange={(next) => setRange(next)}
//   />

import { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIso(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function fmtShort(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Build a 6x7 grid of Dates covering the given month, padded with the
// trailing days of the previous month and leading days of the next so
// every week row is complete (matches the screenshot's greyed-out
// out-of-month days).
function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay(); // 0=Sun
  const gridStart = new Date(year, month, 1 - startOffset);
  const days = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  }
  return days;
}

function isSameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isBetween(d, start, end) {
  if (!start || !end) return false;
  const t = d.getTime();
  return t > Math.min(start.getTime(), end.getTime()) && t < Math.max(start.getTime(), end.getTime());
}

export default function CalendarRangePicker({ value, onChange, label = 'Date range' }) {
  const state = value || { from: '', to: '' };
  const committedFrom = parseIso(state.from);
  const committedTo = parseIso(state.to);

  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState((committedFrom || new Date()).getFullYear());
  const [viewMonth, setViewMonth] = useState((committedFrom || new Date()).getMonth());
  // Draft selection while the popover is open — committed to the parent
  // (via onChange) only once both ends are picked, so a half-made
  // selection never leaks out mid-click.
  const [draftStart, setDraftStart] = useState(committedFrom);
  const [draftEnd, setDraftEnd] = useState(committedTo);
  const [hoverDate, setHoverDate] = useState(null);
  const rootRef = useRef(null);

  // Re-sync draft state from the committed value whenever the popover
  // (re)opens, so a Cancel-via-outside-click doesn't leave stale drafts.
  useEffect(() => {
    if (open) {
      setDraftStart(committedFrom);
      setDraftEnd(committedTo);
      if (committedFrom) {
        setViewYear(committedFrom.getFullYear());
        setViewMonth(committedFrom.getMonth());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const goMonth = (delta) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  const pickDay = (day) => {
    // No selection yet, or a full range already exists → start fresh.
    if (!draftStart || (draftStart && draftEnd)) {
      setDraftStart(day);
      setDraftEnd(null);
      return;
    }
    // One end already picked — clicking again on the SAME day is the
    // "double-tap to pick one date" single-day-range shortcut.
    if (isSameDay(day, draftStart)) {
      onChange?.({ from: toIsoDate(day), to: toIsoDate(day) });
      setDraftEnd(day);
      setOpen(false);
      return;
    }
    // Second click completes the range — order-independent (clicking an
    // earlier date than draftStart flips start/end automatically).
    const from = day < draftStart ? day : draftStart;
    const to = day < draftStart ? draftStart : day;
    setDraftStart(from);
    setDraftEnd(to);
    onChange?.({ from: toIsoDate(from), to: toIsoDate(to) });
    setOpen(false);
  };

  const reset = () => {
    setDraftStart(null);
    setDraftEnd(null);
    onChange?.({ from: '', to: '' });
  };

  const days = buildMonthGrid(viewYear, viewMonth);
  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const buttonLabel = committedFrom
    ? (committedTo && !isSameDay(committedFrom, committedTo)
      ? `${fmtShort(committedFrom)} - ${fmtShort(committedTo)}`
      : fmtShort(committedFrom))
    : label;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="input-field"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          width: 'auto',
          minWidth: 150,
          justifyContent: 'flex-start',
          cursor: 'pointer',
          fontSize: 'inherit',
        }}
      >
        <Calendar size={14} style={{ flexShrink: 0, color: 'var(--text-secondary, #9aa0ab)' }} />
        <span style={{ whiteSpace: 'nowrap' }}>{buttonLabel}</span>
        {committedFrom && (
          <X
            size={13}
            onClick={(e) => { e.stopPropagation(); reset(); }}
            style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--text-secondary, #9aa0ab)' }}
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Select date range"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50,
            background: 'var(--card-bg, #1a1a1a)', color: 'var(--text-primary)',
            border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
            borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
            padding: '0.85rem', width: 300,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <button type="button" onClick={() => goMonth(-1)} aria-label="Previous month" style={navBtnStyle}>
              <ChevronLeft size={16} />
            </button>
            <strong style={{ fontSize: '0.9rem' }}>{monthLabel}</strong>
            <button type="button" onClick={() => goMonth(1)} aria-label="Next month" style={navBtnStyle}>
              <ChevronRight size={16} />
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {WEEKDAYS.map((w, i) => (
              <div key={`${w}-${i}`} style={{ textAlign: 'center', fontSize: '0.7rem', color: 'var(--text-secondary, #9aa0ab)', padding: '2px 0' }}>
                {w}
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {days.map((day) => {
              const inMonth = day.getMonth() === viewMonth;
              const isStart = isSameDay(day, draftStart);
              const isEnd = isSameDay(day, draftEnd);
              const rangeEndForHover = draftEnd || (draftStart && !draftEnd ? hoverDate : null);
              const inRange = isBetween(day, draftStart, rangeEndForHover);
              const isEdge = isStart || isEnd;
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  onClick={() => pickDay(day)}
                  onMouseEnter={() => setHoverDate(day)}
                  disabled={!inMonth}
                  style={{
                    padding: '6px 0',
                    fontSize: '0.8rem',
                    border: 'none',
                    borderRadius: isEdge ? '50%' : 6,
                    background: isEdge
                      ? 'var(--accent-color, #3b82f6)'
                      : inRange
                        ? 'rgba(59,130,246,0.15)'
                        : 'transparent',
                    color: !inMonth
                      ? 'var(--text-secondary, #6b7280)'
                      : isEdge
                        ? '#fff'
                        : 'var(--text-primary)',
                    opacity: inMonth ? 1 : 0.4,
                    cursor: inMonth ? 'pointer' : 'default',
                  }}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #9aa0ab)', maxWidth: 180 }}>
              Double-click a date to pick just one day, or click two dates to select a range.
            </span>
            <button type="button" onClick={reset} className="btn-secondary" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}>
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const navBtnStyle = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary, #9aa0ab)',
  cursor: 'pointer',
  padding: 4,
  display: 'flex',
};
