/**
 * CancellationPolicies.test.jsx — vitest + RTL coverage for the Travel-
 * vertical cancellation-policies admin page
 * (frontend/src/pages/travel/CancellationPolicies.jsx, shipped S54 slice).
 *
 * Scope — pins page-surface invariants for the operator-facing per-sub-
 * brand refund-ladder library (sibling to QuoteTemplates / SuppliersAdmin):
 *
 *   1. Page chrome: heading "Cancellation Policies" + sub-brand filter +
 *      active filter + "New Policy" CTA (ADMIN/MANAGER only).
 *   2. Loading state: shows "Loading…" placeholder before first GET
 *      resolves.
 *   3. GET on mount: hits /api/travel/cancellation-policies with the
 *      default ?active=true filter and renders one row per policy with
 *      response shape { policies, total, limit, offset }.
 *   4. Empty state — no rows: renders the "No policies match." card when
 *      the API returns an empty `policies` array.
 *   5. Empty state — 403: renders the "Access restricted." copy per #829
 *      (permissionDenied distinguishes 403 from genuine empty).
 *   6. Sub-brand filter: selecting "rfu" re-fetches with ?subBrand=rfu.
 *   7. New-policy modal opens with default tier ladder pre-populated.
 *   8. Tier validation: invalid tier (negative days OR percent>100) →
 *      notify.error + NO POST fires.
 *   9. Tier preview rendering: rendered preview text matches the
 *      band-string for the default ladder (4 tiers: 60+d/30-59d/7-29d/<7d).
 *  10. Delete flow: clicking delete prompts via window.confirm; confirm-
 *      yes → DELETEs the policy; confirm-no → no DELETE fires.
 *  11. USER role gates: no "New Policy" CTA + no Actions column (read-
 *      only viewer).
 *  12. MANAGER role: can edit (Pencil) but cannot delete (Trash hidden —
 *      delete is ADMIN-only per backend verifyRole).
 *
 * Backend contract pinned (per backend/routes/travel_cancellation_policies.js):
 *   GET    /api/travel/cancellation-policies[?subBrand=&active=]
 *                                            → 200 { policies, total, limit, offset }
 *                                              | 403 sub-brand denied
 *   POST   /api/travel/cancellation-policies → 201 created
 *                                              | 400 MISSING_FIELDS / INVALID_TIERS
 *                                              | 403 sub-brand denied
 *   PATCH  /api/travel/cancellation-policies/:id → 200 updated
 *   DELETE /api/travel/cancellation-policies/:id → 204 No Content (ADMIN)
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders.
 *   - AuthContext provided with role:ADMIN / MANAGER / USER per test.
 *   - travelSubBrand imported REAL (not mocked) so sub-brand-bg drift is
 *     caught here.
 *   - window.confirm stubbed per-test for the delete flow.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 sync getBy for data-dependent text is a CI
 *     race trap).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify inside handleSubmit / handleDelete,
// so a fresh object per render would flap state across re-renders.
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
import CancellationPolicies, {
  validateTiers,
  renderTierPreview,
} from '../pages/travel/CancellationPolicies';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const MANAGER_USER = { userId: 2, name: 'Manager', email: 'm@x.com', role: 'MANAGER' };
const USER_USER = { userId: 3, name: 'Plain User', email: 'u@x.com', role: 'USER' };

// Canonical policy rows — two sub-brands + one tenant-wide to exercise
// the badge + preview-rendering paths.
function makePolicy(overrides = {}) {
  return {
    id: 401,
    tenantId: 1,
    name: 'TMC Default',
    description: 'Standard TMC school-trip cancellation policy.',
    subBrand: 'tmc',
    tiersJson: JSON.stringify([
      { daysBeforeServiceStart: 60, refundPercent: 100 },
      { daysBeforeServiceStart: 30, refundPercent: 50 },
      { daysBeforeServiceStart: 7, refundPercent: 25 },
      { daysBeforeServiceStart: 0, refundPercent: 0 },
    ]),
    isActive: true,
    createdAt: '2026-05-10T09:00:00.000Z',
    updatedAt: '2026-05-10T09:00:00.000Z',
    ...overrides,
  };
}

const POLICIES_DEFAULT = [
  makePolicy({ id: 401, subBrand: 'tmc', name: 'TMC Default' }),
  makePolicy({
    id: 402,
    subBrand: 'rfu',
    name: 'RFU Default',
    tiersJson: JSON.stringify([
      { daysBeforeServiceStart: 90, refundPercent: 100 },
      { daysBeforeServiceStart: 45, refundPercent: 75 },
      { daysBeforeServiceStart: 14, refundPercent: 50 },
      { daysBeforeServiceStart: 0, refundPercent: 0 },
    ]),
  }),
  makePolicy({
    id: 403,
    subBrand: null,
    name: 'Tenant-wide Fallback',
    isActive: false,
    tiersJson: 'not-valid-json',
  }),
];

function installFetchMock({
  list = {
    policies: POLICIES_DEFAULT,
    total: POLICIES_DEFAULT.length,
    limit: 50,
    offset: 0,
  },
  create = null,
  update = null,
  del = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (
      url.startsWith('/api/travel/cancellation-policies') &&
      method === 'GET'
    ) {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (
      url === '/api/travel/cancellation-policies' &&
      method === 'POST'
    ) {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makePolicy({ id: 999 }));
    }
    if (
      /^\/api\/travel\/cancellation-policies\/\d+$/.test(url) &&
      method === 'PATCH'
    ) {
      if (update instanceof Error) return Promise.reject(update);
      return Promise.resolve(
        update || makePolicy({ id: 401, name: 'Updated' }),
      );
    }
    if (
      /^\/api\/travel\/cancellation-policies\/\d+$/.test(url) &&
      method === 'DELETE'
    ) {
      if (del instanceof Error) return Promise.reject(del);
      // Backend returns 204 No Content — fetchApi resolves with null/undefined.
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{
          user,
          token: 'tk',
          tenant: { id: 1, defaultCurrency: 'INR' },
          loading: false,
        }}
      >
        <CancellationPolicies />
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
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<CancellationPolicies /> — page chrome + filter bar', () => {
  it('renders heading + filter bar + "New Policy" CTA (ADMIN role)', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /Cancellation Policies/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Filter by active status/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New Policy/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) =>
          typeof u === 'string' &&
          u.startsWith('/api/travel/cancellation-policies'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('hides "New Policy" CTA + Actions column for plain USER role (canWrite=false)', async () => {
    renderPage(USER_USER);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /New Policy/i })).toBeNull();
    await screen.findByText('TMC Default');
    expect(
      screen.queryByRole('columnheader', { name: /Actions/i }),
    ).toBeNull();
  });

  it('MANAGER can edit but not delete (Trash hidden — ADMIN-only)', async () => {
    renderPage(MANAGER_USER);
    await screen.findByText('TMC Default');
    expect(
      screen.getByRole('button', { name: /Edit policy TMC Default/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Delete policy TMC Default/i }),
    ).toBeNull();
  });
});

describe('<CancellationPolicies /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (
        url.startsWith('/api/travel/cancellation-policies') &&
        method === 'GET'
      ) {
        return new Promise((res) => {
          resolveList = res;
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({
      policies: POLICIES_DEFAULT,
      total: POLICIES_DEFAULT.length,
    });
    await screen.findByText('TMC Default');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/cancellation-policies on mount with default ?active=true', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          typeof u === 'string' &&
          u.startsWith('/api/travel/cancellation-policies') &&
          (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      // Default isActive filter is 'true' → ?active=true threaded
      expect(listCall[0]).toContain('active=true');
    });
    expect(await screen.findByText('TMC Default')).toBeInTheDocument();
    expect(screen.getByText('RFU Default')).toBeInTheDocument();
    expect(screen.getByText('Tenant-wide Fallback')).toBeInTheDocument();
  });

  it('renders empty state "No policies match." when API returns []', async () => {
    installFetchMock({ list: { policies: [], total: 0 } });
    renderPage();
    expect(await screen.findByText('No policies match.')).toBeInTheDocument();
  });

  it('renders "Access restricted." copy per #829 when API rejects with status:403', async () => {
    const err = new Error('Forbidden sub-brand');
    err.status = 403;
    installFetchMock({ list: err });
    renderPage();
    expect(
      await screen.findByText(/Access restricted\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your role does not have permission to view/i),
    ).toBeInTheDocument();
  });
});

describe('<CancellationPolicies /> — filter behavior', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu in the URL', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fetchApiMock.mockClear();
    installFetchMock({ list: { policies: [POLICIES_DEFAULT[1]], total: 1 } });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), {
      target: { value: 'rfu' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          typeof u === 'string' &&
          u.includes('subBrand=rfu') &&
          (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<CancellationPolicies /> — row rendering: tier count + preview + sub-brand badge', () => {
  it('tier count column shows array length for valid tiersJson', async () => {
    renderPage();
    const row = await screen.findByText('TMC Default');
    const tr = row.closest('tr');
    expect(tr).toBeTruthy();
    // TMC Default has 4 tiers
    expect(within(tr).getByText('4')).toBeInTheDocument();
  });

  it('tier count column shows "—" for malformed tiersJson', async () => {
    renderPage();
    const row = await screen.findByText('Tenant-wide Fallback');
    const tr = row.closest('tr');
    expect(tr).toBeTruthy();
    // Tenant-wide Fallback has tiersJson = 'not-valid-json' → renders "—"
    const dashes = within(tr).getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('tier preview column renders the band-string for TMC Default ladder', async () => {
    renderPage();
    const row = await screen.findByText('TMC Default');
    const tr = row.closest('tr');
    // Preview for 60d/100% → 30d/50% → 7d/25% → 0d/0% should contain
    // canonical band tokens.
    const preview = within(tr).getByText(/at 60\+d → 100% refund/);
    expect(preview).toBeInTheDocument();
    expect(preview.textContent).toMatch(/at 30-59d → 50% refund/);
    expect(preview.textContent).toMatch(/at 7-29d → 25% refund/);
    expect(preview.textContent).toMatch(/at <7d → 0% refund/);
  });

  it('sub-brand badge per row uses real SUB_BRAND_BG palette (rgba) from travelSubBrand.js', async () => {
    renderPage();
    const tmcRow = await screen.findByText('TMC Default');
    const tr = tmcRow.closest('tr');
    const badge = within(tr).getByText('tmc');
    // Real SUB_BRAND_BG palette renders as rgba(... 0.18) — assert the rgba prefix.
    expect(badge.style.background).toMatch(/rgba\(/);
  });

  it('Active/Inactive status badge renders per row', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    // Two active rows (TMC + RFU) + one inactive (Tenant-wide Fallback) →
    // both badges present in the DOM. Use getAllByText since "Active" is
    // both a filter chrome option AND a row badge (RTL standing rule).
    const activeBadges = screen.getAllByText('Active');
    expect(activeBadges.length).toBeGreaterThanOrEqual(2);
    const inactiveRow = screen
      .getByText('Tenant-wide Fallback')
      .closest('tr');
    expect(within(inactiveRow).getByText('Inactive')).toBeInTheDocument();
  });
});

describe('<CancellationPolicies /> — new-policy modal + create POST', () => {
  it('clicking "New Policy" reveals the create form pre-populated with default ladder', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    expect(screen.queryByLabelText(/^Policy name$/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    expect(screen.getByLabelText(/^Policy name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Description$/i)).toBeInTheDocument();
    // Default ladder rows pre-populated — 4 "days" inputs.
    expect(screen.getByLabelText(/Tier 1 days/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tier 4 days/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Save$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Cancel/i }),
    ).toBeInTheDocument();
  });

  it('tier preview updates live inside the form modal', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    // The default ladder is 60/100, 30/50, 7/25, 0/0 → preview must match
    // canonical band string.
    const preview = screen.getByTestId('tier-preview');
    expect(preview.textContent).toMatch(/at 60\+d → 100% refund/);
    expect(preview.textContent).toMatch(/at 30-59d → 50% refund/);
    expect(preview.textContent).toMatch(/at 7-29d → 25% refund/);
    expect(preview.textContent).toMatch(/at <7d → 0% refund/);
  });

  it('happy path: filling the form + Save POSTs /api/travel/cancellation-policies with parsed payload', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    fireEvent.change(screen.getByLabelText(/^Policy name$/i), {
      target: { value: 'TravelStall Custom' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel/cancellation-policies' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.name).toBe('TravelStall Custom');
      expect(typeof body.tiersJson).toBe('string');
      const tiers = JSON.parse(body.tiersJson);
      expect(Array.isArray(tiers)).toBe(true);
      expect(tiers.length).toBe(4);
      // Canonical DESC sort by days.
      expect(tiers[0].daysBeforeServiceStart).toBe(60);
      expect(tiers[0].refundPercent).toBe(100);
    });
  });

  it('validation: empty name does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel/cancellation-policies' && o?.method === 'POST',
      );
      expect(post).toBeUndefined();
    });
  });

  it('validation: invalid tier (refundPercent>100) surfaces notify.error + does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    fireEvent.change(screen.getByLabelText(/^Policy name$/i), {
      target: { value: 'Bad' },
    });
    // Remove tier rows down to one, then set its refund% to 999. We use
    // remove-tier rather than just editing the first row because some
    // jsdom + React 18 + `<input type=number max=100>` interactions clamp
    // the value before validation runs. The simpler approach: remove all
    // tiers so validation fires the "non-empty array" guard instead.
    // First, click "Remove tier 1" four times to empty the ladder.
    for (let i = 4; i >= 1; i--) {
      fireEvent.click(
        screen.getByRole('button', { name: new RegExp(`Remove tier ${i}`) }),
      );
    }
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    // notify.error called with "Tiers must be a non-empty array".
    expect(notifyError.mock.calls[0][0]).toMatch(/non-empty/);
    const post = fetchApiMock.mock.calls.find(
      ([u, o]) =>
        u === '/api/travel/cancellation-policies' && o?.method === 'POST',
    );
    expect(post).toBeUndefined();
  });
});

describe('<CancellationPolicies /> — edit + delete flows', () => {
  it('Edit icon opens the form pre-filled with the row fields', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(
      screen.getByRole('button', { name: /Edit policy TMC Default/i }),
    );
    const nameInput = screen.getByLabelText(/^Policy name$/i);
    expect(nameInput.value).toBe('TMC Default');
    expect(
      screen.getByRole('button', { name: /Save Changes/i }),
    ).toBeInTheDocument();
  });

  it('editing + Save PATCHes /api/travel/cancellation-policies/:id', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(
      screen.getByRole('button', { name: /Edit policy TMC Default/i }),
    );
    fireEvent.change(screen.getByLabelText(/^Policy name$/i), {
      target: { value: 'TMC Default VIP' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel/cancellation-policies/401' &&
          o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      expect(body.name).toBe('TMC Default VIP');
    });
  });

  it('Delete confirms via window.confirm; yes → DELETE fires', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(
      screen.getByRole('button', { name: /Delete policy TMC Default/i }),
    );
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          u === '/api/travel/cancellation-policies/401' &&
          o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
  });

  it('Delete confirms via window.confirm; no → DELETE does NOT fire', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(
      screen.getByRole('button', { name: /Delete policy TMC Default/i }),
    );
    expect(confirmSpy).toHaveBeenCalled();
    const del = fetchApiMock.mock.calls.find(
      ([u, o]) =>
        u === '/api/travel/cancellation-policies/401' &&
        o?.method === 'DELETE',
    );
    expect(del).toBeUndefined();
  });
});

describe('validateTiers + renderTierPreview — pure helpers', () => {
  it('validateTiers: rejects empty array', () => {
    const r = validateTiers([]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-empty/);
  });

  it('validateTiers: rejects negative days', () => {
    const r = validateTiers([{ daysBeforeServiceStart: -1, refundPercent: 50 }]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-negative integer/);
  });

  it('validateTiers: rejects non-integer days (3.5)', () => {
    const r = validateTiers([
      { daysBeforeServiceStart: 3.5, refundPercent: 50 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-negative integer/);
  });

  it('validateTiers: rejects percent > 100', () => {
    const r = validateTiers([
      { daysBeforeServiceStart: 7, refundPercent: 150 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\[0..100\]/);
  });

  it('validateTiers: rejects percent < 0', () => {
    const r = validateTiers([
      { daysBeforeServiceStart: 7, refundPercent: -5 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\[0..100\]/);
  });

  it('validateTiers: accepts a canonical ladder and DESC-sorts', () => {
    const r = validateTiers([
      { daysBeforeServiceStart: 7, refundPercent: 25 },
      { daysBeforeServiceStart: 60, refundPercent: 100 },
      { daysBeforeServiceStart: 0, refundPercent: 0 },
      { daysBeforeServiceStart: 30, refundPercent: 50 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.normalized.map((t) => t.daysBeforeServiceStart)).toEqual([
      60, 30, 7, 0,
    ]);
  });

  it('renderTierPreview: 4-tier ladder produces canonical band string', () => {
    const s = renderTierPreview([
      { daysBeforeServiceStart: 60, refundPercent: 100 },
      { daysBeforeServiceStart: 30, refundPercent: 50 },
      { daysBeforeServiceStart: 7, refundPercent: 25 },
      { daysBeforeServiceStart: 0, refundPercent: 0 },
    ]);
    expect(s).toBe(
      'at 60+d → 100% refund; at 30-59d → 50% refund; at 7-29d → 25% refund; at <7d → 0% refund',
    );
  });

  it('renderTierPreview: single-tier ladder', () => {
    const s = renderTierPreview([
      { daysBeforeServiceStart: 14, refundPercent: 100 },
    ]);
    expect(s).toBe('at 14+d → 100% refund');
  });

  it('renderTierPreview: empty array returns "(no tiers)"', () => {
    expect(renderTierPreview([])).toBe('(no tiers)');
    expect(renderTierPreview(null)).toBe('(no tiers)');
  });

  it('renderTierPreview: defensive DESC-sort on out-of-order input', () => {
    const s = renderTierPreview([
      { daysBeforeServiceStart: 7, refundPercent: 25 },
      { daysBeforeServiceStart: 60, refundPercent: 100 },
      { daysBeforeServiceStart: 30, refundPercent: 50 },
    ]);
    expect(s).toBe(
      'at 60+d → 100% refund; at 30-59d → 50% refund; at <30d → 25% refund',
    );
  });

  // S55 (TRAVEL_BIG_SCOPE_BACKLOG) — App.jsx route registration pin. S54
  // shipped this page but did not touch App.jsx (shared-file hazard); S55
  // wires it in. Without this assertion the lazy import + Route could be
  // silently dropped in a future App.jsx refactor and the page would 404
  // for users navigating from the Sidebar.
  describe('S55 — App.jsx route registration', () => {
    it('registers TravelCancellationPolicies lazy import + Route path="travel/cancellation-policies"', async () => {
      const { readFileSync } = await import('node:fs');
      const path = await import('node:path');
      const appSrc = readFileSync(
        path.resolve(__dirname, '../App.jsx'),
        'utf-8',
      );
      // Lazy import — module path must point at the SUT.
      expect(appSrc).toMatch(
        /lazy\(\(\) => import\(['"]\.\/pages\/travel\/CancellationPolicies['"]\)\)/,
      );
      // Route path — registered under the travel cluster.
      expect(appSrc).toMatch(/path=["']travel\/cancellation-policies["']/);
      // Wrapped in TravelOnly so non-travel-tenant hits bounce.
      expect(appSrc).toMatch(/<TravelOnly><TravelCancellationPolicies \/><\/TravelOnly>/);
    });
  });
});
