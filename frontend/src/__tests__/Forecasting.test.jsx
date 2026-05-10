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
