/**
 * Profile.jsx — Practitioner section conditional render (#641) + form contracts.
 *
 * Issue context
 * ─────────────
 *   Wellness Demo User (user@wellness.demo, RBAC role=USER) was rendered
 *   a phantom "Practitioner" badge + section on /profile, even though
 *   they had no clinical privileges. Root cause: the seed had quietly
 *   assigned wellnessRole='professional' to the demo account AND the
 *   Profile page rendered the practitioner block unconditionally.
 *   Both sides need pinning so a future seed flip OR an unconditional
 *   render regression breaks the test, not the demo.
 *
 * Contracts pinned here
 * ─────────────────────
 *   Practitioner gating (#641):
 *     1. When /api/auth/me returns wellnessRole=null, Profile DOES NOT
 *        render the practitioner section (data-testid="profile-practitioner-section")
 *        AND DOES NOT render the wellnessRole badge (data-testid="profile-wellness-role-badge").
 *     2. Same for wellnessRole='helper' or 'telecaller' — non-clinical
 *        wellness roles still must NOT see the practitioner block.
 *     3. When wellnessRole='doctor' OR 'professional', Profile renders
 *        both the practitioner section AND the wellness-role badge.
 *     4. The role badge text matches the wellnessRole value (capitalised
 *        via CSS, asserted on raw text).
 *
 *   Form / fetch contracts (extension):
 *     5. Initial mount fetches GET /api/auth/me and populates name/email
 *        inputs from the response.
 *     6. Save Changes diff-PATCHes only changed fields against the
 *        baseline profile (#606: no-op PATCHes were polluting audit
 *        logs + training users to ignore success toasts).
 *     7. Submitting with no field changes shows "No changes to save"
 *        info message and DOES NOT call PUT.
 *     8. Successful profile update propagates the new name/email back
 *        into AuthContext via setUser (so Sidebar / header re-render).
 *     9. Password change happy path fires PUT /api/auth/me with
 *        {currentPassword, newPassword} and clears the form on success.
 *    10. Password mismatch (new !== confirm) blocks the PUT and renders
 *        the mismatch error inline.
 *    11. Password too-short (<6 chars) blocks the PUT and renders the
 *        length error inline.
 *    12. /api/auth/me failure on mount surfaces a "Failed to load
 *        profile" error message (not a crash).
 *    13. Loading state shows "Loading profile..." before the /me fetch
 *        resolves (no flash of empty form).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable mock-object pattern (2026-05-23 standing rule): a single object
// reference returned from useNotify so any useCallback / useMemo deps
// referencing it stay identity-stable across re-renders.
const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: () => Promise.resolve(true),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import Profile from '../pages/Profile';

function renderProfile(meResponse, opts = {}) {
  const { setUser = vi.fn(), subscription = null } = opts;
  // Note: caller is responsible for fetchApiMock setup if it needs
  // more than the basic /me success path. renderProfile defaults
  // /api/auth/me to meResponse and any other URL to {}.
  if (!opts.skipDefaultMock) {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return Promise.resolve(meResponse);
      return Promise.resolve({});
    });
  }
  return render(
    <AuthContext.Provider value={{
      user: meResponse ? { ...meResponse, userId: meResponse.id } : null,
      setUser,
      token: 'tk', tenant: { id: 1 }, loading: false,
      subscription,
    }}>
      <Profile />
    </AuthContext.Provider>
  );
}

describe('<Profile /> — practitioner section gating (#641)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('does NOT render the practitioner section when wellnessRole=null (Demo User regression pin)', async () => {
    renderProfile({
      id: 99, name: 'Demo User', email: 'user@wellness.demo',
      role: 'USER', wellnessRole: null, createdAt: '2026-01-01T00:00:00Z',
    });
    await waitFor(() => expect(screen.getByText('Demo User')).toBeInTheDocument());

    expect(screen.queryByTestId('profile-practitioner-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-wellness-role-badge')).not.toBeInTheDocument();
  });

  it('does NOT render the practitioner section for helper / telecaller', async () => {
    for (const wellnessRole of ['helper', 'telecaller']) {
      renderProfile({
        id: 100, name: 'Support Staff', email: 'staff@x.com',
        role: 'USER', wellnessRole, createdAt: '2026-01-01T00:00:00Z',
      });
      await waitFor(() => expect(screen.getByText('Support Staff')).toBeInTheDocument());

      expect(screen.queryByTestId('profile-practitioner-section')).not.toBeInTheDocument();
      // The wellnessRole badge SHOULD appear (the role is set), but the
      // practitioner section must NOT — these two render conditions are
      // intentionally different (badge = "is wellnessRole truthy", section
      // = "is wellnessRole clinical").
      expect(screen.getByTestId('profile-wellness-role-badge')).toBeInTheDocument();
      // Tear down between iterations so the next render starts from a
      // clean DOM (otherwise getByTestId trips on duplicate matches).
      cleanup();
    }
  });

  it('renders the practitioner section when wellnessRole=doctor', async () => {
    renderProfile({
      id: 101, name: 'Dr. Harsh Kumar', email: 'drharsh@enhancedwellness.in',
      role: 'USER', wellnessRole: 'doctor', createdAt: '2026-01-01T00:00:00Z',
    });
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    expect(screen.getByTestId('profile-practitioner-section')).toBeInTheDocument();
    const badge = screen.getByTestId('profile-wellness-role-badge');
    expect(badge.textContent).toMatch(/doctor/i);
  });

  it('renders the practitioner section when wellnessRole=professional', async () => {
    renderProfile({
      id: 102, name: 'Priya Pro', email: 'priya@enhancedwellness.in',
      role: 'USER', wellnessRole: 'professional', createdAt: '2026-01-01T00:00:00Z',
    });
    await waitFor(() => expect(screen.getByText('Priya Pro')).toBeInTheDocument());

    expect(screen.getByTestId('profile-practitioner-section')).toBeInTheDocument();
    expect(screen.getByTestId('profile-wellness-role-badge').textContent).toMatch(/professional/i);
  });
});

describe('<Profile /> — initial fetch + loading state', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('shows "Loading profile..." before /api/auth/me resolves', async () => {
    // Use a pending promise so the component stays in loading state.
    let resolveMe;
    const pending = new Promise((resolve) => { resolveMe = resolve; });
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return pending;
      return Promise.resolve({});
    });

    render(
      <AuthContext.Provider value={{ user: null, setUser: vi.fn(), token: 'tk', tenant: { id: 1 }, loading: false }}>
        <Profile />
      </AuthContext.Provider>
    );

    // Loading copy is visible.
    expect(screen.getByText(/loading profile/i)).toBeInTheDocument();
    // The "My Profile" h1 is NOT yet rendered (page still loading).
    expect(screen.queryByText(/^My Profile$/)).not.toBeInTheDocument();

    // Resolve so the test can clean up without an unsettled promise.
    resolveMe({ id: 1, name: 'X', email: 'x@y.z', role: 'USER', wellnessRole: null });
    await waitFor(() => expect(screen.getByText('My Profile')).toBeInTheDocument());
  });

  it('fetches /api/auth/me on mount and populates form inputs', async () => {
    renderProfile({
      id: 50, name: 'Alice Apple', email: 'alice@apple.test',
      role: 'MANAGER', wellnessRole: null, createdAt: '2026-01-01T00:00:00Z',
    });

    await waitFor(() => expect(screen.getByText('Alice Apple')).toBeInTheDocument());

    // The /me endpoint was the first call.
    expect(fetchApiMock).toHaveBeenCalledWith('/api/auth/me');

    // Name + Email inputs initialised from the response.
    const nameInput = screen.getByPlaceholderText('Your name');
    const emailInput = screen.getByPlaceholderText('Your email');
    expect(nameInput.value).toBe('Alice Apple');
    expect(emailInput.value).toBe('alice@apple.test');
  });

  it('renders a "Failed to load profile" error when /api/auth/me rejects', async () => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return Promise.reject(new Error('network down'));
      return Promise.resolve({});
    });

    render(
      <AuthContext.Provider value={{ user: null, setUser: vi.fn(), token: 'tk', tenant: { id: 1 }, loading: false }}>
        <Profile />
      </AuthContext.Provider>
    );

    // Loading clears (setLoading(false) in catch tail), then the page
    // renders with the error message in the profileMsg area.
    await waitFor(() => expect(screen.getByText(/failed to load profile/i)).toBeInTheDocument());
  });
});

describe('<Profile /> — Edit Profile form', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('diff-PATCHes only changed fields on Save (#606 — no-op writes are blocked)', async () => {
    const profile = {
      id: 60, name: 'Bob Baseline', email: 'bob@base.test',
      role: 'USER', wellnessRole: null, createdAt: '2026-01-01T00:00:00Z',
    };
    const updated = { ...profile, name: 'Bob Updated' };
    const setUserMock = vi.fn();

    let callCount = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      callCount += 1;
      if (callCount === 1 && url === '/api/auth/me') return Promise.resolve(profile);
      if (url === '/api/auth/me' && opts?.method === 'PUT') return Promise.resolve(updated);
      return Promise.resolve({});
    });

    render(
      <AuthContext.Provider value={{
        user: { ...profile, userId: profile.id },
        setUser: setUserMock,
        token: 'tk', tenant: { id: 1 }, loading: false,
      }}>
        <Profile />
      </AuthContext.Provider>
    );

    await waitFor(() => expect(screen.getByText('Bob Baseline')).toBeInTheDocument());

    // Change name only.
    const nameInput = screen.getByPlaceholderText('Your name');
    fireEvent.change(nameInput, { target: { value: 'Bob Updated' } });

    // Click Save Changes.
    const saveBtn = screen.getByRole('button', { name: /save changes/i });
    fireEvent.click(saveBtn);

    // PUT fired with ONLY {name}, NOT {name, email}.
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/auth/me' && c[1]?.method === 'PUT'
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body).toEqual({ name: 'Bob Updated' });
    });

    // Success toast renders.
    await waitFor(() =>
      expect(screen.getByText(/profile updated successfully/i)).toBeInTheDocument()
    );

    // AuthContext.setUser was called with the merged user (Sidebar
    // header re-render depends on this).
    expect(setUserMock).toHaveBeenCalled();
    const setUserArg = setUserMock.mock.calls[setUserMock.mock.calls.length - 1][0];
    expect(setUserArg.name).toBe('Bob Updated');
    expect(setUserArg.email).toBe('bob@base.test');
  });

  it('shows "No changes to save" and DOES NOT call PUT when the form is unchanged (#606)', async () => {
    const profile = {
      id: 61, name: 'Carol Constant', email: 'carol@const.test',
      role: 'USER', wellnessRole: null, createdAt: '2026-01-01T00:00:00Z',
    };
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return Promise.resolve(profile);
      return Promise.resolve({});
    });

    render(
      <AuthContext.Provider value={{
        user: { ...profile, userId: profile.id },
        setUser: vi.fn(),
        token: 'tk', tenant: { id: 1 }, loading: false,
      }}>
        <Profile />
      </AuthContext.Provider>
    );

    await waitFor(() => expect(screen.getByText('Carol Constant')).toBeInTheDocument());

    // Submit without changing anything.
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // "No changes to save" message.
    await waitFor(() =>
      expect(screen.getByText(/no changes to save/i)).toBeInTheDocument()
    );

    // No PUT call was made — fetchApiMock should only have the
    // initial GET.
    const putCalls = fetchApiMock.mock.calls.filter(
      (c) => c[1]?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(0);
  });

  it('renders a server error message when PUT /api/auth/me rejects', async () => {
    const profile = {
      id: 62, name: 'Dave Doomed', email: 'dave@doom.test',
      role: 'USER', wellnessRole: null, createdAt: '2026-01-01T00:00:00Z',
    };
    let firstCall = true;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/me' && firstCall && !opts) {
        firstCall = false;
        return Promise.resolve(profile);
      }
      if (url === '/api/auth/me' && opts?.method === 'PUT') {
        return Promise.reject(new Error('duplicate email'));
      }
      return Promise.resolve({});
    });

    render(
      <AuthContext.Provider value={{
        user: { ...profile, userId: profile.id },
        setUser: vi.fn(),
        token: 'tk', tenant: { id: 1 }, loading: false,
      }}>
        <Profile />
      </AuthContext.Provider>
    );

    await waitFor(() => expect(screen.getByText('Dave Doomed')).toBeInTheDocument());

    // Change email so the PUT actually fires.
    const emailInput = screen.getByPlaceholderText('Your email');
    fireEvent.change(emailInput, { target: { value: 'dave2@doom.test' } });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // Server's error.message is surfaced in the inline message.
    await waitFor(() =>
      expect(screen.getByText(/duplicate email/i)).toBeInTheDocument()
    );
  });
});

describe('<Profile /> — Change Password form', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('fires PUT /api/auth/me with {currentPassword, newPassword} on happy path + clears the form', async () => {
    const profile = {
      id: 70, name: 'Eve Endo', email: 'eve@endo.test',
      role: 'USER', wellnessRole: null, createdAt: '2026-01-01T00:00:00Z',
    };
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/me' && !opts) return Promise.resolve(profile);
      if (url === '/api/auth/me' && opts?.method === 'PUT') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });

    render(
      <AuthContext.Provider value={{
        user: { ...profile, userId: profile.id },
        setUser: vi.fn(),
        token: 'tk', tenant: { id: 1 }, loading: false,
      }}>
        <Profile />
      </AuthContext.Provider>
    );

    await waitFor(() => expect(screen.getByText('Eve Endo')).toBeInTheDocument());

    const currentInput = screen.getByPlaceholderText('Enter current password');
    const newInput = screen.getByPlaceholderText('Enter new password');
    const confirmInput = screen.getByPlaceholderText('Confirm new password');

    fireEvent.change(currentInput, { target: { value: 'old-pw-12' } });
    fireEvent.change(newInput, { target: { value: 'new-pw-345' } });
    fireEvent.change(confirmInput, { target: { value: 'new-pw-345' } });

    fireEvent.click(screen.getByRole('button', { name: /change password/i }));

    // Verify the PUT call body.
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/auth/me' && c[1]?.method === 'PUT'
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body).toEqual({ currentPassword: 'old-pw-12', newPassword: 'new-pw-345' });
    });

    // Success message.
    await waitFor(() =>
      expect(screen.getByText(/password changed successfully/i)).toBeInTheDocument()
    );

    // Form fields cleared after success.
    expect(currentInput.value).toBe('');
    expect(newInput.value).toBe('');
    expect(confirmInput.value).toBe('');
  });

  it('blocks the PUT and shows mismatch error when new !== confirm', async () => {
    const profile = {
      id: 71, name: 'Frank Fail', email: 'frank@fail.test',
      role: 'USER', wellnessRole: null, createdAt: '2026-01-01T00:00:00Z',
    };
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return Promise.resolve(profile);
      return Promise.resolve({});
    });

    render(
      <AuthContext.Provider value={{
        user: { ...profile, userId: profile.id },
        setUser: vi.fn(),
        token: 'tk', tenant: { id: 1 }, loading: false,
      }}>
        <Profile />
      </AuthContext.Provider>
    );

    await waitFor(() => expect(screen.getByText('Frank Fail')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Enter current password'), { target: { value: 'old-pw-12' } });
    fireEvent.change(screen.getByPlaceholderText('Enter new password'), { target: { value: 'new-pw-AAA' } });
    fireEvent.change(screen.getByPlaceholderText('Confirm new password'), { target: { value: 'new-pw-BBB' } });

    fireEvent.click(screen.getByRole('button', { name: /change password/i }));

    // Mismatch error renders.
    await waitFor(() =>
      expect(screen.getByText(/new passwords do not match/i)).toBeInTheDocument()
    );

    // PUT was NOT called (only the initial GET).
    const putCalls = fetchApiMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });

  it('blocks the PUT and shows min-length error when new password is < 6 chars', async () => {
    const profile = {
      id: 72, name: 'Gina Short', email: 'gina@short.test',
      role: 'USER', wellnessRole: null, createdAt: '2026-01-01T00:00:00Z',
    };
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return Promise.resolve(profile);
      return Promise.resolve({});
    });

    render(
      <AuthContext.Provider value={{
        user: { ...profile, userId: profile.id },
        setUser: vi.fn(),
        token: 'tk', tenant: { id: 1 }, loading: false,
      }}>
        <Profile />
      </AuthContext.Provider>
    );

    await waitFor(() => expect(screen.getByText('Gina Short')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Enter current password'), { target: { value: 'old' } });
    fireEvent.change(screen.getByPlaceholderText('Enter new password'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByPlaceholderText('Confirm new password'), { target: { value: 'abc' } });

    fireEvent.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() =>
      expect(screen.getByText(/at least 6 characters/i)).toBeInTheDocument()
    );

    const putCalls = fetchApiMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });
});
