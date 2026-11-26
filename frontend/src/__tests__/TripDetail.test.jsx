/**
 * TripDetail.test.jsx — vitest + RTL coverage for the Travel-vertical TMC
 * trip-detail page (frontend/src/pages/travel/TripDetail.jsx).
 *
 * Scope — pins the page-surface invariants for the trip-detail tabbed page:
 *
 *   1. Loading state: "Loading…" placeholder before first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning).
 *   2. Route-param handling: MemoryRouter wrapped with route path
 *      /travel/trips/:id + initialEntries=['/travel/trips/101'] — fetch
 *      fires with the matching id in the URL.
 *   3. GET on mount: hits /api/travel/trips/101 (single canonical endpoint).
 *   4. Not-found state: backend returns null trip body → renders "Trip not
 *      found." copy + Back-to-trips link (not a crash).
 *   5. Successful render: heading shows tripCode + Luggage icon, status
 *      badge renders the literal status text (e.g. "confirmed"), and the
 *      destination / depart / return appear in the header sub-row.
 *   6. Tab strip: 5 tabs render (Overview / Participants / Documents /
 *      Rooming / Payment plan) with role="tab" + aria-selected wiring.
 *   7. Overview tab (default): renders 9 metric cards including Destination,
 *      Depart, Return, Legal entity, Price/student, Participants count,
 *      Required docs, Payment plan ("configured" / "not set"), and the
 *      landing-page experience card.
 *   8. Participants tab: switching to it shows the count caption and an
 *      empty-state when no participants; populated trip renders names + the
 *      Trash2 remove buttons (one per participant).
 *   9. Participants tab — add: typing a fullName + clicking Add POSTs
 *      /api/travel/trips/:id/participants and surfaces notify.success.
 *  10. Rooming tab: triggers a secondary GET to /api/travel/trips/:id/rooming
 *      on mount (the inner tab fetches its own data) and renders the room
 *      count caption + Download-XLSX link.
 *  11. Documents tab: admin-defined names and accepted file types render in
 *      the participant upload-status matrix.
 *  12. Documents tab: add/edit/remove requests use the trip requirement API.
 *  13. Documents tab: the full trip consent document loads for editing and
 *      updated clauses are sent to the requirement API.
 *  13. Load error: GET rejection surfaces notify.error with the body.error.
 *
 * Backend contract pinned (per backend/routes/travel_trips.js):
 *   GET /api/travel/trips/:id → 200 { ...trip, participants[],
 *     documentRequirements[], _count? } | 404 "Trip not
 *     found" (catch path in SUT renders the !trip branch).
 *   POST /api/travel/trips/:id/participants body { fullName, parentName?,
 *     parentPhone? } → 201 created.
 *   GET /api/travel/trips/:id/rooming → 200 { rooming: [] }.
 *
 * Drift pinned (prompt vs. actual code):
 *   - Prompt mentioned "day-by-day itinerary" — the SUT does NOT render a
 *     day-by-day section. Day-by-day rendering lives in a separate
 *     ItineraryDetail page. Tests OMIT day-card assertions.
 *   - Prompt mentioned "suppliers section" — the SUT has no suppliers tab.
 *     Suppliers are managed elsewhere (Suppliers admin page). Tests OMIT.
 *   - Prompt mentioned "status timeline" — the SUT has no status timeline.
 *     Status is a single badge in the page header. Tests OMIT timeline.
 *   - Prompt mentioned "status-transition flow" — the SUT has no status-
 *     transition CTA on the detail page; status is read-only (changes
 *     happen via the Deal in the sales pipeline). Tests OMIT transitions.
 *   - Prompt mentioned "edit flow" — there is no top-level "Edit trip"
 *     button; the page is read-only at the header level. Per-tab edits
 *     exist (rooming PATCH, payment-plan PUT, add-participant POST) but they
 *     are not gated by an explicit Edit toggle.
 *   - Prompt mentioned "RBAC: USER role hides mutation CTAs" — the SUT
 *     does NOT consume AuthContext + does NOT gate CTAs by role. All
 *     mutation buttons render unconditionally; authz is enforced server-
 *     side. Tests OMIT canWrite=false assertions.
 *   - Prompt mentioned "sub-brand badge" — TMC-only context, no sub-brand
 *     badge rendered (TMC-only routing is enforced by sidebar + backend
 *     requireTmcAccess middleware). Tests OMIT sub-brand assertions.
 *   - Prompt mentioned 404 handling rendering "Not found" — the SUT
 *     actually renders "Trip not found." (with the period) under the
 *     trip=null branch when fetchApi resolves with null. A true 404 from
 *     fetchApi throws → catch path notify.error fires instead. Tests pin
 *     BOTH paths (null → "Trip not found." + reject → notify.error).
 *   - The notify mock module path is '../utils/notify' (sibling Trips test
 *     uses the same pattern).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api; getAuthToken returns a stable token.
 *   - notifyObj is a STABLE module-level reference (Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap useCallback identity
 *     across the load + tab mutation flows).
 *   - MemoryRouter wraps with Routes + Route path="/travel/trips/:id" so
 *     useParams resolves the id parameter the SUT reads on line 46.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning: sync getBy for async data is a
 *     CI race trap).
 *   - confirm() is stubbed to true so the add-participant happy path is
 *     deterministic (the SUT does NOT use confirm() on add, only on
 *     remove; stub kept anyway for symmetry).
 *   - For dates: use fixed ISO strings + locale-tolerant substring
 *     assertions on the header sub-row.
 *
 * Path: flat __tests__/ per tick #111 path-coordination — sibling
 * Agent A may own a different travel file in the same flat dir; this
 * test file owns TripDetail.test.jsx exclusively (verified prior to
 * commit via ls + git status; no other agent touches this path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../App';

const fetchApiMock = vi.fn();
const rawFetchMock = vi.fn();
const originalFetch = globalThis.fetch;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes notify into useCallback at line 52-58, so a
// fresh object per render would re-fire load() each time and break
// loading-state assertions.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyPrompt = vi.fn(() => Promise.resolve('Documents do not meet trip requirements'));
const notifyObj = {
  error: notifyError,
  success: notifySuccess,
  confirm: notifyConfirm,
  prompt: notifyPrompt,
};
const CONSENT_TERMS_TEMPLATE = 'TERMS AND CONDITIONS FOR INTERNATIONAL EDUCATIONAL TRAVEL PROGRAMMES These Terms and Conditions govern the booking and participation. 1. DEFINITIONS Unless the context otherwise requires: A. “Participant” means the student enrolled in the programme. 2. ACCEPTANCE OF TERMS A. By accepting these Terms, the Parent or Guardian agrees to the programme rules.';
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import TripDetail from '../pages/travel/TripDetail';
import LandingPageBuilder from '../pages/LandingPageBuilder';

// Canonical trip fixture — exercises Overview, Participants, Documents,
// Rooming, and Payment Plan surfaces. One participant lets us assert both
// populated + remove-button shape.
function makeTrip(overrides = {}) {
  return {
    id: 101,
    tenantId: 1,
    tripCode: 'TMC-AND-2026-MUMBAI-G7',
    destination: 'Andaman',
    schoolContactId: 5001,
    schoolName: 'The Modern Classroom',
    departDate: '2026-12-01T00:00:00.000Z',
    returnDate: '2026-12-08T00:00:00.000Z',
    pricePerStudent: 125000,
    status: 'confirmed',
    legalEntity: 'tmc_nexus',
    driveFolderId: null,
    participants: [
      { id: 901, fullName: 'Anaya Sharma', parentName: 'Riya Sharma', parentPhone: '+919876543210' },
    ],
    documentRequirements: [
      { id: 1, docType: 'School medical clearance', acceptedFileTypes: ['pdf', 'docx'], required: true },
      { id: 2, docType: 'Emergency contact letter', acceptedFileTypes: ['pdf', 'jpg'], required: true },
    ],
    _count: { rooming: 0 },
    paymentPlan: null,
    createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

// Fetch router — keyed by URL prefix + method. Tests override the
// `trip` surface via overrides; everything else returns the default.
function installFetchMock({
  trip = makeTrip(),
  rooming = { rooming: [] },
  roomCreate = { id: 7002, tripId: 101, roomNumber: '101', roomType: 'twin', sharingCapacity: 2, participantIds: '[]' },
  roomUpdate = { id: 7001, tripId: 101, roomNumber: '101', roomType: 'twin', sharingCapacity: 2, participantIds: '[]' },
  participantPost = { id: 902, fullName: 'Test Add' },
  // Phase 8 — pending registrations + landing-page mocks default to
  // empty / not-linked so existing tests stay green.
  pendingRegs = [],
  landingPage = { status: 404, body: { code: 'NOT_LINKED' } }, // 404 = no page linked
  builderLandingPage = null,
  landingPageCreate = null, // override to return a created page on POST
  registrationDecide = null, // override per-test to assert approve/reject
  itinerarySuggest = null, // override to return a custom AI suggestion
  parentLink = 'https://example.com/tmc/register/parent?token=abc',
  teachers = [],
} = {}) {
  let currentRooming = rooming;
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    // GET /api/travel/trips/:id (single — exact match guards against the
    // POST-participants endpoint also starting with /api/travel/trips/101).
    if (method === 'GET' && /^\/api\/travel\/trips\/\d+$/.test(url)) {
      if (trip instanceof Error) return Promise.reject(trip);
      return Promise.resolve(trip);
    }
    if (method === 'GET' && /^\/api\/travel\/trips\/\d+\/documents$/.test(url)) {
      return Promise.resolve({ documents: [], consentTermsTemplate: CONSENT_TERMS_TEMPLATE, consentTermsSaved: '' });
    }
    if (method === 'GET' && url === '/api/portal/tmc/staff/teachers') {
      return Promise.resolve({ teachers });
    }
    if (method === 'PATCH' && /^\/api\/travel\/trips\/\d+$/.test(url)) {
      return Promise.resolve({ ok: true });
    }
    // Admin-only TMC parent registration link generation
    if (method === 'POST' && /^\/api\/portal\/tmc\/staff\/trips\/\d+\/parent-link$/.test(url)) {
      return Promise.resolve({ link: parentLink });
    }
    // GET /api/travel/trips/:id/rooming
    if (method === 'GET' && /^\/api\/travel\/trips\/\d+\/rooming$/.test(url)) {
      return Promise.resolve(currentRooming);
    }
    if (method === 'POST' && /^\/api\/travel\/trips\/\d+\/rooming$/.test(url)) {
      if (Array.isArray(currentRooming?.rooming)) {
        currentRooming = { ...currentRooming, rooming: [...currentRooming.rooming, roomCreate] };
      }
      return Promise.resolve(roomCreate);
    }
    if (method === 'PATCH' && /^\/api\/travel\/trips\/\d+\/rooming\/\d+$/.test(url)) {
      return Promise.resolve(roomUpdate);
    }
    if (method === 'DELETE' && /^\/api\/travel\/trips\/\d+\/rooming\/\d+$/.test(url)) {
      return Promise.resolve({ deleted: true });
    }
    // POST /api/travel/trips/:id/participants
    if (method === 'POST' && /^\/api\/travel\/trips\/\d+\/participants$/.test(url)) {
      if (participantPost instanceof Error) return Promise.reject(participantPost);
      return Promise.resolve(participantPost);
    }
    // DELETE participant
    if (method === 'DELETE' && /^\/api\/travel\/trips\/\d+\/participants\/\d+$/.test(url)) {
      return Promise.resolve({});
    }
    // Phase 8 — GET /api/travel/trips/:id/registrations (pending list)
    if (method === 'GET' && /^\/api\/travel\/trips\/\d+\/registrations$/.test(url)) {
      return Promise.resolve(pendingRegs);
    }
    // Phase 8 — POST /api/travel/trips/:id/registrations/:rid/(approve|reject)
    if (method === 'POST' && /^\/api\/travel\/trips\/\d+\/registrations\/\d+\/(approve|reject)$/.test(url)) {
      if (registrationDecide instanceof Error) return Promise.reject(registrationDecide);
      return Promise.resolve(registrationDecide || { ok: true });
    }
    // Phase 8 — GET /api/travel/trips/:id/landing-page (404 = not linked)
    if (method === 'GET' && /^\/api\/travel\/trips\/\d+\/landing-page$/.test(url)) {
      if (landingPage instanceof Error) return Promise.reject(landingPage);
      if (landingPage && landingPage.status === 404) {
        const err = new Error('NOT_LINKED');
        err.status = 404;
        err.body = landingPage.body;
        return Promise.reject(err);
      }
      return Promise.resolve(landingPage);
    }
    if (method === 'POST' && url === '/api/landing-pages/77/publish') return Promise.resolve({ status: 'PUBLISHED' });
    // GET /api/landing-pages/:id (builder surface reached from the trip page)
    if (method === 'GET' && /^\/api\/landing-pages\/\d+$/.test(url)) {
      if (builderLandingPage instanceof Error) return Promise.reject(builderLandingPage);
      if (builderLandingPage) return Promise.resolve(builderLandingPage);
      return Promise.resolve({
        id: 77,
        title: 'Trip landing page',
        slug: 'trip-landing-page',
        status: 'DRAFT',
        content: JSON.stringify([]),
      });
    }
    // Phase 8 — POST /api/travel/trips/:id/landing-page (lazy create)
    if (method === 'POST' && /^\/api\/travel\/trips\/\d+\/landing-page$/.test(url)) {
      if (landingPageCreate instanceof Error) return Promise.reject(landingPageCreate);
      return Promise.resolve(landingPageCreate || {
        id: 77, slug: 'trip-tmc-and-2026-mumbai-g7', status: 'DRAFT', tripId: 101,
        title: 'Andaman Trip — TMC-AND-2026-MUMBAI-G7',
      });
    }
    // Phase 8 — POST /api/travel/itineraries/suggest (AI itinerary generation)
    if (method === 'POST' && url === '/api/travel/itineraries/suggest') {
      if (itinerarySuggest instanceof Error) return Promise.reject(itinerarySuggest);
      return Promise.resolve(itinerarySuggest || {
        suggestion: {
          daySplit: [
            { day: 1, title: 'Arrival', items: [{ description: 'Airport transfer and hotel check-in' }] },
            { day: 2, title: 'Local Sightseeing', items: [{ description: 'Guided city tour' }] },
          ],
        },
        model: 'gemini-flash',
        stub: false,
      });
    }
    // Payment-plan + instalments (the Payment tab fires them on mount when
    // active, but we never switch to that tab; included for completeness so
    // any latent fire doesn't reject and surface a stray notify.error).
    if (method === 'GET' && /payment-plan$/.test(url)) return Promise.resolve(null);
    if (method === 'GET' && /instalments$/.test(url)) return Promise.resolve({ instalments: [] });
    return Promise.resolve(null);
  });
}

// Render at /travel/trips/101 with the Routes + Route wrapper so useParams
// reads { id: '101' }. The default role is ADMIN so room inventory controls
// can be exercised; individual tests can pass a lower role to check read-only.
function renderPage(tripId = 101, entryState = null, role = 'ADMIN') {
  let entry = `/travel/trips/${tripId}`;
  if (entryState) {
    if (typeof entryState === 'object' && (Object.prototype.hasOwnProperty.call(entryState, 'pathname') || Object.prototype.hasOwnProperty.call(entryState, 'search') || Object.prototype.hasOwnProperty.call(entryState, 'hash'))) {
      entry = {
        pathname: entryState.pathname || `/travel/trips/${tripId}`,
        search: entryState.search || '',
        hash: entryState.hash || '',
        state: Object.prototype.hasOwnProperty.call(entryState, 'state') ? entryState.state : null,
      };
    } else {
      entry = { pathname: `/travel/trips/${tripId}`, state: entryState };
    }
  }
  const authValue = {
    user: { role, tenant: { vertical: 'travel' } },
    tenant: { vertical: 'travel' },
    loading: false,
  };
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/travel/trips/:id" element={<TripDetail />} />
          <Route path="/landing-pages/builder/:id" element={<LandingPageBuilder />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  rawFetchMock.mockReset();
  globalThis.fetch = rawFetchMock;
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  notifyPrompt.mockReset();
  notifyPrompt.mockResolvedValue('Documents do not meet trip requirements');
  // Stub window.confirm for the remove-participant path (used only in the
  // remove case; harmless elsewhere).
  vi.stubGlobal('confirm', vi.fn(() => true));
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    delete navigator.clipboard;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<TripDetail /> — load lifecycle', () => {
  it('shows "Loading…" before the GET resolves', async () => {
    let resolveTrip;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'GET' && /^\/api\/travel\/trips\/\d+$/.test(url)) {
        return new Promise((res) => { resolveTrip = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolveTrip(makeTrip());
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
  });

  it('GETs /api/travel/trips/:id on mount with the route-param id', async () => {
    renderPage(101);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101' && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 })).toBeInTheDocument();
  });

  it('renders "Trip not found." + Back-to-trips link when fetch resolves null', async () => {
    installFetchMock({ trip: null });
    renderPage();
    expect(await screen.findByText(/Trip not found\./i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Trips/i })).toHaveAttribute(
      'href',
      '/travel/trips',
    );
  });

  it('GET rejection surfaces notify.error with the body.error', async () => {
    const err = new Error('boom');
    err.body = { error: 'Failed to load trip' };
    installFetchMock({ trip: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to load trip');
    });
  });
});

describe('<TripDetail /> — header + status badge', () => {
  it('renders the tripCode heading + destination + status badge after load', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /TMC-AND-2026-MUMBAI-G7/ }),
    ).toBeInTheDocument();
    // The header sub-row + Overview card both contain "Andaman" — assert
    // ≥ 1 occurrence rather than uniqueness (per CLAUDE.md `getAllByText`
    // standing rule for labels that appear in both filter chrome AND row
    // cells).
    expect(screen.getAllByText(/Andaman/).length).toBeGreaterThanOrEqual(1);
    // Status badge text — uppercased via CSS but the DOM text node is the
    // literal status string.
    expect(screen.getByText('confirmed')).toBeInTheDocument();
  });

  it('Trips back-link in header points to /travel/trips', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    const backLink = screen.getByRole('link', { name: /Trips/i });
    expect(backLink).toHaveAttribute('href', '/travel/trips');
  });
});

describe('<TripDetail /> — tab strip', () => {
  it('normalizes the removed microsite URL to Overview', async () => {
    renderPage(101, { search: '?tab=microsite' });
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    expect(screen.getByRole('tab', { name: /Overview/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('restores the active tab from the trip URL after refresh', async () => {
    renderPage(101, { search: '?tab=documents' });
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    expect(screen.getByRole('tab', { name: /Documents/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Documents to collect')).toBeInTheDocument();
  });

  it('uses preserved report result URL when opened from Reports drill-down', async () => {
    renderPage(101, { backTo: '/travel/trips?status=confirmed&from=reports', backLabel: 'Back to reports results' });
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    expect(screen.getByRole('link', { name: /Back to reports results/i })).toHaveAttribute(
      'href',
      '/travel/trips?status=confirmed&from=reports',
    );
  });

  it('renders all 5 tabs with role="tab" + Overview selected by default', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    const labels = tabs.map((t) => t.textContent.trim());
    expect(labels).toEqual(
      expect.arrayContaining(['Overview', 'Participants', 'Documents', 'Rooming', 'Payment plan']),
    );
    // Overview is selected by default.
    const overview = screen.getByRole('tab', { name: /Overview/i });
    expect(overview).toHaveAttribute('aria-selected', 'true');
  });
});

describe('<TripDetail /> — Overview tab', () => {
  it('allows multiple teachers to be assigned to the same trip', async () => {
    installFetchMock({
      trip: makeTrip({ teacherAssignments: [{ teacherContactId: 42 }] }),
      teachers: [
        { id: 42, name: 'Asha Teacher' },
        { id: 43, name: 'Mira Teacher' },
      ],
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Assigned teachers: Asha Teacher' }));
    expect(await screen.findByRole('checkbox', { name: 'Asha Teacher' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mira Teacher' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save teachers' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/travel/trips/101',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ teacherContactIds: [42, 43] }),
      }),
    ));
  });

  it('expands the teacher picker within the sharing layout without covering nearby actions', async () => {
    installFetchMock({
      trip: makeTrip({ teacherContactId: 42 }),
      teachers: [
        { id: 42, name: 'Asha Teacher' },
        { id: 43, name: 'Mira Teacher' },
      ],
    });
    renderPage();

    const trigger = await screen.findByRole('button', { name: 'Assigned teachers: Asha Teacher' });
    fireEvent.click(trigger);

    const teacherMenu = await screen.findByRole('group', { name: 'Available TMC teachers' });
    expect(teacherMenu.parentElement).toContainElement(trigger);
    expect(teacherMenu.parentElement).toContainElement(teacherMenu);
    expect(teacherMenu).toHaveStyle({ maxHeight: '240px', overflowY: 'auto' });
    expect(teacherMenu.style.position).toBe('');
    expect(screen.getByRole('button', { name: 'Generate parent link' })).toBeEnabled();
    const landingPagesLink = screen.getByRole('link', { name: 'Go to Landing Pages' });
    expect(landingPagesLink).toHaveAttribute('href', '/landing-pages');
    expect(landingPagesLink).toHaveStyle({ opacity: '1', filter: 'none' });
  });

  it('copies the teacher portal registration link from trip sharing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    installFetchMock();
    renderPage();

    const copyButton = await screen.findByRole('button', { name: 'Copy teacher portal link' });
    const accessHeader = screen.getByRole('heading', { name: 'Access and sharing' }).parentElement.parentElement;
    expect(accessHeader).toContainElement(copyButton);
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('/tmc/register/teacher?tenantSlug=travel-stall&tmcRole=TEACHER'),
    ));
    expect(notifySuccess).toHaveBeenCalledWith('Teacher registration link copied');
  });

  it('lets an admin generate the parent link after a teacher is assigned', async () => {
    const parentLink = 'https://example.com/tmc/register/parent?token=abc';
    installFetchMock({
      trip: makeTrip({ teacherContactId: 42 }),
      parentLink,
      teachers: [{ id: 42, name: 'Asha Teacher' }],
    });
    renderPage();

    const generateButton = await screen.findByRole('button', { name: 'Generate parent link' });
    fireEvent.click(generateButton);

    expect(await screen.findByDisplayValue(parentLink)).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/portal/tmc/staff/trips/101/parent-link',
      { method: 'POST' },
    );
  });

  it('renders hero band + KPI cards + summary bands wired to the ops-dashboard surface', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    // Hero band shows Destination label + the value + legal entity inline.
    expect(screen.getByText('Destination')).toBeInTheDocument();
    expect(screen.getByText('tmc_nexus')).toBeInTheDocument();
    // KPI strip + summary bands keep these labels.
    expect(screen.getByText('Required docs')).toBeInTheDocument();
    expect(screen.getByText('Trip status')).toBeInTheDocument();
    const kpiCards = [...document.querySelectorAll('.trip-overview-kpi-card')];
    expect(kpiCards).toHaveLength(3);
    expect(kpiCards.every((card) => card.style.padding === '14px' && card.style.width === '100%')).toBe(true);
    expect(kpiCards[2].querySelector('div[style*="overflow-wrap"]')).toHaveStyle({ overflowWrap: 'anywhere' });
    // 'Participants' / 'Payment plan' appear as both tab chrome AND in the
    // overview (KPI card / summary band title). Scope via
    // getAllByText.
    expect(screen.getAllByText('Participants').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Payment plan').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('landing-page-card')).toBeInTheDocument();
    // Summary-band status pills (rendered uppercase via CSS; literal mixed-
    // case in DOM).
    expect(screen.getByText('Not set yet')).toBeInTheDocument();
  });

  it('shows itinerary family context without merging registration ownership', async () => {
    installFetchMock({
      trip: makeTrip({
        familyParent: {
          id: 90,
          tripCode: 'TMC-AND-2026-PRIMARY',
          destination: 'Andaman',
        },
        familyVariants: [],
      }),
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });

    expect(screen.getByText('Trip family')).toBeInTheDocument();
    expect(screen.getByText(/Teacher assignments, landing pages, parent links/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Primary trip: TMC-AND-2026-PRIMARY/i }))
      .toHaveAttribute('href', '/travel/trips/90');
  });
});

describe('<TripDetail /> — Participants tab', () => {
  it('switching to Participants shows the registered roster and no manual add CTA', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    expect(await screen.findByTestId('participants-list-count')).toHaveTextContent('1 participant');
    expect(screen.queryByTestId('participants-tab-count')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Registered participants' })).not.toBeInTheDocument();
    // Existing participant row.
    expect(screen.getByText('Anaya Sharma')).toBeInTheDocument();
    expect(screen.getByTestId('registered-participants-list')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import participants/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add participant/i })).not.toBeInTheDocument();
  });

  it('empty trip renders the empty roster copy and a zero participant list badge', async () => {
    installFetchMock({ trip: makeTrip({ participants: [] }) });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    // Click Participants tab — scope via getAllByRole + label filter to
    // avoid the regex ambiguity that bit the prior shape (the count caption
    // "0 participants" can flap the role-name lookup in some renders).
    const tabs = screen.getAllByRole('tab');
    const participantsTab = tabs.find((t) => /Participants/.test(t.textContent));
    expect(participantsTab).toBeTruthy();
    fireEvent.click(participantsTab);
    expect(await screen.findByText(/No registered participants yet/i)).toBeInTheDocument();
    expect(screen.getByTestId('participants-list-count')).toHaveTextContent('0 participants');
  });

  it('uses the configured document requirements without trip-type restrictions', async () => {
    installFetchMock({
      trip: makeTrip({
        tripType: 'day_trip',
        documentRequirements: [{ id: 9, docType: 'Teacher emergency contact', acceptedFileTypes: ['docx'], required: true }],
      }),
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma');

    fireEvent.click(screen.getByRole('tab', { name: /Documents/i }));
    expect(screen.getByText('Teacher emergency contact')).toBeInTheDocument();
    expect(screen.getByText('DOCX · Required')).toBeInTheDocument();
    expect(screen.queryByText(/passport status|upload passport|sync passport/i)).not.toBeInTheDocument();
  });

  it('keeps digital consent review out of the simplified participant roster', async () => {
    installFetchMock({
      trip: makeTrip({
        participants: [{
          id: 901,
          fullName: 'Anaya Sharma',
          parentName: 'Riya Sharma',
          parentPhone: '+919876543210',
          parentDocuments: [{
            id: 502,
            documentRequirementId: 1,
            documentType: 'Parent consent form',
            captureMode: 'digital_consent',
            answers: {
              parentName: 'Riya Sharma',
              participantName: 'Anaya Sharma',
              relationship: 'Parent / Guardian',
              signatureName: 'Riya Sharma',
            },
            termsSnapshot: 'I agree to this trip.',
            agreedAt: '2026-06-01T10:00:00.000Z',
          }],
        }],
        documentRequirements: [{ id: 1, docType: 'Parent consent form', captureMode: 'digital_consent', required: true }],
      }),
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    expect(await screen.findByTestId('registered-participants-list')).toBeInTheDocument();
    expect(screen.queryByTestId('view-participant-901-1')).not.toBeInTheDocument();
    expect(rawFetchMock).not.toHaveBeenCalled();
  });

  it('does not expose manual participant creation', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByTestId('registered-participants-list');
    expect(screen.queryByRole('button', { name: /Add participant/i })).not.toBeInTheDocument();
    expect(fetchApiMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('requires the import flow for adding participants', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Import participants/i }));
    expect(await screen.findByTestId('participant-bulk-import-modal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm import/i })).toBeDisabled();
  });

  it('bulk import panel opens a modal, posts multipart file, and shows the summary', async () => {
    rawFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ inserted: 1, updated: 1, skipped: 0, errors: [], total: 2 }),
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma');

    expect(screen.queryByTestId('participant-bulk-import-modal')).toBeNull();
    expect(screen.queryByLabelText(/Bulk import participants file/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Import participants/i }));
    expect(await screen.findByTestId('participant-bulk-import-modal')).toBeInTheDocument();

    const file = new File(['fullName,parentPhone\nKabir Mehta,9876543210'], 'participants.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText(/Bulk import participants file/i), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirm import/i }));
    await waitFor(() => {
      expect(rawFetchMock).toHaveBeenCalled();
    });
    const [url, opts] = rawFetchMock.mock.calls[0];
    expect(url).toBe('/api/travel/trips/101/participants/import');
    expect(opts?.method).toBe('POST');
    expect(opts?.body).toBeInstanceOf(FormData);
    expect(await screen.findByTestId('participant-bulk-import-result')).toBeInTheDocument();
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Imported 1, updated 1/i));
  });

  it('shows the participant import schema and downloads the CSV template', async () => {
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:participant-template');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    rawFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob(['fullName,parentName'], { type: 'text/csv' })),
    });

    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma');
    fireEvent.click(screen.getByRole('button', { name: /Import participants/i }));

    const schema = await screen.findByTestId('participant-import-schema');
    expect(schema).toHaveTextContent('fullName');
    expect(screen.getByRole('dialog')).toHaveTextContent(/first four columns are required/i);
    expect(screen.getByRole('button', { name: /CSV template/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /XLSX template/i })).toBeInTheDocument();
    expect(screen.getByText('applicationStatus')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /CSV template/i }));
    await waitFor(() => {
      expect(rawFetchMock).toHaveBeenCalledWith(
        '/api/travel/trips/101/participants/import-template?format=csv',
        { headers: { Authorization: 'Bearer test-token' } },
      );
    });
    expect(createObjectUrlSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Downloaded CSV participant template/i));
  });
});

describe('<TripDetail /> — Rooming tab', () => {
  it('switching to Rooming loads inventory and exposes admin setup controls', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101/rooming' && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    // Empty rooming caption: "0 rooms · 1 of 1 participant unassigned"
    // (singular form for count === 1; rooming returns []).
    expect(await screen.findByText(/0 rooms/)).toBeInTheDocument();
    // Exports stay hidden on the trip setup page.
    expect(screen.queryByRole('link', { name: /Download rooming as XLSX/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download rooming as PDF/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Auto-allocate/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add room/i })).toBeInTheDocument();
  });

  it('admin adds a room number and sharing capacity without assigning participants', async () => {
    installFetchMock({
      roomCreate: { id: 7002, tripId: 101, roomNumber: '305', roomType: 'custom', sharingCapacity: 5, participantIds: '[]' },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add room' }));

    expect(screen.getByText(/Set a room number and the maximum number of participants/i)).toBeInTheDocument();
    expect(screen.getByText(/Maximum number of participants teachers can assign to this room/i)).toBeInTheDocument();
    const addRoomButton = screen.getByRole('button', { name: 'Add room' });
    expect(addRoomButton).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Room number' }), { target: { value: '305' } });
    expect(addRoomButton).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Sharing capacity' }), { target: { value: '5' } });
    expect(addRoomButton).toBeEnabled();
    expect(screen.getByText('Room is ready to save.')).toBeInTheDocument();
    expect(screen.queryByText(/Participants \(0 selected\)/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url, options]) => (
        url === '/api/travel/trips/101/rooming' && options?.method === 'POST'
      ));
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ roomNumber: '305', sharingCapacity: 5 });
    });
    expect(notifySuccess).toHaveBeenCalledWith('Room added for teacher assignment');
  });

  it('USER role can view room inventory but cannot add or assign rooms', async () => {
    renderPage(101, null, 'USER');
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    expect(await screen.findByText(/No rooms configured yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add room/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Assign participants/i })).not.toBeInTheDocument();
  });

  it('filters orphaned participantIds so room occupancy and the unassigned counter agree', async () => {
    // Regression: room.participantIds JSON had [901, 999] where 999 was a
    // since-deleted participant. Pre-fix the orphan inflated both the
    // room-tile capacity readout and made the header's unassigned count
    // disagree with the current participant roster. The orphan should be
    // dropped on load so only the surviving participant contributes.
    const tripFixture = makeTrip({
      participants: [
        { id: 901, fullName: 'Anaya Sharma' },
      ],
    });
    const roomingWithOrphan = {
      rooming: [
        {
          id: 7001,
          tripId: 101,
          roomNumber: '101',
          roomType: 'twin',
          participantIds: JSON.stringify([901, 999]),
        },
      ],
    };
    installFetchMock({ trip: tripFixture, rooming: roomingWithOrphan });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    // Room tile capacity readout must reflect the SURVIVING participant
    // only — not the orphaned 999. Pre-fix this rendered "2 / 2 assigned".
    expect(await screen.findByText(/2 sharing \(1\/2\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/2 \/ 2 assigned/)).toBeNull();
    // Header counter agrees with the tile: 1 valid participant who IS
    // assigned → 0 unassigned of 1 total.
    expect(screen.getByText(/0 of 1 participant unassigned/)).toBeInTheDocument();
  });
});

// ─── EXTENSION WAVE — 2026-05-26 ────────────────────────────────────────
//
// Pins surface that the existing 15-case spec does NOT cover yet. Drift
// notes (prompt vs. actual SUT) carried over from the header block; this
// wave avoids the false-claim items (DigiLocker / Drive folder / RBAC /
// status transitions / document checklist as a tab) which the SUT does
// NOT implement. Instead it pins:
//
//   - Participants remove flow (Trash2 + window.confirm + DELETE).
//   - Participants add — POST rejection surfaces notify.error.
//   - Participants add — Cancel closes the inline form.
//   - Header date-format edges (null returnDate → "—" via the fmt() helper).
//   - Rooming — admin creates room inventory with a sharing capacity.
//   - Rooming — empty-state copy and role-specific controls.
//   - Payment plan — loading-state then empty editor copy.
//   - Payment plan — Add instalment + validation (missing dueDate).
//   - Payment plan — total recomputes after adding rows.
//   - Overview card values — Price/student formatted with ₹ + locale.
//
// All assertions use stable mocks + findBy / waitFor + getAllByText where
// the same label appears in tab + card chrome.

describe('<TripDetail /> — Participants remove flow', () => {
  it('does not expose participant deletion from the simplified roster', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByTestId('registered-participants-list');
    expect(screen.queryByRole('button', { name: /Remove/i })).not.toBeInTheDocument();
  });

  it('does not issue participant DELETE requests from the simplified roster', async () => {
    notifyConfirm.mockResolvedValue(false);
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByTestId('registered-participants-list');
    expect(fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'DELETE')).toHaveLength(0);
  });
});

describe('<TripDetail /> — Participants add error + cancel', () => {
  it('does not expose the legacy participant POST flow', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByTestId('registered-participants-list');
    expect(screen.queryByRole('button', { name: /Add participant/i })).not.toBeInTheDocument();
    expect(fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0);
  });

  it('keeps the import modal closed until the admin requests it', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByTestId('registered-participants-list');
    expect(screen.queryByTestId('participant-bulk-import-modal')).not.toBeInTheDocument();
  });
});

describe('<TripDetail /> — Header date edge cases', () => {
  it('renders "—" placeholder when returnDate is null', async () => {
    installFetchMock({ trip: makeTrip({ returnDate: null }) });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    // Header sub-row reads "{depart} → {return} · {destination}". When
    // returnDate is null the fmt() helper renders "—".
    // The em-dash is the only place "—" appears on the un-published trip
    // (Overview cards use English copy, not em-dashes); assert ≥ 1 instance.
    expect(screen.getAllByText((content) => content.includes('—')).length).toBeGreaterThanOrEqual(1);
  });

  it('Overview hero band renders locale-formatted price / student inline', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    // Price now renders in the hero band as "<IndianRupee icon> {value} /
    // student" — the ₹ glyph is an SVG icon, so assert the locale-formatted
    // numeric value + "/ student" suffix appears (the matcher reads the
    // text node, ignoring the sibling icon).
    const hits = screen.getAllByText((c) => /[\d,]+\s*\/\s*student/.test(c));
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('<TripDetail /> - Rooming admin setup', () => {
  it('shows room counts and lets admins add room inventory when none exists', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    expect(await screen.findByText(/No rooms configured yet/i)).toBeInTheDocument();
    expect(screen.getByText(/0 rooms/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Auto-allocate/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add room/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download rooming/i })).not.toBeInTheDocument();
  });

  it('allows admins to edit room number and sharing without assigning participants', async () => {
    const trip = makeTrip({
      participants: [{ id: 901, fullName: 'Anaya Sharma' }],
    });
    installFetchMock({
      trip,
      rooming: {
        rooming: [{
          id: 7001,
          tripId: 101,
          roomNumber: '101',
          roomType: 'twin',
          sharingCapacity: 2,
          participantIds: JSON.stringify([901]),
        }],
      },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    expect(await screen.findByText('Room 101')).toBeInTheDocument();
    expect(screen.getByText('Anaya Sharma')).toBeInTheDocument();
    expect(screen.getByTitle(/Unassign participants in the teacher portal before deleting/i)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit room' }));
    const roomNumber = screen.getByRole('textbox', { name: 'Room number' });
    fireEvent.change(roomNumber, { target: { value: '102' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Sharing capacity' }), { target: { value: '6' } });
    expect(screen.queryByText(/Participants \(1 selected\)/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url, options]) => (
        url === '/api/travel/trips/101/rooming/7001' && options?.method === 'PATCH'
      ));
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ roomNumber: '102', sharingCapacity: 6 });
    });
  });
});

describe('<TripDetail /> — Payment plan tab', () => {
  it('switching to Payment plan shows the empty-state editor copy', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    // Heading reads "Create payment plan" when there's no existing plan.
    expect(
      await screen.findByRole('heading', { name: /Create payment plan/i }),
    ).toBeInTheDocument();
    // Empty editor copy.
    expect(screen.getByText(/No instalments/i)).toBeInTheDocument();
    // Add instalment button visible.
    expect(screen.getByRole('button', { name: /Add instalment/i })).toBeInTheDocument();
  });

  it('clicking "Add instalment" prepends a row + total starts at ₹0', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    await screen.findByRole('heading', { name: /Create payment plan/i });
    fireEvent.click(screen.getByRole('button', { name: /Add instalment/i }));
    // Instalment row #1 appears (date input aria-labelled).
    expect(
      await screen.findByLabelText(/Instalment 1 due date/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Instalment 1 amount/i)).toBeInTheDocument();
    // Total readout — initial amount is 0. Footer now shows "Per
    // participant: ₹0" (and adds a "× N = ₹gross" trailer when participants
    // are present + total > 0, which doesn't apply here since total === 0).
    expect(screen.getByText((c) => /Per participant:/.test(c))).toBeInTheDocument();
    expect(
      screen.getAllByText((c) => /^₹0$/.test(c)).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('keeps an unsaved instalment when a background payment refresh arrives', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    await screen.findByRole('heading', { name: /Create payment plan/i });
    fireEvent.click(screen.getByRole('button', { name: /Add instalment/i }));

    const dueDate = await screen.findByLabelText(/Instalment 1 due date/i);
    const amount = screen.getByLabelText(/Instalment 1 amount/i);
    fireEvent.change(dueDate, { target: { value: '2099-09-20' } });
    fireEvent.change(amount, { target: { value: '260000' } });

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'globus:travel-payment-complete', tripId: 101 },
    }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Instalment 1 due date/i)).toHaveValue('2099-09-20');
      expect(screen.getByLabelText(/Instalment 1 amount/i)).toHaveValue(260000);
    });
  });

  it('Save with no dueDate surfaces notify.error + no PUT fires', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    await screen.findByRole('heading', { name: /Create payment plan/i });
    fireEvent.click(screen.getByRole('button', { name: /Add instalment/i }));
    await screen.findByLabelText(/Instalment 1 due date/i);
    // Amount stays 0 + due date stays empty → save should fail validation.
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save payment plan/i }));
    await waitFor(() => {
      // First failing instalment fires: "Instalment 1: due date is required".
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/due date is required/i),
      );
    });
    const puts = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'PUT');
    expect(puts.length).toBe(0);
  });

  it('sets each date input minimum to today and the previous instalment date', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    await screen.findByRole('heading', { name: /Create payment plan/i });
    fireEvent.click(screen.getByRole('button', { name: /Add instalment/i }));

    const firstDate = await screen.findByLabelText(/Instalment 1 due date/i);
    expect(firstDate.min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.change(firstDate, { target: { value: '2099-09-20' } });
    fireEvent.click(screen.getByRole('button', { name: /Add instalment/i }));

    expect(screen.getByLabelText(/Instalment 2 due date/i).min).toBe('2099-09-20');
    fireEvent.change(firstDate, { target: { value: '2099-09-25' } });
    expect(screen.getByLabelText(/Instalment 2 due date/i).min).toBe('2099-09-25');
  });

  it('rejects a past due date before sending the payment plan', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    await screen.findByRole('heading', { name: /Create payment plan/i });
    fireEvent.click(screen.getByRole('button', { name: /Add instalment/i }));
    fireEvent.change(await screen.findByLabelText(/Instalment 1 due date/i), {
      target: { value: '2000-01-01' },
    });
    fireEvent.change(screen.getByLabelText(/Instalment 1 amount/i), {
      target: { value: '5000' },
    });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save payment plan/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/due date cannot be in the past/i),
      );
    });
    expect(fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(0);
  });

  it('rejects a later instalment date before the previous date', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    await screen.findByRole('heading', { name: /Create payment plan/i });
    fireEvent.click(screen.getByRole('button', { name: /Add instalment/i }));
    fireEvent.change(await screen.findByLabelText(/Instalment 1 due date/i), {
      target: { value: '2099-09-20' },
    });
    fireEvent.change(screen.getByLabelText(/Instalment 1 amount/i), {
      target: { value: '5000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add instalment/i }));
    fireEvent.change(screen.getByLabelText(/Instalment 2 due date/i), {
      target: { value: '2099-09-19' },
    });
    fireEvent.change(screen.getByLabelText(/Instalment 2 amount/i), {
      target: { value: '5000' },
    });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save payment plan/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/due date cannot be before instalment 1/i),
      );
    });
    expect(fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(0);
  });
});

// ─── EXTENSION WAVE 2 — 2026-05-26 ──────────────────────────────────────
//
// Second extension pass. The first extension covered participants-remove,
// participants-add-error, header date edges, rooming assignment and admin room setup,
// payment-plan editor + Add-instalment + dueDate validation.
//
// This wave pins the remaining uncovered surface:
//
//   1. Rooming — createRoom POSTs /rooming with the right body shape.
//   2. Rooming — createRoom validation: empty roomNumber surfaces
//      notify.error + no POST fires.
//   3. Rooming — load failure (GET reject) → empty rooms state, NO crash.
//   4. Rooming — RoomCard capacity guard: at-capacity unchecked boxes are
//      disabled using the admin-configured room capacity.
//   5. Payment plan — load with existing plan hydrates editor (instalment
//      count + Edit-heading text + Delete-plan button visible).
//   6. Payment plan — empty editor (no instalments) Save surfaces "Add at
//      least one instalment" + no PUT fires.
//   7. Payment plan — adding then removing an instalment leaves zero rows.
//   8. Payment plan — Move-up reorders the instalment list (assert by
//      sequential aria-labels after swap).
//   9. Payment plan — per-participant instalments section renders the
//      backend's payload when /instalments returns a populated list.
//  10. StatusBadge — unknown status string falls back to subtle colours
//      without crashing (renders the literal status text).
//
// All cases use stable mock object refs, findBy / waitFor for async, and
// getAllByText where labels appear in tab + card chrome.

describe('<TripDetail /> — Payment plan with existing plan', () => {
  const planFixture = {
    id: 7001,
    tripId: 101,
    graceDays: 5,
    instalmentsJson: JSON.stringify([
      { dueDate: '2026-08-01', amount: 30000, reminderDays: 7 },
      { dueDate: '2026-10-01', amount: 50000, reminderDays: 7 },
      { dueDate: '2026-12-01', amount: 45000, reminderDays: 3 },
    ]),
  };

  function installPaymentMock({ plan = planFixture, instalments = [] } = {}) {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'GET' && /^\/api\/travel\/trips\/\d+$/.test(url)) {
        return Promise.resolve(makeTrip());
      }
      if (method === 'GET' && /payment-plan$/.test(url)) return Promise.resolve(plan);
      if (method === 'GET' && /instalments$/.test(url)) {
        return Promise.resolve({ instalments });
      }
      if (method === 'GET' && /rooming$/.test(url)) {
        return Promise.resolve({ rooming: [] });
      }
      if (method === 'DELETE' && /payment-plan$/.test(url)) return Promise.resolve({});
      return Promise.resolve(null);
    });
  }

  it('load with existing plan hydrates editor with instalments + Delete-plan button', async () => {
    installPaymentMock();
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    // Heading flips to "Edit payment plan" when plan exists.
    expect(
      await screen.findByRole('heading', { name: /Edit payment plan/i }),
    ).toBeInTheDocument();
    // 3 instalments rendered — each with sequential aria-labels.
    expect(screen.getByLabelText(/Instalment 1 due date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Instalment 2 due date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Instalment 3 due date/i)).toBeInTheDocument();
    // Total = 30000 + 50000 + 45000 = 125000 → "₹125,000" (en-US) or "₹1,25,000" (en-IN).
    // Footer now renders BOTH a "Per participant: ₹125,000" line and a
    // "× N participants = ₹{gross}" trailer; with the single-participant
    // fixture, gross === per-participant so the same string can appear in
    // both places. Assert at-least-one match.
    expect(
      screen.getAllByText((c) => /^₹(125,000|1,25,000)$/.test(c)).length,
    ).toBeGreaterThanOrEqual(1);
    // Delete-plan button visible (plan truthy).
    expect(
      screen.getByRole('button', { name: /Delete payment plan/i }),
    ).toBeInTheDocument();
    // Grace days hydrated to 5.
    const grace = screen.getByLabelText(/Grace days/i);
    expect(grace.value).toBe('5');
  });

  it('empty editor Save surfaces "Add at least one instalment" + no PUT fires', async () => {
    // No plan → editInstalments starts as []. Save without adding rows.
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    await screen.findByRole('heading', { name: /Create payment plan/i });
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Save payment plan/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Add at least one instalment/i),
      );
    });
    const puts = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'PUT');
    expect(puts.length).toBe(0);
  });


  it('removes the ambiguous plan-level payment-link column', async () => {
    installPaymentMock();
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    await screen.findByRole('heading', { name: /Edit payment plan/i });

    expect(screen.queryByText(/^Payment link$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy instalment \d+ payment link/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Generate payment link/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/rzp\.io/i)).not.toBeInTheDocument();
  });
  it('per-participant instalments section renders rows from /instalments response', async () => {
    const perPartFixture = [
      {
        id: 8001,
        participantId: 901,
        instalmentIndex: 0,
        dueDate: '2026-08-01T00:00:00.000Z',
        amount: 30000,
        status: 'pending',
      },
      {
        id: 8002,
        participantId: 901,
        instalmentIndex: 1,
        dueDate: '2026-10-01T00:00:00.000Z',
        amount: 50000,
        status: 'paid',
      },
    ];
    installPaymentMock({ instalments: perPartFixture });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Payment plan/i }));
    await screen.findByRole('heading', { name: /Per-participant instalments/i });
    // Participant accordion header shows "Anaya Sharma" (fixture participant 901).
    expect(screen.getByText('Anaya Sharma')).toBeInTheDocument();
    // Expand the accordion by clicking the participant's row to see the instalments.
    const accordionBtn = screen.getByRole('button', { name: /Anaya Sharma/ });
    fireEvent.click(accordionBtn);
    // Status labels now visible in the expanded instalment rows.
    await waitFor(() => {
      expect(screen.getByText('pending')).toBeInTheDocument();
      expect(screen.getByText('paid')).toBeInTheDocument();
    });
  });
});

describe('<TripDetail /> — StatusBadge fallback', () => {
  it('unknown status renders the literal text using subtle fallback colours (no crash)', async () => {
    installFetchMock({ trip: makeTrip({ status: 'pending-approval' }) });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    // The badge falls back to {bg:'var(--subtle-bg)', color:'var(--text-secondary)'}
    // when status isn't in the known set; literal text still renders.
    expect(screen.getByText('pending-approval')).toBeInTheDocument();
  });
});

describe('<TripDetail /> — dynamic document requirements', () => {
  async function openDocumentsTab(trip = makeTrip(), pendingRegs = []) {
    installFetchMock({ trip, pendingRegs });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Documents/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Document collection/i }));
    await screen.findByRole('heading', { name: 'Documents to collect' });
  }

  async function openParticipantsTab(trip = makeTrip()) {
    installFetchMock({ trip });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByRole('heading', { name: 'Participant status' });
  }

  it('shows custom requirements and participant upload status in the admin matrix', async () => {
    await openDocumentsTab(makeTrip({
      participants: [{
        id: 901,
        fullName: 'Anaya Sharma',
        parentName: 'Riya Sharma',
        parentEmail: 'parent@example.com',
      }],
      parentDocuments: [{
        parentEmail: 'parent@example.com',
        documents: [{
          id: 501,
          documentRequirementId: 1,
          documentType: 'School medical clearance',
          filename: 'medical-clearance.docx',
        }],
      }],
    }));

    expect(screen.getAllByText('School medical clearance')).toHaveLength(2);
    expect(screen.getAllByText('Emergency contact letter')).toHaveLength(2);
    expect(screen.getByText(/PDF, DOCX · Required/)).toBeInTheDocument();
    expect(screen.getByText(/PDF, JPG \/ JPEG · Required/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View document/ })).toBeInTheDocument();
    expect(screen.getByTestId('trip-document-actions')).toHaveStyle({ justifyContent: 'flex-start', width: '100%' });
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText(/Passport|Aadhaar|Visa documents/i)).not.toBeInTheDocument();
  });

  it('paginates participant documents and lets the admin move between pages', async () => {
    const participants = Array.from({ length: 6 }, (_, index) => ({
      id: 900 + index,
      fullName: `Pagination Participant ${index + 1}`,
      parentName: `Parent ${index + 1}`,
    }));
    await openDocumentsTab(makeTrip({ participants, documentRequirements: [] }));

    expect(screen.getByText('Pagination Participant 1')).toBeInTheDocument();
    expect(screen.getByText('Pagination Participant 5')).toBeInTheDocument();
    expect(screen.queryByText('Pagination Participant 6')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1-5 of 6 participants')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next participants page' }));
    expect(screen.queryByText('Pagination Participant 1')).not.toBeInTheDocument();
    expect(screen.getByText('Pagination Participant 6')).toBeInTheDocument();
    expect(screen.getByText('Showing 6-6 of 6 participants')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Previous participants page' }));
    expect(screen.getByText('Pagination Participant 1')).toBeInTheDocument();
    expect(screen.queryByText('Pagination Participant 6')).not.toBeInTheDocument();
  });

  it('shows configured requirements in a searchable compact card grid without a view toggle', async () => {
    await openDocumentsTab();
    const configuredRequirements = screen.getByTestId('trip-configured-requirements');
    const cards = within(configuredRequirements).getByTestId('trip-requirement-cards');

    expect(cards).toHaveAttribute('data-layout', 'grid');
    expect(within(cards).getAllByTestId('trip-requirement-card')).toHaveLength(2);
    const searchInput = screen.getByLabelText('Search configured requirements');
    expect(searchInput).toHaveAttribute('placeholder', 'Search requirement...');
    expect(searchInput).toHaveStyle({ width: '100%' });
    expect(screen.queryByRole('button', { name: 'Grid view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'List view' })).not.toBeInTheDocument();
    fireEvent.change(searchInput, {
      target: { value: 'Emergency contact' },
    });
    expect(within(cards).getAllByTestId('trip-requirement-card')).toHaveLength(1);
    expect(within(cards).getByText('Emergency contact letter')).toBeInTheDocument();
  });

  it('keeps document collection collapsed by default while participant documents remain visible', async () => {
    installFetchMock({ trip: makeTrip({ documentRequirements: [] }) });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Documents/i }));

    const collectionButton = await screen.findByRole('button', { name: /Document collection/i });
    expect(collectionButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: 'Documents to collect' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Participant documents' })).toBeInTheDocument();

    fireEvent.click(collectionButton);
    expect(await screen.findByRole('heading', { name: 'Documents to collect' })).toBeInTheDocument();
    expect(collectionButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('trip-configured-requirements')).toHaveTextContent('No requirements added yet');
    fireEvent.click(collectionButton);
    expect(screen.queryByRole('heading', { name: 'Documents to collect' })).not.toBeInTheDocument();
  });

  it('opens participant details from the Participants tab identity cell', async () => {
    await openParticipantsTab(makeTrip({
      participants: [{
        id: 901,
        fullName: 'Anaya Sharma',
        parentName: 'Riya Sharma',
        parentEmail: 'riya@example.com',
        parentPhone: '+919876543210',
        applicationStatus: 'approved',
        reviewNotes: 'Verified with the school coordinator.',
      }],
    }));

    fireEvent.click(screen.getByRole('button', { name: 'View details for Anaya Sharma' }));
    const modal = await screen.findByRole('dialog', { name: 'Participant details' });
    expect(within(modal).getByText('Anaya Sharma')).toBeInTheDocument();
    expect(within(modal).getByText('riya@example.com')).toBeInTheDocument();
    expect(within(modal).getByText('+919876543210')).toBeInTheDocument();
    expect(within(modal).getByText('The Modern Classroom')).toBeInTheDocument();
    expect(within(modal).getByText('Approved')).toBeInTheDocument();
    expect(within(modal).getByText('Verified with the school coordinator.')).toBeInTheDocument();

    fireEvent.click(within(modal).getByRole('button', { name: 'Close participant details' }));
    expect(screen.queryByRole('dialog', { name: 'Participant details' })).not.toBeInTheDocument();
  });

  it('does not expose the participant-details trigger in the Documents tab', async () => {
    await openDocumentsTab(makeTrip({
      participants: [{
        id: 901,
        fullName: 'Anaya Sharma',
        parentName: 'Riya Sharma',
        parentEmail: 'riya@example.com',
      }],
    }));

    expect(screen.queryByRole('button', { name: 'View details for Anaya Sharma' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Participant details' })).not.toBeInTheDocument();
  });

  it('shows school and registration fields for a participant', async () => {
    await openParticipantsTab(makeTrip({
      participants: [{
        id: 902,
        fullName: 'Aarav Iyer',
        studentSchool: 'Springfield School',
        studentClass: 'Grade 8',
        parentName: 'Rohan Iyer',
        parentEmail: 'rohan@example.com',
        parentPhone: '+919876543210',
      }],
    }));

    fireEvent.click(screen.getByRole('button', { name: 'View details for Aarav Iyer' }));
    const modal = await screen.findByRole('dialog', { name: 'Participant details' });
    expect(within(modal).getByText('Springfield School')).toBeInTheDocument();
    expect(within(modal).getByText('Grade 8')).toBeInTheDocument();
    expect(within(modal).getByText('rohan@example.com')).toBeInTheDocument();
  });

  it('opens an uploaded file from its participant-document cell', async () => {
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:uploaded-document');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    rawFetchMock.mockImplementation(async (url) => {
      if (url.endsWith('/view-url')) {
        return {
          ok: true,
          json: () => Promise.resolve({ url: 'https://objectstorage.ap-mumbai-1.oraclecloud.com/p/signed-parent-document' }),
        };
      }
      return {
        ok: true,
        blob: () => Promise.resolve(new Blob(['document'], { type: 'application/pdf' })),
      };
    });
    await openDocumentsTab(makeTrip({
      participants: [{
        id: 901,
        fullName: 'Anaya Sharma',
        parentName: 'Riya Sharma',
        parentEmail: 'parent@example.com',
      }],
      parentDocuments: [{
        parentEmail: 'parent@example.com',
        documents: [{
          id: 501,
          documentRequirementId: 1,
          documentType: 'School medical clearance',
          filename: 'medical-clearance.pdf',
        }],
      }],
    }));

    fireEvent.click(screen.getByRole('button', { name: /View document/ }));
    await waitFor(() => {
      expect(rawFetchMock).toHaveBeenCalledWith(
        '/api/travel/trips/101/participants/901/parent-documents/501/view-url',
        { headers: { Authorization: 'Bearer test-token' } },
      );
    });
    expect(createObjectUrlSpy).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('https://objectstorage.ap-mumbai-1.oraclecloud.com/p/signed-parent-document', '_blank', 'noopener,noreferrer');

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => {
      expect(rawFetchMock).toHaveBeenCalledWith(
        '/api/travel/trips/101/participants/901/parent-documents/501/file',
        { headers: { Authorization: 'Bearer test-token' } },
      );
    });
  });

  it('presents accepted terms before submitted consent details', async () => {
    await openDocumentsTab(makeTrip({
      participants: [{
        id: 901,
        fullName: 'Anaya Sharma',
        parentName: 'Riya Sharma',
        parentEmail: 'parent@example.com',
        parentDocuments: [{
          id: 502,
          documentRequirementId: 1,
          documentType: 'Parent consent form',
          captureMode: 'digital_consent',
          answers: {
            parentName: 'Riya Sharma',
            participantName: 'Anaya Sharma',
            relationship: 'Parent / Guardian',
            signatureName: 'Riya Sharma',
            notes: 'No medical restrictions.',
          },
          termsSnapshot: 'TERMS AND CONDITIONS FOR INTERNATIONAL EDUCATIONAL TRAVEL PROGRAMMES 1. DEFINITIONS These terms apply to this trip. 2. ACCEPTANCE OF TERMS The parent accepts these terms. 14. TERM These terms remain in force. 15. REMOVAL FROM THE PROGRAMME A. The Company may remove a participant. 16. PRIVACY AND COMMUNICATIONS A. The parent consents to communication.',
          agreedAt: '2026-06-01T10:00:00.000Z',
        }],
      }],
      documentRequirements: [{ id: 1, docType: 'Parent consent form', captureMode: 'digital_consent', required: true }],
    }));

    const viewConsentButton = screen.getByRole('button', { name: 'View consent' });
    expect(viewConsentButton).toHaveClass('trip-document-view-action');
    fireEvent.click(viewConsentButton);
    const modal = await screen.findByRole('dialog');
    const modalText = modal.textContent;
    expect(modalText.indexOf('Terms and conditions')).toBeLessThan(modalText.indexOf('Submitted details'));
    expect(within(modal).getByRole('heading', { name: 'TERMS AND CONDITIONS FOR INTERNATIONAL EDUCATIONAL TRAVEL PROGRAMMES' })).toBeInTheDocument();
    expect(within(modal).getByRole('heading', { name: '1. DEFINITIONS' })).toBeInTheDocument();
    expect(within(modal).getByRole('heading', { name: '14. TERM' })).toBeInTheDocument();
    expect(within(modal).getByRole('heading', { name: '15. REMOVAL FROM THE PROGRAMME' })).toBeInTheDocument();
    expect(within(modal).getByRole('heading', { name: '16. PRIVACY AND COMMUNICATIONS' })).toBeInTheDocument();
    expect(within(modal).getByRole('heading', { name: 'Submitted details' })).toBeInTheDocument();
    expect(within(modal).getByText('Parent name')).toBeInTheDocument();
    expect(within(modal).getAllByText('Riya Sharma')).toHaveLength(2);
  });

  it('creates an admin-defined requirement with the selected file types', async () => {
    await openDocumentsTab();
    const documentNameInput = screen.getByLabelText('Document name');
    expect(documentNameInput).toBeRequired();
    expect(documentNameInput.closest('label')).toHaveTextContent(/Document name\s*\*/);
    fireEvent.change(screen.getByLabelText('Document name'), { target: { value: 'Travel insurance certificate' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'PDF' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'DOCX' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add requirement' }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, options]) => url === '/api/travel/trips/101/documents' && options?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({
        docType: 'Travel insurance certificate',
        acceptedFileTypes: ['jpg', 'png', 'docx'],
        required: true,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith('Document requirement added');
  });

  it('blocks document requirement names that already exist on the trip', async () => {
    await openDocumentsTab();
    fireEvent.change(screen.getByLabelText('Document name'), { target: { value: '  school MEDICAL clearance  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add requirement' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A document requirement with this name already exists');
    expect(fetchApiMock.mock.calls.some(
      ([url, options]) => url === '/api/travel/trips/101/documents' && options?.method === 'POST',
    )).toBe(false);
  });

  it('disables adding a second digital consent form while keeping its edit action available', async () => {
    await openDocumentsTab(makeTrip({
      documentRequirements: [{
        id: 42,
        docType: 'Consent form',
        captureMode: 'digital_consent',
        consentTerms: 'Existing clauses.',
        required: true,
      }],
    }));

    expect(screen.getByRole('radio', { name: 'Digital consent form' })).toBeDisabled();
    expect(screen.getByText('A consent form is already configured. Edit or remove it below.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('radio', { name: 'Digital consent form' })).toBeEnabled();
    expect(screen.getByLabelText('Consent form terms')).toHaveValue('Existing clauses.');
  });

  it('shows the digital consent form preview and saves its editable terms', async () => {
    await openDocumentsTab(makeTrip({ tripType: 'international' }));
    fireEvent.change(screen.getByLabelText('Document name'), { target: { value: 'Parent consent form' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Digital consent form' }));
    expect(screen.getByTestId('trip-consent-form-fields')).toBeInTheDocument();
    expect(screen.getByText('Parent or guardian full name *')).toBeInTheDocument();
    const termsEditor = await screen.findByLabelText('Consent form terms');
    await waitFor(() => expect(termsEditor.value).toContain('TERMS AND CONDITIONS FOR INTERNATIONAL EDUCATIONAL TRAVEL PROGRAMMES\n\nThese Terms'));
    expect(termsEditor.value).toContain('1. DEFINITIONS\nUnless the context otherwise requires:');
    expect(termsEditor.value).toContain('\nA. “Participant” means');
    expect(termsEditor.value).toContain('\nB. “Parent/Guardian” means');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const previewDialog = await screen.findByRole('dialog', { name: 'Parent consent preview' });
    expect(previewDialog.parentElement.parentElement).toBe(document.body);
    expect(previewDialog.getAttribute('style')).toContain('var(--modal-bg, #fff)');
    expect(within(previewDialog).getByRole('heading', { name: 'TERMS AND CONDITIONS FOR INTERNATIONAL EDUCATIONAL TRAVEL PROGRAMMES' })).toBeInTheDocument();
    expect(within(previewDialog).getByRole('heading', { name: '1. DEFINITIONS' })).toBeInTheDocument();
    fireEvent.click(within(previewDialog).getByRole('button', { name: 'Close preview' }));
    const editedTerms = `${termsEditor.value}\n\nADMIN ADDED CLAUSE`;
    fireEvent.change(termsEditor, { target: { value: editedTerms } });
    fireEvent.change(screen.getByLabelText('Document name'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Add requirement' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, options]) => url === '/api/travel/trips/101' && options?.method === 'PATCH',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ consentTerms: editedTerms });
    });
    expect(notifySuccess).toHaveBeenCalledWith('Consent form saved');
    fireEvent.change(screen.getByLabelText('Document name'), { target: { value: 'Parent consent form' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add requirement' }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, options]) => url === '/api/travel/trips/101/documents' && options?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({
        docType: 'Parent consent form',
        acceptedFileTypes: ['pdf', 'jpg', 'png'],
        required: true,
        captureMode: 'digital_consent',
        consentTerms: editedTerms,
      });
    });
  });

  it('lets an admin edit and update terms on an existing digital consent form', async () => {
    await openDocumentsTab(makeTrip({
      documentRequirements: [{
        id: 8,
        docType: 'Parent consent form',
        acceptedFileTypes: ['pdf'],
        captureMode: 'digital_consent',
        consentTerms: 'Current trip consent terms.',
        required: true,
      }],
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Consent form terms')).toHaveValue('Current trip consent terms.');
    fireEvent.change(screen.getByLabelText('Consent form terms'), {
      target: { value: 'Updated consent terms for the next parent submissions.' },
    });
    expect(screen.getByLabelText('Consent form terms')).toHaveValue('Updated consent terms for the next parent submissions.');
    fireEvent.change(screen.getByLabelText('Document name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, options]) => url === '/api/travel/trips/101' && options?.method === 'PATCH',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ consentTerms: 'Updated consent terms for the next parent submissions.' });
    });
    expect(notifySuccess).toHaveBeenCalledWith('Consent form saved');
  });

  it('edits and removes a configured requirement without a document-type restriction', async () => {
    await openDocumentsTab();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    expect(screen.getByLabelText('Document name')).toHaveValue('School medical clearance');
    fireEvent.change(screen.getByLabelText('Document name'), { target: { value: 'Updated authorization letter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, options]) => url === '/api/travel/trips/101/documents/1' && options?.method === 'PATCH',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({
        docType: 'Updated authorization letter',
        acceptedFileTypes: ['pdf', 'docx'],
        required: true,
      });
    });

    notifyConfirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/travel/trips/101/documents/1',
        { method: 'DELETE' },
      );
    });
    expect(notifySuccess).toHaveBeenCalledWith('Document requirement removed');
  });
});

// ─── Phase 8 — Unified Participants list + Public Experience section ──

describe('<TripDetail /> — Phase 8 unified Participants list', () => {
  function makePendingReg(overrides = {}) {
    return {
      id: 9001,
      tripId: 101,
      tenantId: 1,
      status: 'OTP_VERIFIED',
      studentName: 'Aarav Iyer',
      parentName: 'Rohan Iyer',
      parentEmail: 'rohan@example.com',
      parentPhone: '+919876543210',
      otpVerified: true,
      otpVerifiedAt: '2026-05-10T10:00:00.000Z',
      createdAt: '2026-05-10T09:55:00.000Z',
      ...overrides,
    };
  }

  it('Participants tab shows the registered roster without fetching pending registrations', async () => {
    installFetchMock({ pendingRegs: [makePendingReg()] });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    expect(await screen.findByTestId('registered-participants-list')).toBeInTheDocument();
    expect(screen.getByText('Anaya Sharma')).toBeInTheDocument();
    expect(screen.queryByText('Aarav Iyer')).not.toBeInTheDocument();
    expect(fetchApiMock.mock.calls.some(([url]) => url === '/api/travel/trips/101/registrations')).toBe(false);
  });

  it('does not show pending registration counters on the simplified roster', async () => {
    installFetchMock({
      pendingRegs: [
        makePendingReg(),
        makePendingReg({ id: 9002, status: 'OTP_VERIFIED', studentName: 'Priya' }),
        makePendingReg({ id: 9003, status: 'DRAFT', studentName: 'Sara' }),
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByTestId('registered-participants-list');
    expect(screen.queryByTestId('pending-regs-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-registrations-list')).not.toBeInTheDocument();
  });

  it('shows document and payment completion status for each registered participant', async () => {
    installFetchMock({
      trip: makeTrip({
        participants: [
          {
            id: 901,
            fullName: 'Complete Participant',
            parentName: 'Complete Parent',
            parentDocuments: [{ id: 700, documentRequirementId: 1, status: 'approved' }],
            paymentStatus: 'completed',
            paymentSummary: { completedInstallments: 2, totalInstallments: 2 },
          },
          {
            id: 902,
            fullName: 'Pending Participant',
            parentName: 'Pending Parent',
            paymentStatus: 'pending',
            paymentSummary: { completedInstallments: 0, totalInstallments: 2 },
          },
        ],
        documentRequirements: [{ id: 1, docType: 'Consent form', required: true }],
      }),
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    expect(await screen.findByText('Complete Participant')).toBeInTheDocument();
    expect(screen.getByText('Pending Participant')).toBeInTheDocument();
    expect(screen.getAllByText('Completed')).toHaveLength(2);
    expect(screen.getAllByText('Pending')).toHaveLength(2);
  });

  it('does not render unregistered draft rows', async () => {
    installFetchMock({
      pendingRegs: [makePendingReg({ id: 9003, status: 'DRAFT', studentName: 'Sara' })],
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByTestId('registered-participants-list');
    expect(screen.queryByText('Sara')).not.toBeInTheDocument();
  });

  it('shows only the converted participant once', async () => {
    installFetchMock({
      trip: makeTrip({ participants: [{ id: 555, fullName: 'AlreadyConverted' }] }),
      pendingRegs: [
        makePendingReg({ id: 9001, status: 'OTP_VERIFIED', studentName: 'StillPending' }),
        makePendingReg({ id: 9002, status: 'CONVERTED', studentName: 'AlreadyConverted', convertedToParticipantId: 555, extrasJson: JSON.stringify({ documents: { passport: 'stored' } }) }),
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    expect(screen.getByText('AlreadyConverted')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-reg-row-9002')).not.toBeInTheDocument();
    expect(screen.queryByText('StillPending')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-regs-count')).not.toBeInTheDocument();
  });

  it('does not show a later draft for someone already in the participant list', async () => {
    installFetchMock({
      trip: makeTrip({ participants: [{ id: 19, fullName: 'Ritu',
        parentEmail: 'laura@temptami.com', parentPhone: '6789451234' }] }),
      pendingRegs: [
        makePendingReg({ id: 13, status: 'CONVERTED', studentName: 'Ritu',
          parentEmail: 'laura@temptami.com', parentPhone: '6789451234', convertedToParticipantId: 19 }),
        makePendingReg({ id: 14, status: 'DRAFT', studentName: 'Ritu',
          parentEmail: 'laura@temptami.com', parentPhone: '6789451234' }),
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Ritu');
    expect(screen.queryByTestId('pending-reg-row-14')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-regs-count')).not.toBeInTheDocument();
  });

  it('does not render rejected or converted registration staging rows', async () => {
    installFetchMock({
      trip: makeTrip({ participants: [{ id: 14, fullName: 'Jas' }] }),
      pendingRegs: [
        makePendingReg({ id: 1, status: 'CONVERTED', studentName: 'Jas', convertedToParticipantId: 14 }),
        makePendingReg({ id: 2, status: 'REJECTED', studentName: 'Jas' }),
        makePendingReg({ id: 3, status: 'REJECTED', studentName: 'Jas' }),
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Jas');
    expect(screen.getAllByText('Jas')).toHaveLength(1);
    expect(screen.queryByTestId('pending-regs-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-registrations-list')).not.toBeInTheDocument();
  });

  it.skip('legacy Approve endpoint remains available for old records', async () => {
    installFetchMock({
      pendingRegs: [makePendingReg()],
      registrationDecide: { approved: true, participant: { id: 555 }, registration: { id: 9001, status: 'CONVERTED' } },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    const approveBtn = await screen.findByTestId('approve-registration-9001');
    fireEvent.click(approveBtn);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101/registrations/9001/approve' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/added as a participant/i));
    });
  });

  it.skip('legacy Reject endpoint remains available for old records', async () => {
    // Fresh resolve for each test to avoid mock cross-contamination
    const confirmMock = vi.fn(async () => true);
    vi.mocked(notifyObj.confirm).mockImplementation(confirmMock);

    installFetchMock({
      pendingRegs: [makePendingReg()],
      registrationDecide: { rejected: true, registration: { id: 9001, status: 'REJECTED' } },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    const rejectBtn = await screen.findByTestId('reject-registration-9001');
    fireEvent.click(rejectBtn);
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Reject registration',
        destructive: true,
      }));
    });
    expect(notifyPrompt).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Reason for rejection',
      confirmText: 'Continue',
    }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101/registrations/9001/reject' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({
        reviewNotes: 'Documents do not meet trip requirements',
      });
    });
  });

  it.skip('legacy Reject cancel does NOT fire the endpoint', async () => {
    // Fresh mock for this test to avoid cross-contamination
    const confirmMock = vi.fn(async () => false);
    vi.mocked(notifyObj.confirm).mockImplementation(confirmMock);

    installFetchMock({ pendingRegs: [makePendingReg()] });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    const rejectBtn = await screen.findByTestId('reject-registration-9001');
    fireEvent.click(rejectBtn);
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(fetchApiMock.mock.calls.find(
      ([u]) => /\/registrations\/9001\/reject/.test(u),
    )).toBeFalsy();
  });

  it.skip('legacy rejecting without a reason shows a required toast', async () => {
    notifyPrompt.mockResolvedValueOnce('   ');
    installFetchMock({ pendingRegs: [makePendingReg()] });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    fireEvent.click(await screen.findByTestId('reject-registration-9001'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('A reason is required to reject a participant.');
    });
    expect(fetchApiMock.mock.calls.find(([u]) => /\/registrations\/9001\/reject/.test(u))).toBeFalsy();
  });

  it('shows the registered list without a pending registrations section', async () => {
    installFetchMock({ pendingRegs: [] });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma'); // existing participant still shows
    expect(screen.getByTestId('registered-participants-list')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-registrations-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-regs-count')).not.toBeInTheDocument();
  });
});

describe('<TripDetail /> — Phase 8 Public Experience: LandingPageCard', () => {
  it('renders "No landing page linked yet" empty state with a link to the Landing Pages module', async () => {
    installFetchMock({ landingPage: { status: 404, body: { code: 'NOT_LINKED' } } });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    expect(await screen.findByTestId('landing-page-card')).toBeInTheDocument();
    expect(screen.getByText(/No landing page created yet/i)).toBeInTheDocument();
    expect(screen.getByText(/participant registration/i)).toBeInTheDocument();
    // Redirect-only — no lazy-create button on the trip detail surface.
    expect(screen.queryByTestId('create-landing-page-btn')).not.toBeInTheDocument();
    const gotoLink = screen.getByTestId('goto-landing-pages-link');
    expect(gotoLink.getAttribute('href')).toBe('/landing-pages');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('renders existing linked landing page with single "Manage in Landing Pages" link to the existing module', async () => {
    installFetchMock({
      landingPage: {
        id: 77, slug: 'trip-bali2026', status: 'PUBLISHED', tripId: 101,
        title: 'Bali Trip — bali2026',
      },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    expect(await screen.findByText('Bali Trip — bali2026')).toBeInTheDocument();
    const manageLink = screen.getByTestId('manage-landing-page-link');
    expect(manageLink.getAttribute('href')).toBe('/landing-pages/builder/77');
    // No duplicate Edit/Open/Copy buttons embedded in the trip detail.
    expect(screen.queryByTestId('open-landing-page-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('copy-landing-page-url-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('create-landing-page-btn')).not.toBeInTheDocument();
  });

  it('the landing-page handoff from Public Experience preserves the TMC Trips return state', async () => {
    installFetchMock({
      landingPage: {
        id: 77,
        slug: 'trip-bali2026',
        status: 'PUBLISHED',
        tripId: 101,
        title: 'Bali Trip — bali2026',
      },
      builderLandingPage: {
        id: 77,
        tripId: 101,
        slug: 'trip-bali2026',
        status: 'DRAFT',
        title: 'Bali Trip — bali2026',
        content: JSON.stringify([]),
      },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    fireEvent.click(await screen.findByTestId('manage-landing-page-link'));

    expect(await screen.findByRole('button', { name: 'Step 4: Landing page, pending' })).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'Publish', exact: true }));
    expect(await screen.findByRole('button', { name: 'Step 4: Landing page, complete' })).toBeVisible();
    expect(await screen.findByTitle('Back to TMC Trips')).toHaveAttribute('href', '/travel/trips/101?tab=overview');
    expect(screen.getByRole('link', { name: 'TMC Trips' })).toHaveAttribute('href', '/travel/trips/101?tab=overview');
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/travel/trips/101?tab=overview');
  });

  it('Overview renders the landing-page card without microsite controls', async () => {
    installFetchMock({
      landingPage: {
        id: 77, slug: 'trip-bali2026', status: 'PUBLISHED', tripId: 101,
        title: 'Bali Trip',
      },
    });
    renderPage();
    await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
    // Landing page card present
    expect(await screen.findByTestId('landing-page-card')).toBeInTheDocument();
    expect(screen.queryByText(/Create a public registration page/i)).not.toBeInTheDocument();
  });
});


it('shows saved steps independently and opens the selected tab from either navigator', async () => {
  installFetchMock({ trip: makeTrip({ teacherContactId: 45 }), landingPage: { id: 90, slug: 'school-trip', status: 'PUBLISHED' } });
  renderPage();
  expect(await screen.findByText('4 of 7 complete')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Step 5: Assign teacher, complete' })).toHaveLength(2);
  const docs = screen.getAllByRole('button', { name: 'Step 3: Documents, complete' });
  fireEvent.click(docs[1]);
  expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getAllByRole('button', { name: 'Step 2: Payment plan, pending' })[0]);
  expect(screen.getByRole('tab', { name: 'Payment plan' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('4 of 7 complete')).toBeInTheDocument();
});

it('marks Rooming complete in both progress bars after the admin adds a room', async () => {
  installFetchMock();
  renderPage();
  await screen.findByRole('heading', { name: 'TMC-AND-2026-MUMBAI-G7', level: 1 });
  const roomingSteps = await screen.findAllByRole('button', { name: 'Step 7: Rooming, pending' });
  expect(roomingSteps).toHaveLength(2);

  fireEvent.click(roomingSteps[0]);
  expect(screen.getByRole('tab', { name: /Rooming/i })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(await screen.findByRole('button', { name: 'Add room' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Room number' }), { target: { value: '701' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Sharing capacity' }), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add room' }));

  expect(await screen.findAllByRole('button', { name: 'Step 7: Rooming, complete' })).toHaveLength(2);
  expect(screen.getByText('3 of 7 complete')).toBeInTheDocument();
});
it('restarts the landing highlight and moves it to the teacher row from the floating navigator', async () => {
  installFetchMock();
  renderPage();
  const landing = await screen.findAllByRole('button', {name: /Step 4: Landing page/});
  fireEvent.click(landing[0]);
  const firstChip = await screen.findByText('Step 4 · Landing page');
  expect(screen.getByTestId('landing-page-card')).toContainElement(firstChip);
  fireEvent.click(landing[1]);
  expect(await screen.findByText('Step 4 · Landing page')).not.toBe(firstChip);
  fireEvent.click(screen.getAllByRole('button', {name: /Step 5: Assign teacher/})[1]);
  expect(screen.queryByText('Step 4 · Landing page')).toBeNull();
  expect(screen.getByText('Teacher portal access').closest('.ts-highlight-target'))
    .toContainElement(await screen.findByText('Step 5 · Assign teacher'));
  fireEvent.click(screen.getAllByRole('button', {name: /Step 6: Parent link/})[0]);
  expect(screen.queryByText('Step 6 · Parent link')).toBeNull();
});
