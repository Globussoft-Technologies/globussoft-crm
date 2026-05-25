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

// ── Extension: Retention policy CRUD, Data Export, RBAC, states ──
//
// Augments the original #584 modal + #576 clinical-retention pins with
// coverage of the rest of Privacy.jsx's surface:
//   - Retention policies list rendered on mount (fetchApi GET wires through)
//   - Server-returned policies merge over defaults (#389 — coerce zero to default)
//   - Save Policies fires fetchApi PUT with the serialized policy array
//   - Edit retain-days input updates state before save (PUT body picks it up)
//   - Edit "Active" checkbox toggles isActive in the PUT body
//   - Export My Data fires POST /api/gdpr/export/me and triggers download
//   - Export failure surfaces notify.error
//   - RBAC: USER role → retention-policies section NOT rendered + no GET fired
//   - Loading state: "Loading policies..." copy renders before fetch resolves
//   - Error state: fetchApi reject falls back to defaults (no crash; defaults visible)
//
// Vitest pattern compliance:
//   - stable mock-object refs at module scope (notifyError, notifySuccess shared)
//   - getAllByText / scoped within(getByTestId(...)) for ambiguity (labels appear
//     both in table chrome and may collide with copy elsewhere)
//   - run from frontend/ via `npx vitest run src/__tests__/Privacy.test.jsx`
describe('<Privacy /> — Retention policy CRUD + data export + RBAC + states', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockResolvedValue([]);
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  it('admin: retention policy list renders the 5 CRM messaging entities by label', async () => {
    renderPrivacy();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/gdpr/retention-policies');
    });
    // All 5 CRM messaging entity labels are visible. Defaults-only path
    // because mock returns [].
    await waitFor(() => {
      expect(screen.getByText('Email Messages')).toBeInTheDocument();
    });
    expect(screen.getByText('Call Logs')).toBeInTheDocument();
    expect(screen.getByText('Activities')).toBeInTheDocument();
    expect(screen.getByText('SMS Messages')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp Messages')).toBeInTheDocument();
  });

  it('admin: server-returned retainDays overrides defaults (positive values applied)', async () => {
    // First call (mount) returns persisted policies overriding defaults.
    fetchApiMock.mockResolvedValueOnce([
      { entity: 'EmailMessage', retainDays: 90, isActive: true },
      { entity: 'CallLog', retainDays: 30, isActive: false },
    ]);

    renderPrivacy();
    await waitFor(() => {
      expect(screen.getByText('Email Messages')).toBeInTheDocument();
    });

    const numberInputs = document.querySelectorAll('input[type="number"]');
    const values = Array.from(numberInputs).map((i) => Number(i.value));
    // EmailMessage = 90, CallLog = 30, rest default (1095, 365, 365).
    expect(values).toContain(90);
    expect(values).toContain(30);
  });

  it('admin: zero / NaN / empty retainDays from server falls back to defaults (#389 coercion)', async () => {
    // Regression for #389: server returning retainDays === 0 / "" / null
    // previously rendered as blank input. Coercion must restore defaults.
    fetchApiMock.mockResolvedValueOnce([
      { entity: 'EmailMessage', retainDays: 0, isActive: false },
      { entity: 'CallLog', retainDays: '', isActive: false },
      { entity: 'Activity', retainDays: null, isActive: false },
    ]);

    renderPrivacy();
    await waitFor(() => {
      expect(screen.getByText('Email Messages')).toBeInTheDocument();
    });

    const numberInputs = document.querySelectorAll('input[type="number"]');
    const values = Array.from(numberInputs).map((i) => Number(i.value));
    // EmailMessage default 730, CallLog default 365, Activity default 1095.
    expect(values).toContain(730);
    expect(values).toContain(365);
    expect(values).toContain(1095);
    // No blank or zero input slipped through.
    expect(values.every((v) => v > 0)).toBe(true);
  });

  it('admin: clicking Save Policies fires fetchApi PUT with serialized retention array', async () => {
    const user = userEvent.setup();
    renderPrivacy();
    await waitFor(() => {
      expect(screen.getByText('Email Messages')).toBeInTheDocument();
    });

    // Save Policies button. fetchApi for PUT resolves successfully.
    fetchApiMock.mockResolvedValueOnce({ ok: true });
    await user.click(screen.getByRole('button', { name: /Save Policies/i }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/gdpr/retention-policies',
        expect.objectContaining({
          method: 'PUT',
          body: expect.any(String),
        }),
      );
    });

    // Body is a JSON-stringified array of {entity, retainDays, isActive}.
    const putCall = fetchApiMock.mock.calls.find(
      (c) => c[0] === '/api/gdpr/retention-policies' && c[1]?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const parsed = JSON.parse(putCall[1].body);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(5); // 5 CRM messaging entities
    expect(parsed[0]).toMatchObject({
      entity: expect.any(String),
      retainDays: expect.any(Number),
      isActive: expect.any(Boolean),
    });
    expect(notifySuccess).toHaveBeenCalledWith('Retention policy saved');
  });

  it('admin: editing retainDays input then saving sends the new value in the PUT body', async () => {
    const user = userEvent.setup();
    renderPrivacy();
    await waitFor(() => {
      expect(screen.getByText('Email Messages')).toBeInTheDocument();
    });

    // First number input corresponds to the first row (EmailMessage).
    const numberInputs = document.querySelectorAll('input[type="number"]');
    expect(numberInputs.length).toBeGreaterThan(0);
    const emailInput = numberInputs[0];

    fireEvent.change(emailInput, { target: { value: '180' } });
    expect(emailInput.value).toBe('180');

    fetchApiMock.mockResolvedValueOnce({ ok: true });
    await user.click(screen.getByRole('button', { name: /Save Policies/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/gdpr/retention-policies' && c[1]?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const parsed = JSON.parse(putCall[1].body);
      // EmailMessage is the first CRM entity; updated retainDays is 180.
      const email = parsed.find((p) => p.entity === 'EmailMessage');
      expect(email).toBeDefined();
      expect(email.retainDays).toBe(180);
    });
  });

  it('admin: toggling Active checkbox is persisted in the PUT body isActive flag', async () => {
    const user = userEvent.setup();
    renderPrivacy();
    await waitFor(() => {
      expect(screen.getByText('Email Messages')).toBeInTheDocument();
    });

    // Find checkboxes inside the retention table. First one toggles
    // EmailMessage row's isActive flag.
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThan(0);
    const firstCheckbox = checkboxes[0];
    expect(firstCheckbox.checked).toBe(false);

    fireEvent.click(firstCheckbox);
    expect(firstCheckbox.checked).toBe(true);

    fetchApiMock.mockResolvedValueOnce({ ok: true });
    await user.click(screen.getByRole('button', { name: /Save Policies/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/gdpr/retention-policies' && c[1]?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const parsed = JSON.parse(putCall[1].body);
      // At least one entity now has isActive === true.
      expect(parsed.some((p) => p.isActive === true)).toBe(true);
    });
  });

  it('admin: save failure surfaces notify.error and does NOT toast success', async () => {
    const user = userEvent.setup();
    renderPrivacy();
    await waitFor(() => {
      expect(screen.getByText('Email Messages')).toBeInTheDocument();
    });

    fetchApiMock.mockRejectedValueOnce(new Error('boom'));
    await user.click(screen.getByRole('button', { name: /Save Policies/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save policies'),
      );
    });
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('Export My Data: clicking the button fires POST /api/gdpr/export/me with bearer token', async () => {
    const user = userEvent.setup();
    // Mock global fetch (the export uses raw fetch, not fetchApi, because it
    // needs the raw blob response).
    const blob = new Blob(['{"deals":[]}'], { type: 'application/json' });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      blob: () => Promise.resolve(blob),
    });
    // URL.createObjectURL doesn't exist in jsdom by default.
    const origCreate = window.URL.createObjectURL;
    const origRevoke = window.URL.revokeObjectURL;
    window.URL.createObjectURL = vi.fn(() => 'blob:fake-url');
    window.URL.revokeObjectURL = vi.fn();

    renderPrivacy();
    await user.click(
      screen.getByRole('button', { name: /Download My Data \(JSON\)/i }),
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/gdpr/export/me',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    // Success affordance appears.
    await waitFor(() => {
      expect(screen.getByText(/Export downloaded/i)).toBeInTheDocument();
    });

    fetchSpy.mockRestore();
    window.URL.createObjectURL = origCreate;
    window.URL.revokeObjectURL = origRevoke;
  });

  it('Export My Data: !res.ok response triggers notify.error', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      blob: () => Promise.resolve(new Blob([])),
    });

    renderPrivacy();
    await user.click(
      screen.getByRole('button', { name: /Download My Data \(JSON\)/i }),
    );

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to export data'),
      );
    });

    fetchSpy.mockRestore();
  });

  it('RBAC: USER role does NOT render the retention-policies section and skips the GET', async () => {
    const userRoleUser = { ...TEST_USER, role: 'USER' };
    renderPrivacy(userRoleUser);

    // useEffect early-exits when !isAdmin, so the section header is absent.
    // (Loading must be off too — `setPoliciesLoading(false)` in the early branch.)
    await waitFor(() => {
      expect(screen.queryByText('Data Retention Policies')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Loading policies...')).not.toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/gdpr/retention-policies');

    // Export My Data + Account Deletion sections remain (user-self-service).
    expect(
      screen.getByRole('button', { name: /Download My Data \(JSON\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Request Account Deletion/i }),
    ).toBeInTheDocument();
  });

  it('RBAC: ADMIN role renders the retention-policies section + Save button', async () => {
    renderPrivacy(); // TEST_USER is ADMIN by default
    await waitFor(() => {
      expect(screen.getByText('Data Retention Policies')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Save Policies/i })).toBeInTheDocument();
  });

  it('loading state: "Loading policies..." copy renders before the GET resolves', async () => {
    // Force fetchApi to a never-resolving promise so the loading state lingers.
    let resolver;
    const pending = new Promise((res) => {
      resolver = res;
    });
    fetchApiMock.mockReturnValueOnce(pending);

    renderPrivacy();

    // Loading copy is visible while fetch is in-flight.
    await waitFor(() => {
      expect(screen.getByText(/Loading policies\.\.\./i)).toBeInTheDocument();
    });

    // Resolve so the test exits cleanly.
    resolver([]);
    await waitFor(() => {
      expect(screen.queryByText(/Loading policies\.\.\./i)).not.toBeInTheDocument();
    });
  });

  it('error state: fetchApi rejection falls back to defaults (no crash, defaults rendered)', async () => {
    // Mount-time GET rejects. SUT catches + falls back to VISIBLE_RETENTION_ENTITIES
    // defaults; the table still renders.
    fetchApiMock.mockRejectedValueOnce(new Error('network down'));

    renderPrivacy();

    await waitFor(() => {
      expect(screen.getByText('Email Messages')).toBeInTheDocument();
    });
    // Defaults visible — 730 for EmailMessage among others.
    const numberInputs = document.querySelectorAll('input[type="number"]');
    const values = Array.from(numberInputs).map((i) => Number(i.value));
    expect(values).toContain(730);
    expect(values).toContain(1095);
    // No global error toast — the catch is silent (console.error only).
    expect(notifyError).not.toHaveBeenCalled();
  });
});
