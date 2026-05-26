// frontend/src/__tests__/DateRangePicker.test.jsx
//
// Locks the API contract of the shared DateRangePicker component that
// landed alongside #837 (Prescriptions — No date-wise filter available,
// cron tick #27 / Agent 1) and is intended to also subsume the inline
// date-filter UIs in Payments.jsx (#846) + InventoryReceipts.jsx (#843).
//
// Contract under test:
//   • Renders a preset <select> and a label
//   • Default presets render (today, yesterday, week7, month, all, custom)
//   • Custom inputs only render when preset === 'custom'
//   • onChange fires with the FULL next state ({preset, customFrom, customTo})
//   • effectiveRangeFor() resolves 'today' / 'all' / 'custom' correctly

import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import DateRangePicker, { effectiveRangeFor, rangeFromPreset } from '../components/DateRangePicker';

function Harness({ initial }) {
  const [state, setState] = useState(initial || { preset: 'all', customFrom: '', customTo: '' });
  return (
    <div>
      <DateRangePicker value={state} onChange={setState} id="rdp-harness" />
      <div data-testid="state">{JSON.stringify(state)}</div>
    </div>
  );
}

describe('<DateRangePicker />', () => {
  it('renders the label + select', () => {
    render(<Harness />);
    expect(screen.getByLabelText(/filter by date/i)).toBeTruthy();
  });

  it('renders the default preset options', () => {
    render(<Harness />);
    const select = screen.getByLabelText(/filter by date/i);
    // Default presets: today, yesterday, week7, month, all, custom
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain('today');
    expect(options).toContain('all');
    expect(options).toContain('custom');
  });

  it('does NOT render custom date inputs when preset !== custom', () => {
    render(<Harness initial={{ preset: 'all', customFrom: '', customTo: '' }} />);
    expect(screen.queryByLabelText(/custom from date/i)).toBeNull();
    expect(screen.queryByLabelText(/custom to date/i)).toBeNull();
  });

  it('renders custom date inputs when preset === custom', () => {
    render(<Harness initial={{ preset: 'custom', customFrom: '', customTo: '' }} />);
    expect(screen.getByLabelText(/custom from date/i)).toBeTruthy();
    expect(screen.getByLabelText(/custom to date/i)).toBeTruthy();
  });

  it('emits full next state on preset change', () => {
    render(<Harness initial={{ preset: 'all', customFrom: '', customTo: '' }} />);
    const select = screen.getByLabelText(/filter by date/i);
    fireEvent.change(select, { target: { value: 'today' } });
    const state = JSON.parse(screen.getByTestId('state').textContent);
    expect(state.preset).toBe('today');
    // customFrom/customTo are preserved unchanged
    expect(state.customFrom).toBe('');
    expect(state.customTo).toBe('');
  });

  it('emits full next state on custom-from change', () => {
    render(<Harness initial={{ preset: 'custom', customFrom: '', customTo: '' }} />);
    const from = screen.getByLabelText(/custom from date/i);
    fireEvent.change(from, { target: { value: '2026-05-01' } });
    const state = JSON.parse(screen.getByTestId('state').textContent);
    expect(state.preset).toBe('custom');
    expect(state.customFrom).toBe('2026-05-01');
  });

  it('honours a custom preset whitelist', () => {
    function Limited() {
      const [s, setS] = useState({ preset: 'today', customFrom: '', customTo: '' });
      return <DateRangePicker value={s} onChange={setS} presets={['today', 'all']} id="lim" />;
    }
    render(<Limited />);
    const select = screen.getByLabelText(/filter by date/i);
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['today', 'all']);
  });
});

describe('effectiveRangeFor()', () => {
  it("returns {null, null} for preset='all'", () => {
    expect(effectiveRangeFor({ preset: 'all', customFrom: '', customTo: '' }))
      .toEqual({ from: null, to: null });
  });

  it("returns ISO date strings for preset='today'", () => {
    const r = effectiveRangeFor({ preset: 'today', customFrom: '', customTo: '' });
    expect(r.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.from).toBe(r.to); // today === today
  });

  it("returns custom inputs for preset='custom'", () => {
    expect(effectiveRangeFor({ preset: 'custom', customFrom: '2026-05-01', customTo: '2026-05-31' }))
      .toEqual({ from: '2026-05-01', to: '2026-05-31' });
  });

  it("returns {null, null} for preset='custom' with blank inputs", () => {
    expect(effectiveRangeFor({ preset: 'custom', customFrom: '', customTo: '' }))
      .toEqual({ from: null, to: null });
  });
});

describe('rangeFromPreset()', () => {
  it("yesterday returns a single-day window before today", () => {
    const today = rangeFromPreset('today');
    const yest = rangeFromPreset('yesterday');
    expect(yest.from).toBe(yest.to);
    expect(yest.from < today.from).toBe(true);
  });

  it("week7 returns a 7-day window ending today", () => {
    const r = rangeFromPreset('week7');
    expect(r.to).toBe(rangeFromPreset('today').from);
    // 6 days prior (inclusive both ends → 7 days)
    const fromDate = new Date(r.from);
    const toDate = new Date(r.to);
    const days = Math.round((toDate - fromDate) / 86_400_000);
    expect(days).toBe(6);
  });

  it("month returns 1st-of-month to today", () => {
    const r = rangeFromPreset('month');
    expect(r.from).toMatch(/-01$/); // first-of-month
    expect(r.to).toBe(rangeFromPreset('today').from);
  });

  // ── Additional uncovered preset windows (last30 / last90 / year) ──
  it("last30 returns a 30-day window ending today (29 days prior, inclusive)", () => {
    const r = rangeFromPreset('last30');
    expect(r.to).toBe(rangeFromPreset('today').from);
    const days = Math.round((new Date(r.to) - new Date(r.from)) / 86_400_000);
    expect(days).toBe(29);
  });

  it("last90 returns a 90-day window ending today (89 days prior, inclusive)", () => {
    const r = rangeFromPreset('last90');
    expect(r.to).toBe(rangeFromPreset('today').from);
    const days = Math.round((new Date(r.to) - new Date(r.from)) / 86_400_000);
    expect(days).toBe(89);
  });

  it("year returns a 365-day window ending today (364 days prior, inclusive)", () => {
    const r = rangeFromPreset('year');
    expect(r.to).toBe(rangeFromPreset('today').from);
    const days = Math.round((new Date(r.to) - new Date(r.from)) / 86_400_000);
    expect(days).toBe(364);
  });

  // ── Defensive fallbacks ─────────────────────────────────────────────
  it("unknown preset key falls back to {null, null} (default branch)", () => {
    expect(rangeFromPreset('not-a-real-preset')).toEqual({ from: null, to: null });
  });

  it("undefined preset key falls back to {null, null} (default branch)", () => {
    expect(rangeFromPreset(undefined)).toEqual({ from: null, to: null });
  });

  it("'all' preset returns {null, null} so consumers can omit params", () => {
    expect(rangeFromPreset('all')).toEqual({ from: null, to: null });
  });

  it("all preset ISO date strings are zero-padded MM/DD", () => {
    // Pin the toIsoDate helper's padding behaviour — months and days must
    // be 2-digit even in single-digit-month windows (e.g. January, day 5).
    const today = rangeFromPreset('today');
    expect(today.from).toMatch(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// effectiveRangeFor() — additional edge cases for nullish state +
// partial custom inputs
// ─────────────────────────────────────────────────────────────────────
describe('effectiveRangeFor() — edge cases', () => {
  it("returns {null, null} when state is null", () => {
    expect(effectiveRangeFor(null)).toEqual({ from: null, to: null });
  });

  it("returns {null, null} when state is undefined", () => {
    expect(effectiveRangeFor(undefined)).toEqual({ from: null, to: null });
  });

  it("returns {from, null} for preset='custom' with only customFrom set", () => {
    expect(effectiveRangeFor({ preset: 'custom', customFrom: '2026-05-01', customTo: '' }))
      .toEqual({ from: '2026-05-01', to: null });
  });

  it("returns {null, to} for preset='custom' with only customTo set", () => {
    expect(effectiveRangeFor({ preset: 'custom', customFrom: '', customTo: '2026-05-31' }))
      .toEqual({ from: null, to: '2026-05-31' });
  });

  it("ignores customFrom/customTo when preset !== 'custom'", () => {
    // Even though customFrom/customTo are set, preset='today' resolves via
    // rangeFromPreset(); the custom inputs are NOT leaked through.
    const r = effectiveRangeFor({ preset: 'today', customFrom: '1999-01-01', customTo: '1999-12-31' });
    expect(r.from).not.toBe('1999-01-01');
    expect(r.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.from).toBe(r.to);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Additional component-level cases: defensive defaults, custom prop
// wiring (label, id, presets filtering), customTo change, testid surface
// ─────────────────────────────────────────────────────────────────────
describe('<DateRangePicker /> — extended surface', () => {
  it('renders defensively when value prop is omitted entirely', () => {
    // Component falls back to {preset:'all', customFrom:'', customTo:''}.
    // The select renders at value='all' and the custom inputs are hidden.
    const noop = () => {};
    render(<DateRangePicker onChange={noop} id="defensive" />);
    const select = screen.getByLabelText(/filter by date/i);
    expect(select.value).toBe('all');
    expect(screen.queryByLabelText(/custom from date/i)).toBeNull();
  });

  it('does not crash when onChange is omitted (optional chaining guards the calls)', () => {
    // Defensive contract — consumer may pass a read-only value temporarily.
    render(<DateRangePicker value={{ preset: 'all', customFrom: '', customTo: '' }} id="no-onchange" />);
    const select = screen.getByLabelText(/filter by date/i);
    // Should NOT throw even with no onChange handler wired.
    expect(() => fireEvent.change(select, { target: { value: 'today' } })).not.toThrow();
  });

  it('emits full next state on custom-to change (mirrors custom-from case)', () => {
    render(<Harness initial={{ preset: 'custom', customFrom: '2026-05-01', customTo: '' }} />);
    const to = screen.getByLabelText(/custom to date/i);
    fireEvent.change(to, { target: { value: '2026-05-31' } });
    const state = JSON.parse(screen.getByTestId('state').textContent);
    expect(state.preset).toBe('custom');
    expect(state.customFrom).toBe('2026-05-01'); // unchanged
    expect(state.customTo).toBe('2026-05-31');
  });

  it('filters out unknown preset keys silently (defensive against typos)', () => {
    function WithTypo() {
      const [s, setS] = useState({ preset: 'today', customFrom: '', customTo: '' });
      return <DateRangePicker value={s} onChange={setS} presets={['today', 'NOT_A_PRESET', 'all']} id="typo" />;
    }
    render(<WithTypo />);
    const select = screen.getByLabelText(/filter by date/i);
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    // Unknown key is silently dropped; valid keys are preserved in order.
    expect(options).toEqual(['today', 'all']);
  });

  it('exposes data-testid="date-range-picker" on the wrapper', () => {
    render(<Harness />);
    expect(screen.getByTestId('date-range-picker')).toBeTruthy();
  });

  it('honours a custom label prop', () => {
    function CustomLabel() {
      const [s, setS] = useState({ preset: 'all', customFrom: '', customTo: '' });
      return <DateRangePicker value={s} onChange={setS} label="Period:" id="custom-label" />;
    }
    render(<CustomLabel />);
    // Label text appears next to the select.
    expect(screen.getByText('Period:')).toBeTruthy();
  });

  it('wires the id prop through to label htmlFor + select id (a11y)', () => {
    function WithId() {
      const [s, setS] = useState({ preset: 'all', customFrom: '', customTo: '' });
      return <DateRangePicker value={s} onChange={setS} id="rx-date-preset" label="Date:" />;
    }
    const { container } = render(<WithId />);
    const select = container.querySelector('#rx-date-preset');
    expect(select).toBeTruthy();
    const label = container.querySelector('label[for="rx-date-preset"]');
    expect(label).toBeTruthy();
    expect(label.textContent).toBe('Date:');
  });

  it('preserves customFrom/customTo when switching preset away from custom and back', () => {
    // Round-trip test — typing dates in custom mode, switching to 'today',
    // switching back to 'custom' should restore the same typed values
    // because the parent state holds them.
    function Trip() {
      const [s, setS] = useState({ preset: 'custom', customFrom: '2026-01-01', customTo: '2026-12-31' });
      return (
        <div>
          <DateRangePicker value={s} onChange={setS} id="trip" />
          <div data-testid="trip-state">{JSON.stringify(s)}</div>
        </div>
      );
    }
    render(<Trip />);
    const select = screen.getByLabelText(/filter by date/i);
    // Switch away from custom — custom inputs unmount but state is preserved.
    fireEvent.change(select, { target: { value: 'today' } });
    let state = JSON.parse(screen.getByTestId('trip-state').textContent);
    expect(state.customFrom).toBe('2026-01-01');
    expect(state.customTo).toBe('2026-12-31');
    // Switch back to custom — inputs remount with the original values.
    fireEvent.change(select, { target: { value: 'custom' } });
    expect(screen.getByLabelText(/custom from date/i).value).toBe('2026-01-01');
    expect(screen.getByLabelText(/custom to date/i).value).toBe('2026-12-31');
  });

  it('handles state with undefined customFrom/customTo gracefully (destructure default)', () => {
    // Consumer passes only {preset:'custom'} with no custom* fields.
    // The destructure default `= ''` should kick in; inputs render empty.
    function Sparse() {
      const [s, setS] = useState({ preset: 'custom' });
      return <DateRangePicker value={s} onChange={setS} id="sparse" />;
    }
    render(<Sparse />);
    expect(screen.getByLabelText(/custom from date/i).value).toBe('');
    expect(screen.getByLabelText(/custom to date/i).value).toBe('');
  });
});
