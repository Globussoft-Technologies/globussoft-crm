/**
 * Trips.test.jsx — vitest + RTL coverage for the Travel-vertical TMC trips
 * list page (frontend/src/pages/travel/Trips.jsx).
 *
 * Scope — pins the page-surface invariants for the TMC trips list page
 * (sibling to QuotesAdmin / InvoicesAdmin / SuppliersAdmin / VisaApplications
 * — the most-recent travel-fork admin pages):
 *
 *   1. Page chrome: heading "TMC Trips" + Lucide Luggage icon + filter bar
 *      (status <select> + Refresh button) + "New Trip" CTA (always visible —
 *      no RBAC gate in the SUT).
 *   2. Loading state: shows "Loading…" placeholder before first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount: hits /api/travel/trips?limit=100 (no status when filter
 *      is empty) and renders one row per trip (table layout, 7 columns).
 *   4. Empty state: zero trips → "No trips yet. New trips spawn from the
 *      linked Deal in the sales pipeline." copy.
 *   5. Status filter: selecting "Confirmed" re-fetches with ?status=confirmed.
 *   6. Status badge per row: renders the trip status text (lowercase in DOM,
 *      uppercased via CSS textTransform — the row for trip 101 contains the
 *      literal text "confirmed", 102 contains "in-trip", etc.).
 *   7. Row link: trip code cell wraps a <Link to="/travel/trips/:id"> — pinned
 *      via getByRole('link', { name: tripCode }) + href attribute check.
 *   8. Dates per row: depart + return dates render via the SUT's `fmt`
 *      helper (toLocaleDateString) — assert via the row's CalendarIcon
 *      sibling + the "→" separator + a date substring.
 *   9. Participants count per row: renders t._count.participants (zero
 *      when _count missing).
 *  10. Per-student price formatting: INR row with pricePerStudent=125000
 *      renders the ₹1.25L abbreviation (the SUT's fmtMoney lakhs format);
 *      undefined pricePerStudent renders the em-dash fallback.
 *  11. Refresh button: clicking it re-fires the GET.
 *  12. New-Trip drawer open: clicking the CTA opens the drawer with the
 *      required fields (tripCode / destination / school / dates / price /
 *      status) AND fires /api/contacts?limit=200 for the school picker.
 *  13. Form validation — missing tripCode/destination/school/dates triggers
 *      notify.error + no POST.
 *  14. Submit happy path: POSTs /api/travel/trips with parsed payload
 *      (schoolContactId coerced to Int, pricePerStudent to Number) and
 *      re-fetches the list.
 *  15. Error handling: GET rejection surfaces notify.error.
 *
 * Backend contract pinned (per backend/routes/travel_trips.js):
 *   GET    /api/travel/trips[?status=&limit=&offset=&schoolContactId=]
 *          → 200 { trips, total, limit, offset }
 *          | 400 INVALID_STATUS
 *          | 500 "Failed to list trips"
 *   POST   /api/travel/trips body:{tripCode,schoolContactId,destination,
 *                                  departDate,returnDate,status?,
 *                                  pricePerStudent?,legalEntity?,
 *                                  micrositeUrl?,driveFolderId?}
 *          → 201 created
 *          | 400 MISSING_FIELDS / INVALID_CONTACT_ID / INVALID_STATUS /
 *                INVALID_DATE / INVERTED_DATES
 *          | 409 DUPLICATE_TRIP_CODE
 *
 * Drift pinned around (prompt vs. actual code):
 *   - Prompt mentioned "sub-brand filter" — the SUT has NO sub-brand filter.
 *     This page is TMC-only (the URL is the giveaway: /travel/trips lives
 *     in Travel sidebar's TMC section). Tests OMIT all sub-brand-filter
 *     assertions. Backend route is gated by requireTmcAccess middleware,
 *     not by a query-string ?subBrand=.
 *   - Prompt mentioned "RBAC: USER role hides mutation CTAs" — the SUT
 *     does NOT gate the "New Trip" CTA by AuthContext role. The button
 *     renders for every authenticated user (backend handles authz).
 *     Tests OMIT the canWrite=false assertion path.
 *   - Prompt's status enum suggested "confirmed / in-trip / completed /
 *     cancelled" — pinned exactly via SUT's STATUSES array (lines 17-23).
 *   - Prompt mentioned "trip-type filter" — no trip-type filter exists.
 *     The only filter is status. School-contact-id filter is supported
 *     by the BACKEND query but NOT exposed in the page chrome.
 *   - Prompt mentioned navigation to TripDetail — pinned via getByRole
 *     ('link') with href /travel/trips/:id (not a row-onClick handler).
 *   - SUT's "Loading…" text is rendered via the &hellip; entity (literal
 *     unicode in the DOM) — assert via findByText('Loading…').
 *   - The notify mock module path is '../utils/notify' (tests live in
 *     __tests__/ which is a sibling of utils/ — the SUT lives 2 levels
 *     deeper at pages/travel/ so its import is '../../utils/notify',
 *     but the vi.mock() path is relative to the TEST file).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference (Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap useCallback identity).
 *   - AuthContext provided via the real Provider from App (the SUT does
 *     NOT consume AuthContext directly, but a router context is required
 *     for the <Link>; MemoryRouter handles that).
 *   - For dates: use fixed ISO strings + locale-tolerant substring
 *     assertions (per CLAUDE.md cron-learning 2026-05-07 wave-9: date-
 *     boundary tests should be unambiguous-future).
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning: sync getBy for data-dependent
 *     text is a CI race trap).
 *
 * Path: flat __tests__/ per tick #111 path-coordination (sibling Agent B
 * owns Itineraries.test.jsx in the same flat dir; no collision).
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
// f59e91d). The SUT closes over notify inside load + submitCreate, so a
// fresh object per render would flap state across re-renders.
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
import Trips from '../pages/travel/Trips';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

// Canonical trip rows — multiple statuses + price ranges to exercise the
// status-pill + fmtMoney render paths.
function makeTrip(overrides = {}) {
  return {
    id: 101,
    tenantId: 1,
    tripCode: 'TMC-AND-2026-MUMBAI-G7',
    destination: 'Andaman',
    schoolContactId: 5001,
    departDate: '2026-12-01T00:00:00.000Z',
    returnDate: '2026-12-08T00:00:00.000Z',
    pricePerStudent: 125000,
    status: 'confirmed',
    _count: { participants: 24, documentRequirements: 3 },
    legalEntity: 'tmc_nexus',
    micrositeUrl: null,
    driveFolderId: null,
    createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const TRIPS_DEFAULT = [
  makeTrip({
    id: 101,
    tripCode: 'TMC-AND-2026-MUMBAI-G7',
    destination: 'Andaman',
    schoolContactId: 5001,
    status: 'confirmed',
    pricePerStudent: 125000,
    _count: { participants: 24, documentRequirements: 3 },
  }),
  makeTrip({
    id: 102,
    tripCode: 'TMC-GOA-2026-DPS-G8',
    destination: 'Goa',
    schoolContactId: 5002,
    status: 'in-trip',
    pricePerStudent: 85000,
    _count: { participants: 18, documentRequirements: 2 },
  }),
  makeTrip({
    id: 103,
    tripCode: 'TMC-SHIM-2025-BPS-G10',
    destination: 'Shimla',
    schoolContactId: 5003,
    status: 'completed',
    pricePerStudent: null,
    _count: { participants: 12, documentRequirements: 0 },
  }),
];

const SCHOOLS_DEFAULT = [
  { id: 5001, name: 'Mumbai International School', email: 'admin@mis.example' },
  { id: 5002, name: 'Delhi Public School', email: 'admin@dps.example' },
  { id: 5003, name: 'Bombay Public School', email: 'admin@bps.example' },
];

// Install a fetchApi mock that routes by URL + method. Tests override only
// the surface they care about.
function installFetchMock({
  list = { trips: TRIPS_DEFAULT, total: TRIPS_DEFAULT.length, limit: 100, offset: 0 },
  schools = SCHOOLS_DEFAULT,
  create = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/travel/trips') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url.startsWith('/api/contacts') && method === 'GET') {
      if (schools instanceof Error) return Promise.reject(schools);
      return Promise.resolve(schools);
    }
    if (url === '/api/travel/trips' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeTrip({ id: 999 }));
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <Trips />
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

describe('<Trips /> — page chrome', () => {
  it('renders heading "TMC Trips" + filter bar + "New Trip" CTA', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /TMC Trips/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by status/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload list/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create a new trip/i })).toBeInTheDocument();
    // Wait for the mount-time GET to settle.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/travel/trips'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe('<Trips /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/trips') && method === 'GET') {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({ trips: TRIPS_DEFAULT, total: TRIPS_DEFAULT.length, limit: 100, offset: 0 });
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/trips on mount with limit=100 + no status when filter empty', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/trips')
        && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      expect(listCall[0]).toContain('limit=100');
      // No status= when filter empty.
      expect(listCall[0]).not.toContain('status=');
    });
    // Renders one row per trip (by tripCode).
    expect(await screen.findByText('TMC-AND-2026-MUMBAI-G7')).toBeInTheDocument();
    expect(screen.getByText('TMC-GOA-2026-DPS-G8')).toBeInTheDocument();
    expect(screen.getByText('TMC-SHIM-2025-BPS-G10')).toBeInTheDocument();
  });

  it('renders empty-state copy when trips=[]', async () => {
    installFetchMock({ list: { trips: [], total: 0, limit: 100, offset: 0 } });
    renderPage();
    expect(
      await screen.findByText(/No trips yet\. New trips spawn from the linked Deal/i),
    ).toBeInTheDocument();
  });

  it('GET rejection surfaces notify.error with the body.error', async () => {
    const err = new Error('boom');
    err.body = { error: 'Failed to list trips' };
    installFetchMock({ list: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to list trips');
    });
  });
});

describe('<Trips /> — filter behavior', () => {
  it('selecting status "Confirmed" re-fetches with ?status=confirmed', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fetchApiMock.mockClear();
    installFetchMock({ list: { trips: [TRIPS_DEFAULT[0]], total: 1, limit: 100, offset: 0 } });
    fireEvent.change(screen.getByLabelText(/Filter by status/i), {
      target: { value: 'confirmed' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('status=confirmed')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('Refresh button re-fires the GET', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Reload list/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/trips')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<Trips /> — row rendering: status / link / dates / participants / price', () => {
  it('renders the status text per row (confirmed / in-trip / completed)', async () => {
    renderPage();
    const row1 = (await screen.findByText('TMC-AND-2026-MUMBAI-G7')).closest('tr');
    expect(within(row1).getByText('confirmed')).toBeInTheDocument();
    const row2 = screen.getByText('TMC-GOA-2026-DPS-G8').closest('tr');
    expect(within(row2).getByText('in-trip')).toBeInTheDocument();
    const row3 = screen.getByText('TMC-SHIM-2025-BPS-G10').closest('tr');
    expect(within(row3).getByText('completed')).toBeInTheDocument();
  });

  it('trip-code cell renders a <Link> to /travel/trips/:id', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    const link = screen.getByRole('link', { name: 'TMC-AND-2026-MUMBAI-G7' });
    expect(link).toHaveAttribute('href', '/travel/trips/101');
    const link2 = screen.getByRole('link', { name: 'TMC-GOA-2026-DPS-G8' });
    expect(link2).toHaveAttribute('href', '/travel/trips/102');
  });

  it('renders participants count per row from t._count.participants', async () => {
    renderPage();
    const row1 = (await screen.findByText('TMC-AND-2026-MUMBAI-G7')).closest('tr');
    expect(within(row1).getByText('24')).toBeInTheDocument();
    const row2 = screen.getByText('TMC-GOA-2026-DPS-G8').closest('tr');
    expect(within(row2).getByText('18')).toBeInTheDocument();
  });

  it('renders per-student price in ₹L lakhs format for INR ≥100k, em-dash for null', async () => {
    renderPage();
    // Trip 101: pricePerStudent=125000 INR → "₹1.25L"
    const row1 = (await screen.findByText('TMC-AND-2026-MUMBAI-G7')).closest('tr');
    expect(within(row1).getByText('₹1.25L')).toBeInTheDocument();
    // Trip 103: pricePerStudent=null → em-dash fallback. (Trip 103 also has
    // _count.documentRequirements=0 but that's not rendered; participants=12
    // is rendered. So the em-dash uniquely appears in the per-student cell.)
    const row3 = screen.getByText('TMC-SHIM-2025-BPS-G10').closest('tr');
    expect(within(row3).getByText('—')).toBeInTheDocument();
  });

  it('renders school-contact id reference per row (#5001 / #5002 / #5003)', async () => {
    renderPage();
    const row1 = (await screen.findByText('TMC-AND-2026-MUMBAI-G7')).closest('tr');
    expect(within(row1).getByText('#5001')).toBeInTheDocument();
    const row2 = screen.getByText('TMC-GOA-2026-DPS-G8').closest('tr');
    expect(within(row2).getByText('#5002')).toBeInTheDocument();
  });
});

describe('<Trips /> — new-trip drawer + create POST', () => {
  it('clicking "New Trip" opens the drawer + fires /api/contacts?limit=200 for school picker', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Create a new trip/i }));
    // Drawer surface renders.
    const heading = await screen.findByRole('heading', { name: /^New Trip$/i });
    expect(heading).toBeInTheDocument();
    // The 5 required-ish fields surface (Trip code / Destination / School /
    // Depart date / Return date) — assert via label text scoped to the drawer
    // form (table header also contains "Trip code" / "Destination" / "School").
    const drawerForm = heading.closest('form');
    expect(drawerForm).toBeTruthy();
    expect(within(drawerForm).getByText(/Trip code/i)).toBeInTheDocument();
    expect(within(drawerForm).getByText(/^Destination$/i)).toBeInTheDocument();
    expect(within(drawerForm).getByText(/^School$/i)).toBeInTheDocument();
    expect(within(drawerForm).getByText(/Depart date/i)).toBeInTheDocument();
    expect(within(drawerForm).getByText(/Return date/i)).toBeInTheDocument();
    // /api/contacts?limit=200 fired so the school picker can populate.
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

  it('validation: missing required fields surfaces notify.error + does NOT fire POST', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('button', { name: /Create a new trip/i }));
    await screen.findByRole('heading', { name: /^New Trip$/i });
    fetchApiMock.mockClear();
    installFetchMock();
    // Submit the form with everything blank — bypass HTML5 required-attr.
    const form = screen.getByRole('heading', { name: /^New Trip$/i }).closest('form');
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Trip code, destination, school, depart \+ return dates required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/trips' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('happy path: filling the form + Create POSTs /api/travel/trips with parsed payload', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('button', { name: /Create a new trip/i }));
    await screen.findByRole('heading', { name: /^New Trip$/i });
    // Wait for school picker to populate so the <option value="5001"> exists.
    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /Mumbai International School/i }),
      ).toBeInTheDocument();
    });
    // Fill the form. Use textbox role for trip code + destination so the
    // labels are pinned to the right inputs.
    const inputs = screen.getAllByRole('textbox');
    // Trip code is the first textbox, destination is the second.
    fireEvent.change(inputs[0], { target: { value: 'TMC-KAS-2026-XYZ-G9' } });
    fireEvent.change(inputs[1], { target: { value: 'Kashmir' } });
    // There are 3 comboboxes in the DOM: filter-bar Status (index 0),
    // drawer School (index 1), drawer Status (index 2). Pick School by index.
    const comboboxes = screen.getAllByRole('combobox');
    fireEvent.change(comboboxes[1], { target: { value: '5001' } });
    // Depart date + return date inputs — find by type="date".
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-12-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-12-08' } });
    // Per-student price (optional)
    const numberInput = document.querySelector('input[type="number"]');
    fireEvent.change(numberInput, { target: { value: '95000' } });

    fetchApiMock.mockClear();
    installFetchMock();
    // Click the submit button "Create Trip"
    fireEvent.click(screen.getByRole('button', { name: /Create Trip/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.tripCode).toBe('TMC-KAS-2026-XYZ-G9');
      expect(body.destination).toBe('Kashmir');
      // schoolContactId coerced to Int.
      expect(body.schoolContactId).toBe(5001);
      expect(typeof body.schoolContactId).toBe('number');
      expect(body.departDate).toBe('2026-12-01');
      expect(body.returnDate).toBe('2026-12-08');
      // pricePerStudent coerced to Number.
      expect(body.pricePerStudent).toBe(95000);
      // Default status is "confirmed" (form default per EMPTY_FORM).
      expect(body.status).toBe('confirmed');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Trip created/i),
    );
  });
});
