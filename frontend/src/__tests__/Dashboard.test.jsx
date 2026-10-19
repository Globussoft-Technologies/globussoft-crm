/**
 * Dashboard.test.jsx — vitest coverage for the generic Dashboard KPI tiles.
 *
 * #567: pre-fix the page reduced over /api/deals?limit=100 to compute
 * Closed Revenue / Expected Revenue / Total Deals, so on tenants with > 100
 * deals (5,381 on demo, 375 won, $5B aggregate) the newest-100 window often
 * contained 0 won deals → "Closed Revenue $0" permanently. The fix routes
 * KPI numbers through /api/deals/stats (server-side full-population
 * aggregates) and keeps /api/deals?limit=10 only for the Recent Deals
 * widget. These tests pin that contract:
 *
 *  - KPI tiles reflect stats.wonValue / stats.expectedValue / stats.totalDeals
 *    (not a list-reduce over /api/deals).
 *  - Recent Deals reads from a separate /api/deals?limit=10 fetchApi call.
 *  - Regression pin: zero aggregates render "0" / "0%" / "$0", not "—" or NaN.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock fetchApi BEFORE importing the component
vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

// Recharts ResponsiveContainer needs a layout it can't get in jsdom; stub it
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => <div data-testid="rc">{children}</div>,
  };
});

import { fetchApi } from '../utils/api';
import Dashboard from '../pages/Dashboard';
import { AuthContext } from '../App';

// Force USD locale so formatMoney output is stable regardless of host
// localStorage state. Other suites may have written 'tenant' to localStorage
// (the OwnerDashboard suite seeds wellness/INR), which would otherwise leak
// across files because vitest reuses the jsdom global per worker.
beforeEach(() => {
  try {
    localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }));
  } catch {
    /* ignore — some test envs disable localStorage */
  }
});

// These suite-level tests pin the ADMIN variant of the Dashboard (Closed
// Revenue / Total Contacts / Recent Deals — the org-wide view). The page
// now branches its labels + widgets on `user.role` from AuthContext, so
// we wrap with a Provider that supplies an ADMIN user. Pre-fix this suite
// silently relied on the Dashboard's role-fallback defaulting to ADMIN —
// that fallback was changed to 'USER' (least-privilege) after a security
// review, so explicit ADMIN context is now required for these assertions.
function renderDashboard(userOverride) {
  const authValue = { user: { id: 1, role: 'ADMIN', email: 'admin@test.com' }, ...(userOverride || {}) };
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('<Dashboard />', () => {
  it('shows rate provenance and stale/missing warnings without displaying misleading totals', async () => {
    fetchApi.mockImplementation(url => Promise.resolve(url.startsWith('/api/deals/stats') ? {
      wonValue: null, totalDeals: 3,
      fx: { baseCurrency: 'INR', source: 'Frankfurter', asOf: '2026-10-16', stale: true, incomplete: true, missingCurrencies: ['XYZ'] },
    } : []));
    renderDashboard({ tenant: { id: 1, vertical: 'generic', defaultCurrency: 'INR' } });
    expect(await screen.findByText(/Dashboard currency: INR/)).toHaveTextContent('Reference rates as of 2026-10-16');
    expect(screen.getByRole('status')).toHaveTextContent('Rates may be out of date');
    expect(screen.getByRole('status')).toHaveTextContent('missing rates for XYZ');
    expect(screen.getByText(/Pipeline valuation unavailable/)).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('refreshes Generic stats on tab return and every 15 minutes, cleaning up on unmount', async () => {
    fetchApi.mockResolvedValue([]);
    const interval = vi.spyOn(window, 'setInterval');
    const clear = vi.spyOn(window, 'clearInterval');
    const { unmount } = renderDashboard({ tenant: { id: 1, vertical: 'generic' } });
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/deals/stats?currencyMode=latest'));
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 900000);
    fetchApi.mockClear();
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/deals/stats?currencyMode=latest'));
    unmount();
    expect(clear).toHaveBeenCalled();
    interval.mockRestore(); clear.mockRestore();
  });

  beforeEach(() => {
    fetchApi.mockReset();
  });

  it.each(['wellness', 'travel'])('does not add chart navigation to the %s theme', async (vertical) => {
    fetchApi.mockResolvedValue([]);
    renderDashboard({ tenant: { vertical } });
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    expect(screen.queryByRole('navigation', { name: 'Pipeline chart navigation' })).not.toBeInTheDocument();
  });

  it('renders Closed Revenue from stats.wonValue (not a list reduce of /api/deals)', async () => {
    // The exact $5B-on-demo scenario from #567. The stats endpoint reports
    // 375 won / $5B even though the newest-10 list has no won deals — pre-fix,
    // the page rendered "$0". Post-fix, it must show the wonValue from /stats.
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/deals/stats')) {
        return Promise.resolve({
          totalDeals: 5381,
          totalValue: 7_500_000_000,
          wonCount: 375,
          wonValue: 5_000_000_000,
          lostCount: 200,
          lostValue: 800_000_000,
          expectedValue: 1_200_000_000,
          winRate: 65,
          byStage: [
            { stage: 'lead', count: 2000, value: 100_000_000 },
            { stage: 'contacted', count: 1500, value: 200_000_000 },
            { stage: 'proposal', count: 1306, value: 1_400_000_000 },
            { stage: 'won', count: 375, value: 5_000_000_000 },
            { stage: 'lost', count: 200, value: 800_000_000 },
          ],
        });
      }
      if (url.startsWith('/api/deals?')) {
        // Recent Deals list — newest 10. None are won (this is the demo scenario).
        return Promise.resolve([
          { id: 1, title: 'Recent A', stage: 'lead', amount: 1000, createdAt: new Date().toISOString() },
          { id: 2, title: 'Recent B', stage: 'contacted', amount: 2000, createdAt: new Date().toISOString() },
        ]);
      }
      if (url === '/api/contacts?count=1') return Promise.resolve({ total: 3 });
      return Promise.resolve([]);
    });

    renderDashboard();

    // Closed Revenue tile reflects stats.wonValue ($5B), not a sum over the
    // newest-10 list (which would render $0).
    await waitFor(() => expect(screen.getByText('Closed Revenue')).toBeInTheDocument());
    // Intl.NumberFormat for $5B in en-US is "$5,000,000,000".
    await waitFor(() => expect(screen.getByText('$5,000,000,000')).toBeInTheDocument());
    const kpis = screen.getByText('Closed Revenue').closest('.dashboard-kpis');
    expect(kpis.style.getPropertyValue('--dashboard-kpi-count')).toBe('5');
    expect(kpis.querySelectorAll('.dashboard-kpi-card')).toHaveLength(5);
    expect(kpis.style.gridTemplateColumns).toBe('');
    // Expected Revenue tile reflects stats.expectedValue.
    expect(screen.getByText('$1,200,000,000')).toBeInTheDocument();
    // Total Deals tile reflects stats.totalDeals.
    expect(screen.getByText('5381')).toBeInTheDocument();
    // #639 — Conversion Rate is now formatted by formatPercent (1 decimal,
    // canonical "0.0%"). 375/5381 * 100 ≈ 6.97 → "7.0%". Pre-#639 this was
    // Math.round-d to "7%".
    expect(screen.getByText('7.0%')).toBeInTheDocument();
  });

  it('shows the full contact count instead of the first 100 contacts', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/deals/stats') return Promise.resolve({});
      if (url.startsWith('/api/deals?')) return Promise.resolve([]);
      if (url === '/api/contacts?count=1') return Promise.resolve({ total: 2105 });
      return Promise.resolve([]);
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText('2,105')).toBeInTheDocument());
    expect(fetchApi).toHaveBeenCalledWith('/api/contacts?count=1');
    expect(fetchApi).not.toHaveBeenCalledWith('/api/contacts');
  });

  it('requests won and lost deals separately and renders compact closed-deal cards only', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/deals/stats')) {
        return Promise.resolve({
          totalDeals: 100, totalValue: 500_000, wonCount: 10, wonValue: 50_000,
          expectedValue: 75_000, winRate: 50, byStage: [],
        });
      }
      if (url.startsWith('/api/deals?')) {
        return Promise.resolve([
          { id: 100, title: 'Most-recent X', stage: 'lead', amount: 1000, createdAt: new Date().toISOString() },
          { id: 101, title: 'Most-recent Y', stage: 'won', amount: 2000, createdAt: new Date().toISOString() },
          { id: 102, title: 'Lost deal Z', stage: 'lost', amount: 3000, contact: { name: 'Maria Santos' }, owner: { name: 'Priya Sharma' }, createdAt: new Date().toISOString() },
        ]);
      }
      if (url === '/api/contacts?count=1') return Promise.resolve({ total: 0 });
      return Promise.resolve([]);
    });

    renderDashboard();

    // Verify the SEPARATE fetchApi call to /api/deals?limit=10 happened.
    await waitFor(() => {
      const calls = fetchApi.mock.calls.map((c) => c[0]);
      expect(calls.some((u) => u.startsWith('/api/deals/stats'))).toBe(true);
      expect(calls).toContain('/api/deals?limit=4&stage=won');
      expect(calls).toContain('/api/deals?limit=4&stage=lost');
    });

    // Recent Deals widget shows the rows the limit=10 call returned.
    await waitFor(() => expect(screen.getByText('Most-recent Y')).toBeInTheDocument());
    expect(screen.queryByText('Most-recent X')).not.toBeInTheDocument();
    expect(screen.getByText('Lost deal Z')).toBeInTheDocument();
    expect(screen.getByText('Contact: Maria Santos')).toBeInTheDocument();
    expect(screen.getByText('Owner: Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Owner: Unassigned')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
    expect(screen.getByText('Lost')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Most-recent Y/ })).toHaveAttribute('href', '/pipeline?dealId=101');
  });

  it('renders 0 (not "—" or NaN) when /api/deals/stats returns all-zero aggregates', async () => {
    // Regression pin: a brand-new tenant with zero deals must render "0" /
    // "$0" / "0%", not "—" or "NaN" or empty strings. The pre-fix code path
    // had a divide-by-zero guard that emitted em-dash for the conversion-rate
    // tile when there were no deals; the new path renders plain 0.
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/deals/stats')) {
        return Promise.resolve({
          totalDeals: 0, totalValue: 0, wonCount: 0, wonValue: 0,
          lostCount: 0, lostValue: 0, expectedValue: 0, winRate: 0, byStage: [],
        });
      }
      if (url.startsWith('/api/deals?')) return Promise.resolve([]);
      if (url === '/api/contacts?count=1') return Promise.resolve({ total: 0 });
      return Promise.resolve([]);
    });

    renderDashboard();

    await waitFor(() => expect(screen.getByText('Closed Revenue')).toBeInTheDocument());
    // $0 (USD) — Closed Revenue + Expected Revenue.
    expect(screen.getAllByText('$0').length).toBeGreaterThanOrEqual(2);
    // Total Contacts + Total Deals — plain "0".
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(2);
    // Conversion Rate. #639 canonical 1-decimal format → "0.0%".
    expect(screen.getByText('0.0%')).toBeInTheDocument();
    // No NaN leaked into the KPI tiles. Note: em-dash IS the canonical
    // formatPercent fallback for null/undefined, but a zero-deals tenant
    // computes a real numeric 0 (not null) so we still expect "0.0%".
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('shows a closed-deal empty state when there are no won or lost deals', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/deals/stats')) {
        return Promise.resolve({
          totalDeals: 0, totalValue: 0, wonCount: 0, wonValue: 0,
          expectedValue: 0, winRate: 0, byStage: [],
        });
      }
      if (url.startsWith('/api/deals?')) return Promise.resolve([]);
      if (url === '/api/contacts?count=1') return Promise.resolve({ total: 0 });
      return Promise.resolve([]);
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText('No won or lost deals yet.')).toBeInTheDocument());
  });
});
