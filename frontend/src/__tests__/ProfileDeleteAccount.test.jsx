/**
 * Profile.jsx — Danger Zone / self-service account deletion flow.
 *
 * Contracts pinned here
 * ─────────────────────
 *   1. The danger zone card renders for every account with a
 *      "Delete account" button (all three verticals share Profile.jsx,
 *      so one render path covers generic / wellness / travel).
 *   2. Clicking "Delete account" arms the confirm area: a current-password
 *      input appears for password accounts.
 *   3. Submitting without a password blocks (notify.error) and does NOT
 *      call the API.
 *   4. Happy path: password filled → destructive notify.confirm modal
 *      ("irreversible") → DELETE /api/auth/me/account with
 *      { confirmDestructive:true, password } → local auth cleared
 *      (setUser(null) + setToken(null)) → navigate('/login').
 *   5. Declining the modal aborts: no DELETE call, session intact.
 *   6. SSO accounts (ssoProvider set) see NO password input and can delete
 *      with just the modal confirmation.
 *   7. 2FA accounts must fill the TOTP code input before the modal opens.
 *   8. API failure (wrong password, LAST_ADMIN, …) does NOT log the user
 *      out — fetchApi's auto-toast surfaces the error and the page stays.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable mock-object pattern (2026-05-23 standing rule).
const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigateMock };
});

import { AuthContext } from '../App';
import Profile from '../pages/Profile';

const BASE_PROFILE = {
  id: 7,
  name: 'Asha Verma',
  email: 'asha@acme.test',
  role: 'USER',
  wellnessRole: null,
  ssoProvider: null,
  twoFactorEnabled: false,
  createdAt: '2026-01-01T00:00:00Z',
};

function renderProfile(meResponse = BASE_PROFILE, opts = {}) {
  const { setUser = vi.fn(), setToken = vi.fn(), deleteResult } = opts;
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url, fetchOpts) => {
    if (url === '/api/auth/me/account' && fetchOpts?.method === 'DELETE') {
      // deleteResult is a thunk so a rejection is created lazily at call
      // time (an eager Promise.reject() trips vitest's unhandled-rejection
      // detector before the component attaches its catch).
      return deleteResult ? deleteResult() : Promise.resolve(true);
    }
    if (url === '/api/auth/me') return Promise.resolve(meResponse);
    return Promise.resolve({});
  });
  render(
    <AuthContext.Provider value={{
      user: { ...meResponse, userId: meResponse.id },
      setUser,
      setToken,
      token: 'tk', tenant: { id: 1 }, loading: false,
      subscription: null,
    }}>
      <Profile />
    </AuthContext.Provider>
  );
  return { setUser, setToken };
}

function getDeleteCalls() {
  return fetchApiMock.mock.calls.filter(
    ([url, opts]) => url === '/api/auth/me/account' && opts?.method === 'DELETE',
  );
}

async function armDangerZone() {
  await waitFor(() => expect(screen.getByTestId('profile-danger-zone')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('profile-delete-account-button'));
  await waitFor(() =>
    expect(screen.getByTestId('profile-delete-account-confirm')).toBeInTheDocument(),
  );
}

describe('<Profile /> — danger zone account deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
  });

  it('renders the danger zone with a Delete account button', async () => {
    renderProfile();
    await waitFor(() => expect(screen.getByTestId('profile-danger-zone')).toBeInTheDocument());
    expect(screen.getByTestId('profile-delete-account-button')).toBeInTheDocument();
    // confirm area is NOT shown until armed
    expect(screen.queryByTestId('profile-delete-account-confirm')).not.toBeInTheDocument();
  });

  it('arming reveals the current-password input for password accounts', async () => {
    renderProfile();
    await armDangerZone();
    expect(screen.getByPlaceholderText('Current password')).toBeInTheDocument();
  });

  it('blocks submission without a password and does not call the API', async () => {
    renderProfile();
    await armDangerZone();
    fireEvent.click(screen.getByTestId('profile-delete-account-submit'));
    await waitFor(() => expect(notifyObj.error).toHaveBeenCalled());
    expect(notifyObj.confirm).not.toHaveBeenCalled();
    expect(getDeleteCalls()).toHaveLength(0);
  });

  it('happy path: confirm modal → DELETE call → auth cleared → /login', async () => {
    const { setUser, setToken } = renderProfile();
    await armDangerZone();

    fireEvent.change(screen.getByPlaceholderText('Current password'), {
      target: { value: 'hunter2hunter2' },
    });
    fireEvent.click(screen.getByTestId('profile-delete-account-submit'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true }));

    // irreversible warning shown as a destructive modal
    expect(notifyObj.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        destructive: true,
        message: expect.stringContaining('irreversible'),
      }),
    );

    const calls = getDeleteCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toEqual({
      confirmDestructive: true,
      password: 'hunter2hunter2',
    });

    // logged out locally at the same moment
    expect(setUser).toHaveBeenCalledWith(null);
    expect(setToken).toHaveBeenCalledWith(null);
    expect(notifyObj.success).toHaveBeenCalled();
  });

  it('declining the modal aborts the deletion', async () => {
    notifyObj.confirm.mockImplementation(() => Promise.resolve(false));
    const { setUser } = renderProfile();
    await armDangerZone();

    fireEvent.change(screen.getByPlaceholderText('Current password'), {
      target: { value: 'hunter2hunter2' },
    });
    fireEvent.click(screen.getByTestId('profile-delete-account-submit'));

    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalled());
    expect(getDeleteCalls()).toHaveLength(0);
    expect(setUser).not.toHaveBeenCalledWith(null);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('SSO accounts see no password input and can delete without one', async () => {
    renderProfile({ ...BASE_PROFILE, ssoProvider: 'google' });
    await armDangerZone();

    expect(screen.queryByPlaceholderText('Current password')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('profile-delete-account-submit'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true }));
    const calls = getDeleteCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toEqual({ confirmDestructive: true });
  });

  it('2FA accounts must supply a verification code before the modal opens', async () => {
    renderProfile({ ...BASE_PROFILE, twoFactorEnabled: true });
    await armDangerZone();

    fireEvent.change(screen.getByPlaceholderText('Current password'), {
      target: { value: 'hunter2hunter2' },
    });
    fireEvent.click(screen.getByTestId('profile-delete-account-submit'));
    await waitFor(() => expect(notifyObj.error).toHaveBeenCalled());
    expect(getDeleteCalls()).toHaveLength(0);

    fireEvent.change(screen.getByPlaceholderText('6-digit code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('profile-delete-account-submit'));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true }));
    expect(JSON.parse(getDeleteCalls()[0][1].body)).toEqual({
      confirmDestructive: true,
      password: 'hunter2hunter2',
      code: '123456',
    });
  });

  it('API failure leaves the user logged in (no navigate, no setUser(null))', async () => {
    const { setUser, setToken } = renderProfile(BASE_PROFILE, {
      deleteResult: () =>
        Promise.reject(Object.assign(new Error('Current password is incorrect'), { status: 400 })),
    });
    await armDangerZone();

    fireEvent.change(screen.getByPlaceholderText('Current password'), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByTestId('profile-delete-account-submit'));

    await waitFor(() => expect(getDeleteCalls()).toHaveLength(1));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalledWith(null);
    expect(setToken).not.toHaveBeenCalledWith(null);
    // button unfreezes for a retry
    await waitFor(() =>
      expect(screen.getByTestId('profile-delete-account-submit')).not.toBeDisabled(),
    );
  });
});
