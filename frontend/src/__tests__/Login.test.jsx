/**
 * Login.jsx — vitest + RTL coverage for the /login page.
 *
 * Scope: pins the page-surface invariants for the primary authentication
 * entry point. The page is ~458 LOC and has FIVE distinct UI surfaces:
 *   (a) the heading + email/password form + Sign-In CTA,
 *   (b) the SSO buttons (Google / Microsoft) that redirect to
 *       /api/sso/<provider>/start,
 *   (c) the "Forgot Password?" toggle that opens an inline reset-token
 *       form (POSTs /api/auth/forgot-password),
 *   (d) the QuickLoginSection rows grouped by tenant — Generic CRM /
 *       Enhanced Wellness / Travel Stall — each rendering one-click
 *       buttons that fire the login flow with the seeded password
 *       'password123' (per CLAUDE.md "Demo Credentials"),
 *   (e) the 2FA challenge form that replaces (a)+(b)+(c)+(d) when
 *       /api/auth/login responds with { requires2FA: true, tempToken }.
 *
 * Contracts pinned here
 * ─────────────────────
 *   1. Initial render: "Globussoft CRM" heading + "Sign in to your
 *      account" subhead + email + password fields + Sign-In button.
 *   2. Quick-login Generic CRM section renders Admin/Manager/User
 *      buttons; Wellness section renders Owner (Rishu)/Demo Admin/Demo
 *      User; Travel section renders Owner (Yasin)/Demo Admin/TMC
 *      Operator/RFU Advisor.
 *   3. Successful login POSTs /api/auth/login with { email, password },
 *      seeds setUser + setToken + setTenant, and navigates to
 *      /dashboard for tenant.vertical='generic'.
 *   4. Wellness tenant login redirects to /wellness for ADMIN/MANAGER
 *      role; tenant.vertical='wellness' check fires the wellnessLandingFor
 *      branch.
 *   5. Travel tenant login redirects to /travel for
 *      tenant.vertical='travel'.
 *   6. Failed login (non-2xx) surfaces the server's `error` string in
 *      the red banner; setUser is NOT called.
 *   7. Server-error (fetch rejection) surfaces the "Server error.
 *      Ensure backend is running." copy.
 *   8. Missing email or password surfaces "Please fill out all
 *      required fields" without firing the network request.
 *   9. requires2FA=true response swaps the page chrome — the 6-digit
 *      input + "Verify" + "Cancel and sign in as another user"
 *      buttons render; the password form is hidden.
 *  10. 2FA verify POSTs /api/auth/2fa/verify with { tempToken, code },
 *      then on success seeds the auth context and navigates.
 *  11. Clicking a quick-login button (Admin in Generic CRM) auto-fires
 *      the login flow with the canonical demo credentials.
 *  12. SSO buttons (Google / Microsoft) redirect to
 *      /api/sso/<provider>/start via window.location.
 *  13. "Forgot Password?" toggles the reset-token sub-form; submitting
 *      with empty email surfaces "Please enter your email" without
 *      firing the POST.
 *
 * Drift notes
 * ───────────
 *   - The page uses raw `fetch` (not `fetchApi`) for /api/auth/login,
 *     /api/auth/2fa/verify, and /api/auth/forgot-password. Global
 *     fetch mock is required, not the utils/api stub.
 *   - useNavigate is mocked at the module level; AuthContext setters
 *     (setUser/setToken/setTenant) are passed as a stable mock object
 *     reference per the CLAUDE.md "RTL: stable mock object references"
 *     rule so useEffect dependency arrays don't re-fire.
 *   - The Sign-In submit relies on a real <form> with onSubmit; the
 *     spec uses fireEvent.submit on the form or fireEvent.click on the
 *     button — either path drives performLogin.
 *   - The page seeds email='admin@globussoft.com' + password='password123'
 *     in initial state — the test does NOT need to type into either to
 *     exercise the happy path.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigateMock };
});

import { AuthContext } from '../App';
import Login from '../pages/Login';

// Stable auth-context mock — per CLAUDE.md "RTL: stable mock object
// references for hooks used in useCallback dependencies", give the
// page ONE object identity for the entire test. Fresh objects per
// render trip Login's useEffect SSO-callback path and produce false
// negatives.
const setUserMock = vi.fn();
const setTokenMock = vi.fn();
const setTenantMock = vi.fn();
const authValue = {
  user: null,
  token: '',
  tenant: null,
  setUser: setUserMock,
  setToken: setTokenMock,
  setTenant: setTenantMock,
};

function renderLogin() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <Login />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

// Helper: minimal Response-shape stub so the page's `response.json()` +
// `response.ok` reads work. The page uses raw fetch, not fetchApi.
function fetchResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('<Login /> — page surface', () => {
  let originalFetch;
  let originalLocation;
  beforeEach(() => {
    navigateMock.mockClear();
    setUserMock.mockClear();
    setTokenMock.mockClear();
    setTenantMock.mockClear();
    originalFetch = global.fetch;
    // Default impl returns an empty-list response so the on-mount
    // `fetch("/api/auth/public/tenants").then(...)` in Login.jsx:49 doesn't
    // resolve `undefined.then` and throw a TypeError. Tests that exercise
    // a specific endpoint override this with mockImplementation.
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve([]),
    }));
    // Snapshot + replace window.location with a writable stub so the
    // SSO buttons' window.location.href = '...' assignment is
    // observable + reversible.
    originalLocation = window.location;
    delete window.location;
    window.location = { href: '', pathname: '/login', search: '' };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    window.location = originalLocation;
  });

  it('renders the heading, sign-in copy, and email + password inputs on initial mount', () => {
    renderLogin();
    expect(screen.getByRole('heading', { name: /Globussoft CRM/i })).toBeInTheDocument();
    expect(screen.getByText(/Sign in to your account/i)).toBeInTheDocument();
    // Post-46247368 refactor: email + password inputs render EMPTY on
    // initial mount (the hardcoded admin@globussoft.com / password123
    // defaults were removed; demo creds now live on the quick-login
    // account objects). The placeholder strings stay the same.
    const emailInput = screen.getByPlaceholderText('admin@globussoft.com');
    expect(emailInput).toBeInTheDocument();
    expect(emailInput.value).toBe('');
    const passwordInput = screen.getByPlaceholderText('••••••••');
    expect(passwordInput).toBeInTheDocument();
    expect(passwordInput.value).toBe('');
    expect(screen.getByRole('button', { name: /Sign In$/i })).toBeInTheDocument();
  });

  // Helper: type the canonical demo credentials into the empty form so
  // performLogin() reaches the fetch call. Post-46247368 the form starts
  // empty, so every Sign-In-path test must type before clicking.
  function fillCredentials(email = 'admin@globussoft.com', password = 'password123') {
    fireEvent.change(screen.getByPlaceholderText('admin@globussoft.com'), {
      target: { value: email },
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: password },
    });
  }

  it('renders quick-login sections grouped by tenant — Generic / Wellness / Travel', () => {
    renderLogin();
    // Section header copy includes the tenant title.
    expect(screen.getByText(/Generic CRM — click to log in/i)).toBeInTheDocument();
    expect(screen.getByText(/Enhanced Wellness — Demo — click to log in/i)).toBeInTheDocument();
    expect(screen.getByText(/Travel Stall — Demo — click to log in/i)).toBeInTheDocument();
    // Sample buttons across the three groups exist.
    // (The "Demo Admin" label appears twice — once in the Wellness
    // section, once in the Travel section. Use getAllByText for those
    // per the CLAUDE.md "prefer getAllByText for duplicate labels"
    // rule.)
    expect(screen.getByText(/^Admin$/i)).toBeInTheDocument(); // Generic only
    expect(screen.getAllByText(/^Demo Admin$/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Owner \(Rishu\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Owner \(Yasin\)/i)).toBeInTheDocument();
    expect(screen.getByText(/TMC Operator/i)).toBeInTheDocument();
    expect(screen.getByText(/RFU Advisor/i)).toBeInTheDocument();
  });

  // SSO buttons are gated behind `SHOW_SSO = false` in Login.jsx:9 — feature
  // is hidden until tenant-level SSO config + provider credentials land. Flip
  // the SHOW_SSO const + un-skip these three tests together when re-enabling.
  it.skip('renders SSO buttons for Google and Microsoft — gated behind SHOW_SSO', () => {});

  it('successful login POSTs /api/auth/login and navigates to /dashboard for generic tenant', async () => {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/login') {
        return fetchResponse({
          token: 'jwt-abc',
          user: { userId: 1, email: 'admin@globussoft.com', role: 'ADMIN' },
          tenant: { id: 1, name: 'Globussoft', vertical: 'generic' },
        });
      }
      return fetchResponse({}, 404);
    });
    renderLogin();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/dashboard');
    });
    // Verify the auth setters fired with the server's payload.
    expect(setUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'admin@globussoft.com', role: 'ADMIN' })
    );
    // `setToken` carries a second arg (`{ remember }`) since the
    // "keep me signed in" feature landed. Match the token + tolerate
    // the options bag with any shape.
    expect(setTokenMock).toHaveBeenCalledWith('jwt-abc', expect.anything());
    expect(setTenantMock).toHaveBeenCalledWith(
      expect.objectContaining({ vertical: 'generic' })
    );
    // Verify the POST body shape.
    const loginCall = global.fetch.mock.calls.find(([u]) => u === '/api/auth/login');
    expect(loginCall).toBeTruthy();
    expect(loginCall[1].method).toBe('POST');
    expect(JSON.parse(loginCall[1].body)).toEqual({
      email: 'admin@globussoft.com',
      password: 'password123',
    });
  });

  it('wellness tenant login (ADMIN role) navigates to /wellness', async () => {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/login') {
        return fetchResponse({
          token: 'jwt-well',
          user: { userId: 2, email: 'rishu@enhancedwellness.in', role: 'ADMIN' },
          tenant: { id: 2, name: 'Enhanced Wellness', vertical: 'wellness' },
        });
      }
      return fetchResponse({}, 404);
    });
    renderLogin();

    fillCredentials('rishu@enhancedwellness.in');
    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/wellness');
    });
  });

  it('travel tenant login navigates to /travel', async () => {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/login') {
        return fetchResponse({
          token: 'jwt-trv',
          user: { userId: 3, email: 'yasin@travelstall.in', role: 'ADMIN' },
          tenant: { id: 3, name: 'Travel Stall', vertical: 'travel' },
        });
      }
      return fetchResponse({}, 404);
    });
    renderLogin();

    fillCredentials('yasin@travelstall.in');
    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/travel');
    });
  });

  it('failed login surfaces the server error message and does NOT seed the auth context', async () => {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/login') {
        return fetchResponse({ error: 'Invalid credentials' }, 401);
      }
      return fetchResponse({}, 404);
    });
    renderLogin();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));

    expect(await screen.findByText(/Invalid credentials/i)).toBeInTheDocument();
    expect(setUserMock).not.toHaveBeenCalled();
    expect(setTokenMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('falls back to the customer portal when staff login 401s but the portal login succeeds', async () => {
    localStorage.clear();
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/login') return fetchResponse({ error: 'Invalid credentials' }, 401);
      if (url === '/api/portal/login') {
        return fetchResponse({ token: 'portal-jwt', contact: { id: 65, name: 'Ahmed Khan', email: 'ahmed.pilgrim@demo.test' } });
      }
      return fetchResponse({}, 404);
    });
    renderLogin();

    fillCredentials('ahmed.pilgrim@demo.test');
    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));

    // Hands off to the travel portal page.
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/travel/portal'));
    // Portal token persisted under the keys TravelCustomerPortal reads.
    expect(localStorage.getItem('portalToken')).toBe('portal-jwt');
    expect(JSON.parse(localStorage.getItem('portalContact')).email).toBe('ahmed.pilgrim@demo.test');
    // Staff auth context is NOT seeded — portal is a separate system.
    expect(setUserMock).not.toHaveBeenCalled();
    expect(setTokenMock).not.toHaveBeenCalled();
    // Both endpoints were attempted, staff first.
    expect(global.fetch.mock.calls.some(([u]) => u === '/api/portal/login')).toBe(true);
  });

  it('shows the error when BOTH staff and portal login fail', async () => {
    localStorage.clear();
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/login') return fetchResponse({ error: 'Invalid credentials' }, 401);
      if (url === '/api/portal/login') return fetchResponse({ error: 'Invalid credentials' }, 401);
      return fetchResponse({}, 404);
    });
    renderLogin();

    fillCredentials('nobody@example.com');
    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));

    expect(await screen.findByText(/Invalid credentials/i)).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('portalToken')).toBeNull();
  });

  it('network rejection surfaces the "Server error" copy', async () => {
    global.fetch.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    renderLogin();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));

    expect(await screen.findByText(/Server error\. Ensure backend is running\./i)).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('missing email or password surfaces the validation banner without firing fetch', async () => {
    renderLogin();
    const emailInput = screen.getByPlaceholderText('admin@globussoft.com');
    const passwordInput = screen.getByPlaceholderText('••••••••');
    fireEvent.change(emailInput, { target: { value: '' } });
    fireEvent.change(passwordInput, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));

    expect(await screen.findByText(/Please fill out all required fields/i)).toBeInTheDocument();
    // /api/auth/login MUST NOT have been called.
    const loginCall = global.fetch.mock.calls.find(([u]) => u === '/api/auth/login');
    expect(loginCall).toBeUndefined();
  });

  it('requires2FA response swaps the form to the 2FA challenge view', async () => {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/login') {
        return fetchResponse({ requires2FA: true, tempToken: 'tmp-xyz' });
      }
      return fetchResponse({}, 404);
    });
    renderLogin();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));

    // 2FA chrome appears.
    expect(
      await screen.findByText(/Two-factor verification required/i),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('123456')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Verify$/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Cancel and sign in as another user/i }),
    ).toBeInTheDocument();
    // The password form has been hidden — Sign-In CTA no longer visible.
    expect(screen.queryByRole('button', { name: /Sign In$/i })).not.toBeInTheDocument();
    // setUser was NOT called yet — the 2FA verify step hasn't fired.
    expect(setUserMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('successful 2FA verify POSTs /api/auth/2fa/verify with { tempToken, code } and finalizes the login', async () => {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/login') {
        return fetchResponse({ requires2FA: true, tempToken: 'tmp-xyz' });
      }
      if (url === '/api/auth/2fa/verify') {
        return fetchResponse({
          token: 'jwt-2fa',
          user: { userId: 1, email: 'admin@globussoft.com', role: 'ADMIN' },
          tenant: { id: 1, vertical: 'generic' },
        });
      }
      return fetchResponse({}, 404);
    });
    renderLogin();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /Sign In$/i }));
    const codeInput = await screen.findByPlaceholderText('123456');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /^Verify$/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/dashboard');
    });
    // Same shape note as the generic-tenant test above — second `remember`
    // arg added with the "keep me signed in" feature.
    expect(setTokenMock).toHaveBeenCalledWith('jwt-2fa', expect.anything());
    const verifyCall = global.fetch.mock.calls.find(([u]) => u === '/api/auth/2fa/verify');
    expect(verifyCall).toBeTruthy();
    expect(JSON.parse(verifyCall[1].body)).toEqual({
      tempToken: 'tmp-xyz',
      code: '123456',
    });
  });

  it('clicking a quick-login button (Generic Admin) fires the login flow with the canonical demo credentials', async () => {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/login') {
        return fetchResponse({
          token: 'jwt-quick',
          user: { userId: 1, email: 'admin@globussoft.com', role: 'ADMIN' },
          tenant: { id: 1, vertical: 'generic' },
        });
      }
      return fetchResponse({}, 404);
    });
    renderLogin();

    // The Generic Admin quick-login button is a <button> whose visible
    // descendant text is the email 'admin@globussoft.com'. Multiple
    // matches exist (the input placeholder uses the same string), so
    // pick the BUTTON role specifically.
    const quickButtons = screen.getAllByRole('button').filter(
      (b) => b.textContent && b.textContent.includes('admin@globussoft.com')
        && /admin/i.test(b.textContent),
    );
    expect(quickButtons.length).toBeGreaterThan(0);
    fireEvent.click(quickButtons[0]);

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/dashboard');
    });
    const loginCall = global.fetch.mock.calls.find(([u]) => u === '/api/auth/login');
    expect(loginCall).toBeTruthy();
    expect(JSON.parse(loginCall[1].body)).toEqual({
      email: 'admin@globussoft.com',
      password: 'password123',
    });
  });

  // See SHOW_SSO note above.
  it.skip('SSO Google button redirects window.location to /api/sso/google/start — gated behind SHOW_SSO', () => {});

  it.skip('SSO Microsoft button redirects window.location to /api/sso/microsoft/start — gated behind SHOW_SSO', () => {});

  it('Forgot Password toggle opens the reset-token form; empty submit surfaces the inline validation', async () => {
    renderLogin();

    // Toggle the forgot-password sub-form open.
    fireEvent.click(screen.getByRole('button', { name: /Forgot Password\?/i }));

    // The reset-token sub-form is now visible.
    expect(await screen.findByPlaceholderText(/Your email address/i)).toBeInTheDocument();
    const resetBtn = screen.getByRole('button', { name: /Reset Password/i });
    expect(resetBtn).toBeInTheDocument();

    // Submit with empty email — the inline message fires, but the POST
    // does NOT.
    fireEvent.click(resetBtn);
    expect(await screen.findByText(/Please enter your email/i)).toBeInTheDocument();
    const forgotCall = global.fetch.mock.calls.find(
      ([u]) => u === '/api/auth/forgot-password',
    );
    expect(forgotCall).toBeUndefined();
  });

  it('forgot-password success surfaces the server message + reset token chip', async () => {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/auth/forgot-password') {
        return fetchResponse({
          message: 'Reset link sent (demo: token printed below)',
          resetToken: 'reset-abc-123',
        });
      }
      return fetchResponse({}, 404);
    });
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /Forgot Password\?/i }));
    const emailInput = await screen.findByPlaceholderText(/Your email address/i);
    fireEvent.change(emailInput, { target: { value: 'lost@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Reset Password/i }));

    expect(
      await screen.findByText(/Reset link sent \(demo: token printed below\)/i),
    ).toBeInTheDocument();
    // The reset-token chip renders the server's resetToken verbatim.
    expect(screen.getByText('reset-abc-123')).toBeInTheDocument();
    // Verify the POST body.
    const forgotCall = global.fetch.mock.calls.find(
      ([u]) => u === '/api/auth/forgot-password',
    );
    expect(forgotCall).toBeTruthy();
    expect(JSON.parse(forgotCall[1].body)).toEqual({ email: 'lost@example.com' });
  });
});
