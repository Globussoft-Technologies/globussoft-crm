/**
 * Privacy.jsx — Account Deletion confirmation modal (#584 / LOW-02).
 *
 * Scope: pins the irreversibility-guard added to the Account Deletion flow.
 * Before #584 the modal asked the user to type the literal string "DELETE",
 * which is bypassable by anyone with one accidental misclick — fat-finger
 * resistance was effectively zero. The fix mirrors GitHub's destructive-
 * action pattern: type your *actual account email* to enable the confirm
 * button, with the user's name + email named in the modal copy and an
 * explicit "This cannot be undone" warning.
 *
 * Contracts pinned here:
 *   1. Clicking "Request Account Deletion" opens the modal (initially hidden).
 *   2. The modal names the logged-in user (name + email) and lists what gets
 *      deleted, including the explicit "This cannot be undone" warning.
 *   3. The confirm button is disabled until the typed text exactly matches
 *      the user's email (case-insensitive, trimmed).
 *   4. Typing the wrong text → confirm button stays disabled, no fetchApi call.
 *   5. Typing the right email → confirm button enables, click fires fetchApi
 *      against /api/gdpr/consent and closes the modal.
 *   6. Cancel button closes the modal without firing fetchApi.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    info: vi.fn(),
    success: notifySuccess,
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

import { AuthContext } from '../App';
import Privacy from '../pages/Privacy';

const TEST_USER = {
  userId: 42,
  name: 'Rishu Sharma',
  email: 'rishu@enhancedwellness.in',
  role: 'ADMIN',
};

function renderPrivacy(user = TEST_USER, tenant = { id: 1 }) {
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant, loading: false }}>
      <Privacy />
    </AuthContext.Provider>,
  );
}

describe('<Privacy /> — Account Deletion confirmation modal (#584)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockResolvedValue([]);
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  it('does not show the confirmation modal until the trigger button is clicked', async () => {
    renderPrivacy();
    expect(screen.queryByText(/Confirm Account Deletion/i)).not.toBeInTheDocument();
  });

  it('clicking "Request Account Deletion" opens the modal with user name + email + irreversibility warning', async () => {
    const user = userEvent.setup();
    renderPrivacy();
    await user.click(screen.getByRole('button', { name: /Request Account Deletion/i }));

    expect(screen.getByRole('heading', { name: /Confirm Account Deletion/i })).toBeInTheDocument();

    // Modal must name the user (#584 acceptance: "Names the user/account being deleted").
    const target = screen.getByTestId('delete-target');
    expect(target.textContent).toMatch(/Rishu Sharma/);
    expect(target.textContent).toMatch(/rishu@enhancedwellness\.in/);

    // Explicit irreversibility warning.
    expect(screen.getByText(/This cannot be undone/i)).toBeInTheDocument();

    // Lists what gets deleted (#584 acceptance: "Lists what will be deleted").
    expect(screen.getByText(/Personal profile data/i)).toBeInTheDocument();
    expect(screen.getByText(/Activities, tasks, calls, messages, and emails/i)).toBeInTheDocument();
  });

  it('confirm button is disabled until the typed text matches the user email (anti-fat-finger)', async () => {
    const user = userEvent.setup();
    renderPrivacy();
    await user.click(screen.getByRole('button', { name: /Request Account Deletion/i }));

    const confirmBtn = screen.getByRole('button', { name: /Yes, delete permanently/i });
    expect(confirmBtn).toBeDisabled();

    const input = screen.getByLabelText(/Type your account email to confirm deletion/i);

    // Wrong text — still disabled, no fetch.
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: 'wrong@example.com' } });
    expect(confirmBtn).toBeDisabled();

    // The retention-policies GET fires on mount for admins; the destructive
    // /api/gdpr/consent POST must not have fired.
    expect(fetchApiMock).not.toHaveBeenCalledWith(
      '/api/gdpr/consent',
      expect.anything(),
    );
  });

  it('typing the correct email enables the confirm button and submitting fires fetchApi to /api/gdpr/consent', async () => {
    const user = userEvent.setup();
    renderPrivacy();
    await user.click(screen.getByRole('button', { name: /Request Account Deletion/i }));

    const confirmBtn = screen.getByRole('button', { name: /Yes, delete permanently/i });
    const input = screen.getByLabelText(/Type your account email to confirm deletion/i);

    fireEvent.change(input, { target: { value: TEST_USER.email } });
    expect(confirmBtn).not.toBeDisabled();

    await user.click(confirmBtn);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/gdpr/consent',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(notifySuccess).toHaveBeenCalled();
  });

  it('email match is case-insensitive and trimmed (real-world copy/paste safety)', async () => {
    const user = userEvent.setup();
    renderPrivacy();
    await user.click(screen.getByRole('button', { name: /Request Account Deletion/i }));

    const input = screen.getByLabelText(/Type your account email to confirm deletion/i);
    fireEvent.change(input, { target: { value: '  RISHU@enhancedwellness.IN  ' } });

    const confirmBtn = screen.getByRole('button', { name: /Yes, delete permanently/i });
    expect(confirmBtn).not.toBeDisabled();
  });

  it('Cancel button closes the modal without firing fetchApi', async () => {
    const user = userEvent.setup();
    renderPrivacy();
    await user.click(screen.getByRole('button', { name: /Request Account Deletion/i }));
    expect(screen.getByRole('heading', { name: /Confirm Account Deletion/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByRole('heading', { name: /Confirm Account Deletion/i })).not.toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith(
      '/api/gdpr/consent',
      expect.anything(),
    );
  });
});

// ── #576 — Clinical / Medical Records retention sub-section ──
describe('<Privacy /> — Clinical / Medical Records retention (#576)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    // /api/gdpr/retention-policies returns [] for a fresh tenant.
    fetchApiMock.mockResolvedValue([]);
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  it('generic tenant: clinical sub-section + DPDP bullet are NOT rendered', async () => {
    renderPrivacy(TEST_USER, { id: 1, vertical: 'generic' });
    // Wait for retention-policies fetch to resolve before asserting absence.
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    expect(screen.queryByTestId('clinical-retention-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dpdp-compliance-bullet')).not.toBeInTheDocument();
    expect(screen.queryByText(/Clinical \/ Medical Records/i)).not.toBeInTheDocument();
  });

  it('wellness tenant: renders the Clinical / Medical Records table with all 6 entities', async () => {
    renderPrivacy(TEST_USER, { id: 7, vertical: 'wellness' });
    await waitFor(() => {
      expect(screen.getByTestId('clinical-retention-table')).toBeInTheDocument();
    });
    // The 6 medical entities are present as table rows.
    const table = screen.getByTestId('clinical-retention-table');
    expect(table).toHaveTextContent('Patients');
    expect(table).toHaveTextContent('Visits');
    expect(table).toHaveTextContent('Prescriptions');
    expect(table).toHaveTextContent('Consent Forms');
    expect(table).toHaveTextContent('Treatment Plans');
    expect(table).toHaveTextContent('Medical Attachments');
  });

  it('wellness tenant: defaults are 7y for clinical entities, 10y for Patient', async () => {
    renderPrivacy(TEST_USER, { id: 7, vertical: 'wellness' });
    await waitFor(() => {
      expect(screen.getByTestId('clinical-retention-table')).toBeInTheDocument();
    });
    // Patients default = 3650, Visits/etc = 2555. The number inputs are
    // rendered with `value={p.retainDays}` — find them by row label.
    const inputs = screen
      .getByTestId('clinical-retention-table')
      .querySelectorAll('input[type="number"]');
    const values = Array.from(inputs).map((i) => Number(i.value)).sort((a, b) => a - b);
    expect(values).toEqual([2555, 2555, 2555, 2555, 2555, 3650]);
  });

  it('wellness tenant: DPDP (India) compliance bullet is rendered', async () => {
    renderPrivacy(TEST_USER, { id: 7, vertical: 'wellness' });
    await waitFor(() => {
      expect(screen.getByTestId('dpdp-compliance-bullet')).toBeInTheDocument();
    });
    expect(screen.getByText(/DPDP \(India\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Digital Personal Data Protection Act 2023/i)).toBeInTheDocument();
  });
});
