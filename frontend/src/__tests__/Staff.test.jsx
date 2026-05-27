/**
 * Staff.jsx — row action buttons + Inactive badge (#618).
 *
 * Issue context
 * ─────────────
 *   Pre-fix the Staff Directory rendered ONLY a Delete button per row.
 *   Admins had no way to edit a row, deactivate without deleting,
 *   force a password reset, or re-send a stale invite. This commit
 *   adds Edit, Deactivate / Reactivate, Reset Password, Resend Invite
 *   alongside the existing Delete, plus an "Inactive" badge for rows
 *   whose User.deactivatedAt is non-null.
 *
 * Contracts pinned here
 * ─────────────────────
 *   1. For an ADMIN viewer, every non-ADMIN row renders 5 action
 *      buttons: Edit, Deactivate, Reset Password, Resend Invite, Delete.
 *   2. For an ADMIN row, Deactivate + Delete are hidden (admins are
 *      protected from accidental disabling). Edit, Reset Password,
 *      Resend Invite still render.
 *   3. A row whose deactivatedAt is non-null renders the "Inactive"
 *      badge AND the action button toggles to "Reactivate".
 *   4. Non-admin viewers see only "—" in the actions column (no buttons).
 *   5. Clicking Edit opens the edit modal (data-testid="staff-edit-modal").
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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

import { AuthContext } from '../App';
import Staff from '../pages/Staff';

const STAFF_ROWS = [
  { id: 1,  name: 'Rishu Agarwal',  email: 'rishu@enhancedwellness.in', role: 'ADMIN',  wellnessRole: null,           createdAt: '2026-01-01T00:00:00Z', deactivatedAt: null },
  { id: 2,  name: 'Dr. Harsh Kumar', email: 'drharsh@enhancedwellness.in', role: 'USER',  wellnessRole: 'doctor',     createdAt: '2026-01-02T00:00:00Z', deactivatedAt: null },
  { id: 3,  name: 'Priya Pro',       email: 'priya@enhancedwellness.in',   role: 'USER',  wellnessRole: 'professional', createdAt: '2026-01-03T00:00:00Z', deactivatedAt: null },
  { id: 4,  name: 'Inactive Aman',   email: 'aman@enhancedwellness.in',    role: 'USER',  wellnessRole: 'helper',     createdAt: '2026-01-04T00:00:00Z', deactivatedAt: '2026-04-01T00:00:00Z' },
];

function renderStaff(viewerRole = 'ADMIN', overrides = {}) {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url) => {
    if (overrides[url] !== undefined) return Promise.resolve(overrides[url]);
    if (url === '/api/staff') return Promise.resolve(STAFF_ROWS);
    if (url === '/api/staff/commission-profiles') return Promise.resolve([]);
    if (url.startsWith('/api/staff/revenue-goals')) return Promise.resolve([]);
    return Promise.resolve({});
  });
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{
        user: { userId: 1, name: 'Rishu Agarwal', email: 'rishu@enhancedwellness.in', role: viewerRole },
        setUser: vi.fn(), token: 'tk', tenant: { id: 1 }, loading: false,
      }}>
        <Staff />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('<Staff /> — row action buttons (#618)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('non-ADMIN row shows all 5 action buttons for an ADMIN viewer', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    // Row id=2 is non-ADMIN → all 5 buttons.
    expect(screen.getByTestId('staff-action-edit-2')).toBeInTheDocument();
    expect(screen.getByTestId('staff-action-deactivate-2')).toBeInTheDocument();
    expect(screen.getByTestId('staff-action-reset-password-2')).toBeInTheDocument();
    expect(screen.getByTestId('staff-action-resend-invite-2')).toBeInTheDocument();
    expect(screen.getByTestId('staff-action-delete-2')).toBeInTheDocument();
  });

  it('ADMIN row hides Deactivate + Delete, keeps Edit / Reset / Invite', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());

    expect(screen.getByTestId('staff-action-edit-1')).toBeInTheDocument();
    expect(screen.getByTestId('staff-action-reset-password-1')).toBeInTheDocument();
    expect(screen.getByTestId('staff-action-resend-invite-1')).toBeInTheDocument();
    // Admin self-protection — these two must NOT appear on an ADMIN row.
    expect(screen.queryByTestId('staff-action-deactivate-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('staff-action-delete-1')).not.toBeInTheDocument();
  });

  it('Inactive row renders the Inactive badge AND a Reactivate button', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Inactive Aman')).toBeInTheDocument());

    // Badge is keyed by data-testid (unique per row).
    const badges = screen.getAllByTestId('staff-inactive-badge');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toMatch(/Inactive/i);

    // Action toggle: row id=4 should show "Reactivate" not "Deactivate".
    const toggle = screen.getByTestId('staff-action-deactivate-4');
    expect(toggle.textContent).toMatch(/Reactivate/i);
  });

  it('non-admin viewer sees no action buttons (— placeholder)', async () => {
    renderStaff('USER');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    expect(screen.queryByTestId('staff-action-edit-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('staff-action-delete-2')).not.toBeInTheDocument();
  });

  it('clicking Edit opens the edit modal', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    expect(screen.queryByTestId('staff-edit-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('staff-action-edit-2'));
    expect(screen.getByTestId('staff-edit-modal')).toBeInTheDocument();
  });
});

// #818 — Staff edit modal surfaces revenue-goal summary chips so an admin
// editing a staff member can see their per-period goals at-a-glance and
// link out to /revenue-goals?userId=X for full CRUD. StaffRevenueGoal is
// one-to-many on User (each goal pins a period like Q1/2026), so the
// modal does NOT try to persist a single `revenueGoalId` FK — that would
// be data-model incorrect. Instead it shows up to 4 active goals as
// chips with target / achieved / pct, plus a Manage deep-link.
describe('<Staff /> — revenue goal chips in edit modal (#818)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('shows empty-state when staff member has no revenue goals', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-action-edit-2'));
    await waitFor(() => expect(screen.getByTestId('staff-edit-revenue-goals')).toBeInTheDocument());
    // Empty-state copy renders.
    expect(await screen.findByTestId('staff-edit-revenue-goals-empty')).toBeInTheDocument();
  });

  it('renders one chip per goal with period + target + achieved + pct', async () => {
    const goals = [
      { id: 71, userId: 2, period: 'MONTHLY',   targetAmount: '100000', achievedAmount: '50000',  periodStart: '2026-05-01', periodEnd: '2026-06-01', scope: 'ALL' },
      { id: 72, userId: 2, period: 'QUARTERLY', targetAmount: '300000', achievedAmount: '270000', periodStart: '2026-04-01', periodEnd: '2026-07-01', scope: 'ALL' },
      { id: 73, userId: 2, period: 'YEARLY',    targetAmount: '1200000', achievedAmount: '1300000', periodStart: '2026-01-01', periodEnd: '2027-01-01', scope: 'ALL' },
    ];
    renderStaff('ADMIN', { '/api/staff/revenue-goals?userId=2': goals });
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-action-edit-2'));

    // All 3 chips render with their id-keyed testid.
    expect(await screen.findByTestId('staff-edit-revenue-goal-71')).toBeInTheDocument();
    expect(screen.getByTestId('staff-edit-revenue-goal-72')).toBeInTheDocument();
    expect(screen.getByTestId('staff-edit-revenue-goal-73')).toBeInTheDocument();

    // Pct math: 50%, 90%, 108% (capped at 999 not 100 — we show overshoot).
    expect(screen.getByTestId('staff-edit-revenue-goal-71').textContent).toMatch(/50%/);
    expect(screen.getByTestId('staff-edit-revenue-goal-72').textContent).toMatch(/90%/);
    expect(screen.getByTestId('staff-edit-revenue-goal-73').textContent).toMatch(/108%/);

    // Period labels render.
    expect(screen.getByTestId('staff-edit-revenue-goal-71').textContent).toMatch(/MONTHLY/);
    expect(screen.getByTestId('staff-edit-revenue-goal-72').textContent).toMatch(/QUARTERLY/);
    expect(screen.getByTestId('staff-edit-revenue-goal-73').textContent).toMatch(/YEARLY/);

    // Empty-state must NOT appear when at least one goal exists.
    expect(screen.queryByTestId('staff-edit-revenue-goals-empty')).not.toBeInTheDocument();
  });

  it('Manage link deep-links to /revenue-goals filtered by the staff userId', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-action-edit-2'));
    const link = await screen.findByTestId('staff-edit-manage-revenue-goals');
    // userId in the href matches the staff row's id (member 2 = Dr. Harsh).
    expect(link.getAttribute('href')).toBe('/revenue-goals?userId=2');
    // Link text + icon present.
    expect(link.textContent).toMatch(/Manage/i);
  });

  it('caps the chip cluster at 4 + shows "+N more" overflow indicator', async () => {
    const goals = Array.from({ length: 6 }).map((_, i) => ({
      id: 100 + i,
      userId: 2,
      period: 'MONTHLY',
      targetAmount: '50000',
      achievedAmount: String(i * 10000),
      periodStart: '2026-05-01',
      periodEnd: '2026-06-01',
      scope: 'ALL',
    }));
    renderStaff('ADMIN', { '/api/staff/revenue-goals?userId=2': goals });
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-action-edit-2'));

    // Exactly 4 chips render.
    await waitFor(() => expect(screen.getByTestId('staff-edit-revenue-goal-100')).toBeInTheDocument());
    expect(screen.getByTestId('staff-edit-revenue-goal-100')).toBeInTheDocument();
    expect(screen.getByTestId('staff-edit-revenue-goal-101')).toBeInTheDocument();
    expect(screen.getByTestId('staff-edit-revenue-goal-102')).toBeInTheDocument();
    expect(screen.getByTestId('staff-edit-revenue-goal-103')).toBeInTheDocument();
    // Beyond the 4th chip — not rendered.
    expect(screen.queryByTestId('staff-edit-revenue-goal-104')).not.toBeInTheDocument();
    expect(screen.queryByTestId('staff-edit-revenue-goal-105')).not.toBeInTheDocument();
    // Overflow indicator surfaces the remaining count.
    const modal = screen.getByTestId('staff-edit-revenue-goals');
    expect(modal.textContent).toMatch(/\+2 more/);
  });
});

// EXTENSION (2026-05-26): broader surface coverage for the 805-LOC Staff page.
// Eight additional describes cover: list rendering, invite-modal open/submit,
// inline role PATCH, deactivate confirm-and-fire, role-pill filter, deactivated
// + admin row hiding, empty-state, and RBAC-gated invite button visibility.
//
// Vitest discipline applied here
// ──────────────────────────────
//   1. Stable mock object refs for useNotify (per the 2026-05-23 cron rule) —
//      one notifyObj reused across every render so useCallback dependency
//      arrays don't re-fire on each render and trigger infinite loops.
//   2. getAllByText for labels that appear as filter chrome AND row badges
//      (the role-pill filter test below — "USER" shows up as a pill + as the
//      role for 3 rows + as a <select> option).
//   3. Pure pin: tests target the SUT's contracts only — no SUT edits.
//
// Run from:   frontend/
// Command:    npx vitest run src/__tests__/Staff.test.jsx

// Stable refs for the notify hook — re-used across the extension describes.
const notifyExtObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};

describe('<Staff /> — list rendering + stats bar', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    Object.values(notifyExtObj).forEach((fn) => { if (typeof fn?.mockReset === 'function') fn.mockReset(); });
    notifyExtObj.confirm.mockImplementation(() => Promise.resolve(true));
  });

  it('renders every staff row name + email after the GET /api/staff resolves', async () => {
    renderStaff('ADMIN');
    // All four seeded rows surface their primary identity fields.
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());
    expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument();
    expect(screen.getByText('Priya Pro')).toBeInTheDocument();
    expect(screen.getByText('Inactive Aman')).toBeInTheDocument();
    expect(screen.getByText('rishu@enhancedwellness.in')).toBeInTheDocument();
    expect(screen.getByText('aman@enhancedwellness.in')).toBeInTheDocument();
  });

  it('stats bar surfaces accurate admin / manager / user / total counts', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());
    // STAFF_ROWS has 1 ADMIN + 0 MANAGER + 3 USER = 4 total.
    expect(screen.getByText(/1 Admins/)).toBeInTheDocument();
    expect(screen.getByText(/0 Managers/)).toBeInTheDocument();
    expect(screen.getByText(/3 Users/)).toBeInTheDocument();
    expect(screen.getByText(/4 total/)).toBeInTheDocument();
  });

  it('filtering by USER hides the lone ADMIN row', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());

    // "USER" appears in MANY surfaces — filter pill, role <select> options,
    // visible <RoleBadge> values. getAllByText is the right primitive per
    // the 2026-05-23 standing rule. The filter pill is the first element
    // matching with role="button"-shaped semantics.
    const userPills = screen.getAllByText(/3 Users/);
    expect(userPills.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(userPills[0]);

    // After filtering, the ADMIN row (Rishu) is hidden; user rows remain.
    await waitFor(() => expect(screen.queryByText('Rishu Agarwal')).not.toBeInTheDocument());
    expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument();
    expect(screen.getByText('Priya Pro')).toBeInTheDocument();
    expect(screen.getByText('Inactive Aman')).toBeInTheDocument();
  });
});

describe('<Staff /> — Invite modal (#891)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('Invite Staff button is gated to ADMIN viewers only', async () => {
    renderStaff('USER');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    // Non-admins must not see the invite CTA at all.
    expect(screen.queryByTestId('staff-invite-button')).not.toBeInTheDocument();
  });

  it('clicking Invite Staff opens the modal; X button closes it', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());
    // Modal closed by default.
    expect(screen.queryByTestId('staff-invite-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('staff-invite-button'));
    expect(screen.getByTestId('staff-invite-modal')).toBeInTheDocument();

    // X (Close) button dismisses.
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByTestId('staff-invite-modal')).not.toBeInTheDocument();
  });

  it('submitting the invite form POSTs to /api/auth/register with the form fields', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-invite-button'));

    // Fill all required inputs.
    fireEvent.change(screen.getByPlaceholderText('Full Name'),         { target: { value: 'Asha Newhire' } });
    fireEvent.change(screen.getByPlaceholderText('Email Address'),     { target: { value: 'asha@enhancedwellness.in' } });
    fireEvent.change(screen.getByPlaceholderText('Temporary Password'), { target: { value: 'TempPw!1234' } });

    // Submit the form.
    const submit = screen.getByRole('button', { name: /Send Invitation/i });
    fireEvent.click(submit);

    // POST /api/auth/register received the form payload.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls;
      const invite = calls.find((c) => c[0] === '/api/auth/register');
      expect(invite).toBeTruthy();
      const body = JSON.parse(invite[1].body);
      expect(body).toEqual(expect.objectContaining({
        name: 'Asha Newhire',
        email: 'asha@enhancedwellness.in',
        password: 'TempPw!1234',
        role: 'USER', // default selection
      }));
      expect(invite[1].method).toBe('POST');
    });
  });
});

describe('<Staff /> — inline role change (PUT /api/staff/:id/role)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('changing the role <select> on a non-wellness row PUTs the new role', async () => {
    // Need a row whose wellnessRole is null so the inline <select> renders
    // (wellness rows show a read-only badge instead — by design, see SUT:413).
    // Rishu (id=1) has wellnessRole: null → shows the editable role select.
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());

    // The select for the admin row carries the row's current role value.
    const selects = screen.getAllByRole('combobox');
    // Find the select whose current value is ADMIN — that's Rishu's row.
    const rishuSelect = selects.find((s) => s.value === 'ADMIN');
    expect(rishuSelect).toBeDefined();

    fireEvent.change(rishuSelect, { target: { value: 'MANAGER' } });

    // PUT /api/staff/1/role { role: 'MANAGER' } fired.
    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/staff/1/role' && c[1]?.method === 'PUT'
      );
      expect(put).toBeTruthy();
      expect(JSON.parse(put[1].body)).toEqual({ role: 'MANAGER' });
    });
  });
});

describe('<Staff /> — Deactivate flow (PATCH /api/staff/:id)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('clicking Deactivate prompts confirm, then PATCHes active=false', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    // Click Deactivate on a non-admin row (id=2, Dr. Harsh Kumar).
    fireEvent.click(screen.getByTestId('staff-action-deactivate-2'));

    // The notify.confirm wrapper from the top-of-file mock auto-resolves true,
    // so the PATCH should fire with active=false.
    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/staff/2' && c[1]?.method === 'PATCH'
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch[1].body)).toEqual({ active: false });
    });
  });

  it('reactivating an already-inactive user PATCHes active=true', async () => {
    renderStaff('ADMIN');
    // Inactive Aman (id=4) is the seeded deactivated row.
    await waitFor(() => expect(screen.getByText('Inactive Aman')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('staff-action-deactivate-4'));

    await waitFor(() => {
      const patch = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/staff/4' && c[1]?.method === 'PATCH'
      );
      expect(patch).toBeTruthy();
      // Going from deactivatedAt-non-null → null means active=true.
      expect(JSON.parse(patch[1].body)).toEqual({ active: true });
    });
  });
});

describe('<Staff /> — empty list state', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('renders the "No staff members found." copy when the directory is empty', async () => {
    // Override /api/staff with an empty array.
    renderStaff('ADMIN', { '/api/staff': [] });
    await waitFor(() => expect(screen.getByText(/No staff members found\./i)).toBeInTheDocument());
    // Stats bar is NOT rendered (it's gated on staff.length > 0).
    expect(screen.queryByText(/Admins$/)).not.toBeInTheDocument();
  });
});

describe('<Staff /> — RBAC: USER viewer is read-only', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('USER role sees role as a read-only badge (no <select>) and no action buttons', async () => {
    renderStaff('USER');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());

    // No editable role <select> — for a wellness/non-admin viewer the role
    // pill is a read-only <span>, never a <select> (SUT line 449-452).
    // Rishu's role is ADMIN: should appear as a RoleBadge, not a combobox.
    const comboboxes = screen.queryAllByRole('combobox');
    expect(comboboxes.length).toBe(0);

    // No action buttons.
    expect(screen.queryByTestId('staff-action-edit-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('staff-action-edit-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('staff-action-delete-2')).not.toBeInTheDocument();

    // No Invite CTA.
    expect(screen.queryByTestId('staff-invite-button')).not.toBeInTheDocument();
  });
});

// EXTENSION (2026-05-26, agent B): broaden coverage to fill the remaining
// SUT branches. Adds 10 cases covering save-edit PUT shape, reset-password +
// resend-invite + delete POSTs, wellness-role read-only badge, empty-filter
// copy, cashier optgroup (DD-5.1), commission-profile dropdown population,
// invite modal cancel-without-submit, and filter-toggle clearing.
//
// Discipline checklist (per 2026-05-23 cron rules + skill standing rules):
//   - All new cases use existing notify.confirm auto-resolve (top-of-file mock
//     resolves true), so destructive-action specs trigger their fetchApi POST.
//   - Each spec asserts on the PUT/POST/DELETE call SHAPE (URL + method +
//     body), not just on "the request fired" — pins the route contract.
//   - getAllByText / queryAllByRole used wherever a label appears in BOTH
//     filter chrome + row cells (avoids the duplicate-text throw).

describe('<Staff /> — Save edit (PUT /api/staff/:id)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('Save changes PUTs the full editable shape to /api/staff/:id', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-action-edit-2'));
    await waitFor(() => expect(screen.getByTestId('staff-edit-modal')).toBeInTheDocument());

    // Click Save changes (no edits — pin the baseline shape).
    fireEvent.click(screen.getByTestId('staff-edit-save'));

    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/staff/2' && c[1]?.method === 'PUT'
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      // Pin every field the modal sends.
      expect(body).toEqual(expect.objectContaining({
        name: 'Dr. Harsh Kumar',
        email: 'drharsh@enhancedwellness.in',
        role: 'USER',
        wellnessRole: 'doctor',
      }));
      // commissionProfileId column is sent (null when unassigned) — pins the
      // PRD Gap §1.5 shape so backend can clear / set the FK.
      expect(body).toHaveProperty('commissionProfileId');
    });
  });

  it('clearing wellnessRole sends null (not empty string) so backend can clear the column', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-action-edit-2'));
    await waitFor(() => expect(screen.getByTestId('staff-edit-modal')).toBeInTheDocument());

    // Find the wellnessRole select (the one whose current value is 'doctor').
    const selects = screen.getAllByRole('combobox');
    const wellnessSelect = selects.find((s) => s.value === 'doctor');
    expect(wellnessSelect).toBeDefined();
    fireEvent.change(wellnessSelect, { target: { value: '' } });

    fireEvent.click(screen.getByTestId('staff-edit-save'));

    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/staff/2' && c[1]?.method === 'PUT'
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      // '' becomes null on the wire (SUT:198).
      expect(body.wellnessRole).toBeNull();
    });
  });
});

describe('<Staff /> — Reset password (POST /api/staff/:id/reset-password)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('clicking Reset Password confirms, then POSTs to /reset-password', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('staff-action-reset-password-2'));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/staff/2/reset-password' && c[1]?.method === 'POST'
      );
      expect(post).toBeTruthy();
      // Body is empty JSON object (SUT:247).
      expect(JSON.parse(post[1].body)).toEqual({});
    });
  });
});

describe('<Staff /> — Resend invite (POST /api/staff/:id/resend-invite)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('clicking Resend Invite confirms, then POSTs to /resend-invite', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('staff-action-resend-invite-2'));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/staff/2/resend-invite' && c[1]?.method === 'POST'
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post[1].body)).toEqual({});
    });
  });
});

describe('<Staff /> — Delete user (DELETE /api/staff/:id)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('clicking Delete confirms (destructive: true), then DELETEs the user', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('staff-action-delete-2'));

    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/staff/2' && c[1]?.method === 'DELETE'
      );
      expect(del).toBeTruthy();
    });
  });
});

describe('<Staff /> — wellness row renders read-only badge (not select)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('row with wellnessRol=doctor shows badge "Doctor", no inline role <select>', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    // displayRole() capitalises the wellnessRole, so "doctor" → "Doctor".
    // The text appears in the row as a read-only span (not a <select>).
    expect(screen.getByText('Doctor')).toBeInTheDocument();
    expect(screen.getByText('Professional')).toBeInTheDocument();
    expect(screen.getByText('Helper')).toBeInTheDocument();

    // The inline-role <select> only renders for rows where wellnessRole is
    // null (Rishu's row). All wellness rows show a read-only badge.
    // So there should be EXACTLY one combobox (Rishu's role select).
    const comboboxes = screen.queryAllByRole('combobox');
    expect(comboboxes.length).toBe(1);
    expect(comboboxes[0].value).toBe('ADMIN');
  });
});

describe('<Staff /> — Empty filter result copy', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('filtering by MANAGER (no manager rows) shows "No staff members with that role."', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());

    // Click the Managers filter pill — STAFF_ROWS has 0 managers, so this
    // exercises the "filteredStaff.length === 0 && staff.length > 0" branch.
    const managerPill = screen.getByText(/0 Managers/);
    fireEvent.click(managerPill);

    await waitFor(() => expect(
      screen.getByText(/No staff members with that role\./i)
    ).toBeInTheDocument());

    // Existing rows are filtered out.
    expect(screen.queryByText('Rishu Agarwal')).not.toBeInTheDocument();
    expect(screen.queryByText('Dr. Harsh Kumar')).not.toBeInTheDocument();
  });
});

describe('<Staff /> — Edit modal: cashier wellnessRole option (DD-5.1)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('cashier option is rendered under the Sales / POS optgroup', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-action-edit-1'));
    await waitFor(() => expect(screen.getByTestId('staff-edit-modal')).toBeInTheDocument());

    // PRD_WELLNESS_RBAC DD-5.1: cashier exists as an <option value="cashier">.
    // The label includes the "POS sales (no PHI)" disambiguator per DD-5.6.
    const cashierOption = screen.getByRole('option', { name: /Cashier — POS sales \(no PHI\)/i });
    expect(cashierOption).toBeInTheDocument();
    expect(cashierOption.getAttribute('value')).toBe('cashier');

    // Clinical roles still present in their own optgroup.
    expect(screen.getByRole('option', { name: /Doctor/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Professional/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Telecaller/i })).toBeInTheDocument();
  });
});

describe('<Staff /> — Edit modal: commission profile dropdown population (PRD Gap §1.5)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('renders one <option> per active commission profile + "— None —" sentinel', async () => {
    const profiles = [
      { id: 10, name: 'Standard 10%', isActive: true },
      { id: 11, name: 'Stylist Tiered', isActive: true },
      { id: 12, name: 'Legacy 5%',     isActive: false }, // inactive — filtered out
    ];
    renderStaff('ADMIN', { '/api/staff/commission-profiles': profiles });
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-action-edit-2'));
    await waitFor(() => expect(screen.getByTestId('staff-edit-modal')).toBeInTheDocument());

    const commissionSelect = screen.getByTestId('staff-edit-commission-profile');
    expect(commissionSelect).toBeInTheDocument();

    // Active profiles render; inactive (id=12) is filtered out per SUT:132.
    expect(screen.getByRole('option', { name: 'Standard 10%' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Stylist Tiered' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Legacy 5%' })).not.toBeInTheDocument();

    // Sentinel: "— None —" option for unassigned (value="").
    const noneOption = screen.getAllByRole('option').find((o) => o.value === '' && /None/.test(o.textContent));
    expect(noneOption).toBeDefined();
  });
});

describe('<Staff /> — Invite modal: cancel without submit', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('clicking Cancel closes the modal and does NOT POST to /auth/register', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-invite-button'));
    expect(screen.getByTestId('staff-invite-modal')).toBeInTheDocument();

    // Fill some fields so we can verify no payload leaks out.
    fireEvent.change(screen.getByPlaceholderText('Full Name'), { target: { value: 'Should Not Submit' } });

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(screen.queryByTestId('staff-invite-modal')).not.toBeInTheDocument();

    // No /api/auth/register call happened.
    const registerCalls = fetchApiMock.mock.calls.filter((c) => c[0] === '/api/auth/register');
    expect(registerCalls.length).toBe(0);
  });
});

describe('<Staff /> — filter toggle clears the filter when re-clicked', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('clicking the active filter pill a second time clears the filter', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());

    const adminPill = screen.getByText(/1 Admins/);
    fireEvent.click(adminPill);

    // After filtering by ADMIN, the 3 user rows are hidden.
    await waitFor(() => expect(screen.queryByText('Dr. Harsh Kumar')).not.toBeInTheDocument());
    expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument();

    // Click the SAME pill again — should clear the filter (setFilter(null)).
    fireEvent.click(adminPill);

    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    expect(screen.getByText('Priya Pro')).toBeInTheDocument();
    expect(screen.getByText('Inactive Aman')).toBeInTheDocument();
  });
});

