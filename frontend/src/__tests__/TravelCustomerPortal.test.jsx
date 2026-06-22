/**
 * TravelCustomerPortal.test.jsx — vitest + RTL coverage for the new travel
 * customer portal (frontend/src/pages/travel/TravelCustomerPortal.jsx).
 *
 * Scope: pins the page-surface invariants for the auth-gated travel customer
 * portal (a Contact-token portal, distinct from the staff JWT auth surface).
 * Two top-level states: pre-login (<LoginScreen/>) and authenticated
 * (<Dashboard/>). The Dashboard fetches /portal/kyc/status + /portal/travel/
 * itineraries in parallel and renders the DigiLocker connect button (top-
 * right + Profile section) plus the bookings list.
 *
 * DigiLocker flow: in STUB mode (kyc.mode === "stub"), clicking the connect
 * button issues POST /portal/kyc/initiate → POST /portal/kyc/callback inline
 * without any redirect. In REAL mode (apisetu-partner / oauth2), the button
 * redirects to the DigiLocker authorize URL via window.location.href.
 *
 * Test cases (7):
 *   1. Pre-login: renders <LoginScreen/> when no portalToken in localStorage;
 *      Sign-in button + demo creds visible.
 *   2. Pre-login: login error path — bad credentials → inline error rendered,
 *      no token stored.
 *   3. Login happy path: valid credentials → POST /portal/login fires, token
 *      persists to localStorage, transitions to Dashboard with customer name.
 *   4. Dashboard: parallel fetch of /portal/kyc/status + /portal/travel/
 *      itineraries; profile card renders the contact's name + email.
 *   5. Verified state: when kycStatus="verified", header shows "Verified" pill
 *      (no Connect button); Profile section shows ✓ + masked Aadhaar last-4.
 *   6. Connect DigiLocker — stub mode: click button → initiate + callback fire
 *      inline; status reloads; success message visible.
 *   7. Logout: click sign-out → localStorage cleared → surface returns to
 *      LoginScreen.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - SUT uses raw `fetch` (NOT fetchApi from utils/api) — stub
 *     `globalThis.fetch` per-test, not vi.mock the helper.
 *   - localStorage is reset in beforeEach so each test sees pre-login state
 *     by default; dashboard tests pre-seed the token.
 *   - No AuthContext needed — this portal is a standalone public surface.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import TravelCustomerPortal from '../pages/travel/TravelCustomerPortal';

const PORTAL_TOKEN_KEY = 'portalToken';
const PORTAL_CONTACT_KEY = 'portalContact';

const seedContact = {
  id: 3140,
  name: 'Ahmed Khan',
  email: 'ahmed.pilgrim@demo.test',
  company: null,
};

function mockJsonResponse(data, init = {}) {
  return Promise.resolve({
    ok: init.status === undefined || init.status < 400,
    status: init.status || 200,
    json: () => Promise.resolve(data),
  });
}

function setupLoggedIn() {
  localStorage.setItem(PORTAL_TOKEN_KEY, 'fake-portal-jwt');
  localStorage.setItem(PORTAL_CONTACT_KEY, JSON.stringify(seedContact));
}

function renderPortal() {
  return render(
    <MemoryRouter initialEntries={['/travel/portal']}>
      <TravelCustomerPortal />
    </MemoryRouter>,
  );
}

// The dashboard is now a sidebar layout with views. Navigate via the sidebar
// nav (scoped by its aria-label so the label doesn't collide with the
// overview cards / view headings that share the same text).
async function gotoView(name) {
  const nav = await screen.findByRole('navigation', { name: /portal sections/i });
  fireEvent.click(within(nav).getByRole('button', { name }));
}

// Profile is NOT in the sidebar — it opens from the header name/avatar button.
async function openProfile() {
  await screen.findByRole('navigation', { name: /portal sections/i });
  fireEvent.click(screen.getByRole('button', { name: /ahmed khan/i }));
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('TravelCustomerPortal — unauthenticated', () => {
  // The standalone portal login screen was retired: customers sign in via the
  // unified /login page (which auto-falls-back to portal auth). An
  // unauthenticated visit to /travel/portal therefore redirects to /login.
  test('redirects to /login when no portalToken (no separate portal login screen)', async () => {
    render(
      <MemoryRouter initialEntries={['/travel/portal']}>
        <Routes>
          <Route path="/travel/portal/*" element={<TravelCustomerPortal />} />
          <Route path="/login" element={<div>UNIFIED LOGIN</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('UNIFIED LOGIN')).toBeInTheDocument();
    // The old "Customer Portal" standalone login is gone.
    expect(screen.queryByRole('heading', { name: /customer portal/i })).toBeNull();
  });
});

describe('TravelCustomerPortal — Dashboard (authenticated)', () => {
  test('fetches KYC status + itineraries in parallel; profile renders contact details', async () => {
    setupLoggedIn();
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/kyc/status')) {
        return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub', aadhaarLast4: null });
      }
      if (url.includes('/portal/travel/itineraries')) {
        return mockJsonResponse([]);
      }
      return mockJsonResponse({});
    });
    renderPortal();
    // Navigate to the Profile view via the sidebar, then assert details.
    await openProfile();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^profile$/i })).toBeInTheDocument();
    });
    // Name appears in the sidebar, header button + Profile card — use
    // getAllByText per the duplicate-label standing rule.
    expect(screen.getAllByText('Ahmed Khan').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('ahmed.pilgrim@demo.test').length).toBeGreaterThanOrEqual(1);
    // Both dashboard endpoints fetched on mount.
    const calls = globalThis.fetch.mock.calls.map(([u]) => u);
    expect(calls.some((u) => u.includes('/portal/kyc/status'))).toBe(true);
    expect(calls.some((u) => u.includes('/portal/travel/itineraries'))).toBe(true);
  });

  test('verified state hides Connect button and shows masked Aadhaar last-4', async () => {
    setupLoggedIn();
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/kyc/status')) {
        return mockJsonResponse({
          kycStatus: 'verified',
          mode: 'stub',
          aadhaarLast4: '9999',
          kycVerifiedAt: '2026-05-26T13:19:52.320Z',
        });
      }
      if (url.includes('/portal/travel/itineraries')) {
        return mockJsonResponse([]);
      }
      return mockJsonResponse({});
    });
    renderPortal();
    await waitFor(() => {
      // The "Verified" pill in the top-right header (rendered as a span,
      // not a button). Use getAllByText to tolerate duplicate labels.
      expect(screen.getAllByText(/verified/i).length).toBeGreaterThanOrEqual(1);
    });
    // No "Connect with DigiLocker" button should appear when verified.
    expect(screen.queryByRole('button', { name: /connect with digilocker/i })).toBeNull();
    // Masked Aadhaar last-4 lives in the Profile view.
    await openProfile();
    expect(await screen.findByText(/9999/)).toBeInTheDocument();
  });

  test('stub-mode verify flow: click Connect → initiate + callback fire inline → success message', async () => {
    setupLoggedIn();
    let kycStatusCallCount = 0;
    globalThis.fetch = vi.fn((url, opts) => {
      if (url.includes('/portal/kyc/status')) {
        kycStatusCallCount++;
        // First load: unverified. Second load (after callback): verified.
        if (kycStatusCallCount === 1) {
          return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub', aadhaarLast4: null });
        }
        return mockJsonResponse({
          kycStatus: 'verified',
          mode: 'stub',
          aadhaarLast4: '9999',
          kycVerifiedAt: '2026-05-26T13:19:52.320Z',
        });
      }
      if (url.includes('/portal/kyc/initiate')) {
        return mockJsonResponse({
          state: 'abc123def456abc123def456abc123de',
          oauthUrl: 'https://digilocker-stub.invalid/oauth/authorize?state=abc',
          sessionId: 1,
        });
      }
      if (url.includes('/portal/kyc/callback')) {
        return mockJsonResponse({ verified: true, aadhaarLast4: '9999' });
      }
      if (url.includes('/portal/travel/itineraries')) {
        return mockJsonResponse([]);
      }
      return mockJsonResponse({});
    });
    renderPortal();
    // Wait for first load of unverified state — Connect button appears.
    const connectBtn = await screen.findAllByRole('button', { name: /connect with digilocker/i });
    expect(connectBtn.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(connectBtn[0]);
    await waitFor(() => {
      // Status banner shows the success message with the synthetic last-4.
      expect(screen.getByRole('status')).toHaveTextContent(/verified.*9999/i);
    });
    // initiate + callback were both invoked
    const calls = globalThis.fetch.mock.calls.map(([u]) => u);
    expect(calls.some((u) => u.includes('/portal/kyc/initiate'))).toBe(true);
    expect(calls.some((u) => u.includes('/portal/kyc/callback'))).toBe(true);
  });

  test('sign-out clears localStorage and redirects to /login (no portal dashboard left)', async () => {
    setupLoggedIn();
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/kyc/status')) {
        return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub', aadhaarLast4: null });
      }
      if (url.includes('/portal/travel/itineraries')) {
        return mockJsonResponse([]);
      }
      return mockJsonResponse({});
    });
    render(
      <MemoryRouter initialEntries={['/travel/portal']}>
        <Routes>
          <Route path="/travel/portal/*" element={<TravelCustomerPortal />} />
          <Route path="/login" element={<div>UNIFIED LOGIN</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: /portal sections/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    // Tokens cleared + redirected to the unified login (no portal dashboard).
    expect(await screen.findByText('UNIFIED LOGIN')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /portal sections/i })).toBeNull();
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(PORTAL_CONTACT_KEY)).toBeNull();
  });
});

describe('TravelCustomerPortal — self-service diagnostic', () => {
  const RFU_BANK = {
    available: true,
    bankId: 7,
    subBrand: 'rfu',
    version: 1,
    questions: [
      {
        id: 'q1',
        text: 'Have you performed Umrah before?',
        type: 'single-choice',
        options: [
          { value: 'first', label: 'First-time pilgrim' },
          { value: 'repeat', label: 'Repeat (3+)' },
        ],
      },
      {
        id: 'q2',
        text: 'Any special-assistance requirements?',
        type: 'multi-select',
        options: [
          { value: 'wheelchair', label: 'Wheelchair' },
          { value: 'halal-meal', label: 'Halal meal' },
        ],
      },
    ],
  };

  // Base dashboard fetch mock (kyc + itineraries) + a customisable diagnostic
  // handler. `onPost` captures the submitted body. `brands` drives the
  // brand-selector; a single brand auto-selects (no dropdown).
  function mockDashboard({
    brands = [{ subBrand: 'rfu' }],
    defaultSubBrand = 'rfu',
    bank = RFU_BANK,
    history = [],
    postResult,
    onPost,
  } = {}) {
    globalThis.fetch = vi.fn((url, opts) => {
      if (url.includes('/portal/kyc/status')) return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub', aadhaarLast4: null });
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse([]);
      if (url.includes('/portal/travel/diagnostic-brands')) return mockJsonResponse({ brands, defaultSubBrand });
      if (url.includes('/portal/travel/diagnostic-bank')) return mockJsonResponse(bank);
      if (url.includes('/portal/travel/diagnostics')) {
        if (opts && opts.method === 'POST') {
          if (onPost) onPost(JSON.parse(opts.body));
          return mockJsonResponse(postResult, { status: 201 });
        }
        return mockJsonResponse(history);
      }
      return mockJsonResponse({});
    });
  }

  test('renders the take-diagnostic CTA when a bank is available', async () => {
    setupLoggedIn();
    mockDashboard();
    renderPortal();
    await gotoView(/travel diagnostic/i);
    expect(await screen.findByRole('button', { name: /take the diagnostic/i })).toBeInTheDocument();
    // The diagnostic-bank endpoint was fetched.
    const calls = globalThis.fetch.mock.calls.map(([u]) => u);
    expect(calls.some((u) => u.includes('/portal/travel/diagnostic-bank'))).toBe(true);
  });

  test('accepts single + multi answers, POSTs them, and renders the result', async () => {
    setupLoggedIn();
    let posted = null;
    mockDashboard({
      onPost: (body) => { posted = body; },
      postResult: {
        id: 99, subBrand: 'rfu', score: 4, classification: 'level_1',
        classificationLabel: 'Standard Pilgrim', recommendedTier: 'entry',
        createdAt: '2026-06-08T10:00:00.000Z',
      },
    });
    renderPortal();
    await gotoView(/travel diagnostic/i);
    fireEvent.click(await screen.findByRole('button', { name: /take the diagnostic/i }));

    // Answer q1 (single-choice radio) + q2 (multi-select checkbox).
    fireEvent.click(await screen.findByLabelText(/First-time pilgrim/i));
    fireEvent.click(screen.getByLabelText(/Wheelchair/i));
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));

    await waitFor(() => {
      expect(screen.getByText(/Standard Pilgrim/i)).toBeInTheDocument();
    });
    // Submitted shape: brand + single = string, multi = array.
    expect(posted.subBrand).toBe('rfu');
    expect(posted.answers.q1).toBe('first');
    expect(posted.answers.q2).toEqual(['wheelchair']);
  });

  test('blocks submit until every question is answered', async () => {
    setupLoggedIn();
    let postFired = false;
    mockDashboard({ onPost: () => { postFired = true; }, postResult: {} });
    renderPortal();
    await gotoView(/travel diagnostic/i);
    fireEvent.click(await screen.findByRole('button', { name: /take the diagnostic/i }));
    // Answer only q1, leave q2 blank → submit should be rejected client-side.
    fireEvent.click(await screen.findByLabelText(/First-time pilgrim/i));
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/answer every question/i);
    });
    expect(postFired).toBe(false);
  });

  test('shows the latest past result + Retake when history exists', async () => {
    setupLoggedIn();
    mockDashboard({
      history: [{
        id: 50, subBrand: 'rfu', score: 8, classification: 'level_2',
        classificationLabel: 'Confident Pilgrim', recommendedTier: 'primary',
        createdAt: '2026-06-01T10:00:00.000Z',
      }],
    });
    renderPortal();
    await gotoView(/travel diagnostic/i);
    await screen.findByText(/Confident Pilgrim/i);
    expect(screen.getByRole('button', { name: /retake diagnostic/i })).toBeInTheDocument();
  });

  test('shows an unavailable message when no diagnostic brands exist', async () => {
    setupLoggedIn();
    mockDashboard({ brands: [], defaultSubBrand: null });
    renderPortal();
    await gotoView(/travel diagnostic/i);
    await screen.findByText(/no diagnostic is available for you right now/i);
    expect(screen.queryByRole('button', { name: /take the diagnostic/i })).toBeNull();
  });

  test('multi-brand customer can choose which programme to take', async () => {
    setupLoggedIn();
    const TMC_BANK = {
      available: true, bankId: 8, subBrand: 'tmc', version: 1,
      questions: [{ id: 't1', text: 'Group size?', type: 'single-choice', options: [{ value: 'small', label: 'Small group' }] }],
    };
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/kyc/status')) return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub' });
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse([]);
      if (url.includes('/portal/travel/diagnostic-brands')) {
        return mockJsonResponse({ brands: [{ subBrand: 'rfu' }, { subBrand: 'tmc' }], defaultSubBrand: 'rfu' });
      }
      if (url.includes('/portal/travel/diagnostic-bank')) {
        return url.includes('subBrand=tmc') ? mockJsonResponse(TMC_BANK) : mockJsonResponse(RFU_BANK);
      }
      if (url.includes('/portal/travel/diagnostics')) return mockJsonResponse([]);
      return mockJsonResponse({});
    });
    renderPortal();
    await gotoView(/travel diagnostic/i);
    // A selector appears because the customer is served by >1 brand.
    const select = await screen.findByLabelText(/select travel programme/i);
    expect(select).toBeInTheDocument();
    // Default brand (RFU) question is reachable.
    fireEvent.click(await screen.findByRole('button', { name: /take the diagnostic/i }));
    expect(await screen.findByText(/Have you performed Umrah before\?/i)).toBeInTheDocument();
    // Switch to TMC → its question bank loads.
    fireEvent.change(select, { target: { value: 'tmc' } });
    fireEvent.click(await screen.findByRole('button', { name: /take the diagnostic/i }));
    expect(await screen.findByText(/Group size\?/i)).toBeInTheDocument();
  });
});

describe('TravelCustomerPortal — sidebar navigation + avatar', () => {
  function mockBase(extra) {
    globalThis.fetch = vi.fn((url, opts) => {
      if (url.includes('/portal/kyc/status')) return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub', aadhaarLast4: null });
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse(extra?.itineraries || []);
      if (url.includes('/portal/travel/diagnostic-brands')) return mockJsonResponse({ brands: [], defaultSubBrand: null });
      if (url.includes('/portal/travel/avatar') && opts && opts.method === 'POST') {
        return mockJsonResponse({ avatarUrl: 'https://s3.example/avatars/contact/3140/new.jpg' });
      }
      return mockJsonResponse({});
    });
  }

  test('default view is the dashboard overview (cards), not all sections at once', async () => {
    setupLoggedIn();
    mockBase();
    renderPortal();
    await screen.findByRole('navigation', { name: /portal sections/i });
    // Profile heading is NOT shown on the overview — it lives in its own view.
    expect(screen.queryByRole('heading', { name: /^profile$/i })).toBeNull();
  });

  test('clicking the name in the header opens the Profile view', async () => {
    setupLoggedIn();
    mockBase();
    renderPortal();
    await screen.findByRole('navigation', { name: /portal sections/i });
    fireEvent.click(screen.getByRole('button', { name: /ahmed khan/i }));
    expect(await screen.findByRole('heading', { name: /^profile$/i })).toBeInTheDocument();
  });

  test('My Bookings view lists the customer itineraries', async () => {
    setupLoggedIn();
    mockBase({
      itineraries: [{
        id: 1, destination: 'Makkah + Madinah', status: 'accepted',
        startDate: '2026-07-11', endDate: '2026-07-21', totalAmount: 185000, currency: 'INR',
      }],
    });
    renderPortal();
    await gotoView(/my bookings/i);
    expect(await screen.findByText(/Makkah \+ Madinah/i)).toBeInTheDocument();
  });

  test('clicking a booking opens its detail view; Back returns to the list', async () => {
    setupLoggedIn();
    mockBase({
      itineraries: [{
        id: 1, destination: 'Makkah + Madinah', status: 'accepted',
        startDate: '2026-07-11', endDate: '2026-07-21',
        totalAmount: 185000, advancePaidAmount: 92500, currency: 'INR',
        items: [
          { id: 11, itemType: 'flight', description: 'DEL-JED Saudia economy', totalPrice: 42000, position: 0 },
          { id: 12, itemType: 'hotel', description: 'Makkah Hilton — 6 nights', totalPrice: 78000, position: 1 },
        ],
      }],
    });
    renderPortal();
    await gotoView(/my bookings/i);
    // Click the booking row → detail view with items + trip cost.
    fireEvent.click(await screen.findByRole('button', { name: /view makkah \+ madinah details/i }));
    expect(await screen.findByText(/your trip includes/i)).toBeInTheDocument();
    // The item description appears in both the items list AND the per-person
    // estimate-calculator breakdown, so it's a multi-match now.
    expect(screen.getAllByText(/DEL-JED Saudia economy/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/trip cost/i)).toBeInTheDocument();
    // Back returns to the bookings list.
    fireEvent.click(screen.getByRole('button', { name: /back to bookings/i }));
    expect(await screen.findByRole('heading', { name: /my bookings/i })).toBeInTheDocument();
  });

  test('per-person estimate calculator multiplies per-person price by the typed headcount', async () => {
    setupLoggedIn();
    mockBase({
      itineraries: [{
        id: 1, destination: 'Makkah + Madinah', status: 'accepted',
        startDate: '2026-07-11', endDate: '2026-07-21',
        // total 120000 for pax=2 → per person 60000.
        totalAmount: 120000, pax: 2, currency: 'INR',
        items: [
          { id: 11, itemType: 'flight', description: 'DEL-JED Saudia economy', totalPrice: 42000, position: 0 },
          { id: 12, itemType: 'hotel', description: 'Makkah Hilton — 6 nights', totalPrice: 78000, position: 1 },
        ],
      }],
    });
    renderPortal();
    await gotoView(/my bookings/i);
    fireEvent.click(await screen.findByRole('button', { name: /view makkah \+ madinah details/i }));
    await screen.findByText(/estimate for your group/i);

    // Defaults to the advisor's pax (2): 60000 × 2 = 120000.
    expect(screen.getByText(/60,000.*×.*2 people/i)).toBeInTheDocument();

    // Type 5 people → 60000 × 5 = 300000.
    const input = screen.getByLabelText(/number of people for the estimate/i);
    fireEvent.change(input, { target: { value: '5' } });
    expect(screen.getByText(/60,000.*×.*5 people/i)).toBeInTheDocument();
    // The multiplied total surfaces (₹300,000) in the estimate panel.
    expect(screen.getByText(/3,00,000|300,000/)).toBeInTheDocument();
  });

  test('uploads an avatar to /portal/travel/avatar and shows the new image', async () => {
    setupLoggedIn();
    mockBase();
    renderPortal();
    await openProfile();
    const input = await screen.findByLabelText(/upload profile photo/i);
    const file = new File(['x'], 'me.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(document.querySelector('img[src*="avatars/contact/3140"]')).toBeTruthy();
    });
    const calls = globalThis.fetch.mock.calls.map(([u]) => u);
    expect(calls.some((u) => u.includes('/portal/travel/avatar'))).toBe(true);
  });
});

describe('TravelCustomerPortal — customer accept / decline of an offer', () => {
  // A "sent" itinerary is a decidable offer — the customer can accept/decline.
  const OFFER = {
    id: 1, destination: 'Goa Family', status: 'sent',
    startDate: '2026-07-01', endDate: '2026-07-05',
    totalAmount: 50000, currency: 'INR', items: [],
  };

  function mockOffer({ onAccept, onDecline } = {}) {
    globalThis.fetch = vi.fn((url, opts) => {
      if (url.includes('/portal/kyc/status')) return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub' });
      if (url.includes('/portal/travel/diagnostic-brands')) return mockJsonResponse({ brands: [], defaultSubBrand: null });
      if (url.includes('/portal/travel/itineraries/1/accept') && opts && opts.method === 'POST') {
        if (onAccept) onAccept(opts.body ? JSON.parse(opts.body) : {});
        return mockJsonResponse({ id: 1, status: 'accepted' }, { status: 200 });
      }
      if (url.includes('/portal/travel/itineraries/1/decline') && opts && opts.method === 'POST') {
        const body = opts.body ? JSON.parse(opts.body) : {};
        if (onDecline) onDecline(body);
        return mockJsonResponse({ id: 1, status: 'rejected', declineReason: body.reason }, { status: 200 });
      }
      if (url.includes('/portal/travel/itineraries') && (!opts || opts.method === 'GET')) {
        return mockJsonResponse([OFFER]);
      }
      return mockJsonResponse({});
    });
  }

  test('a decidable offer shows Accept + Decline and accepting POSTs /accept', async () => {
    setupLoggedIn();
    let accepted = false;
    mockOffer({ onAccept: () => { accepted = true; } });
    renderPortal();
    await gotoView(/my bookings/i);
    fireEvent.click(await screen.findByRole('button', { name: /view goa family details/i }));
    expect(await screen.findByText(/review this offer/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /accept offer/i }));
    await waitFor(() => expect(accepted).toBe(true));
  });

  test('declining asks for a reason and posts it to /decline', async () => {
    setupLoggedIn();
    let declineBody = null;
    mockOffer({ onDecline: (b) => { declineBody = b; } });
    renderPortal();
    await gotoView(/my bookings/i);
    fireEvent.click(await screen.findByRole('button', { name: /view goa family details/i }));
    // Decline opens a reason form rather than declining immediately.
    fireEvent.click(await screen.findByRole('button', { name: /^decline$/i }));
    const reason = await screen.findByLabelText(/reason for declining/i);
    fireEvent.change(reason, { target: { value: 'Budget too high' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm decline/i }));
    await waitFor(() => expect(declineBody && declineBody.reason).toBe('Budget too high'));
  });
});

// ─── Travel Documents — unified travellers + passport upload ────────────
//
// Customer-side passport flow for ALL 4 sub-brands (PRD_PASSPORT_OCR):
// add travellers (POST /portal/travel/travellers) keyed to the customer +
// upload each one's passport (multipart POST .../travellers/:id/passport-upload).
// No trip-picking. The portal receives STATUS timestamps only — never
// extracted passport values.

describe('TravelCustomerPortal — Travel Documents (travellers + passports)', () => {
  const TRAVELLERS = [
    {
      id: 901, fullName: 'Fatima Khan', relationship: 'spouse', subBrand: 'rfu',
      passportExtractedAt: null, passportVerifiedAt: null, passportRejectedAt: null,
    },
    {
      id: 902, fullName: 'Yusuf Khan', relationship: 'child', subBrand: 'rfu',
      passportExtractedAt: '2026-06-01T10:00:00.000Z',
      passportVerifiedAt: '2026-06-02T10:00:00.000Z',
      passportRejectedAt: null,
    },
  ];

  function mockDocuments({ travellers = TRAVELLERS, onAddTraveller, onUpload } = {}) {
    globalThis.fetch = vi.fn((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url.includes('/portal/kyc/status')) return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub' });
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse([]);
      // Match the upload BEFORE the travellers list — the URL contains both.
      if (url.includes('/passport-upload') && method === 'POST') {
        if (onUpload) onUpload(url, opts);
        return mockJsonResponse({ travellerId: 901, status: 'pending-verification' }, { status: 201 });
      }
      if (url.includes('/portal/travel/travellers') && method === 'POST') {
        if (onAddTraveller) onAddTraveller(JSON.parse(opts.body));
        return mockJsonResponse({ traveller: { id: 905, fullName: 'New Kid', relationship: 'child', subBrand: 'rfu' } }, { status: 201 });
      }
      if (url.includes('/portal/travel/travellers')) return mockJsonResponse({ travellers });
      return mockJsonResponse({});
    });
  }

  test('lists travellers with status badges; verified traveller has no upload control', async () => {
    setupLoggedIn();
    mockDocuments();
    renderPortal();
    await gotoView(/travel documents/i);
    expect(await screen.findByText('Fatima Khan')).toBeInTheDocument();
    expect(screen.getByText('Yusuf Khan')).toBeInTheDocument();
    // Badges per the state matrix.
    expect(screen.getByText('Passport needed')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    // Fatima (no passport) gets an upload control; Yusuf (verified) does not.
    expect(screen.getByLabelText('Passport file for Fatima Khan')).toBeInTheDocument();
    expect(screen.queryByLabelText('Passport file for Yusuf Khan')).toBeNull();
  });

  test('empty state renders the add-travellers hint', async () => {
    setupLoggedIn();
    mockDocuments({ travellers: [] });
    renderPortal();
    await gotoView(/travel documents/i);
    expect(await screen.findByText(/no travellers yet/i)).toBeInTheDocument();
  });

  test('Add traveller posts { fullName, relationship } and reloads the list', async () => {
    setupLoggedIn();
    let addBody = null;
    mockDocuments({ onAddTraveller: (b) => { addBody = b; } });
    renderPortal();
    await gotoView(/travel documents/i);
    await screen.findByText('Fatima Khan');
    fireEvent.click(screen.getByRole('button', { name: /add traveller/i }));
    fireEvent.change(screen.getByLabelText(/traveller full name/i), { target: { value: 'New Kid' } });
    fireEvent.change(screen.getByLabelText(/who is this/i), { target: { value: 'child' } });
    // The header toggle hides while the form is open, so the only
    // "Add traveller" button left is the form's submit.
    fireEvent.click(screen.getByRole('button', { name: /add traveller/i }));
    await waitFor(() => {
      expect(addBody).toEqual({ fullName: 'New Kid', relationship: 'child' });
    });
    expect(await screen.findByText(/now upload their passport/i)).toBeInTheDocument();
  });

  test('uploading a JPG posts FormData to the travellers passport-upload endpoint', async () => {
    setupLoggedIn();
    let uploadUrl = null;
    let uploadBody = null;
    mockDocuments({ onUpload: (url, opts) => { uploadUrl = url; uploadBody = opts.body; } });
    renderPortal();
    await gotoView(/travel documents/i);
    const input = await screen.findByLabelText('Passport file for Fatima Khan');
    const file = new File(['x'], 'passport.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(uploadUrl).toContain('/portal/travel/travellers/901/passport-upload');
    });
    expect(uploadBody).toBeInstanceOf(FormData);
    expect(uploadBody.get('file').name).toBe('passport.jpg');
    expect(await screen.findByText(/our team will verify it shortly/i)).toBeInTheDocument();
  });

  test('unsupported file type shows an error banner and never hits the network', async () => {
    setupLoggedIn();
    let uploaded = false;
    mockDocuments({ onUpload: () => { uploaded = true; } });
    renderPortal();
    await gotoView(/travel documents/i);
    const input = await screen.findByLabelText('Passport file for Fatima Khan');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });
    expect(await screen.findByText(/jpg, png or pdf only/i)).toBeInTheDocument();
    expect(uploaded).toBe(false);
  });

  test('oversize file (>5 MB) shows the limit banner and never hits the network', async () => {
    setupLoggedIn();
    let uploaded = false;
    mockDocuments({ onUpload: () => { uploaded = true; } });
    renderPortal();
    await gotoView(/travel documents/i);
    const input = await screen.findByLabelText('Passport file for Fatima Khan');
    const big = new File(['x'], 'big.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/5 MB limit/i)).toBeInTheDocument();
    expect(uploaded).toBe(false);
  });

  test('upload control is a real button whose accessible name contains the visible label (WCAG 2.5.3)', async () => {
    setupLoggedIn();
    mockDocuments();
    renderPortal();
    await gotoView(/travel documents/i);
    // Real <button>, accessible name "Upload passport for Fatima Khan"
    // (contains the visible "Upload passport" text).
    const btn = await screen.findByRole('button', { name: /upload passport for fatima khan/i });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveTextContent(/upload passport/i);
  });

  test('a 401 on the documents load boots the customer to the unified /login', async () => {
    setupLoggedIn();
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/kyc/status')) return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub' });
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse([]);
      // Session expired mid-session — the documents fetch 401s.
      if (url.includes('/portal/travel/travellers')) {
        return mockJsonResponse({ error: 'Portal session expired' }, { status: 401 });
      }
      return mockJsonResponse({});
    });
    render(
      <MemoryRouter initialEntries={['/travel/portal']}>
        <Routes>
          <Route path="/travel/portal/*" element={<TravelCustomerPortal />} />
          <Route path="/login" element={<div>UNIFIED LOGIN</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await gotoView(/travel documents/i);
    // onLogout clears the token + redirects to the unified /login.
    await waitFor(() => {
      expect(screen.getByText('UNIFIED LOGIN')).toBeInTheDocument();
    });
    expect(localStorage.getItem('portalToken')).toBeNull();
  });
});

describe('TravelCustomerPortal — G092 brand-kit consumer', () => {
  test('fetches brand kit from /api/brand-kits/by-subbrand/:sub when profile carries subBrand', async () => {
    setupLoggedIn();
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/kyc/status')) {
        return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub', aadhaarLast4: null });
      }
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse([]);
      if (url.includes('/portal/travel/profile')) {
        return mockJsonResponse({ id: 3140, name: 'Ahmed Khan', email: 'ahmed.pilgrim@demo.test', subBrand: 'rfu' });
      }
      if (url.includes('/api/brand-kits/by-subbrand/rfu')) {
        return mockJsonResponse({
          subBrand: 'rfu',
          brandKit: {
            primaryColor: '#0B5345',
            accentColor: '#D4AC0D',
            logoUrl: 'https://cdn.example/rfu.png',
            tagline: 'Umrah journeys with care',
            supportEmail: 'umrah@example.com',
            supportPhone: '+91-22-9999-0000',
            missionStatement: 'Trusted Umrah & Hajj operator since 2010.',
          },
        });
      }
      return mockJsonResponse({});
    });
    renderPortal();
    // Brand logo appears in the header via data-testid.
    const logo = await screen.findByTestId('portal-brand-logo');
    expect(logo.getAttribute('src')).toBe('https://cdn.example/rfu.png');
    // Brand footer surfaces mission + support contacts.
    expect(await screen.findByTestId('portal-brand-footer')).toBeInTheDocument();
    expect(screen.getByText(/Trusted Umrah & Hajj operator since 2010/i)).toBeInTheDocument();
    expect(screen.getByText('umrah@example.com')).toBeInTheDocument();
    expect(screen.getByText('+91-22-9999-0000')).toBeInTheDocument();
    // CSS vars applied at root.
    await waitFor(() => {
      const root = document.documentElement;
      expect(root.style.getPropertyValue('--primary-color')).toBe('#0B5345');
      expect(root.style.getPropertyValue('--accent-color')).toBe('#D4AC0D');
    });
  });

  test('skips brand-kit fetch when profile carries no subBrand', async () => {
    setupLoggedIn();
    let calledBrandKit = false;
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/kyc/status')) {
        return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub', aadhaarLast4: null });
      }
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse([]);
      if (url.includes('/portal/travel/profile')) {
        // Profile loads but Contact.subBrand is null.
        return mockJsonResponse({ id: 3140, name: 'Ahmed Khan', email: 'ahmed.pilgrim@demo.test', subBrand: null });
      }
      if (url.includes('/api/brand-kits/by-subbrand/')) {
        calledBrandKit = true;
        return mockJsonResponse({}, { status: 404 });
      }
      return mockJsonResponse({});
    });
    renderPortal();
    // Wait for the dashboard chrome to settle before assertions.
    await screen.findByRole('navigation', { name: /portal sections/i });
    // The brand-kit endpoint should NEVER be called without a sub-brand.
    expect(calledBrandKit).toBe(false);
    // No brand-logo, no brand-footer.
    expect(screen.queryByTestId('portal-brand-logo')).toBeNull();
    expect(screen.queryByTestId('portal-brand-footer')).toBeNull();
  });

  test('falls back gracefully when /api/brand-kits/by-subbrand returns 404', async () => {
    setupLoggedIn();
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/kyc/status')) {
        return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub', aadhaarLast4: null });
      }
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse([]);
      if (url.includes('/portal/travel/profile')) {
        return mockJsonResponse({ id: 3140, name: 'Ahmed Khan', email: 'ahmed.pilgrim@demo.test', subBrand: 'visasure' });
      }
      if (url.includes('/api/brand-kits/by-subbrand/visasure')) {
        return mockJsonResponse({ error: 'No active brand kit', code: 'BRAND_KIT_NOT_FOUND' }, { status: 404 });
      }
      return mockJsonResponse({});
    });
    renderPortal();
    await screen.findByRole('navigation', { name: /portal sections/i });
    // No logo / footer render even when subBrand is set if the fetch 404s.
    expect(screen.queryByTestId('portal-brand-logo')).toBeNull();
    expect(screen.queryByTestId('portal-brand-footer')).toBeNull();
  });
});

// ─── Light / dark theme toggle ──────────────────────────────────────────
//
// The portal is a public Contact-token surface, so the app-global
// data-vertical (driven by tenant.vertical) is "generic" here. The portal
// pins data-vertical="travel" + its own data-theme so it resolves the
// cohesive Travel palette (theme/travel.css) instead of inheriting the
// generic dark :root tokens (which caused the "mixed" cream-page/dark-card
// look). A header toggle flips light↔dark and persists to localStorage.
describe('TravelCustomerPortal — light/dark theme toggle', () => {
  function mockBase() {
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/kyc/status')) return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub' });
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse([]);
      return mockJsonResponse({});
    });
  }

  test('pins the travel vertical and defaults to light mode', async () => {
    setupLoggedIn();
    mockBase();
    renderPortal();
    await screen.findByRole('navigation', { name: /portal sections/i });
    expect(document.documentElement.getAttribute('data-vertical')).toBe('travel');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('toggle flips to dark mode, persists the choice, and updates data-theme', async () => {
    setupLoggedIn();
    mockBase();
    renderPortal();
    await screen.findByRole('navigation', { name: /portal sections/i });
    fireEvent.click(screen.getByRole('button', { name: /switch to dark mode/i }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
    expect(localStorage.getItem('portalTheme')).toBe('dark');
    // The button now offers the reverse action.
    expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeInTheDocument();
  });

  test('restores a previously saved dark preference on mount', async () => {
    setupLoggedIn();
    localStorage.setItem('portalTheme', 'dark');
    mockBase();
    renderPortal();
    await screen.findByRole('navigation', { name: /portal sections/i });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    // Header toggle reflects the dark state (offers switch-to-light).
    expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeInTheDocument();
  });
});

describe('TravelCustomerPortal — My Visa (FR-5/FR-6 self-serve)', () => {
  // Default replies for the dashboard's mount-time loads; the test supplies a
  // visa router on top.
  function withDashboardDefaults(visaRouter) {
    return (url, opts) => {
      if (url.includes('/portal/kyc/status')) return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub' });
      if (url.includes('/portal/travel/itineraries')) return mockJsonResponse([]);
      if (url.includes('/portal/travel/profile')) return mockJsonResponse(null);
      if (url.includes('/portal/travel/diagnostic-brands')) return mockJsonResponse({ brands: [] });
      if (url.includes('/portal/travel/diagnostics')) return mockJsonResponse([]);
      if (url.includes('/brand-kits/')) return mockJsonResponse({});
      const visa = visaRouter(url, opts);
      if (visa) return visa;
      return mockJsonResponse({});
    };
  }

  test('start flow: shows the doc preview, then starts the application + lists the checklist', async () => {
    let started = false;
    const theApp = {
      id: 7, applicationType: 'tourist', destinationCountry: 'United States', status: 'docs-pending',
      documentChecklist: [{ id: 1, docType: 'Passport', required: true, status: 'pending', attachmentUrl: null }],
    };
    globalThis.fetch = vi.fn(
      withDashboardDefaults((url, opts) => {
        if (url.includes('/portal/travel/visa/checklist-preview')) {
          return mockJsonResponse({ items: [{ docType: 'Passport', required: true }, { docType: 'Photo', required: false }] });
        }
        if (url.includes('/portal/travel/visa/applications')) {
          if (opts && opts.method === 'POST') {
            started = true;
            return mockJsonResponse({ created: true, application: theApp }, { status: 201 });
          }
          return mockJsonResponse({ applications: started ? [theApp] : [] });
        }
        return null;
      }),
    );
    setupLoggedIn();
    renderPortal();
    await gotoView('My Visa');

    expect(await screen.findByTestId('visa-start')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('visa-start-destination'), { target: { value: 'United States' } });
    // Live preview appears once a destination is entered.
    expect(await screen.findByTestId('visa-preview')).toBeInTheDocument();
    expect(screen.getByText('Passport')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('visa-start-submit'));
    // POST went out with the right body.
    await waitFor(() => {
      const post = globalThis.fetch.mock.calls.find(
        ([u, o]) => u.includes('/portal/travel/visa/applications') && o && o.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post[1].body)).toMatchObject({ applicationType: 'tourist', destinationCountry: 'United States' });
    });
    // The new application card + its checklist render.
    expect(await screen.findByTestId('visa-application-7')).toBeInTheDocument();
    expect(screen.getByTestId('visa-doc-1')).toBeInTheDocument();
  });

  test('lists multiple applications at once (e.g. a transit visa + a destination visa)', async () => {
    globalThis.fetch = vi.fn(
      withDashboardDefaults((url) => {
        if (url.includes('/portal/travel/visa/applications')) {
          return mockJsonResponse({
            applications: [
              { id: 7, applicationType: 'tourist', destinationCountry: 'United Arab Emirates', status: 'docs-pending', documentChecklist: [] },
              { id: 8, applicationType: 'tourist', destinationCountry: 'United States', status: 'docs-pending', documentChecklist: [] },
            ],
          });
        }
        return null;
      }),
    );
    setupLoggedIn();
    renderPortal();
    await gotoView('My Visa');

    expect(await screen.findByTestId('visa-application-7')).toBeInTheDocument();
    expect(screen.getByTestId('visa-application-8')).toBeInTheDocument();
    expect(screen.getByText(/United Arab Emirates/)).toBeInTheDocument();
    expect(screen.getByText(/United States/)).toBeInTheDocument();
    // "Start another" is offered (not the inline form, since apps exist).
    expect(screen.getByTestId('visa-start-another')).toBeInTheDocument();
  });

  test('upload flow: uploading a pending document flips it to "In review"', async () => {
    let uploaded = false;
    globalThis.fetch = vi.fn(
      withDashboardDefaults((url, opts) => {
        if (url.includes('/portal/travel/visa/documents/') && url.includes('/upload')) {
          uploaded = true;
          return mockJsonResponse(
            { item: { id: 1, docType: 'Passport', required: true, status: 'uploaded', attachmentUrl: 'https://x/visa-docs/a.png', attachmentName: 'p.png' } },
            { status: 201 },
          );
        }
        if (url.includes('/portal/travel/visa/applications')) {
          return mockJsonResponse({
            applications: [{
              id: 7, applicationType: 'tourist', destinationCountry: 'US', status: 'docs-pending',
              documentChecklist: [{ id: 1, docType: 'Passport', required: true, status: uploaded ? 'uploaded' : 'pending', attachmentUrl: uploaded ? 'https://x/visa-docs/a.png' : null }],
            }],
          });
        }
        return null;
      }),
    );
    setupLoggedIn();
    renderPortal();
    await gotoView('My Visa');

    expect(await screen.findByTestId('visa-application-7')).toBeInTheDocument();
    const label = screen.getByTestId('visa-upload-1');
    const input = label.querySelector('input[type="file"]');
    const file = new File(['x'], 'p.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const up = globalThis.fetch.mock.calls.find(
        ([u, o]) => u.includes('/portal/travel/visa/documents/1/upload') && o && o.method === 'POST',
      );
      expect(up).toBeTruthy();
    });
    await waitFor(() =>
      expect(within(screen.getByTestId('visa-doc-1')).getByText(/In review/i)).toBeInTheDocument(),
    );
  });

  test('cancel flow: cancelling a docs-pending application removes it (returns to the start form)', async () => {
    let deleted = false;
    globalThis.fetch = vi.fn(
      withDashboardDefaults((url, opts) => {
        if (url.includes('/portal/travel/visa/applications/') && opts && opts.method === 'DELETE') {
          deleted = true;
          return mockJsonResponse({ success: true, id: 7 });
        }
        if (url.includes('/portal/travel/visa/checklist-preview')) {
          return mockJsonResponse({ items: [] });
        }
        if (url.includes('/portal/travel/visa/applications')) {
          return mockJsonResponse({
            applications: deleted
              ? []
              : [{ id: 7, applicationType: 'tourist', destinationCountry: 'Pakistan', status: 'docs-pending', documentChecklist: [] }],
          });
        }
        return null;
      }),
    );
    setupLoggedIn();
    renderPortal();
    await gotoView('My Visa');

    expect(await screen.findByTestId('visa-application-7')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('visa-cancel-7'));

    // The SUT now uses an inline confirmation modal instead of window.confirm().
    expect(await screen.findByTestId('visa-cancel-confirm-ok')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('visa-cancel-confirm-ok'));

    await waitFor(() => {
      const del = globalThis.fetch.mock.calls.find(
        ([u, o]) => u.includes('/portal/travel/visa/applications/7') && o && o.method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    // No applications left → the start form is shown again.
    expect(await screen.findByTestId('visa-start')).toBeInTheDocument();
  });
});
