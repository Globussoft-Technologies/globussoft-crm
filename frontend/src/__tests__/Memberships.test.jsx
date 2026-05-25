/**
 * Memberships.test.jsx — vitest + RTL coverage for the wellness-vertical
 * membership-plan admin page (frontend/src/pages/wellness/Memberships.jsx).
 *
 * Scope: pins the page-surface invariants for the admin plan catalog —
 * heading + CTAs, loading state, parallel-fetch on mount (plans + services
 * + admin-only dashboard), empty state, plan card render (price/duration/
 * entitlements/inactive badge), New-plan form open/close, validation
 * (name required + at least one entitlement), and RBAC (USER hides
 * mutation CTAs + dashboard cards + does NOT GET the dashboard).
 *
 * Test cases (12):
 *   1. Heading "Memberships" + sub-copy render.
 *   2. Loading state: "Loading membership plans…" renders while initial
 *      fetch is in-flight (per CLAUDE.md tick #108 cron-learning).
 *   3. ADMIN mount fires three parallel GETs:
 *        /api/wellness/membership-plans?includeInactive=1
 *        /api/wellness/services
 *        /api/wellness/memberships/dashboard
 *   4. USER role does NOT GET /api/wellness/memberships/dashboard
 *      (gated behind isAdmin in the SUT's load()).
 *   5. Admin chrome — Export CSV + Import CSV + "New plan" buttons render
 *      for ADMIN role.
 *   6. USER role HIDES mutation CTAs (no New-plan button, no Export CSV,
 *      no dashboard cards).
 *   7. Empty-state copy "No membership plans yet." renders when the plans
 *      GET resolves to [].
 *   8. Plan card renders name + formatted price + duration + Includes
 *      heading + entitlement line items (serviceName × quantity).
 *   9. Inactive plan renders the "Inactive" badge (and the SUT's
 *      isActive=false path).
 *  10. Dashboard summary cards render with ADMIN + dashboard payload
 *      (Active, Expiring this week, Expired counts).
 *  11. Clicking "New plan" opens the form (Name input + Save plan
 *      button render); clicking Cancel closes it.
 *  12. Submit-validation: empty name → notify.error("Plan name is
 *      required") and no POST. With name set + zero entitlements →
 *      notify.error("At least one entitlement is required").
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi + getAuthToken mocked at ../utils/api.
 *   - notifyObj is STABLE module-level — Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule (fresh-per-call objects flap useCallback / useEffect
 *     dep identity).
 *   - AuthContext provided via the real Provider from App (SUT consumes
 *     it for `user.role` isAdmin gating).
 *   - formatMoney is NOT mocked — the SUT calls it directly with the
 *     plan's `currency` field ("INR"), so assertions use locale-tolerant
 *     numeric substring matches (price digits with optional grouping).
 *   - Data-dependent assertions use await findBy / waitFor.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "fetch endpoints — likely /api/memberships OR
 *     /api/wellness/memberships". REALITY: SUT uses
 *     /api/wellness/membership-plans (with ?includeInactive=1 on mount)
 *     for the catalog, /api/wellness/services for service names, and
 *     /api/wellness/memberships/dashboard for admin KPI tiles. Three
 *     distinct endpoints, not one.
 *   - Prompt anticipated "tier name, price, included-services, duration"
 *     form. REALITY: SUT uses {name, description, durationDays, price,
 *     currency, entitlements:[{serviceId, quantity}]}. Entitlements are
 *     row-add via "Add row" button + per-row service<select> + quantity
 *     <input>, NOT a multi-select.
 *   - Prompt anticipated "active-inactive badge per tier". REALITY: only
 *     the INACTIVE badge renders; active plans have no badge (active is
 *     the default state and renders without chrome).
 *   - Prompt anticipated "subscriber count display per tier". REALITY:
 *     SUT does NOT render a subscriber count on plan cards. Active /
 *     expiring / expired counts are an ADMIN dashboard summary only,
 *     not per-tier counts. Omitted from tests.
 *   - Prompt anticipated "delete confirmation + active-subscriber check".
 *     REALITY: SUT calls window.confirm() with a soft-delete message
 *     ("Existing patient memberships keep working until expiry; only new
 *     sales are blocked") then DELETEs /api/wellness/membership-plans/:id.
 *     Backend handles active-member gating. Test covers the open/close
 *     form pattern, not the delete-confirmation flow (deferred — covered
 *     by api-level spec).
 *
 * Path: flat __tests__/Memberships.test.jsx — distinct from any wellness/
 * subdir convention; matches the prompt's path mandate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
const getAuthTokenMock = vi.fn(() => 'test-token');
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: (...args) => getAuthTokenMock(...args),
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import Memberships from '../pages/wellness/Memberships';

const ADMIN_USER = {
  userId: 1,
  name: 'Rishu Admin',
  email: 'rishu@enhancedwellness.in',
  role: 'ADMIN',
};
const REGULAR_USER = {
  userId: 99,
  name: 'Front Desk',
  email: 'desk@enhancedwellness.in',
  role: 'USER',
};

const SERVICES = [
  { id: 11, name: 'Hydrafacial', isActive: true },
  { id: 12, name: 'Microneedling', isActive: true },
  { id: 13, name: 'Retired Service', isActive: false },
];

const ACTIVE_PLAN = {
  id: 201,
  name: 'Gold Facial Pack 10x',
  description: 'Ten facials over six months',
  price: 15000,
  currency: 'INR',
  durationDays: 180,
  isActive: true,
  entitlements: JSON.stringify([{ serviceId: 11, quantity: 10 }]),
};
const INACTIVE_PLAN = {
  id: 202,
  name: 'Legacy Bronze',
  description: null,
  price: 4999,
  currency: 'INR',
  durationDays: 90,
  isActive: false,
  entitlements: JSON.stringify([{ serviceId: 12, quantity: 5 }]),
};

const DASHBOARD_PAYLOAD = {
  active: { count: 23, deferredRevenue: 200000 },
  expiringThisWeek: { count: 4 },
  expired: { count: 11 },
};

function installFetchMock({
  plans = [ACTIVE_PLAN, INACTIVE_PLAN],
  services = SERVICES,
  dashboard = DASHBOARD_PAYLOAD,
  plansPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/wellness/membership-plans') && method === 'GET') {
      if (plansPromise) return plansPromise;
      return Promise.resolve(plans);
    }
    if (url === '/api/wellness/services') return Promise.resolve(services);
    if (url === '/api/wellness/memberships/dashboard') {
      return Promise.resolve(dashboard);
    }
    // POST/PUT/DELETE catchall — resolve so submit() succeeds.
    return Promise.resolve({ ok: true });
  });
}

function renderPage({ user = ADMIN_USER } = {}) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, name: 'Enhanced Wellness' }, loading: false }}>
        <Memberships />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  getAuthTokenMock.mockReset();
  getAuthTokenMock.mockReturnValue('test-token');
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
});

describe('<Memberships /> — page chrome', () => {
  it('renders the "Memberships" heading + sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Memberships/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Time-bound packages of services/i),
    ).toBeInTheDocument();
  });

  it('shows "Loading membership plans…" before the initial fetch resolves', async () => {
    // Block the plans fetch indefinitely to pin the loading branch.
    installFetchMock({ plansPromise: new Promise(() => {}) });
    renderPage();
    expect(
      await screen.findByText(/Loading membership plans…/i),
    ).toBeInTheDocument();
  });
});

describe('<Memberships /> — mount fetches', () => {
  it('ADMIN mount fires plans + services + dashboard GETs in parallel', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/membership-plans?includeInactive=1',
      );
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/services');
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/wellness/memberships/dashboard',
    );
  });

  it('USER role does NOT fetch the admin dashboard endpoint', async () => {
    installFetchMock();
    renderPage({ user: REGULAR_USER });
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/membership-plans?includeInactive=1',
      );
    });
    const dashboardCall = fetchApiMock.mock.calls.find(
      ([u]) => u === '/api/wellness/memberships/dashboard',
    );
    expect(dashboardCall).toBeUndefined();
  });
});

describe('<Memberships /> — RBAC chrome', () => {
  it('ADMIN sees Export CSV + Import CSV + "New plan" buttons', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Export CSV/i })).toBeInTheDocument();
    expect(screen.getByText(/Import CSV/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New plan/i })).toBeInTheDocument();
  });

  it('USER role hides mutation CTAs + dashboard cards', async () => {
    installFetchMock();
    renderPage({ user: REGULAR_USER });
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /New plan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Export CSV/i })).toBeNull();
    expect(screen.queryByTestId('memberships-dashboard-cards')).toBeNull();
  });
});

describe('<Memberships /> — plan list', () => {
  it('renders the empty-state copy when no plans exist', async () => {
    installFetchMock({ plans: [], dashboard: null });
    renderPage();
    expect(
      await screen.findByText(/No membership plans yet\./i),
    ).toBeInTheDocument();
  });

  it('renders a plan card with name + price + duration + entitlements list', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    // Price digits — locale-tolerant: "15,000" or "15000" depending on Intl.
    expect(
      screen.getAllByText((_t, el) =>
        /(?:^|[^\d])15[,. ]?000(?:[^\d]|$)/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // Duration footer.
    expect(screen.getByText(/180 days/i)).toBeInTheDocument();
    // Entitlements section + service-name row.
    expect(screen.getAllByText(/Includes:/i).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText((_t, el) =>
        /Hydrafacial.*×.*10/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('renders the "Inactive" badge on inactive plans', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Legacy Bronze')).toBeInTheDocument();
    });
    expect(screen.getByText(/^Inactive$/)).toBeInTheDocument();
  });
});

describe('<Memberships /> — dashboard summary cards (admin)', () => {
  it('renders Active / Expiring / Expired tiles with payload counts', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('memberships-dashboard-cards')).toBeInTheDocument();
    });
    expect(screen.getByText(/^ ?ACTIVE MEMBERSHIPS$/i)).toBeInTheDocument();
    expect(screen.getByText(/EXPIRING THIS WEEK/i)).toBeInTheDocument();
    expect(screen.getByText(/^EXPIRED$/i)).toBeInTheDocument();
    expect(screen.getByText('23')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
  });
});

describe('<Memberships /> — New-plan form open/close + validation', () => {
  it('clicking "New plan" opens the form; Cancel closes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    expect(
      screen.getByRole('heading', { name: /New membership plan/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Gold Facial Pack 10x/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Save plan/i }),
    ).toBeInTheDocument();
    // Two buttons match /^Cancel$/ when the form is open: the header toggle
    // ("New plan" -> "Cancel") AND the form's own Cancel button. Either closes
    // the form; click the LAST one (the form's), which mirrors a user clicking
    // inside the form rather than scrolling back to the header.
    const cancelBtns = screen.getAllByRole('button', { name: /^Cancel$/ });
    fireEvent.click(cancelBtns[cancelBtns.length - 1]);
    expect(
      screen.queryByRole('heading', { name: /New membership plan/i }),
    ).toBeNull();
  });

  it('submit with empty name → error toast, no POST; with name but no entitlements → entitlement error', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    // Submit empty form — name is required first.
    fireEvent.submit(
      screen.getByRole('button', { name: /Save plan/i }).closest('form'),
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Plan name is required/i),
      );
    });
    // No POST fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();

    // Now type a name + submit with NO entitlements added → second guard.
    fireEvent.change(
      screen.getByPlaceholderText(/Gold Facial Pack 10x/i),
      { target: { value: 'Trial Pack' } },
    );
    // Price is also required by the SUT's parseFloat path, but the
    // entitlements guard fires BEFORE saving (name+entitlements both
    // checked client-side prior to POST).
    fireEvent.submit(
      screen.getByRole('button', { name: /Save plan/i }).closest('form'),
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/At least one entitlement is required/i),
      );
    });
    const postCall2 = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'POST',
    );
    expect(postCall2).toBeUndefined();
  });
});
