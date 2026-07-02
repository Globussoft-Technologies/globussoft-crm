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
 *   6. Tab strip: 5 tabs render (Overview / Participants / Rooming /
 *      Payment plan / Microsite) with role="tab" + aria-selected wiring.
 *   7. Overview tab (default): renders 9 metric cards including Destination,
 *      Depart, Return, Legal entity, Price/student, Participants count,
 *      Required docs, Payment plan ("configured" / "not set"), Microsite
 *      ("published" / "not published").
 *   8. Participants tab: switching to it shows the count caption and an
 *      empty-state when no participants; populated trip renders names + the
 *      Trash2 remove buttons (one per participant).
 *   9. Participants tab — add: typing a fullName + clicking Add POSTs
 *      /api/travel/trips/:id/participants and surfaces notify.success.
 *  10. Rooming tab: triggers a secondary GET to /api/travel/trips/:id/rooming
 *      on mount (the inner tab fetches its own data) and renders the room
 *      count caption + Download-XLSX link.
 *  11. Microsite tab — un-published: renders MicrositeCreate copy ("No
 *      microsite published yet…") with the subdomain default seeded from
 *      trip-{tripCode}.
 *  12. Microsite tab — published: renders MicrositeEditor with publicUuid
 *      visible + Copy URL + Open + Preview buttons.
 *  13. Load error: GET rejection surfaces notify.error with the body.error.
 *
 * Backend contract pinned (per backend/routes/travel_trips.js:165+ for GET
 * /:id, line 190 participants include, line 193 microsite include):
 *   GET /api/travel/trips/:id → 200 { ...trip, participants[],
 *     microsite|null, documentRequirements[], _count? } | 404 "Trip not
 *     found" (catch path in SUT renders the !trip branch).
 *   POST /api/travel/trips/:id/participants body { fullName, parentName?,
 *     parentPhone? } → 201 created.
 *   GET /api/travel/trips/:id/rooming → 200 { rooming: [] }.
 *
 * Drift pinned (prompt vs. actual code):
 *   - Prompt mentioned "day-by-day itinerary" — the SUT does NOT render a
 *     day-by-day section. Itinerary content lives ONLY inside the
 *     Microsite tab's RichTextEditor (HTML string field), not as
 *     structured day cards on the detail page. Day-by-day rendering lives
 *     in a separate ItineraryDetail page. Tests OMIT day-card assertions.
 *   - Prompt mentioned "suppliers section" — the SUT has no suppliers tab.
 *     Suppliers are managed elsewhere (Suppliers admin page). Tests OMIT.
 *   - Prompt mentioned "status timeline" — the SUT has no status timeline.
 *     Status is a single badge in the page header. Tests OMIT timeline.
 *   - Prompt mentioned "status-transition flow" — the SUT has no status-
 *     transition CTA on the detail page; status is read-only (changes
 *     happen via the Deal in the sales pipeline). Tests OMIT transitions.
 *   - Prompt mentioned "edit flow" — there is no top-level "Edit trip"
 *     button; the page is read-only at the header level. Per-tab edits
 *     exist (rooming PATCH, payment-plan PUT, microsite PATCH, add-
 *     participant POST) but they are not gated by an explicit Edit toggle.
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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const fetchApiMock = vi.fn();
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

import TripDetail from '../pages/travel/TripDetail';

// Canonical trip fixture — exercises Overview + Participants + Microsite
// surfaces. Default has no microsite (un-published path), and one
// participant so we can assert both populated + remove-button shape.
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
    legalEntity: 'tmc_nexus',
    micrositeUrl: null,
    driveFolderId: null,
    participants: [
      { id: 901, fullName: 'Anaya Sharma', parentName: 'Riya Sharma', parentPhone: '+919876543210' },
    ],
    documentRequirements: [
      { id: 1, code: 'passport', required: true },
      { id: 2, code: 'consent_form', required: true },
    ],
    paymentPlan: null,
    microsite: null,
    createdAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

// Fetch router — keyed by URL prefix + method. Tests override the
// `trip` surface via overrides; everything else returns the default.
function installFetchMock({
  trip = makeTrip(),
  rooming = { rooming: [] },
  participantPost = { id: 902, fullName: 'Test Add' },
  // Phase 8 — pending registrations + landing-page mocks default to
  // empty / not-linked so existing tests stay green.
  pendingRegs = [],
  landingPage = { status: 404, body: { code: 'NOT_LINKED' } }, // 404 = no page linked
  landingPageCreate = null, // override to return a created page on POST
  registrationDecide = null, // override per-test to assert approve/reject
  itinerarySuggest = null, // override to return a custom AI suggestion
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    // GET /api/travel/trips/:id (single — exact match guards against the
    // POST-participants endpoint also starting with /api/travel/trips/101).
    if (method === 'GET' && /^\/api\/travel\/trips\/\d+$/.test(url)) {
      if (trip instanceof Error) return Promise.reject(trip);
      return Promise.resolve(trip);
    }
    // GET /api/travel/trips/:id/rooming
    if (method === 'GET' && /^\/api\/travel\/trips\/\d+\/rooming$/.test(url)) {
      return Promise.resolve(rooming);
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
// reads { id: '101' }. The SUT does NOT consume AuthContext (no role gate),
// so no Provider is needed.
function renderPage(tripId = 101) {
  return render(
    <MemoryRouter initialEntries={[`/travel/trips/${tripId}`]}>
      <Routes>
        <Route path="/travel/trips/:id" element={<TripDetail />} />
      </Routes>
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
  // Stub window.confirm for the remove-participant path (used only in the
  // remove case; harmless elsewhere).
  vi.stubGlobal('confirm', vi.fn(() => true));
  installFetchMock();
});

afterEach(() => {
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
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('GETs /api/travel/trips/:id on mount with the route-param id', async () => {
    renderPage(101);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101' && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText('TMC-AND-2026-MUMBAI-G7')).toBeInTheDocument();
  });

  it('renders "Trip not found." + Back-to-trips link when fetch resolves null', async () => {
    installFetchMock({ trip: null });
    renderPage();
    expect(await screen.findByText(/Trip not found\./i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to trips/i })).toHaveAttribute(
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
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    const backLink = screen.getByRole('link', { name: /Trips/i });
    expect(backLink).toHaveAttribute('href', '/travel/trips');
  });
});

describe('<TripDetail /> — tab strip', () => {
  it('renders all 5 tabs with role="tab" + Overview selected by default', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    const labels = tabs.map((t) => t.textContent.trim());
    expect(labels).toEqual(
      expect.arrayContaining(['Overview', 'Participants', 'Rooming', 'Payment plan', 'Public Experience']),
    );
    // Overview is selected by default.
    const overview = screen.getByRole('tab', { name: /Overview/i });
    expect(overview).toHaveAttribute('aria-selected', 'true');
  });
});

describe('<TripDetail /> — Overview tab', () => {
  it('renders hero band + KPI cards + summary bands wired to the ops-dashboard surface', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    // Hero band shows Destination label + the value + legal entity inline.
    expect(screen.getByText('Destination')).toBeInTheDocument();
    expect(screen.getByText('tmc_nexus')).toBeInTheDocument();
    // KPI strip + summary bands keep these labels.
    expect(screen.getByText('Required docs')).toBeInTheDocument();
    expect(screen.getByText('Trip status')).toBeInTheDocument();
    // 'Participants' / 'Public Experience' / 'Payment plan' all appear as both tab
    // chrome AND in the overview (KPI card / summary band title). Scope via
    // getAllByText.
    expect(screen.getAllByText('Participants').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Payment plan').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Public Experience').length).toBeGreaterThanOrEqual(2);
    // Summary-band status pills (rendered uppercase via CSS; literal mixed-
    // case in DOM).
    expect(screen.getByText('Not set yet')).toBeInTheDocument();
    expect(screen.getByText('Not published')).toBeInTheDocument();
  });
});

describe('<TripDetail /> — Participants tab', () => {
  it('switching to Participants shows the count caption + the existing participant + Add CTA', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    // Caption: "1 participant" (singular form because count === 1).
    expect(await screen.findByText('1 participant')).toBeInTheDocument();
    // Existing participant row.
    expect(screen.getByText('Anaya Sharma')).toBeInTheDocument();
    // Add CTA renders unconditionally (no RBAC gate).
    expect(screen.getByRole('button', { name: /Add participant/i })).toBeInTheDocument();
  });

  it('empty trip renders "No participants yet." copy + "0 participants" caption', async () => {
    installFetchMock({ trip: makeTrip({ participants: [] }) });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    // Click Participants tab — scope via getAllByRole + label filter to
    // avoid the regex ambiguity that bit the prior shape (the count caption
    // "0 participants" can flap the role-name lookup in some renders).
    const tabs = screen.getAllByRole('tab');
    const participantsTab = tabs.find((t) => /Participants/.test(t.textContent));
    expect(participantsTab).toBeTruthy();
    fireEvent.click(participantsTab);
    // Empty-state copy renders.
    expect(
      await screen.findByText((content) => content.includes('No participants yet')),
    ).toBeInTheDocument();
  });

  it('add-participant happy path: typing fullName + clicking Add POSTs the right endpoint + notify.success', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma');
    // Open the inline add-form.
    fireEvent.click(screen.getByRole('button', { name: /Add participant/i }));
    // Three text inputs in the form (fullName, parentName, parentPhone).
    const fullNameInput = await screen.findByPlaceholderText(/Full name/i);
    fireEvent.change(fullNameInput, { target: { value: 'Kabir Mehta' } });
    // Click the "Add" submit button (NOT the "Add participant" toggle).
    // After opening the form, the toggle is hidden so only the submit Add
    // button remains.
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101/participants' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.fullName).toBe('Kabir Mehta');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Participant added/i),
    );
  });

  it('add-participant validation: empty fullName surfaces notify.error + no POST', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma');
    fireEvent.click(screen.getByRole('button', { name: /Add participant/i }));
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Full name required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([, o]) => o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<TripDetail /> — Rooming tab', () => {
  it('switching to Rooming fires GET /api/travel/trips/:id/rooming + renders count caption + XLSX link', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
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
    // Download-XLSX link — the auth token is appended via ?_t=.
    const xlsxLink = screen.getByRole('link', { name: /Download rooming as XLSX/i });
    expect(xlsxLink.getAttribute('href')).toContain(
      '/api/travel/trips/101/rooming/export.xlsx',
    );
    expect(xlsxLink.getAttribute('href')).toContain('_t=test-token');
  });

  it('filters orphaned participantIds from loaded rooms so the room-tile count + unassigned counter agree with the visible checkboxes', async () => {
    // Regression: room.participantIds JSON had [901, 999] where 999 was a
    // since-deleted participant. Pre-fix the orphan inflated both the
    // room-tile "X / capacity" readout (showed 2/2) AND the header
    // "unassigned" count (used Set membership so 901 looked covered, but
    // the only rendered checkbox was Anaya, so the visible state showed
    // 1 box checked) — header read "1 room · 0 of 1 participant unassigned"
    // while the tile said "2 / 2 assigned" with 1 visible check. Post-fix
    // the orphan is dropped on load: tile shows 1/2 + header shows 0 of 1
    // unassigned (still 0 because the surviving participant IS assigned),
    // and the visible 1 checked box now agrees with both counts.
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
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    // Room tile capacity readout must reflect the SURVIVING participant
    // only — not the orphaned 999. Pre-fix this rendered "2 / 2 assigned".
    expect(await screen.findByText(/1 \/ 2 assigned/)).toBeInTheDocument();
    expect(screen.queryByText(/2 \/ 2 assigned/)).toBeNull();
    // Header counter agrees with the tile: 1 valid participant who IS
    // assigned → 0 unassigned of 1 total.
    expect(screen.getByText(/0 of 1 participant unassigned/)).toBeInTheDocument();
  });
});

describe('<TripDetail /> — Microsite tab', () => {
  it('un-published trip renders MicrositeCreate copy + subdomain default seeded from trip-{tripCode}', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Public Experience/i }));
    expect(
      await screen.findByText(/Create a public registration page/i),
    ).toBeInTheDocument();
    // Subdomain input pre-fills with "trip-{tripCode}".
    const subdomainInput = screen.getByLabelText(/Microsite subdomain/i);
    expect(subdomainInput.value).toBe('trip-TMC-AND-2026-MUMBAI-G7');
    // Publish button visible.
    expect(
      screen.getByRole('button', { name: /Publish public page/i }),
    ).toBeInTheDocument();
  });

  it('published trip renders MicrositeEditor with publicUuid + Copy URL + Open + Preview', async () => {
    const ms = {
      id: 5001,
      tripId: 101,
      subdomain: 'tmc-andaman-mumbai-g7',
      itineraryHtml: '<h2>Day 1</h2><p>Arrival</p>',
      faqJson: null,
      expiresAt: null,
      publicUuid: 'abc-123-def-456',
    };
    installFetchMock({ trip: makeTrip({ microsite: ms }) });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    // Scope tab click via getAllByRole + label filter to dodge the regex
    // ambiguity ("Microsite" appears as tab + Overview card label).
    const tabs = screen.getAllByRole('tab');
    const micrositeTab = tabs.find((t) => /Public Experience/.test(t.textContent));
    expect(micrositeTab).toBeTruthy();
    fireEvent.click(micrositeTab);
    // The full public URL renders in the live-link hero card; the publicUuid
    // appears as a substring of that URL.
    expect(
      await screen.findByText((c) => c.includes('abc-123-def-456')),
    ).toBeInTheDocument();
    // Action buttons — the Copy button is now labelled just "Copy" inside
    // the live-link hero (the verbose "Copy URL" was tightened in v3.9.x).
    expect(screen.getByRole('button', { name: /^Copy$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preview/i })).toBeInTheDocument();
    // Open link → the rendered public page /p/tripmicrosite/<publicUuid>
    // (NOT the raw JSON API). The page fetches the API itself.
    const openLink = screen.getByRole('link', { name: /Open/i });
    expect(openLink.getAttribute('href')).toContain(
      '/p/tripmicrosite/abc-123-def-456',
    );
    expect(openLink.getAttribute('href')).not.toContain('/api/travel/microsites/public/');
  });
});

describe('<TripDetail /> — Microsite Create enhancements', () => {
  it('pre-fills itinerary from linked landing-page itineraryTimeline block', async () => {
    installFetchMock({
      landingPage: {
        id: 77,
        slug: 'trip-tmc-and-2026-mumbai-g7',
        status: 'PUBLISHED',
        tripId: 101,
        title: 'Andaman Trip',
        content: JSON.stringify([
          {
            type: 'itineraryTimeline',
            props: {
              days: [
                { day: 1, title: 'Arrival', bullets: ['Airport pickup', 'Hotel check-in'] },
                { day: 2, title: 'Island hopping', bullets: ['Boat ride', 'Snorkelling'] },
              ],
            },
          },
        ]),
      },
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Public Experience/i }));
    expect(await screen.findByText(/Prefilled from “Andaman Trip”/i)).toBeInTheDocument();
    // The editor receives the landing-page HTML, not the placeholder.
    expect(screen.getByText('Day 1 — Arrival')).toBeInTheDocument();
    expect(screen.getByText('Airport pickup')).toBeInTheDocument();
    expect(screen.getByText('Day 2 — Island hopping')).toBeInTheDocument();
  });

  it('AI Generate itinerary calls /itineraries/suggest and replaces editor content', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Public Experience/i }));
    const aiBtn = await screen.findByRole('button', { name: /AI Generate itinerary/i });
    fetchApiMock.mockClear();
    fireEvent.click(aiBtn);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/itineraries/suggest' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.destination).toBe('Andaman');
      expect(body.days).toBe(8);
    });
    // Generated day content lands in the editor.
    expect(await screen.findByText('Day 1 — Arrival')).toBeInTheDocument();
    expect(screen.getByText('Airport transfer and hotel check-in')).toBeInTheDocument();
    expect(screen.getByText('Day 2 — Local Sightseeing')).toBeInTheDocument();
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
//   - Rooming — Add-room form opens + capacity-by-type readout.
//   - Rooming — empty-state "No rooming assignments yet" copy.
//   - Payment plan — loading-state then empty editor copy.
//   - Payment plan — Add instalment + validation (missing dueDate).
//   - Payment plan — total recomputes after adding rows.
//   - Microsite Create — Publish POSTs the right endpoint + subdomain.
//   - Microsite Create — empty itineraryHtml surfaces notify.error.
//   - Microsite Editor — Preview toggle flips to Edit (button label).
//   - Overview card values — Price/student formatted with ₹ + locale.
//
// All assertions use stable mocks + findBy / waitFor + getAllByText where
// the same label appears in tab + card chrome.

describe('<TripDetail /> — Participants remove flow', () => {
  it('clicking Trash2 + confirm()=true DELETEs the participant + notify.success', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma');
    fetchApiMock.mockClear();
    installFetchMock();
    const removeBtn = screen.getByRole('button', { name: /Remove Anaya Sharma/i });
    fireEvent.click(removeBtn);
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101/participants/901' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Removed/i));
  });

  it('clicking Trash2 with confirm()=false short-circuits — no DELETE fires', async () => {
    notifyConfirm.mockResolvedValue(false);
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma');
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Remove Anaya Sharma/i }));
    // Give microtasks a beat.
    await Promise.resolve();
    const dels = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'DELETE');
    expect(dels.length).toBe(0);
    notifyConfirm.mockResolvedValue(true);
  });
});

describe('<TripDetail /> — Participants add error + cancel', () => {
  it('POST rejection surfaces notify.error with the body.error', async () => {
    const err = new Error('boom');
    err.body = { error: 'Duplicate fullName' };
    installFetchMock({ participantPost: err });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add participant/i }));
    fireEvent.change(await screen.findByPlaceholderText(/Full name/i), {
      target: { value: 'Anaya Sharma' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Duplicate fullName');
    });
  });

  it('Cancel button closes the inline add-form without POSTing', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add participant/i }));
    // Form is open — fullName placeholder visible.
    expect(await screen.findByPlaceholderText(/Full name/i)).toBeInTheDocument();
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    // Form closes (placeholder no longer in DOM).
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/Full name/i)).toBeNull();
    });
    // "Add participant" toggle reappears.
    expect(screen.getByRole('button', { name: /Add participant/i })).toBeInTheDocument();
    const posts = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'POST');
    expect(posts.length).toBe(0);
  });
});

describe('<TripDetail /> — Header date edge cases', () => {
  it('renders "—" placeholder when returnDate is null', async () => {
    installFetchMock({ trip: makeTrip({ returnDate: null }) });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    // Header sub-row reads "{depart} → {return} · {destination}". When
    // returnDate is null the fmt() helper renders "—".
    // The em-dash is the only place "—" appears on the un-published trip
    // (Overview cards use English copy, not em-dashes); assert ≥ 1 instance.
    expect(screen.getAllByText((content) => content.includes('—')).length).toBeGreaterThanOrEqual(1);
  });

  it('Overview hero band renders locale-formatted price / student inline', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    // Price now renders in the hero band as "<IndianRupee icon> {value} /
    // student" — the ₹ glyph is an SVG icon, so assert the locale-formatted
    // numeric value + "/ student" suffix appears (the matcher reads the
    // text node, ignoring the sibling icon).
    const hits = screen.getAllByText((c) => /[\d,]+\s*\/\s*student/.test(c));
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('<TripDetail /> — Rooming Add-room form', () => {
  it('clicking "Add room" opens the inline room editor with capacity readout', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    // Wait for rooming GET to resolve + the empty-state copy.
    expect(
      await screen.findByText(/No rooming assignments yet/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add room/i }));
    // Room number input + room type select render.
    expect(await screen.findByLabelText(/Room number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Room type/i)).toBeInTheDocument();
    // Default room type is "twin" (capacity 2). Assigned count "0 / 2".
    expect(screen.getByText(/0 \/ 2 assigned/)).toBeInTheDocument();
    // The form's "Add room" submit button is now distinct from the toggle —
    // the toggle is gone (newRoom truthy hides it).
    expect(screen.getByRole('button', { name: /^Add room$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel new room/i })).toBeInTheDocument();
  });
});

describe('<TripDetail /> — Payment plan tab', () => {
  it('switching to Payment plan shows the empty-state editor copy', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
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
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
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

  it('Save with no dueDate surfaces notify.error + no PUT fires', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
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
});

describe('<TripDetail /> — Microsite Create flow', () => {
  it('Publish POSTs /api/travel/trips/:id/microsite with subdomain + itineraryHtml', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Public Experience/i }));
    await screen.findByText(/Create a public registration page/i);
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Publish public page/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101/microsite' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.subdomain).toBe('trip-TMC-AND-2026-MUMBAI-G7');
      // Default placeholder content begins with a Day 1 H2.
      expect(body.itineraryHtml).toContain('Day 1');
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Microsite published/i),
    );
  });

  it('Publish with blank itineraryHtml surfaces notify.error + no POST', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Public Experience/i }));
    // The RichTextEditor is contenteditable — direct DOM patching for an
    // empty payload. The SUT's itineraryHtml state seed is the placeholder,
    // so we have to mutate it via the editor's onInput hook. Easier path:
    // patch the contenteditable div's innerHTML + fire input event.
    const editorDiv = await screen.findByLabelText(/Itinerary content editor/i);
    editorDiv.innerHTML = '';
    fireEvent.input(editorDiv);
    // Also fire blur to flush handleInput.
    fireEvent.blur(editorDiv);
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Publish public page/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Itinerary content required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'POST');
    expect(posts.length).toBe(0);
  });
});

describe('<TripDetail /> — Microsite Editor preview toggle', () => {
  it('clicking Preview flips the button label to Edit + renders preview surface', async () => {
    const ms = {
      id: 5001,
      tripId: 101,
      subdomain: 'tmc-andaman-mumbai-g7',
      itineraryHtml: '<h2>Day 1 — Arrival</h2><p>Welcome aboard.</p>',
      faqJson: null,
      expiresAt: null,
      publicUuid: 'abc-123-def-456',
    };
    installFetchMock({ trip: makeTrip({ microsite: ms }) });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs.find((t) => /Public Experience/.test(t.textContent)));
    await screen.findByText((c) => c.includes('abc-123-def-456'));
    // Click Preview button — label flips to Edit.
    fireEvent.click(screen.getByRole('button', { name: /Preview/i }));
    expect(
      await screen.findByRole('button', { name: /Edit/i }),
    ).toBeInTheDocument();
    // Preview surface dangerouslySetInnerHTML renders the H2.
    expect(screen.getByText(/Day 1 — Arrival/)).toBeInTheDocument();
    // Click back to Edit to confirm the toggle is symmetric.
    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Edit$/i })).toBeNull();
    });
    expect(screen.getByRole('button', { name: /Preview/i })).toBeInTheDocument();
  });
});

// ─── EXTENSION WAVE 2 — 2026-05-26 ──────────────────────────────────────
//
// Second extension pass. The first extension covered participants-remove,
// participants-add-error, header date edges, rooming Add-room form open,
// payment-plan editor + Add-instalment + dueDate validation, microsite
// Create POST + blank itineraryHtml, microsite Editor Preview toggle.
//
// This wave pins the remaining uncovered surface:
//
//   1. Rooming — createRoom POSTs /rooming with the right body shape.
//   2. Rooming — createRoom validation: empty roomNumber surfaces
//      notify.error + no POST fires.
//   3. Rooming — load failure (GET reject) → empty rooms state, NO crash.
//   4. Rooming — RoomCard capacity guard: at-capacity unchecked boxes are
//      disabled so the operator can't over-book a twin/triple/quad.
//   5. Payment plan — load with existing plan hydrates editor (instalment
//      count + Edit-heading text + Delete-plan button visible).
//   6. Payment plan — empty editor (no instalments) Save surfaces "Add at
//      least one instalment" + no PUT fires.
//   7. Payment plan — adding then removing an instalment leaves zero rows.
//   8. Payment plan — Move-up reorders the instalment list (assert by
//      sequential aria-labels after swap).
//   9. Payment plan — per-participant instalments section renders the
//      backend's payload when /instalments returns a populated list.
//  10. Microsite Create — POST rejection surfaces notify.error with the
//      body.error from fetchApi (not the default "Failed to publish…").
//  11. Microsite Editor — Save (PATCH) happy path: PATCHes /microsite with
//      subdomain + itineraryHtml + expiresAt:null and
//      surfaces notify.success("Microsite updated").
//  12. Microsite Editor — Unpublish (DELETE) with window.confirm=true.
//  13. StatusBadge — unknown status string falls back to subtle colours
//      without crashing (renders the literal status text).
//
// All cases use stable mock object refs, findBy / waitFor for async, and
// getAllByText where labels appear in tab + card chrome.

describe('<TripDetail /> — Rooming create-room flow', () => {
  it('createRoom POSTs /api/travel/trips/:id/rooming with the right body', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    await screen.findByText(/No rooming assignments yet/i);
    fireEvent.click(screen.getByRole('button', { name: /Add room/i }));
    const roomNum = await screen.findByLabelText(/Room number/i);
    fireEvent.change(roomNum, { target: { value: '203' } });
    fetchApiMock.mockClear();
    installFetchMock();
    // The form's submit button has aria-label "Add room" — but the toggle
    // also reads "Add room" when visible. Once the form is open, the toggle
    // is hidden so there's only one match. Scope by buttons + accessible
    // name to be safe.
    fireEvent.click(screen.getByRole('button', { name: /^Add room$/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101/rooming' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.roomNumber).toBe('203');
      expect(body.roomType).toBe('twin');
      expect(body.participantIds).toEqual([]);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Room added/i));
  });

  it('createRoom with empty roomNumber surfaces notify.error + no POST fires', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    await screen.findByText(/No rooming assignments yet/i);
    fireEvent.click(screen.getByRole('button', { name: /Add room/i }));
    await screen.findByLabelText(/Room number/i);
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /^Add room$/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/roomNumber is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'POST');
    expect(posts.length).toBe(0);
  });

  it('Rooming load failure leaves rooms empty + does NOT crash the tab', async () => {
    // Replace the rooming GET with a rejection. Other endpoints stay
    // healthy so the trip itself still loads.
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'GET' && /^\/api\/travel\/trips\/\d+$/.test(url)) {
        return Promise.resolve(makeTrip());
      }
      if (method === 'GET' && /^\/api\/travel\/trips\/\d+\/rooming$/.test(url)) {
        return Promise.reject(new Error('boom'));
      }
      if (method === 'GET' && /payment-plan$/.test(url)) return Promise.resolve(null);
      if (method === 'GET' && /instalments$/.test(url)) return Promise.resolve({ instalments: [] });
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    // Empty-state copy still renders (load() catch sets rooms=[]).
    expect(
      await screen.findByText(/No rooming assignments yet/i),
    ).toBeInTheDocument();
    // 0 rooms · ... caption visible — page survived the rejection.
    expect(screen.getByText(/0 rooms/)).toBeInTheDocument();
  });

  it('RoomCard at-capacity unchecked participant buttons are not shown', async () => {
    // 3 participants + a single room type (single, capacity 1) →
    // after assigning P1, the "Add more participants" section disappears
    // because the room is at capacity.
    const tripWith3 = makeTrip({
      participants: [
        { id: 901, fullName: 'Anaya Sharma' },
        { id: 902, fullName: 'Kabir Mehta' },
        { id: 903, fullName: 'Riya Singh' },
      ],
    });
    installFetchMock({ trip: tripWith3 });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Rooming/i }));
    await screen.findByText(/No rooming assignments yet/i);
    fireEvent.click(screen.getByRole('button', { name: /Add room/i }));
    await screen.findByLabelText(/Room number/i);
    // Switch room type to "single" (capacity 1).
    const typeSelect = screen.getByLabelText(/Room type/i);
    fireEvent.change(typeSelect, { target: { value: 'single' } });
    // Capacity readout: "0 / 1 assigned".
    expect(screen.getByText(/0 \/ 1 assigned/)).toBeInTheDocument();
    // Assign Anaya — click the button showing her name.
    const anayaBtn = screen.getByRole('button', { name: /Anaya Sharma/ });
    fireEvent.click(anayaBtn);
    // Now capacity reads 1 / 1.
    expect(screen.getByText(/1 \/ 1 assigned/)).toBeInTheDocument();
    // Anaya now appears in the selected participants area (as a pill).
    expect(screen.getByText('Anaya Sharma')).toBeInTheDocument();
    // The "Add more participants" section is hidden because capacity is full.
    expect(screen.queryByText(/Add more participants/i)).not.toBeInTheDocument();
  });
});

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
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
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
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
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
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
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

describe('<TripDetail /> — Microsite Create POST error', () => {
  it('POST rejection surfaces notify.error with body.error from fetchApi', async () => {
    // Use a custom fetch impl: trip GET resolves, microsite POST rejects.
    const err = new Error('boom');
    err.body = { error: 'Subdomain already taken' };
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'GET' && /^\/api\/travel\/trips\/\d+$/.test(url)) {
        return Promise.resolve(makeTrip());
      }
      if (method === 'POST' && /\/microsite$/.test(url)) return Promise.reject(err);
      if (method === 'GET' && /payment-plan$/.test(url)) return Promise.resolve(null);
      if (method === 'GET' && /instalments$/.test(url)) {
        return Promise.resolve({ instalments: [] });
      }
      if (method === 'GET' && /rooming$/.test(url)) {
        return Promise.resolve({ rooming: [] });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Public Experience/i }));
    await screen.findByText(/Create a public registration page/i);
    fireEvent.click(screen.getByRole('button', { name: /Publish public page/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Subdomain already taken');
    });
  });
});

describe('<TripDetail /> — Microsite Editor save/unpublish/faq', () => {
  const ms = {
    id: 5001,
    tripId: 101,
    subdomain: 'tmc-andaman-mumbai-g7',
    itineraryHtml: '<h2>Day 1</h2><p>Arrival</p>',
    faqJson: null,
    expiresAt: null,
    publicUuid: 'abc-123-def-456',
  };

  it('Save changes PATCHes /microsite with the editor state + notify.success', async () => {
    installFetchMock({ trip: makeTrip({ microsite: ms }) });
    // Extend the fetch mock to accept PATCH /microsite.
    const origImpl = fetchApiMock.getMockImplementation();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'PATCH' && /\/microsite$/.test(url)) return Promise.resolve({});
      return origImpl(url, opts);
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs.find((t) => /Public Experience/.test(t.textContent)));
    await screen.findByText((c) => c.includes('abc-123-def-456'));
    fetchApiMock.mockClear();
    // Re-install with PATCH support.
    installFetchMock({ trip: makeTrip({ microsite: ms }) });
    const baseImpl = fetchApiMock.getMockImplementation();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'PATCH' && /\/microsite$/.test(url)) return Promise.resolve({});
      return baseImpl(url, opts);
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(
        ([u, o]) => /\/microsite$/.test(u) && o?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(patch[1].body);
      expect(body.subdomain).toBe('tmc-andaman-mumbai-g7');
      expect(body.itineraryHtml).toContain('Day 1');
      expect(body.expiresAt).toBeNull();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Microsite updated/i),
    );
  });

  it('Unpublish with window.confirm=true DELETEs /microsite + notify.success', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    installFetchMock({ trip: makeTrip({ microsite: ms }) });
    const baseImpl = fetchApiMock.getMockImplementation();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'DELETE' && /\/microsite$/.test(url)) return Promise.resolve({});
      return baseImpl(url, opts);
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs.find((t) => /Public Experience/.test(t.textContent)));
    await screen.findByText((c) => c.includes('abc-123-def-456'));
    fireEvent.click(screen.getByRole('button', { name: /^Unpublish$/i }));
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) => /\/microsite$/.test(u) && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Microsite unpublished/i),
    );
  });
});

describe('<TripDetail /> — StatusBadge fallback', () => {
  it('unknown status renders the literal text using subtle fallback colours (no crash)', async () => {
    installFetchMock({ trip: makeTrip({ status: 'pending-approval' }) });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    // The badge falls back to {bg:'var(--subtle-bg)', color:'var(--text-secondary)'}
    // when status isn't in the known set; literal text still renders.
    expect(screen.getByText('pending-approval')).toBeInTheDocument();
  });
});

// ─── EXTENSION WAVE 3 — 2026-06-12 ──────────────────────────────────────
//
// Passport OCR upload cell (PassportCell) on the Participants tab —
// the operator-side upload surface feeding the verification queue
// (backend/routes/travel_passport.js POST /participants/:id/passport-upload).
//
// Backend contract pinned:
//   POST /api/travel/passport/participants/:id/passport-upload
//     multipart, field name "file" → 201 { extraction, confidence, ... }
//     503 { code: 'PASSPORT_OCR_NOT_YET_ENABLED' } when vendor disabled.
// Client-side guards mirror the route's multer config: 5 MB cap, JPG/PNG/PDF.
//
// Badge state matrix (from participant passport columns on the trip GET):
//   passportVerifiedAt   → "Passport verified", NO upload CTA, Clear &
//                          re-upload CTA instead (DELETE /passport-extraction)
//   passportRejectedAt   → "Passport rejected" + Re-upload CTA
//   passportExtractedAt  → "Pending verification" + Re-upload CTA
//   none                 → "No passport" + "Upload passport" CTA
//
// The upload POST passes { silent: true } — fetchApi's auto-toast would
// stack a second (different-string, so un-deduped) toast next to the
// component's vendor-pending copy. The component owns all error toasts.

describe('<TripDetail /> — Participants passport upload', () => {
  function makeFile(name = 'passport.jpg', type = 'image/jpeg', size = 1024) {
    const f = new File(['x'], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  }

  async function openParticipantsTab() {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma');
  }

  it('renders the four passport status badges from the participant columns', async () => {
    installFetchMock({
      trip: makeTrip({
        participants: [
          { id: 901, fullName: 'Anaya Sharma' },
          { id: 902, fullName: 'Kabir Mehta', passportExtractedAt: '2026-06-01T10:00:00.000Z' },
          { id: 903, fullName: 'Riya Singh', passportExtractedAt: '2026-06-01T10:00:00.000Z', passportVerifiedAt: '2026-06-02T10:00:00.000Z' },
          { id: 904, fullName: 'Dev Patel', passportExtractedAt: '2026-06-01T10:00:00.000Z', passportRejectedAt: '2026-06-02T10:00:00.000Z' },
        ],
      }),
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    expect(await screen.findByText('No passport')).toBeInTheDocument();
    expect(screen.getByText('Pending verification')).toBeInTheDocument();
    expect(screen.getByText('Passport verified')).toBeInTheDocument();
    expect(screen.getByText('Passport rejected')).toBeInTheDocument();
    // Un-uploaded participant gets the "Upload passport" CTA; extracted +
    // rejected get "Re-upload".
    expect(screen.getByRole('button', { name: /Upload passport for Anaya Sharma/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload passport for Kabir Mehta/i })).toHaveTextContent(/Re-upload/);
    expect(screen.getByRole('button', { name: /Upload passport for Dev Patel/i })).toHaveTextContent(/Re-upload/);
  });

  it('VERIFIED participant shows the badge + Clear & re-upload CTA but NO upload CTA', async () => {
    installFetchMock({
      trip: makeTrip({
        participants: [
          { id: 903, fullName: 'Riya Singh', passportExtractedAt: '2026-06-01T10:00:00.000Z', passportVerifiedAt: '2026-06-02T10:00:00.000Z' },
        ],
      }),
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    expect(await screen.findByText('Passport verified')).toBeInTheDocument();
    // Anchored — the Clear CTA's name ends with "...passport for Riya Singh"
    // too, so an unanchored regex would false-match it.
    expect(screen.queryByRole('button', { name: /^Upload passport for Riya Singh$/i })).toBeNull();
    expect(screen.queryByLabelText(/Passport file for Riya Singh/i)).toBeNull();
    // The escape hatch for verified passports needing replacement.
    expect(
      screen.getByRole('button', { name: /Clear & re-upload passport for Riya Singh/i }),
    ).toBeInTheDocument();
  });

  it('Clear & re-upload on a VERIFIED participant DELETEs the extraction + reloads', async () => {
    installFetchMock({
      trip: makeTrip({
        participants: [
          { id: 903, fullName: 'Riya Singh', passportExtractedAt: '2026-06-01T10:00:00.000Z', passportVerifiedAt: '2026-06-02T10:00:00.000Z' },
        ],
      }),
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Passport verified');
    fireEvent.click(screen.getByRole('button', { name: /Clear & re-upload passport for Riya Singh/i }));
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/passport/participants/903/passport-extraction' && o?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/cleared/i),
    );
  });

  it('Clear & re-upload with confirm()=false short-circuits — no DELETE fires', async () => {
    // Mock notify.confirm to return false, so the DELETE is skipped.
    notifyObj.confirm = vi.fn(async () => false);
    installFetchMock({
      trip: makeTrip({
        participants: [
          { id: 903, fullName: 'Riya Singh', passportExtractedAt: '2026-06-01T10:00:00.000Z', passportVerifiedAt: '2026-06-02T10:00:00.000Z' },
        ],
      }),
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Passport verified');
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Clear & re-upload passport for Riya Singh/i }));
    await Promise.resolve();
    const dels = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'DELETE');
    expect(dels.length).toBe(0);
  });

  it('happy path: selecting a JPG POSTs FormData to the passport-upload endpoint + notify.success + trip reload', async () => {
    await openParticipantsTab();
    fetchApiMock.mockClear();
    installFetchMock();
    const fileInput = screen.getByLabelText(/Passport file for Anaya Sharma/i);
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/passport/participants/901/passport-upload' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(post[1].body).toBeInstanceOf(FormData);
      const sent = post[1].body.get('file');
      expect(sent).toBeTruthy();
      expect(sent.name).toBe('passport.jpg');
      // silent:true — the component owns error toasts; fetchApi's
      // auto-toast must stay off for this call.
      expect(post[1].silent).toBe(true);
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/queued for verification/i),
    );
    // onChange() → load() refires the trip GET so the badge refreshes.
    await waitFor(() => {
      const reload = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101' && (!o?.method || o.method === 'GET'),
      );
      expect(reload).toBeTruthy();
    });
  });

  it('oversize file (>5 MB) surfaces notify.error + no POST fires', async () => {
    await openParticipantsTab();
    fetchApiMock.mockClear();
    installFetchMock();
    const fileInput = screen.getByLabelText(/Passport file for Anaya Sharma/i);
    fireEvent.change(fileInput, {
      target: { files: [makeFile('big.jpg', 'image/jpeg', 6 * 1024 * 1024)] },
    });
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/5 MB limit/i));
    });
    const posts = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'POST');
    expect(posts.length).toBe(0);
  });

  it('unsupported mime (.txt) surfaces notify.error + no POST fires', async () => {
    await openParticipantsTab();
    fetchApiMock.mockClear();
    installFetchMock();
    const fileInput = screen.getByLabelText(/Passport file for Anaya Sharma/i);
    fireEvent.change(fileInput, {
      target: { files: [makeFile('notes.txt', 'text/plain')] },
    });
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/JPG, PNG or PDF only/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'POST');
    expect(posts.length).toBe(0);
  });

  it('PASSPORT_OCR_NOT_YET_ENABLED rejection surfaces the vendor-pending message', async () => {
    await openParticipantsTab();
    fetchApiMock.mockClear();
    const err = new Error('Passport OCR vendor not yet enabled for this tenant');
    err.code = 'PASSPORT_OCR_NOT_YET_ENABLED';
    err.status = 503;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && /passport-upload$/.test(url)) return Promise.reject(err);
      if (method === 'GET' && /^\/api\/travel\/trips\/\d+$/.test(url)) {
        return Promise.resolve(makeTrip());
      }
      return Promise.resolve(null);
    });
    const fileInput = screen.getByLabelText(/Passport file for Anaya Sharma/i);
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/vendor integration pending/i),
      );
    });
    // No success toast + no reload on the failure path.
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('generic upload failure surfaces the server error body', async () => {
    await openParticipantsTab();
    fetchApiMock.mockClear();
    const err = new Error('boom');
    err.data = { error: 'Failed to process passport upload' };
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && /passport-upload$/.test(url)) return Promise.reject(err);
      if (method === 'GET' && /^\/api\/travel\/trips\/\d+$/.test(url)) {
        return Promise.resolve(makeTrip());
      }
      return Promise.resolve(null);
    });
    const fileInput = screen.getByLabelText(/Passport file for Anaya Sharma/i);
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to process passport upload');
    });
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

  it('Participants tab fetches pending registrations on mount', async () => {
    installFetchMock({ pendingRegs: [makePendingReg()] });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101/registrations' && (!o?.method || o.method === 'GET'),
      );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByTestId('pending-registrations-list')).toBeInTheDocument();
    expect(screen.getByText('Aarav Iyer')).toBeInTheDocument();
    expect(screen.getByText(/AWAITING REVIEW/)).toBeInTheDocument();
  });

  it('shows "X pending registrations" count next to participants total', async () => {
    installFetchMock({
      pendingRegs: [
        makePendingReg(),
        makePendingReg({ id: 9002, status: 'OTP_VERIFIED', studentName: 'Priya' }),
        makePendingReg({ id: 9003, status: 'DRAFT', studentName: 'Sara' }),
      ],
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    const counter = await screen.findByTestId('pending-regs-count');
    expect(counter.textContent).toMatch(/3 pending registrations/);
  });

  it('DRAFT registration shows "Awaiting verification" pill with Approve and Reject buttons', async () => {
    installFetchMock({
      pendingRegs: [makePendingReg({ id: 9003, status: 'DRAFT', studentName: 'Sara' })],
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Sara');
    expect(screen.getByText(/AWAITING VERIFICATION/)).toBeInTheDocument();
    // Approve is now available for DRAFT registrations (OTP gate relaxed)
    expect(screen.getByTestId('approve-registration-9003')).toBeInTheDocument();
    // Reject is still available
    expect(screen.getByTestId('reject-registration-9003')).toBeInTheDocument();
  });

  it('CONVERTED registrations are filtered out of the pending list', async () => {
    installFetchMock({
      pendingRegs: [
        makePendingReg({ id: 9001, status: 'OTP_VERIFIED', studentName: 'StillPending' }),
        makePendingReg({ id: 9002, status: 'CONVERTED', studentName: 'AlreadyConverted', convertedToParticipantId: 555 }),
      ],
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('StillPending');
    // CONVERTED row must NOT appear in pending list (it shows up as a real participant instead)
    expect(screen.queryByText('AlreadyConverted')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-reg-row-9002')).not.toBeInTheDocument();
  });

  it('clicking Approve fires POST /registrations/:rid/approve and refreshes lists', async () => {
    installFetchMock({
      pendingRegs: [makePendingReg()],
      registrationDecide: { approved: true, participant: { id: 555 }, registration: { id: 9001, status: 'CONVERTED' } },
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
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

  it('clicking Reject prompts confirm then fires POST /registrations/:rid/reject', async () => {
    // Fresh resolve for each test to avoid mock cross-contamination
    const confirmMock = vi.fn(async () => true);
    vi.mocked(notifyObj.confirm).mockImplementation(confirmMock);

    installFetchMock({
      pendingRegs: [makePendingReg()],
      registrationDecide: { rejected: true, registration: { id: 9001, status: 'REJECTED' } },
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    const rejectBtn = await screen.findByTestId('reject-registration-9001');
    fireEvent.click(rejectBtn);
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Reject registration',
        destructive: true,
      }));
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/trips/101/registrations/9001/reject' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
  });

  it('Reject cancel does NOT fire the endpoint', async () => {
    // Fresh mock for this test to avoid cross-contamination
    const confirmMock = vi.fn(async () => false);
    vi.mocked(notifyObj.confirm).mockImplementation(confirmMock);

    installFetchMock({ pendingRegs: [makePendingReg()] });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    const rejectBtn = await screen.findByTestId('reject-registration-9001');
    fireEvent.click(rejectBtn);
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(fetchApiMock.mock.calls.find(
      ([u]) => /\/registrations\/9001\/reject/.test(u),
    )).toBeFalsy();
  });

  it('no pending registrations → pending list is not rendered, participants list still shows', async () => {
    installFetchMock({ pendingRegs: [] });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Participants/i }));
    await screen.findByText('Anaya Sharma'); // existing participant still shows
    expect(screen.queryByTestId('pending-registrations-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-regs-count')).not.toBeInTheDocument();
  });
});

describe('<TripDetail /> — Phase 8 Public Experience: LandingPageCard', () => {
  it('renders "No landing page linked yet" empty state with a link to the Landing Pages module', async () => {
    installFetchMock({ landingPage: { status: 404, body: { code: 'NOT_LINKED' } } });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Public Experience/i }));
    expect(await screen.findByTestId('landing-page-card')).toBeInTheDocument();
    expect(screen.getByText(/No landing page linked yet/i)).toBeInTheDocument();
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
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Public Experience/i }));
    expect(await screen.findByText('Bali Trip — bali2026')).toBeInTheDocument();
    const manageLink = screen.getByTestId('manage-landing-page-link');
    expect(manageLink.getAttribute('href')).toBe('/landing-pages/builder/77');
    // No duplicate Edit/Open/Copy buttons embedded in the trip detail.
    expect(screen.queryByTestId('open-landing-page-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('copy-landing-page-url-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('create-landing-page-btn')).not.toBeInTheDocument();
  });

  it('Public Experience tab renders BOTH landing-page card AND microsite section', async () => {
    installFetchMock({
      landingPage: {
        id: 77, slug: 'trip-bali2026', status: 'PUBLISHED', tripId: 101,
        title: 'Bali Trip',
      },
    });
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Public Experience/i }));
    // Landing page card present
    expect(await screen.findByTestId('landing-page-card')).toBeInTheDocument();
    // Microsite section also present (MicrositeCreate "No microsite" copy
    // shows since the default trip fixture has microsite: null)
    expect(screen.getByText(/Create a public registration page/i)).toBeInTheDocument();
  });
});
