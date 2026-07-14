/**
 * Signup.jsx — vitest + RTL coverage for the /signup page.
 *
 * Scope: pins the page-surface invariants for the organization-creation
 * entry point. The page is 121 LOC and has ONE primary surface:
 *   - a 4-field form (Organization Name / Your Full Name / Email /
 *     Secure Password) that POSTs /api/auth/register, seeds the auth
 *     context on success, and navigates to /dashboard. On failure it
 *     surfaces the server's `message` (or `error`) in a red banner.
 *
 * Contracts pinned here
 * ─────────────────────
 *   1. Initial render: "Globussoft CRM" heading + "Create your
 *      organization" subhead + 4 inputs (organization / name / email /
 *      password) + "Create Organization" submit + "Sign in" link to
 *      /login.
 *   2. The four inputs are individually required (browser-native
 *      `required` attribute) and the password input enforces
 *      minLength=6 via the browser-native constraint.
 *   3. Successful register POSTs /api/auth/register with the four
 *      fields shaped as { name, email, password, organizationName },
 *      seeds setUser + setToken + setTenant from the response, and
 *      navigates to /dashboard.
 *   4. Successful register with NO tenant in the response still seeds
 *      setUser + setToken and navigates — setTenant must NOT be called
 *      because `data.tenant` is falsy.
 *   5. Failed register (non-ok response) surfaces the server's
 *      `message` in the red banner; setUser / setToken / navigate are
 *      NOT called.
 *   6. Failed register with `error` field instead of `message` falls
 *      back to that copy.
 *   7. Failed register with neither field surfaces the generic
 *      "Registration failed securely. Please verify fields." copy.
 *   8. Network rejection (fetch throws) surfaces "Network
 *      synchronization failed. Please check your connection." and
 *      restores the submit button.
 *   9. While the POST is in flight the submit button copy flips to
 *      "Creating organization..." and is disabled.
 *  10. The "Sign in" link renders with href="/login" so existing
 *      users can navigate back without seeing the form.
 *
 * Drift notes
 * ───────────
 *   - The page uses raw `fetch` (not `fetchApi`) — global fetch mock
 *     is required, not the utils/api stub.
 *   - useNavigate is mocked at the module level; AuthContext setters
 *     (setUser/setToken/setTenant) are passed as a stable mock object
 *     reference per the CLAUDE.md "RTL: stable mock object references"
 *     rule.
 *   - The form's <input required> + <input minLength={6}> are
 *     browser-native constraints — jsdom won't always block submit on
 *     those, so the spec exercises the submit path and verifies the
 *     POST shape, not the native-validation gating itself.
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
import Signup from '../pages/Signup';

// Stable auth-context mock — per CLAUDE.md "RTL: stable mock object
// references for hooks used in useCallback dependencies", give the
// page ONE object identity for the entire test run. Fresh objects per
// render can trip child useEffect / useCallback dependency arrays.
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

function renderSignup() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <Signup />
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

// Route the email-OTP endpoints to success and delegate /api/auth/register
// to the caller's handler. The page now gates "Create Organization" behind
// email verification, so every happy/failure path must verify first.
function routeFetch(onRegister) {
  global.fetch.mockImplementation((url, opts) => {
    if (url === '/api/auth/email-otp/request') return fetchResponse({ sent: true });
    if (url === '/api/auth/email-otp/verify') return fetchResponse({ verified: true, verificationToken: 'vtok-123' });
    if (url === '/api/auth/register') return onRegister ? onRegister(url, opts) : fetchResponse({}, 404);
    return fetchResponse({}, 404);
  });
}

// Fill the form AND complete the email-OTP verification (Validate → code →
// Verify), then return the now-enabled "Create Organization" submit button.
async function fillAndVerify() {
  fireEvent.change(screen.getByPlaceholderText('Acme Inc.'), { target: { value: 'Acme Inc.' } });
  fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Priya Sharma' } });
  fireEvent.change(screen.getByPlaceholderText('name@company.com'), { target: { value: 'priya@acme.example' } });
  fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'sup3rsecret' } });
  fireEvent.click(screen.getByTestId('otp-validate'));
  fireEvent.change(await screen.findByTestId('otp-code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('otp-verify'));
  return screen.findByRole('button', { name: /Create Organization/i });
}

describe('<Signup /> — page surface', () => {
  let originalFetch;
  beforeEach(() => {
    navigateMock.mockClear();
    setUserMock.mockClear();
    setTokenMock.mockClear();
    setTenantMock.mockClear();
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders the heading, create-organization subhead, all four inputs, the submit button, and the sign-in link', () => {
    renderSignup();
    expect(screen.getByRole('img', { name: /Globussoft CRM/i })).toBeInTheDocument();
    expect(screen.getByText(/Create your organization/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Acme Inc.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('John Doe')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('name@company.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
    // The email field now has a Validate (OTP) button, and the submit button
    // is gated until the email is verified.
    expect(screen.getByTestId('otp-validate')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Verify your email or phone to continue/i });
    expect(submit).toBeDisabled();
    // Sign-in link routes back to /login.
    const signInLink = screen.getByRole('link', { name: /Sign in/i });
    expect(signInLink).toBeInTheDocument();
    expect(signInLink.getAttribute('href')).toBe('/login');
  });

  it('marks every input required and enforces minLength=6 on the password (browser-native constraints)', () => {
    renderSignup();
    expect(screen.getByPlaceholderText('Acme Inc.')).toBeRequired();
    expect(screen.getByPlaceholderText('John Doe')).toBeRequired();
    expect(screen.getByPlaceholderText('name@company.com')).toBeRequired();
    const passwordInput = screen.getByPlaceholderText('••••••••');
    expect(passwordInput).toBeRequired();
    expect(passwordInput).toHaveAttribute('minLength', '6');
    // The email input is of type=email so the browser enforces format.
    expect(screen.getByPlaceholderText('name@company.com')).toHaveAttribute('type', 'email');
    // Password input is type=password so the browser masks the value.
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('submit stays disabled until the email is verified (gating)', async () => {
    routeFetch();
    renderSignup();
    // Fill everything EXCEPT verifying the email.
    fireEvent.change(screen.getByPlaceholderText('Acme Inc.'), { target: { value: 'Acme Inc.' } });
    fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Priya Sharma' } });
    fireEvent.change(screen.getByPlaceholderText('name@company.com'), { target: { value: 'priya@acme.example' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'sup3rsecret' } });
    expect(screen.getByRole('button', { name: /Verify your email or phone to continue/i })).toBeDisabled();
    // Verify → the submit unlocks.
    fireEvent.click(screen.getByTestId('otp-validate'));
    fireEvent.change(await screen.findByTestId('otp-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('otp-verify'));
    const submit = await screen.findByRole('button', { name: /Create Organization/i });
    expect(submit).not.toBeDisabled();
  });

  it('successful register POSTs /api/auth/register with { name, email, password, organizationName, verificationToken } and navigates to /dashboard', async () => {
    routeFetch(() => fetchResponse({
      token: 'jwt-new',
      user: { userId: 99, email: 'priya@acme.example', role: 'ADMIN' },
      tenant: { id: 99, name: 'Acme Inc.', vertical: 'generic' },
    }));
    renderSignup();

    const submit = await fillAndVerify();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/dashboard');
    });
    expect(setUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'priya@acme.example', role: 'ADMIN' })
    );
    expect(setTokenMock).toHaveBeenCalledWith('jwt-new');
    expect(setTenantMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme Inc.', vertical: 'generic' })
    );
    // Verify the POST shape — the four fields the page collects.
    const registerCall = global.fetch.mock.calls.find(([u]) => u === '/api/auth/register');
    expect(registerCall).toBeTruthy();
    expect(registerCall[1].method).toBe('POST');
    // Drift: component now also sends `vertical` (radio-selected, defaults to
    // 'generic'). Assert the four originally-pinned fields + accept whatever
    // additional fields ship — objectContaining keeps the pin focused.
    expect(JSON.parse(registerCall[1].body)).toEqual(expect.objectContaining({
      name: 'Priya Sharma',
      email: 'priya@acme.example',
      password: 'sup3rsecret',
      organizationName: 'Acme Inc.',
      verificationToken: 'vtok-123',
    }));
  });

  it('successful register with no tenant in the payload still navigates but does NOT fire setTenant', async () => {
    routeFetch(() => fetchResponse({
      token: 'jwt-bare',
      user: { userId: 100, email: 'priya@acme.example', role: 'ADMIN' },
      // No `tenant` field — page must guard the setTenant call.
    }));
    renderSignup();

    fireEvent.click(await fillAndVerify());

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/dashboard');
    });
    expect(setUserMock).toHaveBeenCalled();
    expect(setTokenMock).toHaveBeenCalledWith('jwt-bare');
    expect(setTenantMock).not.toHaveBeenCalled();
  });

  it('failed register surfaces the server `message` and does NOT seed the auth context', async () => {
    routeFetch(() => fetchResponse({ message: 'Email already in use' }, 409));
    renderSignup();

    fireEvent.click(await fillAndVerify());

    expect(await screen.findByText(/Email already in use/i)).toBeInTheDocument();
    expect(setUserMock).not.toHaveBeenCalled();
    expect(setTokenMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('failed register with `error` field instead of `message` falls back to that copy', async () => {
    routeFetch(() => fetchResponse({ error: 'organizationName must be at least 2 chars' }, 400));
    renderSignup();

    fireEvent.click(await fillAndVerify());

    expect(
      await screen.findByText(/organizationName must be at least 2 chars/i)
    ).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('failed register with neither message nor error surfaces the generic fallback copy', async () => {
    routeFetch(() => fetchResponse({}, 500));
    renderSignup();

    fireEvent.click(await fillAndVerify());

    expect(
      await screen.findByText(/Registration failed securely\. Please verify fields\./i)
    ).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('network rejection surfaces the "Network synchronization failed" copy and re-enables the submit button', async () => {
    routeFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    renderSignup();

    fireEvent.click(await fillAndVerify());

    expect(
      await screen.findByText(/Network synchronization failed\. Please check your connection\./i)
    ).toBeInTheDocument();
    // The submit button copy flips back to "Create Organization" and is
    // no longer disabled — the finally block clears the loading flag.
    const submitBtn = screen.getByRole('button', { name: /Create Organization/i });
    expect(submitBtn).not.toBeDisabled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('while the register POST is in flight the submit button shows the loading copy and is disabled', async () => {
    // Deferred register so we can inspect the in-flight UI state (OTP succeeds).
    let resolveFetch;
    routeFetch(() => new Promise((resolve) => {
      resolveFetch = () => resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          token: 'jwt-slow',
          user: { userId: 101, email: 'priya@acme.example', role: 'ADMIN' },
          tenant: { id: 101, vertical: 'generic' },
        }),
      });
    }));
    renderSignup();

    fireEvent.click(await fillAndVerify());

    // While the fetch is pending the button copy flips to the loading
    // string and the button is disabled.
    const loadingBtn = await screen.findByRole('button', { name: /Creating organization\.\.\./i });
    expect(loadingBtn).toBeDisabled();

    // Resolve the deferred fetch and let the navigation fire.
    resolveFetch();
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('the "Sign in" link points to /login so existing users can navigate back without filling the form', () => {
    renderSignup();
    const link = screen.getByRole('link', { name: /Sign in/i });
    expect(link).toHaveAttribute('href', '/login');
  });
});
