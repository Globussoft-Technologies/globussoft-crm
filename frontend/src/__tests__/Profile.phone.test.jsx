/**
 * Profile.jsx — self-service phone number.
 *
 * A CUSTOMER account had no way to supply a contact number, so a self-booked
 * appointment reached the clinic with nothing to call. The Edit Profile form
 * now carries a Phone field that saves through the same PUT /api/auth/me the
 * name/email fields use.
 *
 * Contracts pinned here:
 *   1. The field renders and prefills from GET /api/auth/me.
 *   2. Changing only the phone sends PUT with ONLY {phone} — the #606
 *      changed-fields-only contract must keep holding with a third field.
 *   3. Clearing the field sends phone:"" — that is how a user removes a
 *      number, and it must not be dropped as "falsy, therefore unchanged".
 *   4. An unchanged phone is not sent, and an untouched form is still a no-op.
 *   5. The field re-renders from the server's canonical value, so a number
 *      typed as "9876543210" and stored as "+919876543210" does not read as
 *      a pending change on the next save.
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
  name: 'Mohit Das',
  email: 'mohit@example.test',
  phone: '',
  role: 'CUSTOMER',
  wellnessRole: null,
  createdAt: '2026-08-21T00:00:00Z',
};

function setupApi({ baseline = BASELINE_PROFILE, updated = BASELINE_PROFILE } = {}) {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/auth/me' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve(baseline);
    }
    if (url === '/api/auth/me' && opts?.method === 'PUT') {
      return Promise.resolve(updated);
    }
    return Promise.resolve({});
  });
}

function renderProfile() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{
          user: { ...BASELINE_PROFILE, userId: BASELINE_PROFILE.id },
          setUser: vi.fn(),
          token: 'tk',
          tenant: { id: 1 },
          loading: false,
        }}
      >
        <Profile />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function getPutCalls() {
  return fetchApiMock.mock.calls.filter(
    ([url, opts]) => url === '/api/auth/me' && opts?.method === 'PUT',
  );
}

async function waitForForm() {
  await waitFor(() => expect(screen.getByDisplayValue('Mohit Das')).toBeInTheDocument());
  return screen.getByTestId('profile-phone-input');
}

describe('<Profile /> — self-service phone number', () => {
  beforeEach(() => {
    setupApi();
  });

  it('renders a phone field in the Edit Profile form', async () => {
    renderProfile();
    const input = await waitForForm();
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('prefills the saved number from /api/auth/me', async () => {
    setupApi({ baseline: { ...BASELINE_PROFILE, phone: '+919876543210' } });
    renderProfile();
    const input = await waitForForm();
    expect(input).toHaveValue('+919876543210');
  });

  it('sends ONLY {phone} when the phone is the only change', async () => {
    setupApi({ updated: { ...BASELINE_PROFILE, phone: '+919876543210' } });
    renderProfile();
    const input = await waitForForm();

    fireEvent.change(input, { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(getPutCalls()).toHaveLength(1));
    expect(JSON.parse(getPutCalls()[0][1].body)).toEqual({ phone: '9876543210' });
  });

  it('sends an empty string when the user clears their number', async () => {
    setupApi({
      baseline: { ...BASELINE_PROFILE, phone: '+919876543210' },
      updated: { ...BASELINE_PROFILE, phone: null },
    });
    renderProfile();
    const input = await waitForForm();

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(getPutCalls()).toHaveLength(1));
    expect(JSON.parse(getPutCalls()[0][1].body)).toEqual({ phone: '' });
  });

  it('omits phone from the body when only the name changed', async () => {
    setupApi({
      baseline: { ...BASELINE_PROFILE, phone: '+919876543210' },
      updated: { ...BASELINE_PROFILE, name: 'Mohit D.', phone: '+919876543210' },
    });
    renderProfile();
    await waitForForm();

    fireEvent.change(screen.getByDisplayValue('Mohit Das'), { target: { value: 'Mohit D.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(getPutCalls()).toHaveLength(1));
    const body = JSON.parse(getPutCalls()[0][1].body);
    expect(body).toEqual({ name: 'Mohit D.' });
    expect(body).not.toHaveProperty('phone');
  });

  it('still treats an untouched form as a no-op', async () => {
    setupApi({ baseline: { ...BASELINE_PROFILE, phone: '+919876543210' } });
    renderProfile();
    await waitForForm();

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(screen.getByText(/No changes to save/i)).toBeInTheDocument());
    expect(getPutCalls()).toHaveLength(0);
  });

  it('adopts the canonical number the server stored', async () => {
    setupApi({ updated: { ...BASELINE_PROFILE, phone: '+919876543210' } });
    renderProfile();
    const input = await waitForForm();

    fireEvent.change(input, { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() =>
      expect(screen.getByTestId('profile-phone-input')).toHaveValue('+919876543210'),
    );

    // Saving again is now correctly a no-op — the field matches the baseline.
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(screen.getByText(/No changes to save/i)).toBeInTheDocument());
    expect(getPutCalls()).toHaveLength(1);
  });
});
