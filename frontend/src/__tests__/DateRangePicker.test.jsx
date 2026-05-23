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
});
