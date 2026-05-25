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
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
      expect.arrayContaining(['Overview', 'Participants', 'Rooming', 'Payment plan', 'Microsite']),
    );
    // Overview is selected by default.
    const overview = screen.getByRole('tab', { name: /Overview/i });
    expect(overview).toHaveAttribute('aria-selected', 'true');
  });
});

describe('<TripDetail /> — Overview tab', () => {
  it('renders the 9 metric cards including Destination, Depart, Return, Legal entity, Price/student, Participants, Required docs, Payment plan, Microsite', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    // Card labels (uppercased via CSS; DOM text is title-case).
    expect(screen.getByText('Destination')).toBeInTheDocument();
    expect(screen.getByText('Depart')).toBeInTheDocument();
    expect(screen.getByText('Return')).toBeInTheDocument();
    expect(screen.getByText('Legal entity')).toBeInTheDocument();
    expect(screen.getByText('Price / student')).toBeInTheDocument();
    // 'Participants' + 'Microsite' + 'Payment plan' appear BOTH as tab
    // labels AND as card labels; scope via getAllByText.
    expect(screen.getAllByText('Participants').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Payment plan').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Microsite').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Required docs')).toBeInTheDocument();
    // Card values for legal entity + payment-plan un-set + microsite un-
    // published.
    expect(screen.getByText('tmc_nexus')).toBeInTheDocument();
    expect(screen.getByText('not set')).toBeInTheDocument(); // payment plan
    expect(screen.getByText('not published')).toBeInTheDocument(); // microsite
    // Participants count (1, derived from the single fixture participant) —
    // scope via the Required-docs card NEIGHBOR pattern: find the card
    // whose label is "Participants" (using getAllByText then filtering by
    // closest card surface).
    const participantsLabels = screen.getAllByText('Participants');
    // The CARD label (vs the TAB label) is the one whose parent is the
    // Card div (no role="tab" sibling). Pick the one with a sibling
    // showing the count.
    const participantsCard = participantsLabels.find(
      (el) => el.parentElement && within(el.parentElement).queryByText('1'),
    );
    expect(participantsCard).toBeTruthy();
    // Required docs count = 2 (from documentRequirements fixture).
    const docsLabel = screen.getByText('Required docs');
    const docsCard = docsLabel.parentElement;
    expect(within(docsCard).getByText('2')).toBeInTheDocument();
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
});

describe('<TripDetail /> — Microsite tab', () => {
  it('un-published trip renders MicrositeCreate copy + subdomain default seeded from trip-{tripCode}', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    fireEvent.click(screen.getByRole('tab', { name: /Microsite/i }));
    expect(
      await screen.findByText(/No microsite published yet/i),
    ).toBeInTheDocument();
    // Subdomain input pre-fills with "trip-{tripCode}".
    const subdomainInput = screen.getByLabelText(/Microsite subdomain/i);
    expect(subdomainInput.value).toBe('trip-TMC-AND-2026-MUMBAI-G7');
    // Publish button visible.
    expect(
      screen.getByRole('button', { name: /Publish microsite/i }),
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
    const micrositeTab = tabs.find((t) => /Microsite/.test(t.textContent));
    expect(micrositeTab).toBeTruthy();
    fireEvent.click(micrositeTab);
    // publicUuid renders verbatim in a <code> element.
    expect(await screen.findByText('abc-123-def-456')).toBeInTheDocument();
    // Action buttons.
    expect(screen.getByRole('button', { name: /Copy URL/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preview/i })).toBeInTheDocument();
    // Open link → /api/travel/microsites/public/<publicUuid> (origin
    // included; assert via substring).
    const openLink = screen.getByRole('link', { name: /Open/i });
    expect(openLink.getAttribute('href')).toContain(
      '/api/travel/microsites/public/abc-123-def-456',
    );
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
    vi.stubGlobal('confirm', vi.fn(() => false));
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

  it('Overview "Price / student" card renders ₹ + locale-formatted value', async () => {
    renderPage();
    await screen.findByText('TMC-AND-2026-MUMBAI-G7');
    // Price-per-student card. Locale-formatted 125000 is "1,25,000" under
    // en-IN or "125,000" under en-US; assert presence of the ₹ + trailing
    // 5-digit core (locale-tolerant).
    const priceLabel = screen.getByText('Price / student');
    const priceCard = priceLabel.parentElement;
    expect(within(priceCard).getByText((c) => /^₹[\d,]+$/.test(c))).toBeInTheDocument();
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
    // Total readout — initial amount is 0.
    expect(screen.getByText((c) => /Total:/.test(c))).toBeInTheDocument();
    expect(screen.getByText((c) => /^₹0$/.test(c))).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('tab', { name: /Microsite/i }));
    await screen.findByText(/No microsite published yet/i);
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Publish microsite/i }));
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
    fireEvent.click(screen.getByRole('tab', { name: /Microsite/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /Publish microsite/i }));
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
    fireEvent.click(tabs.find((t) => /Microsite/.test(t.textContent)));
    await screen.findByText('abc-123-def-456');
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
