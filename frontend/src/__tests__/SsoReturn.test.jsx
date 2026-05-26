/**
 * SsoReturn.test.jsx -- vitest + RTL coverage for the SSO callback landing
 * page at frontend/src/pages/SsoReturn.jsx.
 *
 * What SsoReturn.jsx actually does (pinned by reading the source, not
 * assumed):
 *   - On mount, reads URL query params via `new URLSearchParams(
 *     window.location.search)` -- NOT via useSearchParams from react-router.
 *     Params consumed: `token`, `next`, `error`, `tenant`.
 *   - If `error` is present, decodeURIComponent + setError(...) + early
 *     return (no auth handshake attempted).
 *   - Else if `token` is absent, setError('missing_token') + early return.
 *   - Else parse the optional `tenant` param as JSON (after
 *     decodeURIComponent); JSON parse failures are silently swallowed
 *     (parsedTenant stays null).
 *   - Calls AuthContext.loginWithToken(token, parsedTenant) — a Promise:
 *       resolve -> navigate(next || '/dashboard', { replace: true })
 *       reject  -> setError(String(e.message || 'sso_handshake_failed'))
 *   - Renders one of two surfaces:
 *       error truthy -> "SSO sign-in failed" h2 + code-styled error +
 *                       "Back to login" anchor pointing at /
 *       error empty  -> "Signing you in…" copy
 *
 * Contracts pinned here
 * ---------------------
 *   1. URL `?token=...` + no `next` -> loginWithToken called with that
 *      token + null parsedTenant; on resolve, navigate('/dashboard',
 *      { replace: true }).
 *   2. URL `?token=...&next=/wellness` -> on resolve, navigate('/wellness',
 *      { replace: true }) (custom next honored).
 *   3. URL `?token=...&tenant=<encoded-json>` -> tenant arg to
 *      loginWithToken is the parsed object (not the raw string).
 *   4. URL `?token=...&tenant=<malformed>` -> tenant arg is null (parse
 *      error silently swallowed; auth handshake still attempted).
 *   5. URL `?error=invalid_grant` -> error surface renders with the
 *      decoded error code; loginWithToken is NOT called.
 *   6. URL with `error` percent-encoded -> the displayed error code is
 *      the decoded form (e.g. `?error=session%20expired` -> "session
 *      expired").
 *   7. URL with no params -> error surface renders with "missing_token";
 *      loginWithToken is NOT called.
 *   8. loginWithToken rejection -> error surface renders with the
 *      rejection's message (NOT 'sso_handshake_failed' when message is
 *      present).
 *   9. loginWithToken rejection with no message -> error surface renders
 *      with the literal 'sso_handshake_failed' fallback.
 *
 * Mocking strategy
 * ----------------
 *   - react-router-dom: real MemoryRouter wraps the SUT; useNavigate is
 *     mocked via vi.mock('react-router-dom', importOriginal) so we can
 *     assert exact navigate(...) calls. Stable navigate mock (one identity
 *     across the whole run per CLAUDE.md stable-mock-ref standing rule).
 *   - AuthContext: real Provider wraps the SUT. loginWithToken is a vi.fn
 *     reset per test so we can assert call args + resolution behavior.
 *   - window.location.search: stubbed per test via Object.defineProperty
 *     (jsdom default is empty string). The SUT reads it directly, not
 *     through router state.
 *
 * Drift notes
 * -----------
 *   - The prompt anticipated `useSearchParams`/`useLocation`-driven param
 *     reads. REALITY: the SUT reaches into `window.location.search`
 *     directly. Test pins ACTUAL contract via location stubbing rather
 *     than MemoryRouter's `initialEntries` (which writes to router state,
 *     not to window.location).
 *   - The prompt anticipated `setUser`/`setToken` being called by the
 *     SUT. REALITY: the SUT delegates entirely to `loginWithToken` (a
 *     single AuthContext method that internally handles user + token +
 *     tenant seeding). Tests assert on `loginWithToken(token, tenant)`
 *     call args, not on individual setters.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stable navigate mock — one identity across the whole test run, per
// CLAUDE.md standing rule on stable mock object refs for hooks used in
// useEffect dependency arrays. SsoReturn's useEffect has navigate +
// loginWithToken in its deps; unstable identities cause re-render loops.
const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { AuthContext } from '../App';
import SsoReturn from '../pages/SsoReturn';

// Stable AuthContext value with a vi.fn loginWithToken — recreated per
// test via mockReset so call args are clean, but the object identity is
// preserved across renders within a test.
let loginWithTokenMock;
let authValue;

function setLocationSearch(search) {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, search },
  });
}

function renderSsoReturn() {
  return render(
    <MemoryRouter initialEntries={['/sso/return']}>
      <AuthContext.Provider value={authValue}>
        <SsoReturn />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('<SsoReturn /> -- SSO callback landing page', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    loginWithTokenMock = vi.fn();
    authValue = { loginWithToken: loginWithTokenMock };
    // Default to empty search; individual tests override.
    setLocationSearch('');
  });

  afterEach(() => {
    setLocationSearch('');
  });

  it('renders "Signing you in…" copy initially when a token is present', async () => {
    loginWithTokenMock.mockImplementation(() => new Promise(() => {})); // never resolves
    setLocationSearch('?token=jwt-abc');
    renderSsoReturn();
    expect(screen.getByText(/Signing you in/i)).toBeInTheDocument();
    // No error surface in pending state.
    expect(screen.queryByText(/SSO sign-in failed/i)).not.toBeInTheDocument();
  });

  it('calls loginWithToken(token, null) and navigates to /dashboard on success when next is absent', async () => {
    loginWithTokenMock.mockResolvedValue();
    setLocationSearch('?token=jwt-abc');
    renderSsoReturn();
    await waitFor(() => {
      expect(loginWithTokenMock).toHaveBeenCalledTimes(1);
    });
    expect(loginWithTokenMock).toHaveBeenCalledWith('jwt-abc', null);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/dashboard', { replace: true });
    });
  });

  it('honors the `next` query param on success (navigates to /wellness when next=/wellness)', async () => {
    loginWithTokenMock.mockResolvedValue();
    setLocationSearch('?token=jwt-xyz&next=/wellness');
    renderSsoReturn();
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/wellness', { replace: true });
    });
    expect(loginWithTokenMock).toHaveBeenCalledWith('jwt-xyz', null);
  });

  it('passes the parsed tenant object to loginWithToken when `tenant` param is valid encoded JSON', async () => {
    loginWithTokenMock.mockResolvedValue();
    const tenantObj = { id: 42, vertical: 'wellness', name: 'Enhanced Wellness' };
    const encoded = encodeURIComponent(JSON.stringify(tenantObj));
    setLocationSearch(`?token=jwt-t&tenant=${encoded}`);
    renderSsoReturn();
    await waitFor(() => {
      expect(loginWithTokenMock).toHaveBeenCalledTimes(1);
    });
    expect(loginWithTokenMock).toHaveBeenCalledWith('jwt-t', tenantObj);
  });

  it('passes null tenant when the `tenant` param is malformed JSON (parse error silently swallowed)', async () => {
    loginWithTokenMock.mockResolvedValue();
    // Not valid JSON after decoding.
    setLocationSearch('?token=jwt-t&tenant=%7Bnot-json');
    renderSsoReturn();
    await waitFor(() => {
      expect(loginWithTokenMock).toHaveBeenCalledTimes(1);
    });
    expect(loginWithTokenMock).toHaveBeenCalledWith('jwt-t', null);
  });

  it('renders the "SSO sign-in failed" surface with the decoded error param and does NOT call loginWithToken', () => {
    setLocationSearch('?error=invalid_grant');
    renderSsoReturn();
    expect(screen.getByRole('heading', { name: /SSO sign-in failed/i })).toBeInTheDocument();
    // The error code renders inside a <code> element.
    expect(screen.getByText('invalid_grant')).toBeInTheDocument();
    // The "Back to login" anchor points at /.
    const backLink = screen.getByRole('link', { name: /Back to login/i });
    expect(backLink).toHaveAttribute('href', '/');
    // loginWithToken MUST NOT fire when error is present.
    expect(loginWithTokenMock).not.toHaveBeenCalled();
    // navigate MUST NOT fire either.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('decodes percent-encoded error codes (e.g. "session%20expired" -> "session expired")', () => {
    setLocationSearch('?error=session%20expired');
    renderSsoReturn();
    expect(screen.getByText('session expired')).toBeInTheDocument();
    expect(loginWithTokenMock).not.toHaveBeenCalled();
  });

  it('renders the "missing_token" error surface when no token is present in the URL', () => {
    setLocationSearch('');
    renderSsoReturn();
    expect(screen.getByRole('heading', { name: /SSO sign-in failed/i })).toBeInTheDocument();
    expect(screen.getByText('missing_token')).toBeInTheDocument();
    expect(loginWithTokenMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('renders the rejection error message on the failed surface when loginWithToken rejects with an Error', async () => {
    loginWithTokenMock.mockRejectedValue(new Error('jwt_signature_invalid'));
    setLocationSearch('?token=jwt-bad');
    renderSsoReturn();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /SSO sign-in failed/i })).toBeInTheDocument();
    });
    expect(screen.getByText('jwt_signature_invalid')).toBeInTheDocument();
    // navigate MUST NOT fire on rejection.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('falls back to "sso_handshake_failed" when the rejection has no message', async () => {
    // Reject with an object lacking a `message` property — String(undefined)
    // collapses to "undefined", and the SUT's `e.message || 'sso_handshake_failed'`
    // short-circuit lands on the fallback string.
    loginWithTokenMock.mockRejectedValue({});
    setLocationSearch('?token=jwt-bad2');
    renderSsoReturn();
    await waitFor(() => {
      expect(screen.getByText('sso_handshake_failed')).toBeInTheDocument();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
