/**
 * Trips.test.jsx — vitest + RTL coverage for the Travel-vertical TMC trips
 * list page (frontend/src/pages/travel/Trips.jsx).
 *
 * Scope — pins the page-surface invariants for the TMC trips list page
 * (sibling to QuotesAdmin / InvoicesAdmin / SuppliersAdmin / VisaApplications
 * — the most-recent travel-fork admin pages):
 *
 *   1. Page chrome: heading "TMC Trips" + Lucide Luggage icon + filter bar
 *      an expandable multi-field filter panel, Refresh button, and "New Trip" CTA
 *      (always visible — no RBAC gate in the SUT).
 *   2. Loading state: shows "Loading…" placeholder before first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount renders one row per trip with the full 12-column table.
 *   4. Empty state: zero trips → "No trips yet. New trips spawn from the
 *      linked Deal in the sales pipeline." copy.
 *   5. Filter panel: trip family, trip type, status, and departure-date range
 *      can be combined and re-fetch with their query parameters after Apply.
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
 *                                  driveFolderId?}
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
 *   - Trip family, trip type, and status are the selectable filters.
 *     Search remains separate and covers trip code or destination.
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
    perStudentAmount: 125000,
    currency: 'INR',
    status: 'confirmed',
    _count: { participants: 24, documentRequirements: 3 },
    legalEntity: 'tmc_nexus',
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
    perStudentAmount: 125000,
    _count: { participants: 24, documentRequirements: 3 },
  }),
  makeTrip({
    id: 102,
    tripCode: 'TMC-GOA-2026-DPS-G8',
    destination: 'Goa',
    schoolContactId: 5002,
    status: 'in-trip',
    perStudentAmount: 85000,
    _count: { participants: 18, documentRequirements: 2 },
  }),
  makeTrip({
    id: 103,
    tripCode: 'TMC-SHIM-2025-BPS-G10',
    destination: 'Shimla',
    schoolContactId: 5003,
    status: 'completed',
    perStudentAmount: null,
    _count: { participants: 12, documentRequirements: 0 },
  }),
];

function makeTrips(count, startId = 201) {
  return Array.from({ length: count }, (_, i) =>
    makeTrip({
      id: startId + i,
      tripCode: `TMC-PAGE-${String(i + 1).padStart(2, '0')}`,
      destination: `Destination ${i + 1}`,
      schoolContactId: 6000 + i,
      status: i % 4 === 0
        ? 'confirmed'
        : i % 4 === 1
          ? 'in-trip'
          : i % 4 === 2
            ? 'completed'
            : 'cancelled',
      perStudentAmount: 50000 + i * 1000,
      _count: { participants: 10 + i, documentRequirements: i % 3 },
    }),
  );
}

const SCHOOLS_DEFAULT = [
  { id: 5001, name: 'Mumbai International School', email: 'admin@mis.example' },
  { id: 5002, name: 'Delhi Public School', email: 'admin@dps.example' },
  { id: 5003, name: 'Bombay Public School', email: 'admin@bps.example' },
];

// Install a fetchApi mock that routes by URL + method. Tests override only
// the surface they care about.
function installFetchMock({
  list = { trips: TRIPS_DEFAULT, total: TRIPS_DEFAULT.length, limit: 20, offset: 0 },
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

function renderPage(user = ADMIN_USER, initialEntries = ['/travel/trips']) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter initialEntries={initialEntries}>
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
  it('shows Back to reports when opened from Reports and preserves the status query', async () => {
    renderPage(ADMIN_USER, ['/travel/trips?status=confirmed&from=reports']);
    expect(screen.getByRole('link', { name: /Back to reports/i })).toHaveAttribute('href', '/travel/reports');
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('status=confirmed')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('renders heading "TMC Trips" + filter bar + "New Trip" CTA', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /TMC Trips/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Search trips/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Filter trips/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Filter by status/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload list/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create a new trip/i })).toBeInTheDocument();
    // Wait for the mount-time GET to settle.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/travel/trips'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      const badge = screen.getByText((_, node) => {
        const text = node?.textContent?.replace(/\s+/g, " ").trim();
        return text === `${TRIPS_DEFAULT.length} Total Trips`;
      });
      expect(badge).toBeInTheDocument();
    });
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('<Trips /> — resizable trip table', () => {
  it('uses default widths and keeps the Trip Code column marked as frozen', async () => {
    renderPage();
    const table = await screen.findByRole('table');

    expect(Array.from(table.querySelectorAll('col')).map((column) => column.style.width)).toEqual([
      '190px', '210px', '280px', '120px', '150px', '240px',
      '250px', '150px', '145px', '160px', '120px', '140px',
    ]);
    expect(table.style.borderCollapse).toBe('separate');
    expect(table.querySelector('thead th:first-child')).toHaveClass('travel-trips-table__trip-code-header');
    expect(table.querySelector('tbody tr td:first-child')).toHaveClass('travel-trips-table__trip-code-cell');
    expect(within(table).getByRole('columnheader', { name: 'Actions' })).toHaveTextContent('Actions');
    expect(Array.from(table.querySelectorAll('thead th')).every((header) => header.style.textAlign === 'left')).toBe(true);
    expect(table.querySelector('tbody tr td:last-child').style.textAlign).toBe('left');
    expect(within(table).getAllByRole('button', { name: /^Sort / }).every((button) => button.classList.contains('travel-trips-table__sort-button'))).toBe(true);
    expect(screen.getAllByRole('separator', { name: /^Resize .* column$/ })).toHaveLength(12);

    const scrollSync = table.closest('.top-scroll-sync');
    const horizontalScrollbar = scrollSync.querySelector('.top-scroll-sync__detached-bottom');
    expect(horizontalScrollbar.style.marginLeft).toBe('190px');
    expect(horizontalScrollbar.style.width).toBe('calc(100% - 190px)');
    expect(horizontalScrollbar.firstElementChild.style.width).toBe('1965px');
    const tableViewport = scrollSync.querySelector('.travel-trips-table-viewport');
    expect(tableViewport).toHaveClass('top-scroll-sync__bottom--hidden-horizontal-scrollbar');
    expect(tableViewport.style.overflowX).toBe('hidden');
    expect(tableViewport.style.overflowY).toBe('auto');
    expect(tableViewport.style.scrollbarWidth).toBe('auto');
  });

  it('limits Trip Code resizing while other columns can grow and collapse to their minimum', async () => {
    renderPage();
    const table = await screen.findByRole('table');
    const viewport = table.closest('.travel-trips-table-viewport');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 1200 });
    const [tripCodeColumn, familyColumn] = table.querySelectorAll('col');
    const tripCodeHandle = screen.getByRole('separator', { name: 'Resize Trip code column' });
    const familyHandle = screen.getByRole('separator', { name: 'Resize Trip family column' });

    fireEvent.pointerDown(tripCodeHandle, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 1000 });
    fireEvent.pointerUp(window);
    expect(tripCodeColumn.style.width).toBe('600px');

    fireEvent.pointerDown(tripCodeHandle, { button: 0, clientX: 1000 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window);
    expect(tripCodeColumn.style.width).toBe('150px');

    fireEvent.pointerDown(familyHandle, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 900 });
    fireEvent.pointerUp(window);
    expect(familyColumn.style.width).toBe('1010px');

    fireEvent.pointerDown(familyHandle, { button: 0, clientX: 900 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window);
    expect(familyColumn.style.width).toBe('120px');
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
    resolveList({ trips: TRIPS_DEFAULT, total: TRIPS_DEFAULT.length, limit: 20, offset: 0 });
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/trips on mount with limit=20, offset=0, and no status when filter empty', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/trips')
        && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      expect(listCall[0]).toContain('limit=20');
      expect(listCall[0]).toContain('offset=0');
      expect(listCall[0]).not.toContain('status=');
      expect(listCall[0]).not.toContain('search=');
    });
    expect(await screen.findByText('TMC-AND-2026-MUMBAI-G7')).toBeInTheDocument();
    expect(screen.getByText('TMC-GOA-2026-DPS-G8')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'TMC-GOA-2026-DPS-G8' }))
      .toHaveAttribute('title', 'TMC-GOA-2026-DPS-G8');
    expect(screen.getByText('TMC-SHIM-2025-BPS-G10')).toBeInTheDocument();
  });

  it('renders synced top and bottom horizontal scrollbars for the table', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');

    const table = screen.getByRole('table');
    const topScroll = document.querySelector('.top-scroll-sync__top');
    const bottomScroll = document.querySelector('.top-scroll-sync__bottom');

    expect(table.style.width).toBe('100%');
    expect(table.style.minWidth).toBe('1900px');
    expect(table.style.tableLayout).toBe('fixed');
    expect(topScroll).toBeTruthy();
    expect(bottomScroll).toBeTruthy();
    expect(topScroll.style.overflowX).toBe('scroll');
    expect(topScroll.style.overflowY).toBe('hidden');
    expect(bottomScroll.style.overflowX).toBe('scroll');
    expect(table.querySelectorAll('col').length).toBe(12);
  });

  it('renders empty-state copy when trips=[]', async () => {
    installFetchMock({ list: { trips: [], total: 0, limit: 20, offset: 0 } });
    renderPage();
    expect(await screen.findByText(/No trips yet. New trips spawn from the linked Deal/i)).toBeInTheDocument();
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
    installFetchMock({ list: { trips: [TRIPS_DEFAULT[0]], total: 1, limit: 20, offset: 0 } });
    fireEvent.click(screen.getByRole('button', { name: /Filter trips/i }));
    fireEvent.click(screen.getByLabelText(/Filter by status/i));
    fireEvent.click(screen.getByLabelText('Confirmed'));
    fireEvent.click(screen.getByRole('button', { name: /Apply filters/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('status=confirmed')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('applies trip family, type, status, and departure dates together', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fetchApiMock.mockClear();
    installFetchMock({ list: { trips: [TRIPS_DEFAULT[0]], total: 1, limit: 20, offset: 0 } });

    fireEvent.click(screen.getByRole('button', { name: /Filter trips/i }));
    const filterPanel = screen.getByRole('region', { name: /Trip filters/i });
    expect(filterPanel).toHaveStyle({ position: 'relative' });
    expect(filterPanel.nextElementSibling).toHaveClass('travel-trips-page__table-card');
    expect(filterPanel.querySelectorAll('[role="group"]')).toHaveLength(3);
    expect(filterPanel.querySelectorAll('input[type="date"]')).toHaveLength(2);
    fireEvent.click(screen.getByLabelText(/Filter by trip family/i));
    fireEvent.click(screen.getByLabelText('Primary'));
    fireEvent.click(screen.getByLabelText('Variant'));
    fireEvent.click(screen.getByLabelText(/Filter by trip type/i));
    fireEvent.click(screen.getByLabelText('International'));
    fireEvent.click(screen.getByLabelText('Domestic'));
    fireEvent.click(screen.getByLabelText(/Filter by status/i));
    fireEvent.click(screen.getByLabelText('Confirmed'));
    fireEvent.click(screen.getByLabelText('Completed'));
    fireEvent.change(screen.getByLabelText(/Depart from/i), {
      target: { value: '2027-02-01' },
    });
    fireEvent.change(screen.getByLabelText(/Depart to/i), {
      target: { value: '2027-02-28' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Apply filters/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url, options]) => {
        if (typeof url !== 'string' || !url.startsWith('/api/travel/trips') || (options?.method && options.method !== 'GET')) return false;
        const params = new URL(`http://local${url}`).searchParams;
        return params.getAll('family').join(',') === 'primary,variant'
          && params.getAll('tripType').join(',') === 'international,domestic'
          && params.getAll('status').join(',') === 'confirmed,completed'
          && params.get('departFrom') === '2027-02-01'
          && params.get('departTo') === '2027-02-28';
      });
      expect(call).toBeTruthy();
    });
  });

  it('rejects a departure range where Depart from is after Depart to', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('button', { name: /Filter trips/i }));

    const departFrom = screen.getByLabelText(/Depart from/i);
    const departTo = screen.getByLabelText(/Depart to/i);
    fireEvent.change(departFrom, { target: { value: '2027-02-28' } });
    fireEvent.change(departTo, { target: { value: '2027-02-01' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/Depart from must be on or before Depart to/i);
    expect(departFrom).toHaveAttribute('max', '2027-02-01');
    expect(departTo).toHaveAttribute('min', '2027-02-28');
    expect(screen.getByRole('button', { name: /Apply filters/i })).toBeDisabled();
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
    expect(within(row1).getByText('confirmed')).toHaveAttribute('data-status', 'confirmed');
    expect(within(row1).getByText('international')).toHaveAttribute('data-type', 'international');
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

  it('renders trip-family membership in a dedicated column instead of a trip-code subtitle', async () => {
    const primary = makeTrip({
      id: 201,
      tripCode: 'TMC-GROUP-PRIMARY',
      _count: { participants: 5, documentRequirements: 1, familyVariants: 1 },
    });
    const variant = makeTrip({
      id: 202,
      tripCode: 'TMC-GROUP-VARIANT',
      _count: { participants: 3, documentRequirements: 1, familyVariants: 0 },
      familyParent: {
        id: primary.id,
        tripCode: primary.tripCode,
        destination: primary.destination,
      },
    });
    installFetchMock({
      list: { trips: [variant, primary], total: 2, limit: 20, offset: 0 },
    });
    renderPage();

    await screen.findByText(primary.tripCode);
    const primaryRow = screen
      .getAllByRole('link', { name: primary.tripCode })
      .map((link) => link.closest('tr'))
      .find((row) => row?.querySelector('td')?.textContent.includes(primary.tripCode));
    expect(within(primaryRow).getByText('Primary')).toBeInTheDocument();
    expect(within(primaryRow).getByText('1 school variant')).toBeInTheDocument();
    expect(within(primaryRow).getByRole('link', { name: primary.tripCode }))
      .toHaveAttribute('href', `/travel/trips/${primary.id}`);

    fireEvent.click(within(primaryRow).getByRole('button', {
      name: `Expand variants for ${primary.tripCode}`,
    }));
    const variantRow = (await screen.findByText(variant.tripCode)).closest('tr');
    expect(within(variantRow).getByText('Variant')).toBeInTheDocument();
    expect(within(variantRow).getByText(primary.tripCode)).toBeInTheDocument();
    expect(within(variantRow.querySelector('td')).queryByText(/Variant of/i)).not.toBeInTheDocument();

    fireEvent.click(within(primaryRow).getByRole('button', {
      name: `Collapse variants for ${primary.tripCode}`,
    }));
    await waitFor(() => {
      expect(screen.queryByText(variant.tripCode)).not.toBeInTheDocument();
    });
  });

  it('renders the date range with a dash separator', async () => {
    renderPage();
    const row1 = (await screen.findByText('TMC-AND-2026-MUMBAI-G7')).closest('tr');
    const departDate = new Date(TRIPS_DEFAULT[0].departDate).toLocaleDateString();
    const returnDate = new Date(TRIPS_DEFAULT[0].returnDate).toLocaleDateString();

    expect(row1.textContent).toContain(`${departDate} – ${returnDate}`);
    expect(row1.textContent).not.toContain(`${departDate} ? ${returnDate}`);
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
    expect(within(row1).getByText('School #5001')).toBeInTheDocument();
    const row2 = screen.getByText('TMC-GOA-2026-DPS-G8').closest('tr');
    expect(within(row2).getByText('School #5002')).toBeInTheDocument();
  });

  it('renders the API-provided order so the newest trip stays at the top', async () => {
    const newestTrip = makeTrip({
      id: 999,
      tripCode: 'TMC-NEW-2026-DELHI-G9',
      destination: 'Delhi',
      schoolContactId: 5004,
      departDate: '2026-11-15T00:00:00.000Z',
      returnDate: '2026-11-22T00:00:00.000Z',
      perStudentAmount: 91000,
      status: 'confirmed',
      _count: { participants: 0, documentRequirements: 0 },
      createdAt: '2026-08-28T10:00:00.000Z',
    });
    installFetchMock({
      list: {
        trips: [newestTrip, ...TRIPS_DEFAULT],
        total: TRIPS_DEFAULT.length + 1,
        limit: 20,
        offset: 0,
      },
    });
    renderPage();

    const firstTripLink = await screen.findByRole('link', { name: 'TMC-NEW-2026-DELHI-G9' });
    expect(firstTripLink).toHaveAttribute('href', '/travel/trips/999');
    expect(screen.getAllByRole('link', { name: /TMC-/i })[0]).toHaveAttribute(
      'href',
      '/travel/trips/999',
    );
  });

  it('keeps the row action as a validated delete instead of opening trip-family grouping', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    expect(screen.queryByRole('button', { name: /Group trip/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: 'Delete trip TMC-AND-2026-MUMBAI-G7',
    }));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Delete trip',
        confirmText: 'Delete trip',
        destructive: true,
        message: expect.stringContaining('landing page'),
      }));
    });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/travel/trips/101', { method: 'DELETE' });
  });
});

describe('<Trips /> — new-trip drawer + create POST', () => {
  it('clicking "New Trip" opens the drawer with the 5 required fields (school is free-text)', async () => {
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
    // School is a free-text input (not a dropdown) — the operator types the
    // school name and the backend find-or-creates a Contact for it.
    const schoolInput = within(drawerForm).getByPlaceholderText(/DPS North|Bharat Public School/i);
    expect(schoolInput.tagName).toBe('INPUT');
    expect(schoolInput.getAttribute('type')).toBe('text');
    // No /api/contacts?limit=200 prefetch fires any more (no school picker).
    const contactsCall = fetchApiMock.mock.calls.find(([u]) =>
      typeof u === 'string' && u.startsWith('/api/contacts'),
    );
    expect(contactsCall).toBeFalsy();
  });

  it('keeps the New Trip drawer open while copying or pasting field data', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('button', { name: /Create a new trip/i }));
    const heading = await screen.findByRole('heading', { name: /^New Trip$/i });
    const form = heading.closest('form');
    const tripCode = within(form).getByPlaceholderText(/TMC-AND-2026-MUMBAI-G7/i);

    fireEvent.focus(tripCode);
    fireEvent.copy(tripCode);
    fireEvent.keyDown(tripCode, { key: 'c', ctrlKey: true });
    fireEvent.paste(tripCode, { clipboardData: { getData: () => 'TMC-COPIED' } });

    expect(screen.getByRole('heading', { name: /^New Trip$/i })).toBeInTheDocument();
  });

  it('does not close when text selection ends outside the drawer', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('button', { name: /Create a new trip/i }));
    const heading = await screen.findByRole('heading', { name: /^New Trip$/i });
    const form = heading.closest('form');
    const tripCode = within(form).getByPlaceholderText(/TMC-AND-2026-MUMBAI-G7/i);
    const backdrop = form.parentElement;

    fireEvent.mouseDown(tripCode);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);

    expect(screen.getByRole('heading', { name: /^New Trip$/i })).toBeInTheDocument();
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
    // Fill the form. School is now a free-text input — type the school name;
    // the backend find-or-creates a Contact under the hood.
    const inputs = screen.getAllByRole('textbox');
    // Order matches the drawer markup: trip code → destination → school.
    fireEvent.change(inputs[0], { target: { value: 'TMC-KAS-2026-XYZ-G9' } });
    fireEvent.change(inputs[1], { target: { value: 'Kashmir' } });
    fireEvent.change(inputs[2], { target: { value: 'DPS North' } });
    // Depart date + return date inputs — find by type="date".
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-12-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-12-08' } });
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
      // School is sent as free-text schoolName (not schoolContactId); the
      // backend resolves it to a Contact via find-or-create.
      expect(body.schoolName).toBe('DPS North');
      expect(body.schoolContactId).toBeUndefined();
      expect(body.departDate).toBe('2026-12-01');
      expect(body.returnDate).toBe('2026-12-08');
      // Per-student pricing is configured after trip creation.
      expect(body.pricePerStudent).toBeUndefined();
      // Default status is "confirmed" (form default per EMPTY_FORM).
      expect(body.status).toBe('confirmed');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Trip created/i),
    );
  });

  it('creates a school variant with the source trip as its family parent', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('button', {
      name: /Create school variant for TMC-AND-2026-MUMBAI-G7/i,
    }));
    const heading = await screen.findByRole('heading', { name: /Create school variant/i });
    const form = heading.closest('form');
    expect(within(form).getByText(/Itinerary copied from/i)).toBeInTheDocument();

    const inputs = within(form).getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'TMC-AND-2026-DPS-G7' } });
    fireEvent.change(inputs[2], { target: { value: 'DPS North' } });
    const dateInputs = form.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-12-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-12-08' } });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Create variant/i }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, options]) => url === '/api/travel/trips' && options?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post[1].body)).toMatchObject({
        tripCode: 'TMC-AND-2026-DPS-G7',
        familyParentId: 101,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/School trip variant/i));
  });
});

describe('<Trips /> — search + pagination behavior', () => {
  it('search input is present in the filter bar', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    expect(screen.getByLabelText(/Search trips/i)).toBeInTheDocument();
  });

  it('typing a trip code re-fetches with search= and renders the matching row from the full dataset', async () => {
    const allTrips = makeTrips(25);
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/trips') && method === 'GET') {
        const parsed = new URL(`http://local${url}`);
        const search = parsed.searchParams.get('search') || '';
        const offset = Number(parsed.searchParams.get('offset') || 0);
        const limit = Number(parsed.searchParams.get('limit') || 20);
        if (search === 'PAGE-05') {
          return Promise.resolve({ trips: [allTrips[4]], total: 1, limit, offset: 0 });
        }
        return Promise.resolve({
          trips: allTrips.slice(offset, offset + limit),
          total: allTrips.length,
          limit,
          offset,
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TMC-PAGE-01');
    fetchApiMock.mockClear();

    fireEvent.change(screen.getByLabelText(/Search trips/i), {
      target: { value: 'PAGE-05' },
    });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('search=PAGE-05')
        && u.includes('limit=20')
        && u.includes('offset=0')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByRole('link', { name: /TMC-PAGE-05/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /TMC-PAGE-21/i })).not.toBeInTheDocument();
  });

  it('highlights matching trip text after searching the list', async () => {
    const allTrips = makeTrips(25);
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/trips') && method === 'GET') {
        const parsed = new URL(`http://local${url}`);
        const search = parsed.searchParams.get('search') || '';
        const offset = Number(parsed.searchParams.get('offset') || 0);
        const limit = Number(parsed.searchParams.get('limit') || 20);
        if (search === 'PAGE-05') {
          return Promise.resolve({ trips: [allTrips[4]], total: 1, limit, offset: 0 });
        }
        return Promise.resolve({
          trips: allTrips.slice(offset, offset + limit),
          total: allTrips.length,
          limit,
          offset,
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TMC-PAGE-01');
    fetchApiMock.mockClear();

    fireEvent.change(screen.getByLabelText(/Search trips/i), {
      target: { value: 'PAGE-05' },
    });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('search=PAGE-05')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
      expect(screen.getAllByText(/PAGE-05/i, { selector: 'mark' }).length).toBeGreaterThan(0);
    });
  });

  it('page 2 requests offset=20 and renders the second slice', async () => {
    const allTrips = makeTrips(25);
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/trips') && method === 'GET') {
        const parsed = new URL(`http://local${url}`);
        const offset = Number(parsed.searchParams.get('offset') || 0);
        const limit = Number(parsed.searchParams.get('limit') || 20);
        return Promise.resolve({
          trips: allTrips.slice(offset, offset + limit),
          total: allTrips.length,
          limit,
          offset,
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TMC-PAGE-01');
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument();
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '2' }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('offset=20')
        && u.includes('limit=20')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText('TMC-PAGE-21')).toBeInTheDocument();
    expect(screen.queryByText('TMC-PAGE-01')).not.toBeInTheDocument();
  });

  it('search filters across the full dataset rather than only the current page', async () => {
    const allTrips = makeTrips(25);
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/trips') && method === 'GET') {
        const parsed = new URL(`http://local${url}`);
        const search = parsed.searchParams.get('search') || '';
        const offset = Number(parsed.searchParams.get('offset') || 0);
        const limit = Number(parsed.searchParams.get('limit') || 20);
        if (search === 'PAGE-05') {
          return Promise.resolve({ trips: [allTrips[4]], total: 1, limit, offset: 0 });
        }
        return Promise.resolve({
          trips: allTrips.slice(offset, offset + limit),
          total: allTrips.length,
          limit,
          offset,
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TMC-PAGE-01');
    fetchApiMock.mockClear();

    fireEvent.change(screen.getByLabelText(/Search trips/i), {
      target: { value: 'PAGE-05' },
    });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('search=PAGE-05')
        && u.includes('limit=20')
        && u.includes('offset=0')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByRole('link', { name: /TMC-PAGE-05/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /TMC-PAGE-21/i })).not.toBeInTheDocument();
  });

  it('search input updates the query string and page 1 is used for filtered results', async () => {
    const allTrips = makeTrips(25);
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/trips') && method === 'GET') {
        const parsed = new URL(`http://local${url}`);
        const search = parsed.searchParams.get('search') || '';
        const offset = Number(parsed.searchParams.get('offset') || 0);
        const limit = Number(parsed.searchParams.get('limit') || 20);
        const filtered = search ? allTrips.filter((t) => t.tripCode.includes(search)) : allTrips;
        return Promise.resolve({
          trips: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TMC-PAGE-01');

    fireEvent.change(screen.getByLabelText(/Search trips/i), {
      target: { value: 'PAGE-05' },
    });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('search=PAGE-05')
        && u.includes('offset=0')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByRole('link', { name: /TMC-PAGE-05/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /TMC-PAGE-01/i })).not.toBeInTheDocument();
  });

  it('status filter re-fetches from the API instead of filtering the current page locally', async () => {
    const allTrips = makeTrips(25);
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/trips') && method === 'GET') {
        const parsed = new URL(`http://local${url}`);
        const status = parsed.searchParams.get('status') || '';
        const offset = Number(parsed.searchParams.get('offset') || 0);
        const limit = Number(parsed.searchParams.get('limit') || 20);
        const filtered = status
          ? allTrips.filter((t) => t.status === 'confirmed')
          : allTrips;
        return Promise.resolve({
          trips: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TMC-PAGE-01');
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Filter trips/i }));
    fireEvent.click(screen.getByLabelText(/Filter by status/i));
    fireEvent.click(screen.getByLabelText('Confirmed'));
    fireEvent.click(screen.getByRole('button', { name: /Apply filters/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('status=confirmed')
        && u.includes('offset=0')
        && u.includes('limit=20')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText('TMC-PAGE-01')).toBeInTheDocument();
  });
});
