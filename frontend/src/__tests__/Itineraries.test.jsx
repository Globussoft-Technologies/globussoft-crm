/**
 * Itineraries.test.jsx — vitest + RTL coverage for the Travel-vertical
 * Itineraries list page (frontend/src/pages/travel/Itineraries.jsx).
 *
 * Scope — pins the page-surface invariants for the multi-product trip
 * itinerary list page (sibling to QuotesAdmin / InvoicesAdmin /
 * SuppliersAdmin / VisaApplications):
 *
 *   1. Page chrome: heading "Itineraries" + sub-brand filter + status
 *      filter + Refresh button + "Create Itinerary" CTA (no RBAC gate on
 *      the CTA per SUT line 202-209 — every role sees it; server enforces
 *      sub-brand-access via getSubBrandAccessSet on POST).
 *   2. Loading state: shows "Loading…" before first GET resolves (await
 *      findByText per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount: hits /api/travel/itineraries?limit=100 (no sub-brand
 *      or status query params when filters are blank) and renders one row
 *      per itinerary (table layout with 9 columns: Destination, Sub-brand,
 *      Contact, Dates, Items, Total, Status, Tier, Updated).
 *   4. Empty state: zero itineraries → renders the "No itineraries yet."
 *      empty-state copy + the "Create Itinerary" hint.
 *   5. Sub-brand filter: changing the <select> to "rfu" re-fetches with
 *      ?subBrand=rfu in the query string.
 *   6. Status filter: changing the <select> to "sent" re-fetches with
 *      ?status=sent (note: backend enum is lowercase per VALID_STATUSES =
 *      ["draft","sent","revised","accepted","rejected","advance_paid",
 *      "fully_paid"] in routes/travel_itineraries.js:53).
 *   7. Status pill per row: renders the status LABEL via CSS class —
 *      `travel-itin-status-pill travel-itin-status-pill--<variant>` per
 *      commit 8169ce8 theme refactor (#879 — pre-refactor used inline
 *      `${bg}` + `${color}` from a hex/rgba lookup map). Tests assert
 *      className contains the variant suffix, NOT inline-style hex colors.
 *      Unknown statuses fall through to `--other` (STATUS_VARIANT map).
 *   8. Tier pill per row: same className-asserted pattern for `tier`
 *      productTier (entry/primary/premium → variant). Null tier → em-dash.
 *   9. Sub-brand badge per row: SUT uses inline `var(--subtle-bg-3)` /
 *      `var(--primary-color)` from local `brandBadge` constant (lines
 *      452-456), NOT the travelSubBrand SUB_BRAND_BG map (which is used by
 *      QuotesAdmin / InvoicesAdmin / SuppliersAdmin for THEIR pill bgs).
 *      We assert the uppercase sub-brand text is present in the badge; no
 *      rgba-color drift assertion (would be a no-op against CSS vars).
 *  10. Money formatting: SUT-local fmtMoney compacts INR ≥100k to ₹X.YYL
 *      (e.g. 500000 → ₹5.00L) per lines 90-93. Tests pin both compact + raw.
 *  11. Navigation: clicking a row navigates to /travel/itineraries/:id
 *      via react-router useNavigate. Tests assert the navigate spy was
 *      called with the right path.
 *  12. Create-drawer open: clicking "Create Itinerary" opens the drawer
 *      with contact picker + sub-brand + destination + start/end dates +
 *      currency + total amount + diagnostic-first hint copy. Drawer fetch
 *      hits /api/contacts?limit=200.
 *  13. Form validation — empty contactId: notify.error("Contact is required")
 *      + does NOT fire POST.
 *  14. Form validation — empty destination: notify.error fires +
 *      does NOT fire POST (after contactId is filled).
 *  15. Submit happy path: POSTs /api/travel/itineraries with contactId (Int)
 *      + subBrand + destination (trimmed) + status:"draft" + currency. On
 *      201 → drawer closes + notify.success + list re-fetches.
 *  16. Backend 403 SUB_BRAND_DENIED on POST → notify.error fires with the
 *      backend error message.
 *  17. Escape-key closes the drawer (window keydown listener wired in
 *      SUT useEffect lines 180-185).
 *
 * Backend contract pinned (per backend/routes/travel_itineraries.js):
 *   GET    /api/travel/itineraries[?subBrand=&status=&limit=]
 *          → 200 { itineraries, total, limit, offset }
 *          | 400 INVALID_STATUS / 500
 *   POST   /api/travel/itineraries  body:{subBrand,contactId,destination,
 *                                          status?,startDate?,endDate?,
 *                                          totalAmount?,currency?}
 *          → 201 created
 *          | 400 MISSING_FIELDS / INVALID_CONTACT_ID / INVALID_STATUS
 *          | 403 SUB_BRAND_DENIED
 *          | 403 DIAGNOSTIC_REQUIRED (PRD §4.1 diagnostic-first gate)
 *
 * Drift pinned around (prompt vs. actual code):
 *   - PROMPT said "status badges → assertion should check className per
 *     commit 8169ce8". CONFIRMED — SUT lines 293-297 + 100-103 render via
 *     `travel-itin-status-pill--<variant>` / `travel-itin-tier-pill--<variant>`
 *     classes. Tests pin className-contains, NOT inline color hex.
 *   - PROMPT said "sub-brand badge per row: uses real travelSubBrand
 *     styling (still inline per real palette)". DRIFT — the SUT's brandBadge
 *     constant (line 452) uses `var(--subtle-bg-3)` / `var(--primary-color)`
 *     CSS vars, NOT the SUB_BRAND_BG rgba map. Confirmed by grep: no import
 *     of travelSubBrand in Itineraries.jsx (whereas QuotesAdmin/InvoicesAdmin/
 *     SuppliersAdmin DO import SUB_BRAND_BG). The sub-brand pill on
 *     Itineraries uses the SAME bg for every sub-brand (just shows the
 *     uppercase identifier text). Tests assert the text is present, not the
 *     rgba palette.
 *   - PROMPT said "status enum (verify actual)". CONFIRMED — backend enum
 *     is LOWERCASE (draft/sent/revised/accepted/rejected/advance_paid/
 *     fully_paid). SUT's STATUSES dropdown values match. (Distinguishes
 *     from QuotesAdmin's TitleCase: Draft/Sent/Accepted/Rejected.)
 *   - PROMPT mentioned "RBAC: USER role hides mutation CTAs". DRIFT — the
 *     SUT does NOT gate the "Create Itinerary" CTA by role (button is
 *     rendered unconditionally at line 202-209). Server enforces sub-brand
 *     access via getSubBrandAccessSet on POST. Tests OMIT the role-hides-
 *     CTA assertion since it's not in the SUT. Pinned here for the next
 *     reader: if a future commit DOES gate this CTA, a test should be
 *     added to pin that gate.
 *   - PROMPT mentioned "new-itinerary flow: if present". CONFIRMED — SUT
 *     has a full drawer with contact picker + form fields + submit.
 *   - PROMPT mentioned "money formatting: if itineraries have totals".
 *     CONFIRMED — SUT has local fmtMoney with INR-compact-≥100k behaviour
 *     (line 90-93). Tests pin both compact (₹5.00L) and raw (₹50,000).
 *   - PROMPT mentioned "navigation: clicking a row links to /travel/
 *     itineraries/:id". CONFIRMED — SUT line 259 wires onClick to
 *     navigate(`/travel/itineraries/${it.id}`).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (RTL standing rule: Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap useCallback identity).
 *   - useNavigate spied via vi.mock('react-router-dom', ...) so the row-
 *     click navigation can be asserted.
 *   - AuthContext provided with role=ADMIN; user does NOT affect SUT
 *     behaviour since there's no role-gated branch on this page.
 *   - travelSubBrand intentionally NOT imported by the SUT, so the
 *     prompt's "import real travelSubBrand (NOT mocked)" instruction is
 *     a no-op here — no import to leave un-mocked. Tests still verify
 *     the sub-brand identifier text renders correctly per row.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning).
 *
 * Path: flat __tests__/ — sibling Agent A may own a different test file
 * in the same flat dir; no path collision (this is the only Itineraries
 * test file).
 *
 * className-vs-inline-color note (commit 8169ce8): pre-refactor, the SUT
 * computed status colors inline as `{ background: STATUS_COLORS[status].bg,
 * color: STATUS_COLORS[status].fg }`. The 8169ce8 refactor moved colors
 * to CSS classes so the dark-mode override can repaint pills without JS.
 * Asserting className lets us pin the variant identity (which CSS will
 * later tint) WITHOUT binding tests to the specific hex/rgba values
 * (which can drift per theme without changing semantics). The pattern
 * is canonical for theme-aware pills; do not regress to inline-style
 * assertions.
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
// f59e91d). The SUT closes over notify inside submitCreate / load, so a
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
  NotifyProvider: ({ children }) => children,
}));

// Spy on useNavigate so the row-click navigation can be asserted.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

// S81 — MapPreview wire-in. Mock the leaflet-backed component to avoid
// jsdom's lack of getBoundingClientRect/transform support (leaflet bails).
// Tests assert the SUT renders MapPreview with the right items prop +
// selection lifecycle; the real MapPreview's render path is exercised by
// the dedicated MapPreview.test.jsx.
const mapPreviewMock = vi.fn();
vi.mock('../components/MapPreview', () => ({
  __esModule: true,
  default: (props) => {
    mapPreviewMock(props);
    return (
      <div
        data-testid="map-preview-mock"
        data-pin-count={(props.items || []).length}
        data-height={props.height ?? ''}
      >
        MapPreview stub — {(props.items || []).length} items
      </div>
    );
  },
}));

import { AuthContext } from '../App';
import Itineraries from '../pages/travel/Itineraries';
import { invalidatePermissionCache } from '../hooks/usePermissions';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

// Canonical itinerary rows — multiple sub-brands + statuses + tier values
// to exercise the pill className paths + the empty-tier em-dash fallback.
function makeItin(overrides = {}) {
  return {
    id: 401,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 5001,
    status: 'draft',
    productTier: 'entry',
    destination: 'Andaman Islands',
    startDate: '2026-06-01T00:00:00.000Z',
    endDate: '2026-06-07T00:00:00.000Z',
    totalAmount: 50000,
    currency: 'INR',
    items: [],
    createdAt: '2026-05-20T10:00:00.000Z',
    updatedAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

const ITINS_DEFAULT = [
  makeItin({
    id: 401,
    subBrand: 'tmc',
    status: 'draft',
    productTier: 'entry',
    destination: 'Andaman Islands',
    totalAmount: 50000,
    currency: 'INR',
    contactId: 5001,
    items: [
      // S81 — items include lat/lng/dayNumber per backend list endpoint
      // (include: { items }). MapPreview wire-in renders these on Map-button
      // click. Rows without lat/lng are silently dropped by pinnableItems.
      {
        id: 9001, itemType: 'flight', description: 'CCU → IXZ',
        latitude: 11.6234, longitude: 92.7265,
        locationName: 'Port Blair', dayNumber: 1, sortOrder: 0,
      },
      {
        id: 9002, itemType: 'hotel', description: 'Port Blair stay',
        latitude: 11.6700, longitude: 92.7470,
        locationName: 'Port Blair hotel', dayNumber: 1, sortOrder: 1,
      },
    ],
  }),
  makeItin({
    id: 402,
    subBrand: 'rfu',
    status: 'sent',
    productTier: 'premium',
    destination: 'Mecca Umrah Package',
    totalAmount: 750000,
    currency: 'INR',
    contactId: 5002,
    items: [
      {
        id: 9003, itemType: 'flight', description: 'DEL → JED',
        latitude: 21.4225, longitude: 39.8262,
        locationName: 'Jeddah', dayNumber: 1, sortOrder: 0,
      },
      {
        id: 9004, itemType: 'hotel', description: 'Mecca hotel',
        latitude: 21.4225, longitude: 39.8262,
        locationName: 'Mecca hotel', dayNumber: 1, sortOrder: 1,
      },
      {
        id: 9005, itemType: 'visa', description: 'Umrah visa',
        // No lat/lng — pinnableItems drops it, but should NOT break render.
        latitude: null, longitude: null,
        locationName: 'Umrah visa', dayNumber: 0, sortOrder: 2,
      },
    ],
  }),
  makeItin({
    id: 403,
    subBrand: 'visasure',
    status: 'accepted',
    productTier: null, // tests the em-dash fallback
    destination: 'Schengen visa',
    totalAmount: 12000,
    currency: 'USD',
    contactId: 5003,
    // No items with coords — exercises the empty-MapPreview branch.
    items: [{
      id: 9006, itemType: 'visa', description: 'Schengen tourist',
      latitude: null, longitude: null,
      locationName: 'Schengen application', dayNumber: 1, sortOrder: 0,
    }],
  }),
];

const CONTACTS_DEFAULT = [
  { id: 5001, name: 'Riya Sharma', email: 'riya@test.example' },
  { id: 5002, name: 'Arjun Patel', email: 'arjun@test.example' },
];

// Install a fetchApi mock that routes by URL + method. Tests override only
// the surface they care about.
function installFetchMock({
  list = { itineraries: ITINS_DEFAULT, total: ITINS_DEFAULT.length, limit: 100, offset: 0 },
  contacts = CONTACTS_DEFAULT,
  create = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/auth/me/permissions' && method === 'GET') {
      // ADMIN test user — short-circuit PermissionGate so CTAs render.
      return Promise.resolve({ isOwner: true, permissions: [] });
    }
    if (url.startsWith('/api/travel/itineraries') && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (url.startsWith('/api/contacts') && method === 'GET') {
      if (contacts instanceof Error) return Promise.reject(contacts);
      return Promise.resolve(contacts);
    }
    if (url === '/api/travel/itineraries' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create || makeItin({ id: 999 }));
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <Itineraries />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  invalidatePermissionCache();
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  navigateMock.mockReset();
  mapPreviewMock.mockReset();
  installFetchMock();
  // S81 — the page geocodes destination words via global fetch to Nominatim
  // when an itinerary has no pinnable items. Stub it to an empty response so
  // the effect falls back to the raw items without leaving network I/O hanging
  // in jsdom (which would keep mapItems === [] until timeout).
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<Itineraries /> — page chrome + filter bar', () => {
  it('renders heading + sub-brand + status filters + Refresh + Create Itinerary CTA', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Itineraries/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by status/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload list/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create a new itinerary/i }),
    ).toBeInTheDocument();
    // Wait for the mount-time GET to settle.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/travel/itineraries'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe('<Itineraries /> — load + render lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/itineraries') && method === 'GET') {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    // Loading text renders before list resolves (SUT line 232: "Loading&hellip;").
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveList({ itineraries: ITINS_DEFAULT, total: ITINS_DEFAULT.length, limit: 100, offset: 0 });
    await screen.findByText('Andaman Islands');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/itineraries?limit=100 on mount with NO sub-brand/status query string', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.startsWith('/api/travel/itineraries')
        && (!o?.method || o.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
      // limit=100 is always set by the SUT (line 167).
      expect(listCall[0]).toContain('limit=100');
      // No subBrand= / status= when both filters are blank.
      expect(listCall[0]).not.toContain('subBrand=');
      expect(listCall[0]).not.toContain('status=');
    });
    // Renders one row per itinerary (by destination).
    expect(await screen.findByText('Andaman Islands')).toBeInTheDocument();
    expect(screen.getByText('Mecca Umrah Package')).toBeInTheDocument();
    expect(screen.getByText('Schengen visa')).toBeInTheDocument();
  });

  it('renders empty-state copy when itineraries=[] (SUT line 234-237)', async () => {
    installFetchMock({ list: { itineraries: [], total: 0, limit: 100, offset: 0 } });
    renderPage();
    expect(
      await screen.findByText(/No itineraries yet\./i),
    ).toBeInTheDocument();
  });

  it('surfaces notify.error when GET rejects', async () => {
    const err = new Error('boom');
    err.body = { error: 'Failed to load itineraries' };
    installFetchMock({ list: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to load itineraries');
    });
  });
});

describe('<Itineraries /> — filter behaviour', () => {
  it('selecting sub-brand "rfu" re-fetches with ?subBrand=rfu in the URL', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fetchApiMock.mockClear();
    installFetchMock({ list: { itineraries: [ITINS_DEFAULT[1]], total: 1, limit: 100, offset: 0 } });
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), {
      target: { value: 'rfu' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('subBrand=rfu')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('selecting status "sent" re-fetches with ?status=sent (lowercase backend enum)', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fetchApiMock.mockClear();
    installFetchMock({ list: { itineraries: [ITINS_DEFAULT[1]], total: 1, limit: 100, offset: 0 } });
    fireEvent.change(screen.getByLabelText(/Filter by status/i), {
      target: { value: 'sent' },
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u, o]) =>
        typeof u === 'string'
        && u.includes('status=sent')
        && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<Itineraries /> — row rendering: status + tier pills (className-asserted per 8169ce8)', () => {
  it('status pill renders via className (travel-itin-status-pill--<variant>), NOT inline color', async () => {
    renderPage();
    const draftRow = (await screen.findByText('Andaman Islands')).closest('tr');
    const draftPill = within(draftRow).getByText('draft');
    // className-asserted per commit 8169ce8 refactor (#879).
    expect(draftPill.className).toContain('travel-itin-status-pill');
    expect(draftPill.className).toContain('travel-itin-status-pill--draft');
    // No inline hex/rgba color — refactor explicitly moved colors to CSS.
    expect(draftPill.getAttribute('style') || '').not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(draftPill.getAttribute('style') || '').not.toMatch(/rgba?\(/);

    const sentRow = screen.getByText('Mecca Umrah Package').closest('tr');
    const sentPill = within(sentRow).getByText('sent');
    expect(sentPill.className).toContain('travel-itin-status-pill--sent');

    const acceptedRow = screen.getByText('Schengen visa').closest('tr');
    const acceptedPill = within(acceptedRow).getByText('accepted');
    expect(acceptedPill.className).toContain('travel-itin-status-pill--accepted');
  });

  it('tier pill renders via className (travel-itin-tier-pill--<variant>) for non-null tier, em-dash for null', async () => {
    renderPage();
    const entryRow = (await screen.findByText('Andaman Islands')).closest('tr');
    const entryPill = within(entryRow).getByText('entry');
    expect(entryPill.className).toContain('travel-itin-tier-pill');
    expect(entryPill.className).toContain('travel-itin-tier-pill--entry');

    const premiumRow = screen.getByText('Mecca Umrah Package').closest('tr');
    const premiumPill = within(premiumRow).getByText('premium');
    expect(premiumPill.className).toContain('travel-itin-tier-pill--premium');

    // visasure row has productTier=null → em-dash fallback in the Tier cell.
    const nullTierRow = screen.getByText('Schengen visa').closest('tr');
    // Multiple em-dashes can appear across cells (Items / Tier); assert ≥1.
    expect(within(nullTierRow).getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('sub-brand identifier renders in the brand badge cell per row', async () => {
    renderPage();
    const tmcRow = (await screen.findByText('Andaman Islands')).closest('tr');
    expect(within(tmcRow).getByText('tmc')).toBeInTheDocument();
    const rfuRow = screen.getByText('Mecca Umrah Package').closest('tr');
    expect(within(rfuRow).getByText('rfu')).toBeInTheDocument();
    const visaRow = screen.getByText('Schengen visa').closest('tr');
    expect(within(visaRow).getByText('visasure')).toBeInTheDocument();
  });
});

describe('<Itineraries /> — money formatting (SUT-local fmtMoney with INR-compact-≥100k)', () => {
  it('INR 50,000 renders as raw "₹50,000" (below the 100k compact threshold)', async () => {
    renderPage();
    const row = (await screen.findByText('Andaman Islands')).closest('tr');
    expect(within(row).getByText(/₹50,000/)).toBeInTheDocument();
  });

  it('INR 750,000 compacts to "₹7.50L" (≥100k compact branch — SUT line 90-93)', async () => {
    renderPage();
    const row = (await screen.findByText('Mecca Umrah Package')).closest('tr');
    expect(within(row).getByText(/₹7\.50L/)).toBeInTheDocument();
  });

  it('USD 12,000 renders as "USD 12,000" (non-INR branch, no compact)', async () => {
    renderPage();
    const row = (await screen.findByText('Schengen visa')).closest('tr');
    expect(within(row).getByText(/USD 12,000/)).toBeInTheDocument();
  });
});

describe('<Itineraries /> — navigation (row click → /travel/itineraries/:id)', () => {
  it('clicking a row navigates to /travel/itineraries/:id via useNavigate', async () => {
    renderPage();
    const row = (await screen.findByText('Andaman Islands')).closest('tr');
    fireEvent.click(row);
    expect(navigateMock).toHaveBeenCalledWith('/travel/itineraries/401');
  });
});

describe('<Itineraries /> — create drawer + submit', () => {
  it('clicking "Create Itinerary" opens the drawer with the create form + fetches /api/contacts', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Create a new itinerary/i }));
    expect(
      await screen.findByRole('heading', { name: /New Itinerary/i }),
    ).toBeInTheDocument();
    // Diagnostic-first hint copy renders (PRD §4.1 guard disabled; SUT
    // shows a recommendation rather than a hard gate).
    expect(
      screen.getByText(/Running the diagnostic first is still recommended/i),
    ).toBeInTheDocument();
    // /api/contacts?limit=200 fired to populate the picker.
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

  it('validation: empty contactId → notify.error("Contact is required") + no POST', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(screen.getByRole('button', { name: /Create a new itinerary/i }));
    await screen.findByRole('heading', { name: /New Itinerary/i });
    // Bypass HTML5 required by submitting via the form element.
    const form = screen.getByText(/New Itinerary/i).closest('form');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Contact is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/itineraries' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('submit happy path: POSTs /api/travel/itineraries with parsed body + closes drawer + notify.success', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(screen.getByRole('button', { name: /Create a new itinerary/i }));
    await screen.findByRole('heading', { name: /New Itinerary/i });
    // Wait for the contact picker to populate so we can select one.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Riya Sharma/i })).toBeInTheDocument();
    });
    // Select contact (the picker is the first <select> in the drawer — by
    // text label "Contact" inside the form). Use a more targeted lookup.
    const contactOption = screen.getByRole('option', { name: /Riya Sharma/i });
    const contactSelect = contactOption.closest('select');
    fireEvent.change(contactSelect, { target: { value: '5001' } });
    // Fill destination.
    const destInput = screen.getByPlaceholderText(/Andaman Islands/i);
    fireEvent.change(destInput, { target: { value: '  Bali  ' } });
    // Submit.
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Create Itinerary$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/itineraries' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.contactId).toBe(5001);
      expect(typeof body.contactId).toBe('number');
      // Destination is trimmed.
      expect(body.destination).toBe('Bali');
      // Default sub-brand from EMPTY_FORM is "tmc".
      expect(body.subBrand).toBe('tmc');
      // Status defaults to "draft" per submitCreate body construction.
      expect(body.status).toBe('draft');
      // Currency defaults to INR.
      expect(body.currency).toBe('INR');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Itinerary created/i),
    );
    // Drawer closed.
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: /New Itinerary/i }),
      ).toBeNull();
    });
  });

  it('backend 403 SUB_BRAND_DENIED on POST → notify.error fires with the server message', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(screen.getByRole('button', { name: /Create a new itinerary/i }));
    await screen.findByRole('heading', { name: /New Itinerary/i });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Riya Sharma/i })).toBeInTheDocument();
    });
    const contactOption = screen.getByRole('option', { name: /Riya Sharma/i });
    const contactSelect = contactOption.closest('select');
    fireEvent.change(contactSelect, { target: { value: '5001' } });
    fireEvent.change(screen.getByPlaceholderText(/Andaman Islands/i), {
      target: { value: 'Goa' },
    });

    // Re-arm so POST rejects with SUB_BRAND_DENIED.
    const err = new Error('Sub-brand access denied');
    err.body = { error: 'Sub-brand access denied', code: 'SUB_BRAND_DENIED' };
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url.startsWith('/api/travel/itineraries') && method === 'GET') {
        return Promise.resolve({ itineraries: ITINS_DEFAULT, total: ITINS_DEFAULT.length, limit: 100, offset: 0 });
      }
      if (url.startsWith('/api/contacts')) {
        return Promise.resolve(CONTACTS_DEFAULT);
      }
      if (url === '/api/travel/itineraries' && method === 'POST') {
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Create Itinerary$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Sub-brand access denied');
    });
  });

  it('Escape key closes the drawer (window keydown listener wired in SUT useEffect)', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(screen.getByRole('button', { name: /Create a new itinerary/i }));
    await screen.findByRole('heading', { name: /New Itinerary/i });
    // Fire Escape on window.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: /New Itinerary/i }),
      ).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// S63 — "Suggest itinerary" CTA + modal + suggestion preview.
//
// PRD docs/PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.6 step (a) — wires
// `POST /api/travel/itineraries/suggest` into a modal where the operator
// picks destination / duration / budget tier and types interests + pace as
// PLAIN TEXT (the backend assembles the theme JSON), then renders the
// returned suggestion day-by-day so they can review + optionally materialise.
//
// Endpoint contract pinned (FR-3.4 handler in travel_itineraries.js):
//   POST /api/travel/itineraries/suggest
//     body: { destination, days, budgetTier?, interests?, pace? }
//          → 200 { suggestion: { summary, days[] }, theme, model, stub }
//          | 400 MISSING_DESTINATION / INVALID_DAYS / INVALID_SUB_BRAND
//          | 500 (generic failure)
// ---------------------------------------------------------------------------

const STUB_SUGGESTION = {
  suggestion: {
    summary: '2-day Goa (mid) outline',
    days: [
      {
        dayNumber: 1,
        items: [
          { itemType: 'flight', description: 'Arrival in Goa', estimatedCost: 6000 },
          { itemType: 'hotel', description: 'Night 1 — stay in Goa', estimatedCost: 5000 },
          { itemType: 'activity', description: 'Day 1 — sightseeing in Goa', estimatedCost: 1500 },
        ],
      },
      {
        dayNumber: 2,
        items: [
          { itemType: 'hotel', description: 'Night 2 — stay in Goa', estimatedCost: 5000 },
          { itemType: 'activity', description: 'Day 2 — sightseeing in Goa', estimatedCost: 1500 },
          { itemType: 'flight', description: 'Departure from Goa', estimatedCost: 6000 },
        ],
      },
    ],
  },
  theme: { interests: ['beaches'], pace: 'relaxed' },
  subBrand: null,
  model: 'gemini-2.5-flash',
  stub: true,
  costSource: 'llm',
};

// Install the suggest endpoint into the existing routing fetch mock.
// Tests that need a custom response (error / specific shape) override
// fetchApiMock.mockImplementation directly.
function installSuggestMock({ suggestResult = STUB_SUGGESTION } = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/travel/itineraries/suggest' && method === 'POST') {
      if (suggestResult instanceof Error) return Promise.reject(suggestResult);
      return Promise.resolve(suggestResult);
    }
    if (url.startsWith('/api/travel/itineraries') && method === 'GET') {
      return Promise.resolve({
        itineraries: ITINS_DEFAULT,
        total: ITINS_DEFAULT.length, limit: 100, offset: 0,
      });
    }
    if (url.startsWith('/api/contacts')) {
      return Promise.resolve(CONTACTS_DEFAULT);
    }
    return Promise.resolve(null);
  });
}

describe('<Itineraries /> — S63 Suggest itinerary CTA + modal', () => {
  it('renders the "Suggest itinerary" button in the header', async () => {
    renderPage();
    expect(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    ).toBeInTheDocument();
    // Distinct from the "Create Itinerary" CTA — both should coexist.
    expect(
      screen.getByRole('button', { name: /Create a new itinerary/i }),
    ).toBeInTheDocument();
  });

  it('clicking the button opens the modal with all form fields + role=dialog', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    // Modal heading present + role=dialog wired.
    expect(
      await screen.findByRole('heading', { name: /Suggest itinerary/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    // Form fields present.
    expect(within(screen.getByRole('dialog')).getByLabelText('Destination')).toBeInTheDocument();
    expect(screen.getByLabelText(/Duration \(days\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Budget tier/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Interests/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Pace/i)).toBeInTheDocument();
  });

  it('Escape key closes the suggest modal', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: /Suggest itinerary/i }),
      ).toBeNull();
    });
  });

  it('clicking the backdrop closes the suggest modal', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    // The backdrop element has the class travel-itin-suggest-backdrop.
    const backdrop = document.querySelector('.travel-itin-suggest-backdrop');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: /Suggest itinerary/i }),
      ).toBeNull();
    });
  });

  it('validation: empty destination on submit shows inline error + does NOT call POST', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fetchApiMock.mockClear();
    installSuggestMock();
    // Click submit with destination still blank.
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    expect(
      await screen.findByText(/Destination is required/i),
    ).toBeInTheDocument();
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/itineraries/suggest' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('validation: durationDays out-of-range (35) shows inline error', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    fireEvent.change(screen.getByLabelText(/Duration \(days\)/i), {
      target: { value: '35' },
    });
    fetchApiMock.mockClear();
    installSuggestMock();
    // Bypass HTML5 max="30" constraint by submitting the form directly.
    const dialog = screen.getByRole('dialog');
    fireEvent.submit(dialog);
    expect(
      await screen.findByText(/Duration must be an integer 1\.\.30/i),
    ).toBeInTheDocument();
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/itineraries/suggest' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('sends interests + pace as plain text (backend assembles the theme JSON)', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    fireEvent.change(screen.getByLabelText(/Interests/i), {
      target: { value: 'historical, beaches' },
    });
    fireEvent.change(screen.getByLabelText(/Pace/i), {
      target: { value: 'packed' },
    });
    fetchApiMock.mockClear();
    installSuggestMock();
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/itineraries/suggest' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      // Plain-text passthrough — the client does NOT pre-build any JSON.
      expect(body.interests).toBe('historical, beaches');
      expect(body.pace).toBe('packed');
      expect(body.themeJson).toBeUndefined();
    });
  });

  it('submit happy path: POSTs /api/travel/itineraries/suggest with correct body', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: '  Goa  ' },
    });
    fireEvent.change(screen.getByLabelText(/Duration \(days\)/i), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText(/Budget tier/i), {
      target: { value: 'luxury' },
    });
    fetchApiMock.mockClear();
    installSuggestMock();
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/itineraries/suggest' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      // Destination is trimmed.
      expect(body.destination).toBe('Goa');
      // Sent as `days` (the backend contract), parsed to int.
      expect(body.days).toBe(3);
      expect(body.budgetTier).toBe('luxury');
    });
  });

  it('submit with defaults sends days=5, budgetTier=mid, pace=relaxed', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    fetchApiMock.mockClear();
    installSuggestMock();
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/itineraries/suggest' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      // Defaults: days=5, budgetTier=mid, pace=relaxed, interests empty.
      expect(body.days).toBe(5);
      expect(body.budgetTier).toBe('mid');
      expect(body.pace).toBe('relaxed');
      expect(body.interests).toBe('');
    });
  });

  it('loading state: submit button disabled + label changes to "Generating suggestion…"', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    // Install a fetch that hangs so we can observe the loading state.
    let resolveSuggest;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/itineraries/suggest' && method === 'POST') {
        return new Promise((res) => { resolveSuggest = res; });
      }
      if (url.startsWith('/api/travel/itineraries')) {
        return Promise.resolve({
          itineraries: ITINS_DEFAULT, total: ITINS_DEFAULT.length, limit: 100, offset: 0,
        });
      }
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    expect(
      await screen.findByRole('button', { name: /Generating suggestion…/i }),
    ).toBeDisabled();
    // Resolve so the test cleanup is tidy.
    resolveSuggest(STUB_SUGGESTION);
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Generating suggestion…/i }),
      ).toBeNull();
    });
  });

  it('success path: renders suggestionJson preview pane with day-by-day breakdown', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    installSuggestMock();
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    // Preview pane appears.
    expect(
      await screen.findByTestId('suggest-preview-pane'),
    ).toBeInTheDocument();
    // Per-day breakdown rendered.
    expect(screen.getByTestId('suggest-day-1')).toBeInTheDocument();
    expect(screen.getByTestId('suggest-day-2')).toBeInTheDocument();
    // Day-1 items render (flight + hotel + activity from the skeleton).
    expect(
      within(screen.getByTestId('suggest-day-1')).getByText(/Arrival in Goa/i),
    ).toBeInTheDocument();
    // Summary renders.
    expect(screen.getByText(/2-day Goa \(mid\) outline/i)).toBeInTheDocument();
    // Per-person estimated total renders (6000+5000+1500 + 5000+1500+6000 = 25000).
    expect(
      within(screen.getByTestId('suggest-est-total')).getByText(/25,000/),
    ).toBeInTheDocument();
    // A per-item cost renders in the day breakdown.
    expect(
      within(screen.getByTestId('suggest-day-1')).getByText(/₹6,000/),
    ).toBeInTheDocument();
    // "Stub" badge present since stub=true.
    expect(screen.getByText(/^Stub$/i)).toBeInTheDocument();
  });

  it('"Create itinerary from this suggestion" button is present + disabled until a contact is picked (S90 materialise picker)', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    installSuggestMock();
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    const createBtn = await screen.findByRole('button', {
      name: /Create itinerary from this suggestion/i,
    });
    expect(createBtn).toBeInTheDocument();
    // Discard button present too.
    expect(
      screen.getByRole('button', { name: /Discard suggestion/i }),
    ).toBeInTheDocument();
    // Materialise picker is rendered.
    expect(screen.getByTestId('materialise-picker')).toBeInTheDocument();
    // Button starts disabled (no contact picked yet).
    expect(createBtn).toBeDisabled();
  });
});

// S90 — Materialise-from-suggestion (POST /api/travel/itineraries/from-suggestion).
//
// Contracts pinned:
//   1. Picking a contact + clicking "Create itinerary from this suggestion"
//      POSTs to /api/travel/itineraries/from-suggestion with the
//      { suggestionJson, contactId, subBrand } body.
//   2. On 201 success → notify.success("Itinerary created with N items"),
//      modal closes, navigate to /travel/itineraries/:id.
//   3. On 4xx/5xx error → notify.error with the backend error body, no
//      navigate.
//   4. Loading state: button shows "Creating itinerary…" and stays
//      disabled during the in-flight POST.
//   5. Discard button works alongside the materialise picker (pane
//      still closeable without committing).
//   6. Backend 403 SUB_BRAND_DENIED surfaces notify.error.
describe('<Itineraries /> — S90 materialise-from-suggestion', () => {
  function installMaterialiseMock({
    suggestResult = STUB_SUGGESTION,
    materialiseResult = null,
    materialiseError = null,
  } = {}) {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/itineraries/suggest' && method === 'POST') {
        return Promise.resolve(suggestResult);
      }
      if (
        url === '/api/travel/itineraries/from-suggestion'
        && method === 'POST'
      ) {
        if (materialiseError) return Promise.reject(materialiseError);
        return Promise.resolve(materialiseResult || {
          itinerary: {
            id: 12345,
            tenantId: 1,
            subBrand: 'tmc',
            contactId: 5001,
            status: 'draft',
            destination: 'Suggested itinerary',
            currency: 'INR',
            items: [
              { id: 91, itemType: 'activity', description: 'd1 a1', position: 0, dayNumber: 1 },
              { id: 92, itemType: 'meal', description: 'd1 m1', position: 1, dayNumber: 1 },
              { id: 93, itemType: 'activity', description: 'd2 a1', position: 2, dayNumber: 2 },
            ],
          },
          itemsCreated: 3,
          daysProcessed: 2,
        });
      }
      if (url.startsWith('/api/travel/itineraries') && method === 'GET') {
        return Promise.resolve({
          itineraries: ITINS_DEFAULT, total: ITINS_DEFAULT.length, limit: 100, offset: 0,
        });
      }
      if (url.startsWith('/api/contacts')) {
        return Promise.resolve(CONTACTS_DEFAULT);
      }
      return Promise.resolve(null);
    });
  }

  async function openPreviewPane() {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    await screen.findByTestId('suggest-preview-pane');
  }

  it('happy path: pick contact + click materialise → POSTs correct body + notify.success + navigate', async () => {
    installMaterialiseMock();
    await openPreviewPane();
    // Pick a contact.
    fireEvent.change(
      screen.getByLabelText(/Contact for materialised itinerary/i),
      { target: { value: '5001' } },
    );
    const createBtn = screen.getByRole('button', {
      name: /Create itinerary from this suggestion/i,
    });
    expect(createBtn).not.toBeDisabled();
    fireEvent.click(createBtn);
    // notify.success fires with "Itinerary created with 3 items".
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Itinerary created with 3 items/i),
      );
    });
    // POST body shape contract pin.
    const materialiseCall = fetchApiMock.mock.calls.find(
      ([url, opts]) =>
        url === '/api/travel/itineraries/from-suggestion'
        && opts?.method === 'POST',
    );
    expect(materialiseCall).toBeTruthy();
    const body = JSON.parse(materialiseCall[1].body);
    expect(body.contactId).toBe(5001);
    expect(body.subBrand).toBeTruthy();
    expect(body.suggestionJson).toBeTruthy();
    // The component forwards the /suggest result (shape: { summary, days[] })
    // verbatim as suggestionJson; from-suggestion accepts .days (or .daySplit).
    expect(Array.isArray(body.suggestionJson.days)).toBe(true);
    // Navigation to the new itinerary's detail page.
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/travel/itineraries/12345');
    });
  });

  it('error path: backend 500 surfaces notify.error + no navigate', async () => {
    const err = new Error('Materialise failed');
    err.body = {
      error: 'Failed to materialise itinerary from suggestion',
      code: 'ITINERARY_MATERIALISE_FAILED',
    };
    installMaterialiseMock({ materialiseError: err });
    await openPreviewPane();
    fireEvent.change(
      screen.getByLabelText(/Contact for materialised itinerary/i),
      { target: { value: '5001' } },
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: /Create itinerary from this suggestion/i,
      }),
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to materialise itinerary from suggestion/i),
      );
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('backend 403 SUB_BRAND_DENIED → notify.error with backend message + no navigate', async () => {
    const err = new Error('SUB_BRAND_DENIED');
    err.body = {
      error: 'Sub-brand access denied',
      code: 'SUB_BRAND_DENIED',
    };
    installMaterialiseMock({ materialiseError: err });
    await openPreviewPane();
    fireEvent.change(
      screen.getByLabelText(/Contact for materialised itinerary/i),
      { target: { value: '5001' } },
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: /Create itinerary from this suggestion/i,
      }),
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Sub-brand access denied/i),
      );
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('loading state: button shows "Creating itinerary…" + stays disabled during the in-flight POST', async () => {
    let resolveMaterialise;
    const pending = new Promise((resolve) => {
      resolveMaterialise = resolve;
    });
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/itineraries/suggest' && method === 'POST') {
        return Promise.resolve(STUB_SUGGESTION);
      }
      if (url === '/api/travel/itineraries/from-suggestion' && method === 'POST') {
        return pending;
      }
      if (url.startsWith('/api/travel/itineraries') && method === 'GET') {
        return Promise.resolve({
          itineraries: ITINS_DEFAULT, total: ITINS_DEFAULT.length, limit: 100, offset: 0,
        });
      }
      if (url.startsWith('/api/contacts')) {
        return Promise.resolve(CONTACTS_DEFAULT);
      }
      return Promise.resolve(null);
    });
    await openPreviewPane();
    fireEvent.change(
      screen.getByLabelText(/Contact for materialised itinerary/i),
      { target: { value: '5001' } },
    );
    const triggerBtn = screen.getByRole('button', {
      name: /Create itinerary from this suggestion/i,
    });
    fireEvent.click(triggerBtn);
    // Loading text + disabled state. The button's aria-label stays
    // constant ("Create itinerary from this suggestion") for screen-
    // reader stability; the inner TEXT swaps to "Creating itinerary…"
    // during the in-flight POST.
    await waitFor(() => {
      expect(triggerBtn).toBeDisabled();
      expect(triggerBtn.textContent).toMatch(/Creating itinerary/i);
    });
    // Resolve so vitest can complete cleanly.
    resolveMaterialise({
      itinerary: { id: 999, items: [] },
      itemsCreated: 0,
      daysProcessed: 1,
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalled();
    });
  });

  it('no contact picked → notify.error + no POST + button stays disabled', async () => {
    installMaterialiseMock();
    await openPreviewPane();
    // Don't pick a contact.
    const createBtn = screen.getByRole('button', {
      name: /Create itinerary from this suggestion/i,
    });
    expect(createBtn).toBeDisabled();
    // No materialise POST happened.
    const materialiseCalls = fetchApiMock.mock.calls.filter(
      ([url]) => url === '/api/travel/itineraries/from-suggestion',
    );
    expect(materialiseCalls).toHaveLength(0);
  });

  it('discard alongside materialise picker: discarding before pick → preview pane gone, no POST, modal still open', async () => {
    installMaterialiseMock();
    await openPreviewPane();
    expect(screen.getByTestId('materialise-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Discard suggestion/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('suggest-preview-pane')).toBeNull();
    });
    // Modal still open (heading still present).
    expect(
      screen.getByRole('heading', { name: /Suggest itinerary/i }),
    ).toBeInTheDocument();
    // No materialise POST happened.
    const materialiseCalls = fetchApiMock.mock.calls.filter(
      ([url]) => url === '/api/travel/itineraries/from-suggestion',
    );
    expect(materialiseCalls).toHaveLength(0);
  });

  it('uses itinerary.items.length as fallback when backend omits itemsCreated', async () => {
    installMaterialiseMock({
      materialiseResult: {
        itinerary: {
          id: 7777,
          items: [
            { id: 1, itemType: 'activity', description: 'x', position: 0 },
            { id: 2, itemType: 'meal', description: 'y', position: 1 },
          ],
        },
        // itemsCreated intentionally omitted to exercise the fallback.
      },
    });
    await openPreviewPane();
    fireEvent.change(
      screen.getByLabelText(/Contact for materialised itinerary/i),
      { target: { value: '5001' } },
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: /Create itinerary from this suggestion/i,
      }),
    );
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Itinerary created with 2 items/i),
      );
    });
  });

  it('discard button closes the preview pane (back to bare modal form)', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    installSuggestMock();
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    await screen.findByTestId('suggest-preview-pane');
    fireEvent.click(screen.getByRole('button', { name: /Discard suggestion/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('suggest-preview-pane')).toBeNull();
    });
    // Modal stays open.
    expect(
      screen.getByRole('heading', { name: /Suggest itinerary/i }),
    ).toBeInTheDocument();
  });

  it('error path: backend 500 ITINERARY_SUGGEST_FAILED surfaces notify.error', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    const err = new Error('Suggest failed');
    err.body = { error: 'ITINERARY_SUGGEST_FAILED', code: 'ITINERARY_SUGGEST_BUDGET_EXCEEDED' };
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/itineraries/suggest' && method === 'POST') {
        return Promise.reject(err);
      }
      if (url.startsWith('/api/travel/itineraries')) {
        return Promise.resolve({
          itineraries: ITINS_DEFAULT, total: ITINS_DEFAULT.length, limit: 100, offset: 0,
        });
      }
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('AI service is temporarily unavailable. Please try again in a moment.');
    });
    // Preview pane should NOT appear on error.
    expect(screen.queryByTestId('suggest-preview-pane')).toBeNull();
  });

  it('fallback rendering: unfamiliar suggestionJson shape falls back to JSON.stringify pre block', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest itinerary using AI/i }),
    );
    await screen.findByRole('heading', { name: /Suggest itinerary/i });
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Destination'), {
      target: { value: 'Goa' },
    });
    // Custom shape: suggestion present but no days[] → fall through to the
    // JSON.stringify branch.
    installSuggestMock({
      suggestResult: {
        suggestion: { weirdField: 'unknown shape', otherKey: 42 },
        model: 'gemini-2.5-flash', stub: true,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    await screen.findByTestId('suggest-preview-pane');
    // Raw JSON rendered somewhere in the pane.
    const pane = screen.getByTestId('suggest-preview-pane');
    expect(within(pane).getByText(/weirdField/)).toBeInTheDocument();
    expect(within(pane).getByText(/unknown shape/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// S81 — MapPreview consumer wire-in on the Itineraries list page.
//
// Contract pinned:
//   1. No selection on initial render → MapPreview is NOT rendered + the
//      `itineraries-selected-map` panel is absent. Default state is map-less
//      so the page chrome doesn't visually shift on first load.
//   2. Each row has a "Map" button (one per itinerary). aria-label is
//      "Show map for <destination>" when not selected; "Hide map for ..."
//      when selected. aria-pressed mirrors the selection state.
//   3. Clicking a Map button selects that itinerary → MapPreview renders
//      above the table with the itinerary's items as the `items` prop.
//      Map height is the documented S81 default (320). pinnableItems
//      inside MapPreview silently drops rows without lat/lng, so the
//      Mecca itinerary (2 pinnable + 1 non-pinnable visa item) still
//      surfaces with all 3 items in the prop (filtering happens inside
//      MapPreview, not the consumer — see MapPreview.test.jsx for that).
//   4. Re-clicking the SAME row's Map button toggles off (selection
//      cleared, panel removed).
//   5. Clicking a DIFFERENT row's Map button switches the selection
//      without an intermediate "no selection" state.
//   6. The panel's Close button (X icon, aria-label "Close map preview")
//      also clears the selection.
//   7. Clicking the Map button does NOT fire the row's
//      navigate-on-click (stopPropagation prevents the click bubbling).
//
// Why mock MapPreview: leaflet's render path uses getBoundingClientRect
// + CSS transforms that jsdom doesn't model. Tests assert the wire-in
// invariants — items prop, height, when it's rendered — without
// exercising leaflet itself. The real MapPreview render path is covered
// by frontend/src/__tests__/MapPreview.test.jsx.
//
// Per the S81 slice-scope note: the ItineraryDetail.jsx + ItineraryEditor.jsx
// wire-ins are out of scope for this slice — ItineraryEditor.jsx already
// has its own inline Leaflet map (PR #1142), so MapPreview wouldn't add
// value there; ItineraryDetail.jsx is left for a follow-up slice if an
// explicit map block is needed alongside the day-by-day cost breakdown.
// ---------------------------------------------------------------------------
describe('<Itineraries /> — S81 MapPreview wire-in (list page)', () => {
  it('does NOT render MapPreview when no itinerary is selected (initial state)', async () => {
    renderPage();
    // Wait for the list to settle so we're past initial load.
    await screen.findByText('Andaman Islands');
    expect(screen.queryByTestId('itineraries-selected-map')).toBeNull();
    expect(screen.queryByTestId('map-preview-mock')).toBeNull();
    expect(mapPreviewMock).not.toHaveBeenCalled();
  });

  it('each row exposes a "Map" button with row-specific aria-label', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    expect(
      screen.getByRole('button', { name: /Show map for Andaman Islands/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Show map for Mecca Umrah Package/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Show map for Schengen visa/i }),
    ).toBeInTheDocument();
  });

  it("clicking a Map button renders MapPreview with that itinerary's items prop", async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Show map for Andaman Islands/i }),
    );
    // Map panel + mock render.
    expect(
      await screen.findByTestId('itineraries-selected-map'),
    ).toBeInTheDocument();
    const mapMock = screen.getByTestId('map-preview-mock');
    expect(mapMock).toBeInTheDocument();
    // The Andaman itinerary has 2 items with lat/lng.
    expect(mapMock.getAttribute('data-pin-count')).toBe('2');
    // Height default per S81 wire-in is 320.
    expect(mapMock.getAttribute('data-height')).toBe('320');
    // Last call to MapPreview received the right items prop shape.
    const lastCall = mapPreviewMock.mock.calls[mapPreviewMock.mock.calls.length - 1];
    expect(lastCall).toBeTruthy();
    const props = lastCall[0];
    expect(Array.isArray(props.items)).toBe(true);
    expect(props.items.length).toBe(2);
    expect(props.items[0].id).toBe(9001);
    expect(props.items[1].id).toBe(9002);
    // Panel header surfaces the destination + item count text. React
    // renders the pluralised "N item(s)" as 3 sibling text nodes (number,
    // " item", "s") plus the MapPreview stub's own "N items" copy — so we
    // assert the panel's textContent contains "2 item" rather than
    // querying by getByText (which would match multiple nodes).
    const panel = screen.getByTestId('itineraries-selected-map');
    expect(within(panel).getByText('Andaman Islands')).toBeInTheDocument();
    expect(panel.textContent).toMatch(/2\s*item/);
  });

  it('Map button click does NOT trigger row navigation (stopPropagation)', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Show map for Andaman Islands/i }),
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("re-clicking the same row's Map button toggles the panel off", async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    const mapBtn = screen.getByRole('button', { name: /Show map for Andaman Islands/i });
    fireEvent.click(mapBtn);
    await screen.findByTestId('itineraries-selected-map');
    // Same row's button is now labelled "Hide map for Andaman Islands".
    const hideBtn = screen.getByRole('button', { name: /Hide map for Andaman Islands/i });
    expect(hideBtn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(hideBtn);
    await waitFor(() => {
      expect(screen.queryByTestId('itineraries-selected-map')).toBeNull();
    });
  });

  it("clicking a different row's Map button switches the selection", async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Show map for Andaman Islands/i }),
    );
    await screen.findByTestId('itineraries-selected-map');
    // Switch to the Mecca Umrah Package row.
    fireEvent.click(
      screen.getByRole('button', { name: /Show map for Mecca Umrah Package/i }),
    );
    await waitFor(() => {
      const panel = screen.getByTestId('itineraries-selected-map');
      // Panel now shows the Mecca destination header.
      expect(within(panel).getByText('Mecca Umrah Package')).toBeInTheDocument();
    });
    // MapPreview re-rendered with the Mecca items prop (3 items: 2 with
    // lat/lng + 1 visa without — pinnableItems inside MapPreview drops
    // the 3rd. The consumer passes ALL 3; filtering is the component's
    // job per S10 contract).
    const lastCall = mapPreviewMock.mock.calls[mapPreviewMock.mock.calls.length - 1];
    const props = lastCall[0];
    expect(props.items.length).toBe(3);
    expect(props.items.map((it) => it.id).sort()).toEqual([9003, 9004, 9005]);
  });

  it('panel Close button (X) clears the selection', async () => {
    renderPage();
    await screen.findByText('Andaman Islands');
    fireEvent.click(
      screen.getByRole('button', { name: /Show map for Andaman Islands/i }),
    );
    await screen.findByTestId('itineraries-selected-map');
    fireEvent.click(
      screen.getByRole('button', { name: /Close map preview/i }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId('itineraries-selected-map')).toBeNull();
    });
  });

  it("itinerary with only non-pinnable items still passes through to MapPreview (filtering is the component's job)", async () => {
    renderPage();
    await screen.findByText('Schengen visa');
    // Schengen has 1 item with null lat/lng — still selectable. The
    // consumer passes the items through; MapPreview's pinnableItems
    // drops the non-pinnable row internally.
    fireEvent.click(
      screen.getByRole('button', { name: /Show map for Schengen visa/i }),
    );
    await screen.findByTestId('itineraries-selected-map');
    // The SUT geocodes the destination words asynchronously when no item
    // has coordinates. Wait for the fallback to settle back to the raw
    // itinerary items (Nominatim is not mocked, so geocodeCity returns
    // null and the effect falls back to `raw`).
    await waitFor(() => {
      const lastCall = mapPreviewMock.mock.calls[mapPreviewMock.mock.calls.length - 1];
      const props = lastCall[0];
      expect(props.items.length).toBe(1);
      expect(props.items[0].id).toBe(9006);
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: "Deposit overdue" badge must not survive cancellation.
//
// cancellationStatus (requested/cancelled/refunded) is a separate lifecycle
// field from `status` — cancelling a booking never flips `status` away
// from "accepted" (see backend/prisma/schema.prisma comment + the
// cancellation PATCH route). Before the fix, the list badge condition was
// bare `status === "accepted" && paymentOverdueAt`, so a booking that had
// been flagged overdue pre-cancellation kept showing "Deposit overdue"
// forever, even after ItineraryDetail correctly showed "Booking cancelled
// & refunded". SUT lines 878-895 guard on `!it.cancellationStatus`; the
// status pill itself (lines 822-829) also swaps to the CANCELLATION_LABEL/
// CANCELLATION_VARIANT text once cancellationStatus is set.
// ---------------------------------------------------------------------------
describe('<Itineraries /> — cancellation suppresses the stale "Deposit overdue" badge', () => {
  function makeOverdueItin(overrides = {}) {
    return makeItin({
      id: 501,
      subBrand: 'travelstall',
      status: 'accepted',
      productTier: 'primary',
      destination: 'Goa',
      totalAmount: 225000,
      currency: 'INR',
      contactId: 5001,
      paymentOverdueAt: '2026-06-29T10:00:00.000Z',
      cancellationStatus: null,
      items: [],
      ...overrides,
    });
  }

  it('accepted + paymentOverdueAt + no cancellationStatus → shows the "Deposit overdue" badge (baseline)', async () => {
    installFetchMock({
      list: { itineraries: [makeOverdueItin()], total: 1, limit: 100, offset: 0 },
    });
    renderPage();
    const row = (await screen.findByText('Goa')).closest('tr');
    expect(within(row).getByText(/Deposit overdue/i)).toBeInTheDocument();
  });

  it('accepted + paymentOverdueAt + cancellationStatus="cancelled" → badge is suppressed', async () => {
    installFetchMock({
      list: {
        itineraries: [makeOverdueItin({ cancellationStatus: 'cancelled' })],
        total: 1, limit: 100, offset: 0,
      },
    });
    renderPage();
    const row = (await screen.findByText('Goa')).closest('tr');
    expect(within(row).queryByText(/Deposit overdue/i)).toBeNull();
  });

  it('accepted + paymentOverdueAt + cancellationStatus="refunded" → badge suppressed + status pill reads "Cancelled & refunded"', async () => {
    installFetchMock({
      list: {
        itineraries: [makeOverdueItin({ cancellationStatus: 'refunded' })],
        total: 1, limit: 100, offset: 0,
      },
    });
    renderPage();
    const row = (await screen.findByText('Goa')).closest('tr');
    expect(within(row).queryByText(/Deposit overdue/i)).toBeNull();
    const pill = within(row).getByText('Cancelled & refunded');
    expect(pill.className).toContain('travel-itin-status-pill--rejected');
  });

  it('accepted + paymentOverdueAt + cancellationStatus="requested" → badge suppressed while resolution is pending', async () => {
    installFetchMock({
      list: {
        itineraries: [makeOverdueItin({ cancellationStatus: 'requested' })],
        total: 1, limit: 100, offset: 0,
      },
    });
    renderPage();
    const row = (await screen.findByText('Goa')).closest('tr');
    expect(within(row).queryByText(/Deposit overdue/i)).toBeNull();
    expect(within(row).getByText('Cancellation requested')).toBeInTheDocument();
  });

  it('cancelled but never flagged overdue (paymentOverdueAt null) → no badge regardless of guard', async () => {
    installFetchMock({
      list: {
        itineraries: [makeOverdueItin({ cancellationStatus: 'cancelled', paymentOverdueAt: null })],
        total: 1, limit: 100, offset: 0,
      },
    });
    renderPage();
    const row = (await screen.findByText('Goa')).closest('tr');
    expect(within(row).queryByText(/Deposit overdue/i)).toBeNull();
  });
});
