/**
 * Memberships.test.jsx — vitest + RTL coverage for the wellness-vertical
 * membership-plan admin page (frontend/src/pages/wellness/Memberships.jsx).
 *
 * Scope: pins the page-surface invariants for the admin plan catalog —
 * heading + sub-copy, loading state, parallel-fetch on mount (plans +
 * services), empty state, plan card render (price/duration), filter
 * pills, search box, RBAC (ADMIN/MANAGER vs USER), FAB-driven new-plan
 * form, validation (name required + at least one entitlement),
 * entitlement add/remove, and edit + soft-delete flows via the
 * three-dot menu.
 *
 * Drift note vs older draft:
 *   - SUT fetches /api/wellness/membership-plans + /api/wellness/services
 *     on mount; it does NOT call /api/wellness/memberships/dashboard.
 *   - There is no Export/Import CSV button on this page.
 *   - "New plan" trigger is a floating "+" FAB (aria-label="New membership
 *     plan"), not a labeled "New plan" button.
 *   - Edit/Deactivate/Delete live behind the three-dot menu per card
 *     (aria-label="Plan actions"), NOT inline on the card.
 *   - Filter pills: All / Active / Expired / Inactive (default = Active).
 *   - Sub-copy reads "Offer membership plans with exclusive benefits for
 *     returning clients." (not "Time-bound packages of services").
 *   - Empty state copy: "No active membership plans yet." when the default
 *     "Active" filter is in play.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — RTL standing rule (fresh objects per call cause
// infinite useCallback dep loops).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
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
const MANAGER_USER = {
  userId: 50,
  name: 'Wellness Manager',
  email: 'manager@enhancedwellness.in',
  role: 'MANAGER',
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

function installFetchMock({
  plans = [ACTIVE_PLAN, INACTIVE_PLAN],
  services = SERVICES,
  plansPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/wellness/membership-plans') && method === 'GET') {
      if (plansPromise) return plansPromise;
      return Promise.resolve(plans);
    }
    if (url === '/api/wellness/services') return Promise.resolve(services);
    // POST/PUT/DELETE catchall.
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
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
});

describe('<Memberships /> — page chrome', () => {
  it('renders the "Memberships" heading + sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Memberships/i }),
    ).toBeInTheDocument();
    // Real sub-copy in the SUT.
    expect(
      screen.getByText(/Offer membership plans with exclusive benefits/i),
    ).toBeInTheDocument();
  });

  it('shows "Loading membership plans…" before the initial fetch resolves', async () => {
    installFetchMock({ plansPromise: new Promise(() => {}) });
    renderPage();
    expect(
      await screen.findByText(/Loading membership plans…/i),
    ).toBeInTheDocument();
  });
});

describe('<Memberships /> — mount fetches', () => {
  it('mount fires plans + services GETs', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/membership-plans?includeInactive=1',
      );
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/services');
  });
});

describe('<Memberships /> — RBAC chrome', () => {
  it('ADMIN sees the floating "+" New-plan FAB', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /New membership plan/i })).toBeInTheDocument();
  });

  it('USER role HIDES the New-plan FAB + the per-card three-dot menu', async () => {
    installFetchMock();
    renderPage({ user: REGULAR_USER });
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /New membership plan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Plan actions/i })).toBeNull();
  });

  it('MANAGER role gets ADMIN treatment — sees CTA + per-card menu', async () => {
    installFetchMock();
    renderPage({ user: MANAGER_USER });
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /New membership plan/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Plan actions/i }).length).toBeGreaterThanOrEqual(1);
  });
});

describe('<Memberships /> — plan list', () => {
  it('renders the empty-state copy when no plans exist', async () => {
    installFetchMock({ plans: [] });
    renderPage();
    expect(
      await screen.findByText(/No active membership plans yet/i),
    ).toBeInTheDocument();
  });

  it('renders a plan card with name + duration label', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    // The 180-day plan renders as "6 Months plan" via durationLabel.
    expect(
      screen.getAllByText((_t, el) =>
        /6 Months plan/i.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('filter pill defaults to Active and switching to All shows inactive plans too', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    // Default "Active" filter hides inactive plan.
    expect(screen.queryByText('Legacy Bronze')).toBeNull();
    // Click "All" pill to show all.
    const allPill = screen.getByRole('button', { name: /^\s*All\b/i });
    fireEvent.click(allPill);
    await waitFor(() => {
      expect(screen.getByText('Legacy Bronze')).toBeInTheDocument();
    });
  });

  it('clicking "Inactive" filter shows only inactive plans', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    const inactivePill = screen.getByRole('button', { name: /Inactive/i });
    fireEvent.click(inactivePill);
    await waitFor(() => {
      expect(screen.queryByText('Gold Facial Pack 10x')).toBeNull();
      expect(screen.getByText('Legacy Bronze')).toBeInTheDocument();
    });
  });

  it('search box filters plans by name', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    const search = screen.getByPlaceholderText(/Search memberships/i);
    fireEvent.change(search, { target: { value: 'nothing-matches' } });
    await waitFor(() => {
      expect(screen.queryByText('Gold Facial Pack 10x')).toBeNull();
      // Empty-state copy is now filter-aware. A query that matches nothing
      // surfaces the search-specific message.
      expect(screen.getByText(/No plans match your search/i)).toBeInTheDocument();
    });
  });
});

describe('<Memberships /> — New-plan form open/close + validation', () => {
  it('clicking the FAB opens the form; Cancel closes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New membership plan/i }));
    expect(
      screen.getByRole('heading', { name: /New membership plan/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Gold Facial Pack 10x/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Save plan/i }),
    ).toBeInTheDocument();
    // Cancel button in the form footer.
    const cancelBtns = screen.getAllByRole('button', { name: /^Cancel$/ });
    fireEvent.click(cancelBtns[cancelBtns.length - 1]);
    expect(
      screen.queryByRole('heading', { name: /New membership plan/i }),
    ).toBeNull();
  });

  it('submit with empty name → notify.error; with name but no entitlements → second guard', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New membership plan/i }));
    // Submit empty form — name is required first.
    fireEvent.submit(
      screen.getByRole('button', { name: /Save plan/i }).closest('form'),
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Plan name is required/i),
      );
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();

    // Now type a name + submit with NO entitlements added → second guard.
    fireEvent.change(
      screen.getByPlaceholderText(/Gold Facial Pack 10x/i),
      { target: { value: 'Trial Pack' } },
    );
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

  it('submit happy-path: valid name + price + entitlement → POST fires with expected body', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New membership plan/i }));
    fireEvent.change(screen.getByPlaceholderText(/Gold Facial Pack 10x/i), {
      target: { value: 'Silver Pack 5x' },
    });
    fireEvent.change(screen.getByPlaceholderText('15000'), {
      target: { value: '7500' },
    });
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
    fireEvent.click(screen.getByRole('button', { name: /New membership plan/i }));
    expect(
      screen.getByText(/Add at least one service \+ quantity/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    expect(
      screen.queryByText(/Add at least one service \+ quantity/i),
    ).toBeNull();
    expect(screen.getByRole('columnheader', { name: /Service/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Quantity/i })).toBeInTheDocument();
  });

  it('addEntitlement when all active services already used → notify.error fires', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New membership plan/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    // Third click — no available service left.
    fireEvent.click(screen.getByRole('button', { name: /Add row/i }));
    expect(notifyError).toHaveBeenCalledWith(
      expect.stringMatching(/No more services to add/i),
    );
  });
});

describe('<Memberships /> — three-dot menu actions', () => {
  it('clicking the three-dot menu opens the Edit/Delete/Deactivate menu', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    const menuBtns = screen.getAllByRole('button', { name: /Plan actions/i });
    fireEvent.click(menuBtns[0]);
    expect(screen.getByRole('menuitem', { name: /Edit/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Delete/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Deactivate/i })).toBeInTheDocument();
  });

  it('clicking Edit in the menu opens the prefilled form (heading "Edit membership plan")', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    const menuBtns = screen.getAllByRole('button', { name: /Plan actions/i });
    fireEvent.click(menuBtns[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/i }));
    expect(
      screen.getByRole('heading', { name: /Edit membership plan/i }),
    ).toBeInTheDocument();
    const nameInput = screen.getByPlaceholderText(/Gold Facial Pack 10x/i);
    expect(nameInput.value).toBe('Gold Facial Pack 10x');
  });

  it('submit from Edit fires a PUT (not POST) to /api/wellness/membership-plans/:id', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    const menuBtns = screen.getAllByRole('button', { name: /Plan actions/i });
    fireEvent.click(menuBtns[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/i }));
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

  it('Delete: notify.confirm true → DELETE fires + success toast', async () => {
    installFetchMock();
    notifyConfirm.mockResolvedValue(true);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    const menuBtns = screen.getAllByRole('button', { name: /Plan actions/i });
    fireEvent.click(menuBtns[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));
    expect(notifyConfirm).toHaveBeenCalled();
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/membership-plans/201' && opts?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Deleted "Gold Facial Pack 10x"/i),
    );
  });

  it('Delete: notify.confirm false → no DELETE, no toast', async () => {
    installFetchMock();
    notifyConfirm.mockResolvedValue(false);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Gold Facial Pack 10x')).toBeInTheDocument();
    });
    const menuBtns = screen.getAllByRole('button', { name: /Plan actions/i });
    fireEvent.click(menuBtns[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));
    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    // Microtask settle.
    await new Promise((r) => setTimeout(r, 30));
    const deleteCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalledWith(
      expect.stringMatching(/Deleted/i),
    );
  });
});
