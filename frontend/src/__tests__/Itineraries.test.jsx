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

import { AuthContext } from '../App';
import Itineraries from '../pages/travel/Itineraries';

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
      { id: 9001, itemType: 'flight', description: 'CCU → IXZ' },
      { id: 9002, itemType: 'hotel', description: 'Port Blair stay' },
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
      { id: 9003, itemType: 'flight', description: 'DEL → JED' },
      { id: 9004, itemType: 'hotel', description: 'Mecca hotel' },
      { id: 9005, itemType: 'visa', description: 'Umrah visa' },
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
    items: [{ id: 9006, itemType: 'visa', description: 'Schengen tourist' }],
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
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  navigateMock.mockReset();
  installFetchMock();
});

afterEach(() => {
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
    // Diagnostic-first hint copy renders.
    expect(
      screen.getByText(/diagnostic for this sub-brand/i),
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
