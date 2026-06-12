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
import { MemoryRouter } from 'react-router-dom';

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

describe('TravelCustomerPortal — pre-login (LoginScreen)', () => {
  test('renders the login form when no portalToken in localStorage', () => {
    renderPortal();
    expect(screen.getByRole('heading', { name: /customer portal/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/ahmed\.pilgrim@demo\.test/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    // Demo credentials hint visible for testers.
    expect(screen.getByText(/ahmed\.pilgrim@demo\.test/)).toBeInTheDocument();
  });

  test('invalid credentials render inline error, no token stored', async () => {
    globalThis.fetch = vi.fn(() => mockJsonResponse({ error: 'Invalid credentials' }, { status: 401 }));
    renderPortal();
    fireEvent.change(screen.getByPlaceholderText(/ahmed\.pilgrim/i), {
      target: { value: 'wrong@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: 'badpass' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/invalid credentials/i);
    });
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
  });

  test('successful login persists token + contact and transitions to Dashboard', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url.includes('/portal/login')) {
        return mockJsonResponse({ token: 'jwt-x', contact: seedContact });
      }
      if (url.includes('/portal/kyc/status')) {
        return mockJsonResponse({ kycStatus: 'unverified', mode: 'stub', aadhaarLast4: null });
      }
      if (url.includes('/portal/travel/itineraries')) {
        return mockJsonResponse([]);
      }
      return mockJsonResponse({});
    });
    renderPortal();
    fireEvent.change(screen.getByPlaceholderText(/ahmed\.pilgrim/i), {
      target: { value: 'ahmed.pilgrim@demo.test' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => {
      // Dashboard chrome: sidebar nav present after login.
      expect(screen.getByRole('navigation', { name: /portal sections/i })).toBeInTheDocument();
    });
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBe('jwt-x');
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

  test('sign-out button clears localStorage and returns to LoginScreen', async () => {
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
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: /portal sections/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    // LoginScreen heading visible again
    expect(screen.getByRole('heading', { name: /customer portal/i })).toBeInTheDocument();
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

  test('a 401 on the documents load boots the customer back to the login screen', async () => {
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
    renderPortal();
    await gotoView(/travel documents/i);
    // onLogout clears the token + returns to LoginScreen.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /customer portal/i })).toBeInTheDocument();
    });
    expect(localStorage.getItem('portalToken')).toBeNull();
  });
});
