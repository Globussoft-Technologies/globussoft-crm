// frontend/src/components/DateRangePicker.jsx
//
// Shared date-range picker — preset dropdown + Custom range with two
// <input type="date"> fields. Extracts the in-line pattern that
// Payments.jsx (#846, cron tick #23) and InventoryReceipts.jsx (#843,
// cron tick #26) both implemented locally, ahead of the rule-of-3
// trigger that fired on #837 (Prescriptions — No date-wise filter
// available, cron tick #27 / Agent 1).
//
// API contract
// ────────────
//   <DateRangePicker
//     value={{ preset: 'today', from: '2026-05-23', to: '2026-05-23' }}
//     onChange={(next) => setRange(next)}
//     presets={['today','yesterday','week7','month','all','custom']}  // optional
//     label="Date:"        // optional, default 'Date:'
//     id="rx-date-preset"  // optional, used for label htmlFor + select id
//   />
//
// `onChange` receives the FULL next state — preset string + customFrom
// + customTo. Consumers usually derive the effective {from, to} via
// `effectiveRangeFor(state)` below (also exported), which resolves
// the preset into ISO date-only strings, or returns the custom inputs
// when preset === 'custom'.
//
// Theme tokens (var(--text-primary), var(--text-secondary), --border-color,
// --input-bg) are honoured. The component does NOT manage its own state —
// it's a controlled input. The parent owns {preset, customFrom, customTo}
// and re-renders on each change.
//
// TODO: migrate Payments.jsx (#846) + InventoryReceipts.jsx (#843) to
// consume this component. Their current inline implementations work and
// are NOT migrated in this PR (cron tick #27 scope = extract + adopt for
// #837 only). Adoption is follow-up scope.

import React from 'react';
import { Calendar } from 'lucide-react';

// ── Preset → {from, to} resolver ────────────────────────────────────
//
// Returns ISO date-only strings (YYYY-MM-DD) in the browser's local
// timezone. The backend's validateDateRange + Prisma `gte/lte` expect
// this shape (mirrors Payments.jsx + InventoryReceipts.jsx exactly).
//
// 'all' returns {null, null} so consumers can omit the params entirely
// (preserves the pre-filter "no range" default of every list endpoint).
function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function rangeFromPreset(preset) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case 'today':
      return { from: toIsoDate(today), to: toIsoDate(today) };
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(today.getDate() - 1);
      return { from: toIsoDate(y), to: toIsoDate(y) };
    }
    case 'week7': {
      const f = new Date(today);
      f.setDate(today.getDate() - 6);
      return { from: toIsoDate(f), to: toIsoDate(today) };
    }
    case 'month': {
      const f = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: toIsoDate(f), to: toIsoDate(today) };
    }
    case 'last30': {
      const f = new Date(today);
      f.setDate(today.getDate() - 29);
      return { from: toIsoDate(f), to: toIsoDate(today) };
    }
    case 'last90': {
      const f = new Date(today);
      f.setDate(today.getDate() - 89);
      return { from: toIsoDate(f), to: toIsoDate(today) };
    }
    case 'year': {
      const f = new Date(today);
      f.setDate(today.getDate() - 364);
      return { from: toIsoDate(f), to: toIsoDate(today) };
    }
    case 'all':
    default:
      return { from: null, to: null };
  }
}

// Resolve a {preset, customFrom, customTo} state to an effective range.
// For preset === 'custom', returns the typed inputs (or null when blank);
// otherwise resolves via rangeFromPreset.
export function effectiveRangeFor(state) {
  if (!state) return { from: null, to: null };
  if (state.preset === 'custom') {
    return {
      from: state.customFrom || null,
      to: state.customTo || null,
    };
  }
  return rangeFromPreset(state.preset);
}

// Canonical preset list — same labels as Payments.jsx + InventoryReceipts.jsx
// so the UX reads identically across the three (and future) consumers.
const ALL_PRESETS = {
  today: { value: 'today', label: 'Today' },
  yesterday: { value: 'yesterday', label: 'Yesterday' },
  week7: { value: 'week7', label: 'Last 7 days' },
  month: { value: 'month', label: 'This month' },
  last30: { value: 'last30', label: 'Last 30 days' },
  last90: { value: 'last90', label: 'Last 90 days' },
  year: { value: 'year', label: 'Last 12 months' },
  all: { value: 'all', label: 'All time' },
  custom: { value: 'custom', label: 'Custom…' },
};

const DEFAULT_PRESETS = ['today', 'yesterday', 'week7', 'month', 'all', 'custom'];

// ── Style constants (kept inline so the component is drop-in usable
// without a CSS import) ─────────────────────────────────────────────
const inputStyle = {
  padding: '0.4rem 0.65rem',
  fontSize: '0.85rem',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  background: 'var(--input-bg, transparent)',
  color: 'var(--text-primary)',
};

export default function DateRangePicker({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  label = 'Date:',
  id = 'date-range-preset',
}) {
  // Defensive default — consumer omits `value` on first render.
  const state = value || { preset: 'all', customFrom: '', customTo: '' };
  const { preset, customFrom = '', customTo = '' } = state;

  // Build the options list from the consumer-supplied preset whitelist.
  // Unknown preset keys are filtered out (defensive against typos).
  const options = presets
    .map((key) => ALL_PRESETS[key])
    .filter(Boolean);

  const setPreset = (next) => {
    onChange?.({ preset: next, customFrom, customTo });
  };
  const setCustomFrom = (next) => {
    onChange?.({ preset, customFrom: next, customTo });
  };
  const setCustomTo = (next) => {
    onChange?.({ preset, customFrom, customTo: next });
  };

  return (
    <div
      className="glass"
      data-testid="date-range-picker"
      style={{
        padding: '0.85rem 1rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        flexWrap: 'wrap',
      }}
    >
      <Calendar size={16} />
      <label
        style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}
        htmlFor={id}
      >
        {label}
      </label>
      <select
        id={id}
        value={preset}
        onChange={(e) => setPreset(e.target.value)}
        aria-label="Filter by date"
        style={inputStyle}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {preset === 'custom' && (
        <>
          <label style={{ fontSize: '0.85rem' }}>
            From{' '}
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label="Custom from date"
              style={inputStyle}
            />
          </label>
          <label style={{ fontSize: '0.85rem' }}>
            To{' '}
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label="Custom to date"
              style={inputStyle}
            />
          </label>
        </>
      )}
    </div>
  );
}
