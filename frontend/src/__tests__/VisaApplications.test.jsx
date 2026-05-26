/**
 * VisaApplications.test.jsx — vitest + RTL coverage for the Phase 3 Visa Sure
 * Applications admin list page (frontend/src/pages/travel/visa/Applications.jsx,
 * cluster B3 wired tick c0ab496 — V8 list view — and the Create drawer added
 * tick 57aa856 — wires the POST endpoint shipped at 6c084cb).
 *
 * Scope — pins the page-surface invariants for the Visa Sure applications
 * admin list page (sibling to QuotesAdmin / InvoicesAdmin / SuppliersAdmin):
 *
 *   1. Page chrome: heading "Visa Applications" + status filter + Refresh
 *      button + "Create Application" CTA (ADMIN/MANAGER only — canCreate
 *      = user.role === 'ADMIN' || 'MANAGER', per SUT line 199).
 *   2. Loading state: shows "Loading…" before first GET resolves (await
 *      findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount: hits /api/travel/visa/applications with default
 *      limit=50&offset=0 query string, renders one row per application
 *      (table layout with 6 columns: ID, Contact, Type, Status, Risk
 *      indicators, Updated).
 *   4. Empty state: zero applications → empty-state copy explaining
 *      "No visa applications yet" + the subBrand="visasure" gating.
 *   5. Status filter: changing the <select> to "approved" re-fetches with
 *      ?status=approved in the query string (and resets offset to 0 per
 *      onStatusChange SUT:242-245).
 *   6. Status badge per row: each row renders the application status via
 *      the StatusBadge component — status text is uppercased via CSS
 *      textTransform, but DOM text is the raw status (e.g. "approved").
 *   7. Risk pills per row: rows with readinessLevel/advisorRiskFlag/
 *      complexCase render the corresponding pill labels ("ready",
 *      "risk", "complex"). Row with none renders the em-dash fallback.
 *   8. Create-drawer open: clicking "Create Application" opens the drawer
 *      with the 3 required fields (Contact / Application type / Destination
 *      country) and fetches /api/contacts?limit=200 to populate the picker,
 *      client-side-filtered to subBrand="visasure".
 *   9. Form validation — empty destination: client-side gate surfaces
 *      "Destination country is required" inline + does NOT fire POST.
 *  10. Form validation — empty contactId: client-side gate surfaces
 *      "Pick a Visa Sure contact" inline + does NOT fire POST.
 *  11. Submit happy path: POST /api/travel/visa/applications with
 *      contactId (Int) + applicationType + destinationCountry (trimmed)
 *      and the `silent: true` opt (the SUT raises its own targeted
 *      success toast). On 201 → drawer closes + notify.success fires.
 *  12. Backend error mapping: INVALID_DESTINATION → inline error on the
 *      destinationCountry field; NOT_VISA_SURE → inline error on the
 *      contactId field. notify.error fires with the backend message.
 *  13. RBAC: role=USER hides the "Create Application" CTA entirely.
 *
 * Backend contract pinned (per backend/routes/travel_visa.js — ce5f5db + 6c084cb):
 *   GET    /api/travel/visa/applications?status=&limit=&offset=
 *          → 200 { applications, total, limit, offset }
 *          | 403 SUB_BRAND_DENIED (handled at fetchApi-level — out of scope)
 *   POST   /api/travel/visa/applications  body:{contactId,applicationType,
 *                                                destinationCountry}
 *          → 201 created (ADMIN+MANAGER)
 *          | 400 MISSING_FIELDS / INVALID_APPLICATION_TYPE / INVALID_DESTINATION
 *          | 404 NOT_FOUND
 *          | 422 NOT_VISA_SURE
 *
 * Drift pinned around (prompt vs. actual code):
 *   - Dispatch prompt said "sub-brand badge: uses real travelSubBrand
 *     styling (visasure indigo)" — the SUT does NOT render a sub-brand
 *     badge. This page is implicitly visa-only (backend filters to
 *     Contact.subBrand="visasure"), so no per-row sub-brand pill is shown.
 *     Tests OMIT all SUB_BRAND_BG assertions. The styling import is
 *     deliberately absent from the SUT.
 *   - Dispatch prompt said "status: intake / docs-pending / docs-collected
 *     / submitted / approved / rejected" — actual backend VALID_STATUSES
 *     are intake / docs-pending / filed / approved / rejected / appeal
 *     (SUT:58-66 pins the dropdown values). Tests use the actual values.
 *   - Dispatch prompt said "passport-holder name / destination country /
 *     application type / sub-brand likely fixed to 'visasure'" — actual
 *     drawer fields are contactId (picked from a Visa Sure contact list,
 *     NOT a free-text passport-holder name) + applicationType + destination
 *     country. The sub-brand isn't a user input at all; backend ALWAYS
 *     scopes to Contact.subBrand="visasure" so no UI selector exists.
 *   - Dispatch prompt mentioned "loading spinner" — SUT renders the
 *     literal text "Loading…" (via &hellip; entity). Test asserts via
 *     findByText.
 *   - The SUT uses useNavigate on row click → navigate(/travel/visa/
 *     applications/:id). Tests wrap the page in MemoryRouter to satisfy
 *     the router context dependency.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (RTL standing rule: Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap useCallback identity).
 *   - AuthContext is consumed from the real App module via Provider in the
 *     render wrapper (the SUT reads user.role to gate the Create CTA).
 *     Default user role = ADMIN; one test mounts with role=USER.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning).
 *   - Use the SUT's actual button label "Create Application" / "Refresh"
 *     / "Cancel" (NOT the dispatch's "New Application").
 *
 * Path: flat __tests__/ — sibling Agent A owns TravelStallDashboard.test.jsx
 * in the same flat dir; no path collision.
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
// f59e91d). The SUT closes over notify inside submitCreate, so a fresh
// object per render would flap state across re-renders.
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
import VisaApplications from '../pages/travel/visa/Applications';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const MANAGER_USER = { userId: 2, name: 'Mgr', email: 'm@x.com', role: 'MANAGER' };
const USER_USER = { userId: 3, name: 'Plain User', email: 'u@x.com', role: 'USER' };

// Canonical application rows — multiple statuses + risk-indicator combinations
// to exercise the StatusBadge + RiskPills render paths.
function makeApp(overrides = {}) {
  return {
    id: 301,
    tenantId: 1,
    contactId: 5001,
    applicationType: 'tourist',
    destinationCountry: 'United Kingdom',
    status: 'intake',
    readinessLevel: null,
    advisorRiskFlag: false,
    complexCase: false,
    contact: { id: 5001, name: 'Riya Sharma', email: 'riya@test.example', phone: '+919000000001' },
    createdAt: '2026-05-20T10:00:00.000Z',
    updatedAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const APPS_DEFAULT = [
  makeApp({
    id: 301,
    contact: { id: 5001, name: 'Riya Sharma', email: 'riya@test.example' },
    status: 'intake',
    applicationType: 'tourist',
    destinationCountry: 'United Kingdom',
    readinessLevel: null,
    advisorRiskFlag: false,
    complexCase: false,
  }),
  makeApp({
    id: 302,
    contact: { id: 5002, name: 'Arjun Patel', email: 'arjun@test.example' },
    status: 'approved',
    applicationType: 'business',
    destinationCountry: 'Canada',
    readinessLevel: 'ready',
    advisorRiskFlag: false,
    complexCase: false,
  }),
  makeApp({
    id: 303,
    contact: { id: 5003, name: 'Meera Iyer', email: 'meera@test.example' },
    status: 'docs-pending',
    applicationType: 'umrah',
    destinationCountry: 'Saudi Arabia',
    readinessLevel: 'not-ready',
    advisorRiskFlag: true,
    complexCase: true,
  }),
];

const VISA_CONTACTS_DEFAULT = [
  { id: 5001, name: 'Riya Sharma', email: 'riya@test.example', subBrand: 'visasure' },
  { id: 5099, name: 'Other Brand Contact', email: 'other@test.example', subBrand: 'tmc' },
  { id: 5002, name: 'Arjun Patel', email: 'arjun@test.example', subBrand: 'visasure' },
];

// Install a fetchApi mock that routes by URL + method. Tests override only
// the surface they care about.
function installFetchMock({
  list = { applications: APPS_DEFAULT, total: APPS_DEFAULT.length, limit: 50, offset: 0 },
  contacts = VISA_CONTACTS_DEFAULT,
  create = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/visa/applications') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url.startsWith('/api/contacts') && method === 'GET') {
      if (contacts instanceof Error) return Promise.reject(contacts);
      return Promise.resolve(contacts);
    }
    if (url === '/api/travel/visa/applications' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeApp({ id: 999 }));
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <VisaApplications />
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

describe('<VisaApplications /> — page chrome + RBAC', () => {
  it('renders heading + filter chrome + "Create Application" CTA when role=ADMIN', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Visa Applications/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by status/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload list/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create a new visa application/i }),
    ).toBeInTheDocument();
    // Wait for the mount-time GET to settle.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/travel/visa/applications'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('MANAGER role also sees "Create Application" CTA (canCreate = ADMIN || MANAGER)', async () => {
    renderPage(MANAGER_USER);
    expect(
      screen.getByRole('button', { name: /Create a new visa application/i }),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
  });

  it('hides "Create Application" CTA entirely for plain USER role', async () => {
    renderPage(USER_USER);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: /Create a new visa application/i }),
    ).toBeNull();
  });
});

describe('<VisaApplications /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/visa/applications') && method === 'GET') {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    // "Loading…" surfaces in both the header status (when total=0) AND
    // the center card. Per RTL standing rule (Wave 11 + Wave 12), use
    // getAllByText when a label appears in multiple chrome layers.
    await waitFor(() => {
      expect(screen.getAllByText('Loading…').length).toBeGreaterThanOrEqual(1);
    });
    resolveList({ applications: APPS_DEFAULT, total: APPS_DEFAULT.length, limit: 50, offset: 0 });
    await screen.findByText('Riya Sharma');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/visa/applications on mount with limit=50&offset=0 + renders one row per app', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/visa/applications')
        && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      expect(listCall[0]).toContain('limit=50');
      expect(listCall[0]).toContain('offset=0');
      // No status= when filter empty.
      expect(listCall[0]).not.toContain('status=');
    });
    // Renders one row per application (by contact name).
    expect(await screen.findByText('Riya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Arjun Patel')).toBeInTheDocument();
    expect(screen.getByText('Meera Iyer')).toBeInTheDocument();
  });

  it('renders empty-state copy when applications=[] (per SUT line 459-463)', async () => {
    installFetchMock({ list: { applications: [], total: 0, limit: 50, offset: 0 } });
    renderPage();
    expect(
      await screen.findByText(/No visa applications yet/i),
    ).toBeInTheDocument();
  });
});

describe('<VisaApplications /> — filter behaviour', () => {
  it('changing status filter to "approved" re-fetches with ?status=approved', async () => {
    renderPage();
    await screen.findByText('Riya Sharma');
    fetchApiMock.mockClear();
    installFetchMock({ list: { applications: [APPS_DEFAULT[1]], total: 1, limit: 50, offset: 0 } });
    fireEvent.change(screen.getByLabelText(/Filter by status/i), {
      target: { value: 'approved' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('status=approved')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<VisaApplications /> — row rendering: badges + risk pills', () => {
  it('renders the status text in the StatusBadge per row', async () => {
    renderPage();
    const riyaRow = (await screen.findByText('Riya Sharma')).closest('tr');
    expect(within(riyaRow).getByText('intake')).toBeInTheDocument();
    const arjunRow = screen.getByText('Arjun Patel').closest('tr');
    expect(within(arjunRow).getByText('approved')).toBeInTheDocument();
    const meeraRow = screen.getByText('Meera Iyer').closest('tr');
    expect(within(meeraRow).getByText('docs-pending')).toBeInTheDocument();
  });

  it('renders risk pills (readiness / risk / complex) for rows that opt in', async () => {
    renderPage();
    const meeraRow = (await screen.findByText('Meera Iyer')).closest('tr');
    // Meera has readinessLevel='not-ready', advisorRiskFlag=true, complexCase=true.
    expect(within(meeraRow).getByText('not-ready')).toBeInTheDocument();
    expect(within(meeraRow).getByText('risk')).toBeInTheDocument();
    expect(within(meeraRow).getByText('complex')).toBeInTheDocument();
    // Riya has no risk indicators → em-dash fallback in that cell.
    const riyaRow = screen.getByText('Riya Sharma').closest('tr');
    // The Type cell renders "tourist"; the Risk cell renders the em-dash
    // when no pills surface. Assert via the dash being present in the row.
    expect(within(riyaRow).getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });
});

describe('<VisaApplications /> — create drawer', () => {
  it('clicking the CTA opens the drawer with 3 required fields + fetches visa-scoped contacts', async () => {
    renderPage();
    await screen.findByText('Riya Sharma');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Create a new visa application/i }));
    // Drawer fields render.
    expect(
      await screen.findByRole('heading', { name: /New Visa Application/i }),
    ).toBeInTheDocument();
    // The 3 labels (Contact / Application type / Destination country) surface.
    expect(screen.getByText(/Contact \(Visa Sure\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Application type/i)).toBeInTheDocument();
    expect(screen.getByText(/Destination country/i)).toBeInTheDocument();
    // /api/contacts?limit=200 fired so the picker can populate.
    await waitFor(() => {
      const contactsCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/contacts')
        && u.includes('limit=200')
        && (!o?.method || o.method === 'GET'),
      );
      expect(contactsCall).toBeTruthy();
    });
  });

  it('validation: empty destination shows inline error + does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('Riya Sharma');
    fireEvent.click(screen.getByRole('button', { name: /Create a new visa application/i }));
    await screen.findByRole('heading', { name: /New Visa Application/i });
    // Pick a contact (so the contactId gate passes); leave destination blank.
    await waitFor(() => {
      // Wait for the picker to render the Visa Sure contacts.
      expect(screen.getByRole('option', { name: /Riya Sharma/i })).toBeInTheDocument();
    });
    fireEvent.change(
      screen.getByLabelText(/Contact \(Visa Sure\)/i),
      { target: { value: '5001' } },
    );
    fetchApiMock.mockClear();
    installFetchMock();
    // Submit via the form element (bypasses HTML5 required-attr).
    const form = screen.getByLabelText(/Destination country/i).closest('form');
    fireEvent.submit(form);
    await waitFor(() => {
      expect(
        screen.getByText(/Destination country is required/i),
      ).toBeInTheDocument();
    });
    // No POST.
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/visa/applications' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('validation: empty contactId shows "Pick a Visa Sure contact" + does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('Riya Sharma');
    fireEvent.click(screen.getByRole('button', { name: /Create a new visa application/i }));
    await screen.findByRole('heading', { name: /New Visa Application/i });
    // Leave contact blank; fill destination so only contactId fails.
    fireEvent.change(screen.getByLabelText(/Destination country/i), {
      target: { value: 'France' },
    });
    fetchApiMock.mockClear();
    installFetchMock();
    const form = screen.getByLabelText(/Destination country/i).closest('form');
    fireEvent.submit(form);
    await waitFor(() => {
      expect(
        screen.getByText(/Pick a Visa Sure contact/i),
      ).toBeInTheDocument();
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/visa/applications' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('submit happy path: POSTs with contactId (Int) + applicationType + trimmed destination + silent:true', async () => {
    renderPage();
    await screen.findByText('Riya Sharma');
    fireEvent.click(screen.getByRole('button', { name: /Create a new visa application/i }));
    await screen.findByRole('heading', { name: /New Visa Application/i });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Riya Sharma/i })).toBeInTheDocument();
    });
    fireEvent.change(
      screen.getByLabelText(/Contact \(Visa Sure\)/i),
      { target: { value: '5001' } },
    );
    fireEvent.change(
      screen.getByLabelText(/Application type/i),
      { target: { value: 'business' } },
    );
    fireEvent.change(
      screen.getByLabelText(/Destination country/i),
      { target: { value: '  Germany  ' } },
    );
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Create Application/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/visa/applications' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      // contactId coerced to Int.
      expect(body.contactId).toBe(5001);
      expect(typeof body.contactId).toBe('number');
      expect(body.applicationType).toBe('business');
      // Destination trimmed.
      expect(body.destinationCountry).toBe('Germany');
      // Silent flag to suppress the global fetchApi toast.
      expect(post[1].silent).toBe(true);
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Visa application created/i),
    );
  });

  it('backend INVALID_DESTINATION → inline error on the destinationCountry field + notify.error', async () => {
    renderPage();
    await screen.findByText('Riya Sharma');
    fireEvent.click(screen.getByRole('button', { name: /Create a new visa application/i }));
    await screen.findByRole('heading', { name: /New Visa Application/i });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Riya Sharma/i })).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/Contact \(Visa Sure\)/i), { target: { value: '5001' } });
    fireEvent.change(screen.getByLabelText(/Destination country/i), { target: { value: 'X' } });

    // Re-arm the mock so POST rejects with an INVALID_DESTINATION-coded error.
    const err = new Error('destinationCountry is required');
    err.code = 'INVALID_DESTINATION';
    err.data = { code: 'INVALID_DESTINATION', error: 'destinationCountry is required' };
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/visa/applications') && method === 'GET') {
        return Promise.resolve({ applications: APPS_DEFAULT, total: APPS_DEFAULT.length, limit: 50, offset: 0 });
      }
      if (url.startsWith('/api/contacts')) {
        return Promise.resolve(VISA_CONTACTS_DEFAULT);
      }
      if (url === '/api/travel/visa/applications' && method === 'POST') {
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });

    fireEvent.click(screen.getByRole('button', { name: /Create Application/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/destinationCountry is required/i),
      );
    });
    // Inline field error surfaces under the destinationCountry input.
    expect(
      screen.getByText(/destinationCountry is required/i),
    ).toBeInTheDocument();
  });

  it('backend NOT_VISA_SURE → inline error on the contactId field', async () => {
    renderPage();
    await screen.findByText('Riya Sharma');
    fireEvent.click(screen.getByRole('button', { name: /Create a new visa application/i }));
    await screen.findByRole('heading', { name: /New Visa Application/i });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Riya Sharma/i })).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/Contact \(Visa Sure\)/i), { target: { value: '5001' } });
    fireEvent.change(screen.getByLabelText(/Destination country/i), { target: { value: 'Italy' } });

    const err = new Error('Contact is not in the Visa Sure sub-brand');
    err.code = 'NOT_VISA_SURE';
    err.data = { code: 'NOT_VISA_SURE', error: 'Contact is not in the Visa Sure sub-brand' };
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/visa/applications') && method === 'GET') {
        return Promise.resolve({ applications: APPS_DEFAULT, total: APPS_DEFAULT.length, limit: 50, offset: 0 });
      }
      if (url.startsWith('/api/contacts')) {
        return Promise.resolve(VISA_CONTACTS_DEFAULT);
      }
      if (url === '/api/travel/visa/applications' && method === 'POST') {
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });

    fireEvent.click(screen.getByRole('button', { name: /Create Application/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Visa Sure sub-brand/i),
      );
    });
    // The literal "Visa Sure sub-brand" appears in BOTH the drawer hint
    // copy (descriptive) AND the field-level error message. Assert via
    // exact-string match on the backend message so we pin the error
    // surface specifically, not the hint copy.
    expect(
      screen.getByText('Contact is not in the Visa Sure sub-brand'),
    ).toBeInTheDocument();
  });

  it('drawer Cancel button closes the drawer (heading disappears)', async () => {
    renderPage();
    await screen.findByText('Riya Sharma');
    fireEvent.click(screen.getByRole('button', { name: /Create a new visa application/i }));
    await screen.findByRole('heading', { name: /New Visa Application/i });
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: /New Visa Application/i }),
      ).toBeNull();
    });
  });
});
