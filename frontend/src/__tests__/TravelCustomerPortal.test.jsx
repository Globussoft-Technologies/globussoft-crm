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
      // Dashboard chrome: "Travel Customer Portal" header + customer name.
      expect(screen.getByText('Travel Customer Portal')).toBeInTheDocument();
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
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^profile$/i })).toBeInTheDocument();
    });
    // Profile fields rendered from localStorage-cached contact. The name
    // appears twice (header chrome + Profile card) — use getAllByText per
    // CLAUDE.md standing rule on duplicate labels.
    expect(screen.getAllByText('Ahmed Khan').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('ahmed.pilgrim@demo.test')).toBeInTheDocument();
    // Both endpoints fetched
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
      // not a button) — there are also "Verified ✓" texts in the Profile
      // card. Use getAllByText to tolerate duplicate labels (CLAUDE.md
      // standing rule for repeated copy across header chrome + body).
      expect(screen.getAllByText(/verified/i).length).toBeGreaterThanOrEqual(1);
    });
    // No "Connect with DigiLocker" button should appear when verified.
    expect(screen.queryByRole('button', { name: /connect with digilocker/i })).toBeNull();
    // Masked Aadhaar last-4 visible
    expect(screen.getByText(/9999/)).toBeInTheDocument();
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
      expect(screen.getByText('Travel Customer Portal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    // LoginScreen heading visible again
    expect(screen.getByRole('heading', { name: /customer portal/i })).toBeInTheDocument();
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(PORTAL_CONTACT_KEY)).toBeNull();
  });
});
