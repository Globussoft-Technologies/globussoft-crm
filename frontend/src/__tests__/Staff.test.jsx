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
