// Shared date-range filter — preset dropdown + custom two-month range picker.
//
// Usage:
//   const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
//   const [start, end] = resolveDateRange(filter);  // [null, null] = no filter
//   const filtered = (start && end)
//     ? items.filter((i) => { const t = new Date(i.date).getTime(); return t >= start.getTime() && t <= end.getTime(); })
//     : items;
//
//   <DateRangeFilter value={filter} onChange={setFilter} />
//
// The component renders inline controls only (label + dropdown + maybe custom-button);
// callers own the wrapper and any right-aligned counter slot.
//
// The custom-range modal is portaled to document.body so it can escape any
// ancestor with backdrop-filter / transform / filter that would otherwise trap
// position: fixed inside a containing-block region (e.g. a .glass filter bar).

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, X, ChevronLeft, ChevronRight } from 'lucide-react';

const fieldStyle = {
  padding: '0.4rem 0.6rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
};

export const DATE_FILTER_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'thisWeek', label: 'This Week' },
  { value: 'thisMonth', label: 'This Month' },
  { value: 'lastWeek', label: 'Last Week' },
  { value: 'lastMonth', label: 'Last Month' },
  { value: 'last7', label: 'Last 7 Days' },
  { value: 'last30', label: 'Last 30 Days' },
  { value: 'mtd', label: 'Month To Date' },
  { value: 'thisQuarter', label: 'This Quarter' },
  { value: 'thisYear', label: 'This Year' },
  { value: 'custom', label: 'Custom' },
];

export const EMPTY_DATE_FILTER = { preset: 'all', start: '', end: '' };

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
// Treat Monday as the start of the week (matches the existing Case History behavior).
const diffToMonday = (d) => (d.getDay() + 6) % 7;

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s) => {
  if (!s) return null;
  const parts = s.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
};

// Resolves a {preset, start, end} value into a concrete [Date, Date] window in
// local time. Returns [null, null] for "all" or when custom inputs are missing,
// so callers can short-circuit filtering.
export function resolveDateRange(value) {
  const v = value || EMPTY_DATE_FILTER;
  if (v.preset === 'all') return [null, null];
  const now = new Date();
  switch (v.preset) {
    case 'today':
      return [startOfDay(now), endOfDay(now)];
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return [startOfDay(y), endOfDay(y)];
    }
    case 'thisWeek': {
      const s = new Date(now); s.setDate(now.getDate() - diffToMonday(now));
      return [startOfDay(s), endOfDay(now)];
    }
    case 'lastWeek': {
      const e = new Date(now); e.setDate(now.getDate() - diffToMonday(now) - 1);
      const s = new Date(e); s.setDate(e.getDate() - 6);
      return [startOfDay(s), endOfDay(e)];
    }
    case 'thisMonth': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      const e = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return [startOfDay(s), endOfDay(e)];
    }
    case 'lastMonth': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return [startOfDay(s), endOfDay(e)];
    }
    case 'last7': {
      const s = new Date(now); s.setDate(now.getDate() - 6);
      return [startOfDay(s), endOfDay(now)];
    }
    case 'last30': {
      const s = new Date(now); s.setDate(now.getDate() - 29);
      return [startOfDay(s), endOfDay(now)];
    }
    case 'mtd': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return [startOfDay(s), endOfDay(now)];
    }
    case 'thisQuarter': {
      const q = Math.floor(now.getMonth() / 3);
      const s = new Date(now.getFullYear(), q * 3, 1);
      const e = new Date(now.getFullYear(), q * 3 + 3, 0);
      return [startOfDay(s), endOfDay(e)];
    }
    case 'thisYear': {
      const s = new Date(now.getFullYear(), 0, 1);
      const e = new Date(now.getFullYear(), 11, 31);
      return [startOfDay(s), endOfDay(e)];
    }
    case 'custom': {
      if (!v.start || !v.end) return [null, null];
      const s = parseYmd(v.start);
      const e = parseYmd(v.end);
      if (!s || !e) return [null, null];
      return s <= e ? [startOfDay(s), endOfDay(e)] : [startOfDay(e), endOfDay(s)];
    }
    default:
      return [null, null];
  }
}

// Convenience: resolveDateRange but as YYYY-MM-DD strings, for backend ?from&to.
export function resolveDateRangeYmd(value) {
  const [s, e] = resolveDateRange(value);
  return [s ? ymd(s) : null, e ? ymd(e) : null];
}

export function DateRangeFilter({ value, onChange, label = 'Filter by date', includeAllOption = true }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const v = value || EMPTY_DATE_FILTER;
  const isCustom = v.preset === 'custom';
  // Pages where the filter is optional (Case History, Wallet) keep "All time"; pages
  // that require a window (Visits, Reports) opt out and pass a non-'all' initial preset.
  const options = includeAllOption ? DATE_FILTER_OPTIONS : DATE_FILTER_OPTIONS.filter((o) => o.value !== 'all');

  return (
    <>
      {label && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          <Calendar size={14} /> {label}
        </label>
      )}
      <select
        value={v.preset}
        onChange={(ev) => onChange({ ...v, preset: ev.target.value })}
        style={{ ...fieldStyle, width: 'auto', minWidth: 160 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {isCustom && (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          style={{
            ...fieldStyle, width: 'auto', padding: '0.4rem 0.75rem',
            display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer',
          }}
        >
          <Calendar size={14} />
          {v.start && v.end ? `${v.start} – ${v.end}` : 'Pick dates'}
        </button>
      )}
      {pickerOpen && (
        <RangePickerModal
          initialStart={v.start}
          initialEnd={v.end}
          onClose={() => setPickerOpen(false)}
          onSave={(s, e) => { onChange({ preset: 'custom', start: s, end: e }); setPickerOpen(false); }}
        />
      )}
    </>
  );
}

// --- Picker internals ---

const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const buildMonthCells = (year, month) => {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
};

function RangePickerModal({ initialStart, initialEnd, onClose, onSave }) {
  const [tempStart, setTempStart] = useState(parseYmd(initialStart));
  const [tempEnd, setTempEnd] = useState(parseYmd(initialEnd));
  const anchor = parseYmd(initialStart) || new Date();
  const [viewMonth, setViewMonth] = useState(new Date(anchor.getFullYear(), anchor.getMonth(), 1));

  const handleClick = (d) => {
    if (!tempStart || (tempStart && tempEnd)) {
      setTempStart(d); setTempEnd(null);
    } else if (d < tempStart) {
      setTempStart(d); setTempEnd(null);
    } else {
      setTempEnd(d);
    }
  };
  const inRange = (d) => tempStart && tempEnd && d >= tempStart && d <= tempEnd;
  const monthLabel = (d) => d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const nextMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
  const canSave = !!(tempStart && tempEnd);

  const navBtn = { background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '0.3rem 0.55rem', cursor: 'pointer', color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center' };

  return createPortal((
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
    >
      {/* --bg-color is opaque in every theme; --surface-color is rgba(...,0.6) in
          dark wellness which lets the page bleed through. No `.glass` class either
          — its backdrop-filter: blur composites whatever sits behind. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '92%', maxWidth: 440, maxHeight: '88vh', overflow: 'auto',
          padding: '1rem 1.25rem',
          background: 'var(--bg-color, #14181A)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
          borderRadius: 12,
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', padding: 0 }}>
            <X size={18} />
          </button>
          <button
            type="button"
            onClick={() => canSave && onSave(ymd(tempStart), ymd(tempEnd))}
            disabled={!canSave}
            style={{ background: 'transparent', border: 'none', cursor: canSave ? 'pointer' : 'not-allowed', color: canSave ? 'var(--primary-color, var(--accent-color))' : 'var(--text-secondary)', fontWeight: 600, fontSize: '0.95rem', padding: 0 }}
          >
            Save
          </button>
        </div>

        <div style={{ marginBottom: '0.85rem' }}>
          <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>Select range</div>
          <div style={{ fontSize: '0.9rem', color: tempStart || tempEnd ? 'var(--text-primary)' : 'var(--text-secondary)', marginTop: '0.15rem' }}>
            {tempStart ? ymd(tempStart) : 'Start Date'} – {tempEnd ? ymd(tempEnd) : 'End Date'}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
          <button type="button" onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))} aria-label="Previous month" style={navBtn}>
            <ChevronLeft size={14} />
          </button>
          <button type="button" onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))} aria-label="Next month" style={navBtn}>
            <ChevronRight size={14} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', fontSize: '0.78rem', color: 'var(--text-secondary)', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.4rem', marginBottom: '0.4rem' }}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i}>{d}</div>)}
        </div>

        {[viewMonth, nextMonth].map((m, idx) => (
          <div key={idx} style={{ marginBottom: '0.75rem' }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, textAlign: 'center', margin: '0.45rem 0' }}>{monthLabel(m)}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '0.15rem' }}>
              {buildMonthCells(m.getFullYear(), m.getMonth()).map((d, i) => {
                if (!d) return <div key={i} />;
                const isStart = sameDay(d, tempStart);
                const isEnd = sameDay(d, tempEnd);
                const between = inRange(d) && !isStart && !isEnd;
                const selected = isStart || isEnd;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleClick(d)}
                    style={{
                      padding: '0.55rem 0',
                      background: selected
                        ? 'var(--primary-color, var(--accent-color))'
                        : between ? 'rgba(38, 88, 85, 0.22)' : 'transparent',
                      color: selected ? '#fff' : 'var(--text-primary)',
                      border: 'none',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontSize: '0.85rem',
                      fontWeight: selected ? 600 : 400,
                    }}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  ), document.body);
}
