import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

function setupFetch(locations) {
  fetchApi.mockImplementation((url) => {
    if (url.includes('/api/wellness/locations')) return Promise.resolve(locations);
    if (url.includes('/api/wellness/dashboard')) return Promise.resolve(dashboardJson);
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
});
