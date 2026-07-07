/**
 * redirect-handoff.test.jsx — pins the marketing-site → CRM handoff wiring.
 *
 * The external Dr. Haror's marketing site sends users to the CRM with a
 * `?next=` param that they expect to land on after successful register/login.
 * Drift on either page (CustomerRegister, Login) silently breaks the handoff
 * because the marketing-site URL is generated client-side and there's no
 * round-trip to fail loudly.
 *
 * Four cases — two per auth page:
 *   1. CustomerRegister honours `?next=` after successful register.
 *   2. CustomerRegister rejects a hostile `?next=https://evil.com` and falls
 *      back to the vertical default.
 *   3. Login honours `?next=` after successful password login.
 *   4. Login rejects a hostile `?next=//evil.com` (protocol-relative) and
 *      falls back to the vertical default.
 *
 * Mocking strategy mirrors SsoReturn.test.jsx:
 *   - useNavigate is mocked at module scope with a stable vi.fn identity (the
 *     CLAUDE.md standing rule on stable hook-return identities for useEffect
 *     dependency arrays).
 *   - global.fetch is stubbed per test (existing pattern from Invoices.test.jsx).
 *   - AuthContext is provided directly via <AuthContext.Provider> wrapper.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stable navigate mock — one identity for the whole run. Both pages register
// useEffect bodies that close over navigate; an unstable mock would tear
// down + remount the effects on every render and cause spurious warnings.
const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

// Stub out the side-effects we don't care about for this test (sessionStorage
// write, permission cache invalidation). Stable identities to avoid hook
// dependency churn.
vi.mock('../utils/api', () => ({ setAuthToken: vi.fn(), fetchApi: vi.fn() }));
vi.mock('../hooks/usePermissions', () => ({ invalidatePermissionCache: vi.fn() }));

import { AuthContext } from '../App';
import CustomerRegister from '../pages/CustomerRegister';
import Login from '../pages/Login';

const TENANTS = [
  { id: 2, name: "Dr. Haror's Wellness", slug: 'enhanced-wellness', vertical: 'wellness' },
  { id: 1, name: 'Globussoft', slug: 'globussoft', vertical: 'generic' },
];

const WELLNESS_TENANT_RESPONSE = { id: 2, name: "Dr. Haror's Wellness", vertical: 'wellness' };

function authValue() {
  return {
    setUser: vi.fn(),
    setToken: vi.fn(),
    setTenant: vi.fn(),
  };
}

function renderAt(Component, url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuthContext.Provider value={authValue()}>
        <Component />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

// Build a fetch mock that routes by URL. Returns ok=true with `body` when the
// URL matches a registered prefix; ok=false otherwise.
function mockFetch(routes) {
  return vi.fn(async (url, _opts) => {
    for (const [prefix, body] of routes) {
      if (String(url).startsWith(prefix)) {
        return {
          ok: true,
          status: 200,
          json: async () => body,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not mocked' }) };
  });
}

describe('Marketing-site → CRM redirect handoff', () => {
  let originalFetch;
  let locationAssignMock;
  let originalLocationAssign;

  beforeEach(() => {
    navigateMock.mockReset();
    originalFetch = global.fetch;
    // jsdom's Location is read-only; replace the whole window.location with
    // a writable stand-in that captures assign() calls. Restored in afterEach.
    locationAssignMock = vi.fn();
    originalLocationAssign = window.location;
    Object.defineProperty(window, 'location', {
      value: {
        ...originalLocationAssign,
        href: originalLocationAssign.href,
        pathname: originalLocationAssign.pathname,
        search: originalLocationAssign.search,
        assign: locationAssignMock,
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(window, 'location', {
      value: originalLocationAssign,
      writable: true,
      configurable: true,
    });
  });

  describe('CustomerRegister', () => {
    it('navigates to ?next= after a successful register (in-app path is preserved)', async () => {
      global.fetch = mockFetch([
        ['/api/auth/public/tenants', TENANTS],
        ['/api/auth/email-otp/request', { devCode: '123456' }],
        ['/api/auth/email-otp/verify', { verificationToken: 'email-verified-token' }],
        ['/api/auth/customer/register', { token: 'jwt-abc', user: { id: 99 }, tenant: WELLNESS_TENANT_RESPONSE }],
      ]);
      const nextPath = '/wellness/book-appointment?serviceId=434&date=2026-06-15&time=12:00';
      renderAt(CustomerRegister, `/customer/register?tenantSlug=enhanced-wellness&next=${encodeURIComponent(nextPath)}`);

      // Wait for tenants to load + the locked tenant to be auto-selected.
      // Field is now a text input — value is the org name, not the tenant id.
      await waitFor(() => {
        const sel = screen.getByLabelText(/Booking for/i);
        expect(sel).toBeDisabled();
        expect(sel.value).toBe("Dr. Haror's Wellness");
      });

      // Fill required fields + verify email before the submit CTA is enabled.
      fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'jane@example.com' } });
      fireEvent.click(screen.getByTestId('otp-validate'));
      await waitFor(() => {
        expect(screen.getByTestId('otp-box')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId('otp-code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('otp-verify'));
      await waitFor(() => {
        expect(screen.getByTestId('otp-verified')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: 'Jane Doe' } });
      fireEvent.change(screen.getByLabelText(/^Password$/i), { target: { value: 'Secret123' } });
      fireEvent.change(screen.getByLabelText(/Confirm password/i), { target: { value: 'Secret123' } });
      fireEvent.click(screen.getByRole('button', { name: /Create account/i }));

      await waitFor(() => {
        // Handoff path uses window.location.assign (full page reload) so
        // React's batched state updates can't strip the query string before
        // the route guard re-renders. The handoff is dynamic — whatever
        // serviceId / date / time the marketing site sends gets forwarded
        // verbatim. We assert the structural shape, NOT specific values.
        expect(locationAssignMock).toHaveBeenCalledTimes(1);
        const url = locationAssignMock.mock.calls[0][0];
        expect(url).toMatch(/^\/wellness\/book-appointment\?/);
        expect(url).toContain('serviceId=');
        expect(url).toContain('date=');
        expect(url).toContain('time=');
      });
    });

    it('rejects hostile ?next=https://evil.com and falls back to /wellness', async () => {
      global.fetch = mockFetch([
        ['/api/auth/public/tenants', TENANTS],
        ['/api/auth/email-otp/request', { devCode: '123456' }],
        ['/api/auth/email-otp/verify', { verificationToken: 'email-verified-token' }],
        ['/api/auth/customer/register', { token: 'jwt-x', user: { id: 99 }, tenant: WELLNESS_TENANT_RESPONSE }],
      ]);
      renderAt(CustomerRegister, '/customer/register?tenantSlug=enhanced-wellness&next=https%3A%2F%2Fevil.com%2Fphish');

      // Field is now a text input — value is the org name, not the tenant id.
      await waitFor(() => {
        const sel = screen.getByLabelText(/Booking for/i);
        expect(sel).toBeDisabled();
        expect(sel.value).toBe("Dr. Haror's Wellness");
      });

      fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'jane@example.com' } });
      fireEvent.click(screen.getByTestId('otp-validate'));
      await waitFor(() => {
        expect(screen.getByTestId('otp-box')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId('otp-code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('otp-verify'));
      await waitFor(() => {
        expect(screen.getByTestId('otp-verified')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: 'Jane Doe' } });
      fireEvent.change(screen.getByLabelText(/^Password$/i), { target: { value: 'Secret123' } });
      fireEvent.change(screen.getByLabelText(/Confirm password/i), { target: { value: 'Secret123' } });
      fireEvent.click(screen.getByRole('button', { name: /Create account/i }));

      await waitFor(() => {
        expect(navigateMock).toHaveBeenCalled();
      });
      const target = navigateMock.mock.calls[0][0];
      expect(target).toBe('/wellness');
      // Crucially: never an external URL.
      expect(target).not.toMatch(/evil\.com/);
      expect(target).not.toMatch(/^https?:/);
    });
  });

  describe('Login', () => {
    // Login.jsx no longer pre-fills email + password (commit 46247368 removed
    // the hardcoded demo creds, moving them onto per-quick-login buttons). Fill
    // them explicitly before submit, otherwise performLogin's empty-field guard
    // short-circuits with "Please fill out all required fields" and navigate is
    // never called. The mocked /api/auth/login returns success regardless of
    // body — the load-bearing assertion is the post-success navigate.
    it('navigates to ?next= after a successful password login (in-app path is preserved)', async () => {
      global.fetch = mockFetch([
        ['/api/auth/public/tenants', TENANTS],
        ['/api/auth/login', { token: 'jwt-abc', user: { id: 7, role: 'CUSTOMER' }, tenant: WELLNESS_TENANT_RESPONSE }],
      ]);
      const nextPath = '/wellness/book-appointment?serviceId=434&time=15:00';
      renderAt(Login, `/login?tenantSlug=enhanced-wellness&next=${encodeURIComponent(nextPath)}`);

      // Wait for the tenant dropdown to pre-select to enhanced-wellness.
      await waitFor(() => {
        const orgSelect = screen.getAllByRole('combobox')[0];
        expect(orgSelect).toBeDisabled();
        expect(orgSelect.value).toBe('2');
      });

      // Labels in Login.jsx aren't associated via htmlFor/id, so getByLabelText
      // can't find these inputs — match by placeholder instead.
      fireEvent.change(screen.getByPlaceholderText('admin@globussoft.com'), {
        target: { value: 'patient@example.com' },
      });
      fireEvent.change(screen.getByPlaceholderText('••••••••'), {
        target: { value: 'Secret123' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Sign in$/i }));

      await waitFor(() => {
        // Same window.location.assign full-reload path as CustomerRegister.
        // Assert the structural shape; the actual serviceId / date / time
        // values are passed through from the marketing site at runtime.
        expect(locationAssignMock).toHaveBeenCalledTimes(1);
        const url = locationAssignMock.mock.calls[0][0];
        expect(url).toMatch(/^\/wellness\/book-appointment\?/);
        expect(url).toContain('serviceId=');
        expect(url).toContain('time=');
      });
    });

    it('rejects hostile ?next=//evil.com (protocol-relative) and falls back to a safe in-app path', async () => {
      global.fetch = mockFetch([
        ['/api/auth/public/tenants', TENANTS],
        ['/api/auth/login', { token: 'jwt-x', user: { id: 7, role: 'CUSTOMER' }, tenant: WELLNESS_TENANT_RESPONSE }],
        // resolveLandingPath consults /api/pages/me when next is rejected.
        // CUSTOMER role short-circuits that and goes to /home — but we set it
        // up here in case the role guard changes in future.
        ['/api/pages/me', { pages: [{ path: '/home' }] }],
      ]);
      renderAt(Login, '/login?tenantSlug=enhanced-wellness&next=%2F%2Fevil.com%2Fphish');

      await waitFor(() => {
        expect(screen.getAllByRole('combobox')[0]).toBeDisabled();
      });

      // Login.jsx no longer pre-fills demo creds (commit 46247368) — fill the
      // required fields by placeholder so performLogin reaches the navigate.
      fireEvent.change(screen.getByPlaceholderText('admin@globussoft.com'), {
        target: { value: 'patient@example.com' },
      });
      fireEvent.change(screen.getByPlaceholderText('••••••••'), {
        target: { value: 'Secret123' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Sign in$/i }));

      await waitFor(() => {
        expect(navigateMock).toHaveBeenCalled();
      });
      const target = navigateMock.mock.calls[0][0];
      // CUSTOMER role lands on /home per resolveLandingPath's short-circuit.
      // The load-bearing assertion: it's an in-app path, NOT evil.com.
      expect(target).toMatch(/^\//);
      expect(target).not.toMatch(/^\/\//);
      expect(target).not.toMatch(/evil\.com/);
      expect(target).not.toMatch(/^https?:/);
    });
  });
});
