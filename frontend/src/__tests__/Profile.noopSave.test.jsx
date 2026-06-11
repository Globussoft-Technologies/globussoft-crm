/**
 * Profile.jsx — empty-PATCH skip on no-op Save (#606).
 *
 * Pre-fix: clicking Save on /profile sent PUT /api/auth/me with the full
 * {name, email} body unconditionally — even when the user hadn't touched
 * any field. The success toast fired regardless. This trains users to
 * ignore the toast (they see it on every refresh-then-Save) and pollutes
 * the audit log with no-op rows.
 *
 * Fix: handleUpdateProfile compares the form state (name, email) against
 * the baseline loaded from /api/auth/me. If nothing changed, return early
 * without firing the network call and surface a neutral "No changes to
 * save" message instead of the success toast. If something changed, send
 * ONLY the changed fields.
 *
 * Contracts pinned here:
 *   1. Save with no field changes does NOT call fetchApi('/api/auth/me', PUT).
 *   2. Save with no changes shows a neutral "No changes to save" message,
 *      not the success toast.
 *   3. Save with only `name` changed sends PUT with body {name} only —
 *      `email` is omitted from the body.
 *   4. Save with both fields changed sends PUT with both fields.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../App';
import Profile from '../pages/Profile';

const BASELINE_PROFILE = {
  id: 99,
  name: 'Rishu Sharma',
  email: 'rishu@enhancedwellness.in',
  role: 'ADMIN',
  wellnessRole: null,
  createdAt: '2026-01-01T00:00:00Z',
};

function setupApi(updatedProfile = BASELINE_PROFILE) {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/auth/me' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve(BASELINE_PROFILE);
    }
    if (url === '/api/auth/me' && opts?.method === 'PUT') {
      return Promise.resolve(updatedProfile);
    }
    return Promise.resolve({});
  });
}

function renderProfile() {
  // MemoryRouter: Profile's danger-zone delete flow calls useNavigate().
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{
        user: { ...BASELINE_PROFILE, userId: BASELINE_PROFILE.id },
        setUser: vi.fn(),
        token: 'tk', tenant: { id: 1 }, loading: false,
      }}>
        <Profile />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

function getPutCalls() {
  return fetchApiMock.mock.calls.filter(
    ([url, opts]) => url === '/api/auth/me' && opts?.method === 'PUT',
  );
}

describe('<Profile /> — empty PATCH skip (#606)', () => {
  beforeEach(() => {
    setupApi();
  });

  it('does NOT call fetchApi PUT /api/auth/me when no fields changed', async () => {
    renderProfile();
    await waitFor(() => expect(screen.getByDisplayValue('Rishu Sharma')).toBeInTheDocument());

    const saveBtn = screen.getByRole('button', { name: /Save Changes/i });
    fireEvent.click(saveBtn);

    // Wait a tick to make sure no async PUT slips through.
    await new Promise(r => setTimeout(r, 20));
    expect(getPutCalls()).toHaveLength(0);
  });

  it('shows the neutral "No changes to save" message when Save fires with no changes', async () => {
    renderProfile();
    await waitFor(() => expect(screen.getByDisplayValue('Rishu Sharma')).toBeInTheDocument());

    const saveBtn = screen.getByRole('button', { name: /Save Changes/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText(/No changes to save/i)).toBeInTheDocument();
    });
    // The misleading success toast must NOT appear.
    expect(screen.queryByText(/Profile updated successfully/i)).not.toBeInTheDocument();
  });

  it('sends PUT with ONLY the changed field when only name changed', async () => {
    setupApi({ ...BASELINE_PROFILE, name: 'Rishu S.' });
    renderProfile();
    await waitFor(() => expect(screen.getByDisplayValue('Rishu Sharma')).toBeInTheDocument());

    const nameInput = screen.getByDisplayValue('Rishu Sharma');
    fireEvent.change(nameInput, { target: { value: 'Rishu S.' } });

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(getPutCalls()).toHaveLength(1));
    const [, opts] = getPutCalls()[0];
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ name: 'Rishu S.' });
    expect(body).not.toHaveProperty('email');
  });

  it('sends PUT with both fields when both changed', async () => {
    setupApi({ ...BASELINE_PROFILE, name: 'Rishu S.', email: 'rs@enhancedwellness.in' });
    renderProfile();
    await waitFor(() => expect(screen.getByDisplayValue('Rishu Sharma')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Rishu Sharma'), { target: { value: 'Rishu S.' } });
    fireEvent.change(screen.getByDisplayValue('rishu@enhancedwellness.in'), { target: { value: 'rs@enhancedwellness.in' } });

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(getPutCalls()).toHaveLength(1));
    const body = JSON.parse(getPutCalls()[0][1].body);
    expect(body).toEqual({ name: 'Rishu S.', email: 'rs@enhancedwellness.in' });
  });
});
