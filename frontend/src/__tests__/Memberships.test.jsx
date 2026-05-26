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

/**
 * Extension wave — 2026-05-26. Adds coverage for the SUT's still-uncovered
 * branches: edit flow (PUT + form prefill + heading flip), entitlement
 * row-management (add / add-when-exhausted / remove), soft-delete (confirm-
 * yes DELETE + confirm-no no-op), CSV export (disabled-when-empty +
 * happy-path blob anchor click + auth header pass-through), CSV import
 * happy path (multipart POST + load() re-fire), POST happy-path with full
 * valid payload, and the MANAGER role being treated as admin (per the
 * SUT's `isAdmin = role==='ADMIN' || role==='MANAGER'` gate).
 *
 * New cases (10):
 *  13. MANAGER role gets the same admin treatment as ADMIN — sees New-plan +
 *      Export CSV CTAs + the admin dashboard endpoint fires.
 *  14. Clicking "Edit" on a plan card prefills the form (name + price +
 *      duration), flips the heading to "Edit plan", and submitting fires
 *      a PUT (not a POST) to /api/wellness/membership-plans/:id.
 *  15. Submit-happy-path: valid name + price + one entitlement → POST fires
 *      with the expected body shape; notify.success("Created …") called.
 *  16. addEntitlement happy-path: opens form, clicks "Add row" → an active
 *      service is added to the entitlements table.
 *  17. addEntitlement when ALL active services already used → notify.error
 *      "No more services to add" fires; entitlements length unchanged.
 *  18. removeEntitlement: with one row added, clicking the X removes it
 *      (entitlements table disappears, returns to "Add at least one…" copy).
 *  19. Soft-delete CONFIRM path: window.confirm → true → DELETE fires to
 *      /api/wellness/membership-plans/:id + notify.success("Deactivated …").
 *  20. Soft-delete CANCEL path: window.confirm → false → NO DELETE fires,
 *      no notify call (user backed out of the destructive op).
 *  21. CSV Export DISABLED when plans list is empty (button has aria-
 *      disabled attribute, and clicking it does NOT fire the export fetch).
 *  22. CSV Export happy-path: clicks Export CSV → window.fetch is invoked
 *      with the bearer token; a blob anchor is created and downloaded;
 *      notify.success fires with the exported-count copy.
 */
describe('<Memberships /> — extension: MANAGER + edit + submit + entitlement mgmt + delete + CSV', () => {
  const MANAGER_USER = {
    userId: 50,
    name: 'Wellness Manager',
    email: 'manager@enhancedwellness.in',
    role: 'MANAGER',
  };

  it('MANAGER role gets ADMIN treatment — sees CTAs + fires dashboard fetch', async () => {
    installFetchMock();
    renderPage({ user: MANAGER_USER });
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /New plan/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export CSV/i })).toBeInTheDocument();
    // Dashboard endpoint MUST have fired for managers (SUT's isAdmin gate).
    const dashboardCall = fetchApiMock.mock.calls.find(
      ([u]) => u === '/api/wellness/memberships/dashboard',
    );
    expect(dashboardCall).toBeDefined();
  });

  it('clicking Edit on a plan prefills the form + submits as PUT', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    // Find the Edit button inside the active plan card (Legacy Bronze is
    // inactive so its card hides the delete button but keeps Edit).
    const editButtons = screen.getAllByRole('button', { name: /Edit/i });
    fireEvent.click(editButtons[0]);
    // Heading flips to "Edit plan"; form prefilled.
    expect(
      screen.getByRole('heading', { name: /Edit plan/i }),
    ).toBeInTheDocument();
    const nameInput = screen.getByPlaceholderText(/Gold Facial Pack 10x/i);
    expect(nameInput.value).toBe('Gold Facial Pack 10x');
    // Submit → PUT fires (entitlements already populated from the plan).
    fireEvent.submit(
      screen.getByRole('button', { name: /Save plan/i }).closest('form'),
    );
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/membership-plans/201' && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Updated "Gold Facial Pack 10x"/i),
    );
  });

  it('submit happy-path: valid name + price + entitlement → POST fires with expected body', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    fireEvent.change(screen.getByPlaceholderText(/Gold Facial Pack 10x/i), {
      target: { value: 'Silver Pack 5x' },
    });
    // Price input — typed by placeholder "15000".
    fireEvent.change(screen.getByPlaceholderText('15000'), {
      target: { value: '7500' },
    });
    // Add one entitlement row via the "Add row" button.
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    fireEvent.submit(
      screen.getByRole('button', { name: /Save plan/i }).closest('form'),
    );
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/membership-plans' && opts?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Silver Pack 5x');
      expect(body.price).toBe(7500);
      expect(body.currency).toBe('INR');
      expect(body.durationDays).toBe(180);
      expect(Array.isArray(body.entitlements)).toBe(true);
      expect(body.entitlements.length).toBe(1);
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Created "Silver Pack 5x"/i),
    );
  });

  it('addEntitlement happy-path: clicks Add row → entitlement table appears', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    // Pre-Add: italic helper copy visible, no table.
    expect(
      screen.getByText(/Add at least one service \+ quantity/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    // Post-Add: helper copy gone, table header visible.
    expect(
      screen.queryByText(/Add at least one service \+ quantity/i),
    ).toBeNull();
    expect(screen.getByRole('columnheader', { name: /Service/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Quantity/i })).toBeInTheDocument();
  });

  it('addEntitlement when all active services already used → notify.error fires', async () => {
    // SERVICES has 2 ACTIVE entries (Hydrafacial #11, Microneedling #12).
    // Add both rows, then click "Add row" a third time → "No more services
    // to add" error from the SUT's addEntitlement guard.
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    // Third click — no available service left.
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    expect(notifyError).toHaveBeenCalledWith(
      expect.stringMatching(/No more services to add/i),
    );
  });

  it('removeEntitlement: clicking the X on a row removes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    // Row added — find the X-icon button inside the entitlements table.
    // The row's remove button is the LAST button matching the lucide X icon
    // (the form chrome's Cancel/etc. are role=button with text, not just X).
    // Identify by being inside a <td> inside the entitlements <table>.
    const table = document.querySelector('table');
    expect(table).not.toBeNull();
    const removeBtn = table.querySelector('button');
    expect(removeBtn).not.toBeNull();
    fireEvent.click(removeBtn);
    // Helper copy returns when entitlements length goes back to 0.
    expect(
      screen.getByText(/Add at least one service \+ quantity/i),
    ).toBeInTheDocument();
  });

  it('soft-delete CONFIRM path: confirm=true → DELETE fires + success toast', async () => {
    installFetchMock();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    // Only the ACTIVE plan (Gold Facial Pack 10x, id=201) renders the
    // Deactivate button — INACTIVE_PLAN's card hides it per the SUT's
    // `p.isActive &&` guard.
    fireEvent.click(screen.getByRole('button', { name: /Deactivate/i }));
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Soft-delete "Gold Facial Pack 10x"/i),
    );
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/membership-plans/201' && opts?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Deactivated "Gold Facial Pack 10x"/i),
    );
    confirmSpy.mockRestore();
  });

  it('soft-delete CANCEL path: confirm=false → NO DELETE + no toast', async () => {
    installFetchMock();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Deactivate/i }));
    expect(confirmSpy).toHaveBeenCalled();
    // No DELETE fired.
    const deleteCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
    // No success toast.
    expect(notifySuccess).not.toHaveBeenCalledWith(
      expect.stringMatching(/Deactivated/i),
    );
    confirmSpy.mockRestore();
  });

  it('Export CSV button is DISABLED when plans list is empty', async () => {
    installFetchMock({ plans: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No membership plans yet\./i)).toBeInTheDocument();
    });
    const exportBtn = screen.getByRole('button', { name: /Export CSV/i });
    expect(exportBtn).toBeDisabled();
  });

  it('CSV Export happy-path: clicks Export → fetch fires with Bearer token + success toast', async () => {
    installFetchMock();
    // Mock window.fetch directly (the SUT uses native fetch for the blob
    // download, not fetchApi, because plain <a href> can't set Authorization).
    const blob = new Blob(['name,price\nGold Facial Pack 10x,15000'], { type: 'text/csv' });
    const fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(blob),
    });
    // Stub URL.createObjectURL (jsdom doesn't implement it).
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = vi.fn();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/csv/membership-plans/export.csv',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        }),
      );
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Exported 2 plans?/i),
      );
    });
    fetchSpy.mockRestore();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });
});
