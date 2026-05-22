import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock fetchApi BEFORE importing the component
vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

// Mock recharts ResponsiveContainer (no layout in jsdom)
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => <div data-testid="rc">{children}</div>,
  };
});

import { fetchApi } from '../utils/api';
import OwnerDashboard from '../pages/wellness/OwnerDashboard';
import { AuthContext } from '../App';

// The component reads tenant + user from AuthContext for the AdsGPT SSO
// card. Wrap every render in a provider so useContext doesn't destructure
// undefined. Returns a small wrapper component the tests use.
function renderDashboard() {
  return render(
    <AuthContext.Provider value={{
      user: { id: 1, name: 'Test User', email: 'test@x.test', role: 'ADMIN' },
      setUser: () => {},
      token: 't',
      setToken: () => {},
      tenant: { id: 2, name: 'Enhanced Wellness', slug: 'enhanced-wellness', vertical: 'wellness', defaultCurrency: 'INR' },
      setTenant: () => {},
    }}>
      <MemoryRouter><OwnerDashboard /></MemoryRouter>
    </AuthContext.Provider>
  );
}

const dashboardJson = {
  today: { visits: 12, completed: 5, expectedRevenue: 84500, occupancyPct: 72, newLeads: 9 },
  yesterday: { visits: 14, completed: 13, revenue: 92300 },
  pendingApprovals: 3,
  activeTreatmentPlans: 4,
  pendingRecommendations: [
    { id: 1, title: 'Boost Diwali campaign', body: 'Hair restoration ads underperforming.' },
  ],
  revenueTrend: Array.from({ length: 30 }, (_, i) => ({ date: `D${i}`, revenue: 1000 + i * 100 })),
  totals: { patients: 250, services: 105, locations: 1 },
};

function setupFetch(locations, pnl = { totalRevenue: 1201900, totals: { revenue: 1201900 }, rows: [] }) {
  fetchApi.mockImplementation((url) => {
    if (url.includes('/api/wellness/locations')) return Promise.resolve(locations);
    if (url.includes('/api/wellness/dashboard')) return Promise.resolve(dashboardJson);
    if (url.includes('/api/wellness/reports/pnl-by-service')) return Promise.resolve(pnl);
    return Promise.resolve({});
  });
}

describe('<OwnerDashboard />', () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  it('renders KPI tile labels after the dashboard JSON loads', async () => {
    setupFetch([{ id: 1, name: 'Ranchi' }]);
    renderDashboard();

    await waitFor(() => expect(screen.getByText(/Today's appointments/i)).toBeInTheDocument());
    expect(screen.getByText(/Today's expected revenue/i)).toBeInTheDocument();
    expect(screen.getByText(/Occupancy/i)).toBeInTheDocument();
    expect(screen.getByText(/New leads today/i)).toBeInTheDocument();
    expect(screen.getByText(/Pending approvals/i)).toBeInTheDocument();
    expect(screen.getByText(/Active treatment plans/i)).toBeInTheDocument();
  });

  it('formatRupees output appears (₹84,500 today, ₹92,300 yesterday)', async () => {
    setupFetch([{ id: 1, name: 'Ranchi' }]);
    renderDashboard();

    await waitFor(() => expect(screen.getByText(/₹84,500/)).toBeInTheDocument());
    expect(screen.getByText(/₹92,300/)).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
  });

  it('Recommendations link is present', async () => {
    setupFetch([{ id: 1, name: 'Ranchi' }]);
    renderDashboard();

    await waitFor(() => expect(screen.getByText(/Boost Diwali campaign/i)).toBeInTheDocument());
    const links = screen.getAllByRole('link');
    expect(links.some((l) => l.getAttribute('href') === '/wellness/recommendations')).toBe(true);
  });

  it('does NOT show the location switcher when only 1 location exists', async () => {
    setupFetch([{ id: 1, name: 'Ranchi' }]);
    renderDashboard();

    await waitFor(() => expect(screen.getByText(/Today's appointments/i)).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /All locations/i })).not.toBeInTheDocument();
  });

  it('SHOWS the location switcher when locations.length > 1', async () => {
    setupFetch([{ id: 1, name: 'Ranchi' }, { id: 2, name: 'Patna' }]);
    renderDashboard();

    await waitFor(() => expect(screen.getByText(/Today's appointments/i)).toBeInTheDocument());
    expect(screen.getByRole('option', { name: /All locations/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Patna/i })).toBeInTheDocument();
  });

  // #836: the "Top recommendation" panel surfaces a freshness age chip
  // when the top row carries a createdAt. Pen-test framing was "looks
  // scripted" — the chip + Refresh CTA fix the believability issue without
  // touching the recommendation-engine itself.
  it('renders a freshness chip + Refresh CTA on the Top recommendation panel', async () => {
    const freshDashboard = {
      ...dashboardJson,
      pendingRecommendations: [
        {
          id: 99,
          title: 'Boost Diwali campaign',
          body: 'Hair restoration ads underperforming.',
          // 3-hour-old recommendation — should render as fresh (green chip).
          createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
        },
      ],
    };
    fetchApi.mockImplementation((url) => {
      if (url.includes('/api/wellness/locations')) return Promise.resolve([{ id: 1, name: 'Ranchi' }]);
      if (url.includes('/api/wellness/dashboard')) return Promise.resolve(freshDashboard);
      if (url.includes('/api/wellness/reports/pnl-by-service')) return Promise.resolve({ totalRevenue: 0, totals: {}, rows: [] });
      return Promise.resolve({});
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/Boost Diwali campaign/i)).toBeInTheDocument());
    // Freshness chip is visible
    const chip = screen.getByLabelText(/recommendation age/i);
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toMatch(/hour|less than an hour/i);
    // Refresh CTA is visible
    expect(screen.getByRole('button', { name: /Refresh recommendations from the orchestrator/i })).toBeInTheDocument();
  });

  it('marks a > 24h-old recommendation as "likely stale" in the freshness chip', async () => {
    const staleDashboard = {
      ...dashboardJson,
      pendingRecommendations: [
        {
          id: 100,
          title: 'Tomorrow\'s slim-room utilisation only 30%',
          body: 'Old seeded body.',
          createdAt: new Date(Date.now() - 9 * 86400000).toISOString(), // 9 days old
        },
      ],
    };
    fetchApi.mockImplementation((url) => {
      if (url.includes('/api/wellness/locations')) return Promise.resolve([{ id: 1, name: 'Ranchi' }]);
      if (url.includes('/api/wellness/dashboard')) return Promise.resolve(staleDashboard);
      if (url.includes('/api/wellness/reports/pnl-by-service')) return Promise.resolve({ totalRevenue: 0, totals: {}, rows: [] });
      return Promise.resolve({});
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/slim-room utilisation/i)).toBeInTheDocument());
    const chip = screen.getByLabelText(/recommendation age/i);
    // Chip explicitly calls out the stale state so Owner doesn't trust
    // the body copy as today's intelligence.
    expect(chip.textContent).toMatch(/likely stale|9 days ago/i);
  });

  it('clicking Refresh POSTs to /api/wellness/orchestrator/run and refetches the dashboard', async () => {
    let runHit = false;
    let dashboardFetches = 0;
    fetchApi.mockImplementation((url, opts) => {
      if (url.includes('/api/wellness/locations')) return Promise.resolve([{ id: 1, name: 'Ranchi' }]);
      if (url.includes('/api/wellness/dashboard')) {
        dashboardFetches += 1;
        return Promise.resolve(dashboardJson);
      }
      if (url.includes('/api/wellness/reports/pnl-by-service')) return Promise.resolve({ totalRevenue: 0, totals: {}, rows: [] });
      if (url.includes('/api/wellness/orchestrator/run')) {
        expect(opts?.method).toBe('POST');
        runHit = true;
        return Promise.resolve({ created: 2 });
      }
      return Promise.resolve({});
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/Boost Diwali campaign/i)).toBeInTheDocument());
    const before = dashboardFetches;
    fireEvent.click(screen.getByRole('button', { name: /Refresh recommendations from the orchestrator/i }));
    await waitFor(() => expect(runHit).toBe(true));
    // The dashboard endpoint is re-fetched so the new top card shows up
    // immediately without a page reload.
    await waitFor(() => expect(dashboardFetches).toBeGreaterThan(before));
    // Status banner reports the count returned by the orchestrator.
    await waitFor(() => expect(screen.getByText(/Generated 2 new recommendations/i)).toBeInTheDocument());
  });

  it('shows an honest empty-state when pendingRecommendations is empty', async () => {
    const emptyDashboard = { ...dashboardJson, pendingRecommendations: [], pendingApprovals: 0 };
    fetchApi.mockImplementation((url) => {
      if (url.includes('/api/wellness/locations')) return Promise.resolve([{ id: 1, name: 'Ranchi' }]);
      if (url.includes('/api/wellness/dashboard')) return Promise.resolve(emptyDashboard);
      if (url.includes('/api/wellness/reports/pnl-by-service')) return Promise.resolve({ totalRevenue: 0, totals: {}, rows: [] });
      return Promise.resolve({});
    });
    renderDashboard();
    // The empty-state explicitly names the orchestrator + the daily 07:00
    // IST cadence so the surface reads as a real engine, not a stub
    // placeholder. This was the pen-test #836's pushback.
    await waitFor(() => expect(screen.getByText(/AI orchestrator runs daily at 07:00 IST/i)).toBeInTheDocument());
    // Refresh CTA stays visible in the empty state — that's the path out
    // when there genuinely is nothing in the queue.
    expect(screen.getByRole('button', { name: /Refresh recommendations from the orchestrator/i })).toBeInTheDocument();
  });

  // #831: AdsGPT card now derives state from /api/integrations.
  // Three render branches must be covered: linked (real account name +
  // View campaigns CTA), not_linked (Connect AdsGPT CTA — the demo
  // path that the pen-test asked for), error (Retry CTA).

  it('AdsGPT card: renders "View campaigns" + the linked account name when /api/integrations reports an active adsgpt row', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.includes('/api/wellness/locations')) return Promise.resolve([{ id: 1, name: 'Ranchi' }]);
      if (url.includes('/api/wellness/dashboard')) return Promise.resolve(dashboardJson);
      if (url.includes('/api/wellness/reports/pnl-by-service')) return Promise.resolve({ totalRevenue: 0, totals: {}, rows: [] });
      if (url === '/api/integrations') {
        return Promise.resolve([
          {
            provider: 'adsgpt',
            isActive: true,
            settings: JSON.stringify({ login: 'enhancedwellness-prod' }),
            id: 17,
          },
        ]);
      }
      return Promise.resolve({});
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('adsgpt-linked-label')).toBeInTheDocument());
    expect(screen.getByTestId('adsgpt-linked-label').textContent).toMatch(/enhancedwellness-prod/i);
    // "View campaigns" CTA is present (replaces the stale "Open AdsGPT" copy).
    expect(screen.getByRole('button', { name: /Open AdsGPT campaigns for enhancedwellness-prod/i })).toBeInTheDocument();
  });

  it('AdsGPT card: renders "Connect AdsGPT" CTA when /api/integrations returns no adsgpt row (the canonical demo-blocker fix)', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.includes('/api/wellness/locations')) return Promise.resolve([{ id: 1, name: 'Ranchi' }]);
      if (url.includes('/api/wellness/dashboard')) return Promise.resolve(dashboardJson);
      if (url.includes('/api/wellness/reports/pnl-by-service')) return Promise.resolve({ totalRevenue: 0, totals: {}, rows: [] });
      if (url === '/api/integrations') {
        // No adsgpt row in the returned list — this is the staging
        // state the pen-test #831 captured (card always read
        // "Linked account: Not configured" with nowhere to go).
        return Promise.resolve([
          { provider: 'slack', isActive: true, id: 1 },
        ]);
      }
      return Promise.resolve({});
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('adsgpt-not-linked-label')).toBeInTheDocument());
    expect(screen.getByText(/No AdsGPT account linked yet/i)).toBeInTheDocument();
    // The Connect CTA is the unambiguous "go link this now" surface.
    expect(screen.getByRole('button', { name: /Connect AdsGPT account/i })).toBeInTheDocument();
  });

  it('AdsGPT card: renders Retry when /api/integrations rejects', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.includes('/api/wellness/locations')) return Promise.resolve([{ id: 1, name: 'Ranchi' }]);
      if (url.includes('/api/wellness/dashboard')) return Promise.resolve(dashboardJson);
      if (url.includes('/api/wellness/reports/pnl-by-service')) return Promise.resolve({ totalRevenue: 0, totals: {}, rows: [] });
      if (url === '/api/integrations') return Promise.reject(new Error('boom'));
      return Promise.resolve({});
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('adsgpt-error-label')).toBeInTheDocument());
    expect(screen.getByText(/Unable to check link status/i)).toBeInTheDocument();
    // Retry CTA is differentiated from "Connect" / "View campaigns" so
    // the user knows this is a transient error, not a missing link.
    expect(screen.getByRole('button', { name: /Retry checking AdsGPT link status/i })).toBeInTheDocument();
  });

  it('AdsGPT card: settings without a login field falls back to ADSGPT_DEMO_LOGIN', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.includes('/api/wellness/locations')) return Promise.resolve([{ id: 1, name: 'Ranchi' }]);
      if (url.includes('/api/wellness/dashboard')) return Promise.resolve(dashboardJson);
      if (url.includes('/api/wellness/reports/pnl-by-service')) return Promise.resolve({ totalRevenue: 0, totals: {}, rows: [] });
      if (url === '/api/integrations') {
        // Row exists + active, but settings doesn't carry a login —
        // exercise the env-var fallback so demos with unannotated rows
        // still render a name instead of going blank.
        return Promise.resolve([
          { provider: 'adsgpt', isActive: true, settings: '{}', id: 18 },
        ]);
      }
      return Promise.resolve({});
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByTestId('adsgpt-linked-label')).toBeInTheDocument());
    // env-var default is sumitgh2050 (per utils/adsgpt.js).
    expect(screen.getByTestId('adsgpt-linked-label').textContent).toMatch(/sumitgh2050/);
  });

  // #565 (HI-16): the dashboard's "Revenue this month" KPI now reads
  // from the canonical /api/wellness/reports/pnl-by-service endpoint
  // (totalRevenue scalar) so it agrees with /wellness/reports.
  it('fetches /pnl-by-service and renders its totalRevenue', async () => {
    setupFetch([{ id: 1, name: 'Ranchi' }], { totalRevenue: 1201900, totals: { revenue: 1201900 }, rows: [] });
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/Revenue this month/i)).toBeInTheDocument());
    expect(screen.getByText(/₹12,01,900/)).toBeInTheDocument();
    // The canonical endpoint was hit with a from/to query window.
    const calls = fetchApi.mock.calls.map((c) => c[0]);
    expect(calls.some((u) => /\/api\/wellness\/reports\/pnl-by-service\?.*from=/.test(u))).toBe(true);
  });
});
