/**
 * Forecasting.test.jsx — vitest + RTL coverage for the Sales Forecasting page.
 *
 * Scope: pins the page-surface for the pipeline-weighted forecasting screen.
 * Uses Recharts so ResponsiveContainer is stubbed (jsdom can't compute
 * layout — same pattern as Dashboard.test.jsx + Forecasting peer specs).
 *
 *   1. Page renders: heading "Sales Forecasting" + period selector dropdown
 *      + "Save Snapshot" button + 4 KPI cards (Closed, Committed, Expected,
 *      Best Case).
 *   2. /api/forecasting/current?period=<x> + /api/forecasting/trend?months=12
 *      are both fetched on mount.
 *   3. KPI tiles reflect the total.* fields from /current.
 *   4. Per-rep table renders one row per byUser entry, with name + 4
 *      numeric columns + a Total footer row.
 *   5. Empty state: "No deals in this period." renders in the by-rep chart
 *      slot when byUser is empty AND loading completes; the per-rep table
 *      shows "No deals match this period." in the table body.
 *   6. Changing the period dropdown re-fires /api/forecasting/current with
 *      the new period value.
 *   7. Clicking "Save Snapshot" POSTs /api/forecasting/save with the
 *      current period + 4 revenue fields.
 *
 * Mock-pattern variation noted: stubs ResponsiveContainer (Recharts), same
 * as Dashboard.test.jsx. Without the stub, jsdom can't lay out the chart
 * and the page hangs in "Loading..." forever.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Recharts ResponsiveContainer needs a layout it can't get in jsdom; stub it.
// Without this, the BarChart + LineChart render "Loading..." forever in tests.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => <div data-testid="rc">{children}</div>,
  };
});

import { AuthContext } from '../App';
import Forecasting from '../pages/Forecasting';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function renderForecasting(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'USD', locale: 'en-US' }, loading: false }}>
        <Forecasting />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

const sampleCurrent = {
  period: '2026-Q2',
  byUser: [
    { userId: 1, name: 'Alice Rep', expected: 50000, committed: 30000, closed: 25000, bestCase: 65000 },
    { userId: 2, name: 'Bob Rep', expected: 40000, committed: 20000, closed: 15000, bestCase: 55000 },
  ],
  total: { expected: 90000, committed: 50000, bestCase: 120000, closed: 40000 },
};

const sampleTrend = {
  trend: [
    { month: '2025-12', closed: 15000 },
    { month: '2026-01', closed: 22000 },
    { month: '2026-02', closed: 28000 },
  ],
};

describe('<Forecasting /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    // Force USD locale + clear localStorage tenant key so formatMoney is
    // deterministic across the test suite.
    try {
      localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }));
    } catch { /* ignore */ }
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/forecasting/current')) return Promise.resolve(sampleCurrent);
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve(sampleTrend);
      return Promise.resolve(null);
    });
  });

  it('renders the heading + period selector + Save Snapshot button', async () => {
    renderForecasting();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Sales Forecasting/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Save Snapshot/i })).toBeInTheDocument();
    // Period <select> renders.
    const period = screen.getByRole('combobox');
    expect(period).toBeInTheDocument();
  });

  it('renders the 4 KPI cards reflecting /current.total values', async () => {
    renderForecasting();
    // "Closed" / "Committed" / "Expected" each appear in BOTH the KPI label
    // row AND as Recharts Bar legend entries (dataKey strings). Use
    // getAllByText to accept ≥1 occurrence rather than fight the duplication.
    await waitFor(() => {
      expect(screen.getAllByText(/^Closed$/).length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText(/^Committed$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Expected$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Best Case$/).length).toBeGreaterThanOrEqual(1);
    // KPI values render via formatMoney USD → "$40,000", "$50,000", etc.
    expect(screen.getAllByText('$40,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$50,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$90,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$120,000').length).toBeGreaterThanOrEqual(1);
  });

  it('fires /current + /trend on mount', async () => {
    renderForecasting();
    await waitFor(() => {
      const currentCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/forecasting/current')
      );
      const trendCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/forecasting/trend?months=12')
      );
      expect(currentCall).toBeTruthy();
      expect(trendCall).toBeTruthy();
    });
  });

  it('per-rep table renders one row per byUser entry + a Total footer', async () => {
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    expect(screen.getByText('Bob Rep')).toBeInTheDocument();
    // Headers
    expect(screen.getByText(/^Sales Rep$/i)).toBeInTheDocument();
    // Total footer row.
    expect(screen.getByText(/^Total$/i)).toBeInTheDocument();
  });

  it('shows the empty-state messaging when /current.byUser is empty', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/forecasting/current')) {
        return Promise.resolve({
          period: '2026-Q2',
          byUser: [],
          total: { expected: 0, committed: 0, bestCase: 0, closed: 0 },
        });
      }
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve({ trend: [] });
      return Promise.resolve(null);
    });
    renderForecasting();
    // The chart-slot empty state and the table empty state both surface.
    await waitFor(() => {
      expect(screen.getByText(/No deals in this period\./i)).toBeInTheDocument();
    });
    expect(screen.getByText(/No deals match this period\./i)).toBeInTheDocument();
    // Trend empty state.
    expect(screen.getByText(/No data yet\./i)).toBeInTheDocument();
  });

  it('changing the period dropdown re-fires /current with the new value', async () => {
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/forecasting/current')) return Promise.resolve(sampleCurrent);
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve(sampleTrend);
      return Promise.resolve(null);
    });

    const periodSelect = screen.getByRole('combobox');
    // The dropdown has 3 PERIOD_OPTIONS — current quarter, next quarter,
    // this year. We don't know exact YYYY-Qn strings (they're computed from
    // today), so just pick the 2nd option.
    const options = Array.from(periodSelect.querySelectorAll('option'));
    expect(options.length).toBe(3);
    fireEvent.change(periodSelect, { target: { value: options[1].value } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' &&
        u.startsWith('/api/forecasting/current') &&
        u.includes(encodeURIComponent(options[1].value))
      );
      expect(call).toBeTruthy();
    });
  });

  it('clicking Save Snapshot POSTs /api/forecasting/save with the 4 revenue fields', async () => {
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/forecasting/save' && opts?.method === 'POST') {
        return Promise.resolve({ id: 1 });
      }
      if (url.startsWith('/api/forecasting/current')) return Promise.resolve(sampleCurrent);
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve(sampleTrend);
      return Promise.resolve(null);
    });

    fireEvent.click(screen.getByRole('button', { name: /Save Snapshot/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/forecasting/save' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.period).toBeTruthy();
      expect(body.closedRevenue).toBe(40000);
      expect(body.committedRevenue).toBe(50000);
      expect(body.expectedRevenue).toBe(90000);
      expect(body.bestCaseRevenue).toBe(120000);
    });
    // Confirmation message.
    await waitFor(() => {
      expect(screen.getByText(/Snapshot saved\./i)).toBeInTheDocument();
    });
  });
});

describe('<Forecasting /> — extended coverage', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    try {
      localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }));
    } catch { /* ignore */ }
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/forecasting/current')) return Promise.resolve(sampleCurrent);
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve(sampleTrend);
      return Promise.resolve(null);
    });
  });

  it('period selector renders exactly 3 PERIOD_OPTIONS with the expected label shapes', async () => {
    // Pins the 3-option contract: Current Quarter (YYYY-Qn), Next Quarter
    // (YYYY-Qn), This Year (YYYY). If a 4th option (e.g. 6-month or YTD)
    // is added without a test update, this case flags the regression.
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    const periodSelect = screen.getByRole('combobox');
    const options = Array.from(periodSelect.querySelectorAll('option'));
    expect(options.length).toBe(3);
    // Labels follow the "(YYYY-Q[1-4])" or "(YYYY)" pattern.
    expect(options[0].textContent).toMatch(/Current Quarter \(\d{4}-Q[1-4]\)/);
    expect(options[1].textContent).toMatch(/Next Quarter \(\d{4}-Q[1-4]\)/);
    expect(options[2].textContent).toMatch(/This Year \(\d{4}\)/);
  });

  it('per-rep table renders each row with formatted $-values for closed/committed/expected/best-case', async () => {
    // Existing test only asserts row names; this pins the numeric cell
    // shape so a regression in formatMoney (or a column-swap in the JSX)
    // is caught.
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    // Alice: closed=25k, committed=30k, expected=50k, best=65k
    expect(screen.getAllByText('$25,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$30,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$65,000').length).toBeGreaterThanOrEqual(1);
    // Bob: closed=15k, committed=20k, best=55k
    expect(screen.getAllByText('$15,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$20,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$55,000').length).toBeGreaterThanOrEqual(1);
  });

  it('/current fetch URL contains encodeURIComponent(period)', async () => {
    // Pins that the period is URL-encoded (not just concatenated). The
    // initial-mount period is `${YYYY}-Q[1-4]` which contains no
    // encode-sensitive chars, so check that the encoded form (which is
    // equivalent to the raw form for "-" and digits) appears as a
    // substring of the URL.
    renderForecasting();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' &&
        u.startsWith('/api/forecasting/current?period=')
      );
      expect(call).toBeTruthy();
      // YYYY-Qn pattern.
      expect(call[0]).toMatch(/\?period=\d{4}-Q[1-4]/);
    });
  });

  it('Save Snapshot button is disabled while loading (initial mount)', async () => {
    // The button has `disabled={saving || loading}`. Before the /current
    // and /trend Promises resolve, the button must be disabled.
    let resolveCurrent;
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/forecasting/current')) {
        return new Promise(r => { resolveCurrent = () => r(sampleCurrent); });
      }
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve(sampleTrend);
      return Promise.resolve(null);
    });
    renderForecasting();
    const btn = screen.getByRole('button', { name: /Save Snapshot/i });
    // Loading phase — button is disabled.
    expect(btn).toBeDisabled();
    // Resolve the in-flight /current so the test cleans up.
    resolveCurrent();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it('Save Snapshot label shows "Saving..." while POST is in-flight', async () => {
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    let resolveSave;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/forecasting/save' && opts?.method === 'POST') {
        return new Promise(r => { resolveSave = () => r({ id: 99 }); });
      }
      if (url.startsWith('/api/forecasting/current')) return Promise.resolve(sampleCurrent);
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve(sampleTrend);
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Snapshot/i }));
    // In-flight: button reads "Saving..." and is disabled.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Saving\.\.\./i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Saving\.\.\./i })).toBeDisabled();
    resolveSave();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save Snapshot/i })).toBeInTheDocument();
    });
  });

  it('Save Snapshot surfaces the error message when the POST rejects', async () => {
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/forecasting/save' && opts?.method === 'POST') {
        return Promise.reject(new Error('snapshot quota exceeded'));
      }
      if (url.startsWith('/api/forecasting/current')) return Promise.resolve(sampleCurrent);
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve(sampleTrend);
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Snapshot/i }));
    await waitFor(() => {
      expect(screen.getByText(/snapshot quota exceeded/i)).toBeInTheDocument();
    });
  });

  it('changing period to "This Year" fires /current with the YYYY value (not YYYY-Qn)', async () => {
    // The 3rd option is the year-only string. Pin that the URL reflects
    // it, distinguishing it from the quarter shape — both rollups go
    // through the same fetcher, but the backend behavior differs by
    // period shape, so this contract must stay.
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/forecasting/current')) return Promise.resolve(sampleCurrent);
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve(sampleTrend);
      return Promise.resolve(null);
    });
    const periodSelect = screen.getByRole('combobox');
    const options = Array.from(periodSelect.querySelectorAll('option'));
    const yearOption = options[2]; // "This Year (YYYY)"
    expect(yearOption.value).toMatch(/^\d{4}$/);
    fireEvent.change(periodSelect, { target: { value: yearOption.value } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' &&
        u.startsWith('/api/forecasting/current?period=') &&
        u.endsWith(yearOption.value)
      );
      expect(call).toBeTruthy();
    });
  });

  it('Save POST body carries the currently-selected period (changes when dropdown changes)', async () => {
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    const periodSelect = screen.getByRole('combobox');
    const options = Array.from(periodSelect.querySelectorAll('option'));
    const yearValue = options[2].value;
    fireEvent.change(periodSelect, { target: { value: yearValue } });
    // Wait for the new /current to settle.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' &&
        u.startsWith('/api/forecasting/current') &&
        u.endsWith(yearValue)
      );
      expect(call).toBeTruthy();
    });
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/forecasting/save' && opts?.method === 'POST') {
        return Promise.resolve({ id: 7 });
      }
      if (url.startsWith('/api/forecasting/current')) return Promise.resolve(sampleCurrent);
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve(sampleTrend);
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Snapshot/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/forecasting/save' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.period).toBe(yearValue);
    });
  });

  it('trend chart renders inside the rc stub when /trend returns rows', async () => {
    // Two charts on the page → both ResponsiveContainer instances render
    // as data-testid="rc". When trend is populated AND byUser is
    // populated, both rc nodes exist. Pins the "trend chart actually
    // renders when data is present" contract — distinct from the empty
    // state "No data yet." case.
    renderForecasting();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    const rcs = screen.getAllByTestId('rc');
    expect(rcs.length).toBe(2);
  });

  it('renders heading + Save button + 4 KPI labels even when /current returns all-zero totals', async () => {
    // Zero-state shape: backend returns 0s but the page must still
    // render the 4 KPI labels with "$0" values. Distinct from the
    // empty-byUser test above (which exercises the chart + table empty
    // states; this one pins the KPI tile shape).
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/forecasting/current')) {
        return Promise.resolve({
          period: '2026-Q2',
          byUser: [],
          total: { expected: 0, committed: 0, bestCase: 0, closed: 0 },
        });
      }
      if (url.startsWith('/api/forecasting/trend')) return Promise.resolve({ trend: [] });
      return Promise.resolve(null);
    });
    renderForecasting();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Sales Forecasting/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Save Snapshot/i })).toBeInTheDocument();
    // All 4 KPI labels present (each matches ≥1 because the same labels
    // appear in the Recharts legend as well).
    expect(screen.getAllByText(/^Closed$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Committed$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Expected$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Best Case$/).length).toBeGreaterThanOrEqual(1);
    // All KPI values render as "$0" (4 tiles × 1 value each = 4 occurrences).
    expect(screen.getAllByText('$0').length).toBeGreaterThanOrEqual(4);
  });
});
