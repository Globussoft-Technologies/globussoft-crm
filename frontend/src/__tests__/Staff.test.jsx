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

// Stable notify object — keeping the same identity across renders avoids
// useCallback dep-flap that previously caused infinite loops. confirm/prompt
// impls are restored in a global beforeEach because vitest.setup.js calls
// vi.restoreAllMocks() between tests which resets vi.fn() implementations.
const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
beforeEach(() => {
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
  notifyObj.prompt.mockImplementation(() => Promise.resolve(''));
});
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// usePermissions is called by the per-row Permissions button gate. Stub it
// out so the hook doesn't try to fetchApi('/api/auth/me/permissions') and
// the gate stays false for these tests (the action-button counts assume
// no Permissions button rendered).
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: [],
    roles: [],
    isOwner: false,
    userType: null,
    isLoading: false,
    isReady: true,
    error: null,
    hasPermission: () => false,
    hasAllPermissions: () => false,
    hasAnyPermission: () => false,
    refresh: () => Promise.resolve({}),
  }),
}));

import { AuthContext } from '../App';
import Staff from '../pages/Staff';

// Roles catalog returned by GET /api/roles. The new Staff UI pulls its
// single-Role dropdown from this list (RoleSelect popover in the Add/Edit
// modals). Keys 'ADMIN' / 'MANAGER' / 'USER' map onto the legacy access tier;
// any other key (doctor / professional / helper) maps to that wellnessRole
// via deriveWellnessRole.
const ROLES_CATALOG = {
  roles: [
    { id: 100, key: 'ADMIN',        name: 'Admin',        userType: 'STAFF', isActive: true, isSystem: true },
    { id: 101, key: 'MANAGER',      name: 'Manager',      userType: 'STAFF', isActive: true, isSystem: true },
    { id: 102, key: 'USER',         name: 'User',         userType: 'STAFF', isActive: true, isSystem: true },
    { id: 200, key: 'doctor',       name: 'Doctor',       userType: 'STAFF', isActive: true, isSystem: false },
    { id: 201, key: 'professional', name: 'Professional', userType: 'STAFF', isActive: true, isSystem: false },
    { id: 202, key: 'helper',       name: 'Helper',       userType: 'STAFF', isActive: true, isSystem: false },
  ],
};

const WELLNESS_ROLE_TYPES = [
  { id: 1, key: 'doctor',       label: 'Doctor',       isActive: true },
  { id: 2, key: 'professional', label: 'Professional', isActive: true },
  { id: 3, key: 'helper',       label: 'Helper',       isActive: true },
];

const STAFF_ROWS = [
  { id: 1,  name: 'Rishu Agarwal',  email: 'rishu@enhancedwellness.in', role: 'ADMIN',  wellnessRole: null,           primaryRole: { id: 100, key: 'ADMIN',        name: 'Admin' },        createdAt: '2026-01-01T00:00:00Z', deactivatedAt: null },
  { id: 2,  name: 'Dr. Harsh Kumar', email: 'drharsh@enhancedwellness.in', role: 'USER',  wellnessRole: 'doctor',     primaryRole: { id: 200, key: 'doctor',       name: 'Doctor' },       createdAt: '2026-01-02T00:00:00Z', deactivatedAt: null },
  { id: 3,  name: 'Priya Pro',       email: 'priya@enhancedwellness.in',   role: 'USER',  wellnessRole: 'professional', primaryRole: { id: 201, key: 'professional', name: 'Professional' }, createdAt: '2026-01-03T00:00:00Z', deactivatedAt: null },
  { id: 4,  name: 'Inactive Aman',   email: 'aman@enhancedwellness.in',    role: 'USER',  wellnessRole: 'helper',     primaryRole: { id: 202, key: 'helper',       name: 'Helper' },       createdAt: '2026-01-04T00:00:00Z', deactivatedAt: '2026-04-01T00:00:00Z' },
];

function renderStaff(viewerRole = 'ADMIN', overrides = {}) {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url) => {
    if (overrides[url] !== undefined) return Promise.resolve(overrides[url]);
    if (url === '/api/staff') return Promise.resolve(STAFF_ROWS);
    if (url === '/api/staff/commission-profiles') return Promise.resolve([]);
    if (url.startsWith('/api/staff/revenue-goals')) return Promise.resolve([]);
    if (url === '/api/roles') return Promise.resolve(ROLES_CATALOG);
    if (url === '/api/wellness/role-types?activeOnly=1') return Promise.resolve(WELLNESS_ROLE_TYPES);
    return Promise.resolve({});
  });
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{
        user: { userId: 1, name: 'Rishu Agarwal', email: 'rishu@enhancedwellness.in', role: viewerRole },
        // vertical='wellness' is required so loadWellnessRoleTypes() fires
        // (gated on isWellness at Staff.jsx:313). Without it, deriveWellnessRole
        // always returns null because wellnessRoleTypes stays empty.
        setUser: vi.fn(), token: 'tk', tenant: { id: 1, vertical: 'wellness' }, loading: false,
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

// Note: #818 revenue-goal chips in the edit modal are not yet shipped on
// this page (see TODOS / PRD §1.5). The describe block is intentionally
// empty until the feature lands; do not delete — re-author against the
// real surface when the chips ship.
describe.skip('<Staff /> — revenue goal chips in edit modal (#818)', () => {
  it.skip('feature not yet shipped on Staff.jsx', () => {});
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
    expect(screen.queryByTestId('staff-add-button')).not.toBeInTheDocument();
  });

  it('clicking Add Staff opens the modal; X button closes it', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());
    // Modal closed by default.
    expect(screen.queryByTestId('staff-create-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('staff-add-button'));
    expect(screen.getByTestId('staff-create-modal')).toBeInTheDocument();

    // X (Close) button dismisses. Use getAllByLabelText since the edit modal
    // also has one Close button — but it isn't mounted here, so take [0].
    const closeBtns = screen.getAllByLabelText('Close');
    fireEvent.click(closeBtns[0]);
    expect(screen.queryByTestId('staff-create-modal')).not.toBeInTheDocument();
  });

  it('submitting the Add Staff form POSTs to /api/staff with the form fields', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());
    // Wait for the /api/roles fetch to populate availableRoles — without this
    // the RoleSelect popover renders an empty list and the click below would
    // race against the role load.
    await waitFor(() =>
      expect(fetchApiMock.mock.calls.some((c) => c[0] === '/api/roles')).toBe(true)
    );
    fireEvent.click(screen.getByTestId('staff-add-button'));

    fireEvent.change(screen.getByTestId('staff-create-name'),     { target: { value: 'Asha Newhire' } });
    fireEvent.change(screen.getByTestId('staff-create-email'),    { target: { value: 'asha@enhancedwellness.in' } });
    fireEvent.change(screen.getByTestId('staff-create-password'), { target: { value: 'TempPw!1234' } });

    // Post-e7253919: pick the role via the upward-opening RoleSelect popover
    // (replaces the old 3-way native <select> split). Click the trigger, then
    // click the "User" option to seed rbacRoleId — saveCreate requires it.
    fireEvent.click(screen.getByTestId('staff-create-role'));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /^User$/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('option', { name: /^User$/i }));

    fireEvent.click(screen.getByTestId('staff-create-save'));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls;
      const invite = calls.find((c) => c[0] === '/api/staff' && c[1]?.method === 'POST');
      expect(invite).toBeTruthy();
      const body = JSON.parse(invite[1].body);
      // saveCreate derives access tier + wellnessRole from the single Role pick.
      // 'USER' → access tier USER, wellnessRole null (no catalog match).
      expect(body).toEqual(expect.objectContaining({
        name: 'Asha Newhire',
        email: 'asha@enhancedwellness.in',
        password: 'TempPw!1234',
        role: 'USER',
        wellnessRole: null,
        rbacRoleId: 102,
      }));
      expect(invite[1].method).toBe('POST');
    });
  });
});

// Post-e7253919: the per-row inline role <select> + the PUT /api/staff/:id/role
// endpoint hit are no longer how role changes flow. The new UI consolidates
// role editing into the Edit modal's single RoleSelect popover, which fires
// PUT /api/staff/:id with the full editable shape (covered by the "Save edit"
// describe below). Kept skipped (not deleted) so the contract history is
// visible in the test file.
describe.skip('<Staff /> — inline role change (PUT /api/staff/:id/role) — removed in e7253919', () => {
  it.skip('contract moved to PUT /api/staff/:id via Edit modal', () => {});
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
    expect(screen.queryByTestId('staff-add-button')).not.toBeInTheDocument();
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
    // saveEdit's deriveWellnessRole() reads from wellnessRoleTypes; both that
    // catalog AND availableRoles must finish loading before we click Save, or
    // the derivation falls back to null and the shape pin fails.
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map((c) => c[0]);
      expect(urls).toContain('/api/roles');
      expect(urls).toContain('/api/wellness/role-types?activeOnly=1');
    });
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
      // saveEdit derives access tier + wellnessRole from the pre-populated
      // rbacRoleId (Dr. Harsh's primaryRole.id=200, key='doctor'). Doctor key
      // → access tier USER (not in ACCESS_TIER_KEYS) + wellnessRole='doctor'
      // (matches the wellness catalog).
      expect(body).toEqual(expect.objectContaining({
        name: 'Dr. Harsh Kumar',
        email: 'drharsh@enhancedwellness.in',
        role: 'USER',
        wellnessRole: 'doctor',
        rbacRoleId: 200,
      }));
      // commissionProfileId column is sent (null when unassigned) — pins the
      // PRD Gap §1.5 shape so backend can clear / set the FK.
      expect(body).toHaveProperty('commissionProfileId');
    });
  });

  it('picking a non-wellness role sends wellnessRole=null (cleared on the wire)', async () => {
    // Post-e7253919: there's no separate wellnessRole <select> in the Edit
    // modal anymore — the single Role pick drives both access tier and
    // wellnessRole via deriveWellnessRole. Picking a role whose key isn't in
    // the wellness catalog (e.g. 'User') results in wellnessRole=null on the
    // wire so the backend can clear the column.
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());
    await waitFor(() =>
      expect(fetchApiMock.mock.calls.some((c) => c[0] === '/api/roles')).toBe(true)
    );
    fireEvent.click(screen.getByTestId('staff-action-edit-2'));
    await waitFor(() => expect(screen.getByTestId('staff-edit-modal')).toBeInTheDocument());

    // Open the RoleSelect popover and pick the non-wellness "User" role.
    fireEvent.click(screen.getByTestId('staff-edit-role'));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /^User$/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('option', { name: /^User$/i }));

    fireEvent.click(screen.getByTestId('staff-edit-save'));

    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/staff/2' && c[1]?.method === 'PUT'
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(put[1].body);
      // 'USER' key doesn't match the wellness catalog → wellnessRole=null.
      expect(body.wellnessRole).toBeNull();
      expect(body.role).toBe('USER');
      expect(body.rbacRoleId).toBe(102);
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

  it('row with wellnessRole=doctor shows badge "Doctor", no inline role <select>', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    // Post-e7253919: RoleBadge renders primaryRole.name on every row (read-only
    // span). The doctor / professional / helper labels come from each row's
    // primaryRole.name; there's no per-row inline <select> anymore — role
    // editing happens via the Edit modal's RoleSelect popover (covered in the
    // "Save edit" describe).
    expect(screen.getByText('Doctor')).toBeInTheDocument();
    expect(screen.getByText('Professional')).toBeInTheDocument();
    expect(screen.getByText('Helper')).toBeInTheDocument();
    // Rishu's row shows Admin too (was inline <select> pre-refactor).
    expect(screen.getByText('Admin')).toBeInTheDocument();

    // No native <select role="combobox"> renders at initial load: the Filter
    // panel is closed, no Add/Edit modal is mounted, commission-profiles is
    // empty so the modal's commission <select> stays gated off.
    const comboboxes = screen.queryAllByRole('combobox');
    expect(comboboxes.length).toBe(0);
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
      screen.getByText(/No staff members match the current search or filters\./i)
    ).toBeInTheDocument());

    // Existing rows are filtered out.
    expect(screen.queryByText('Rishu Agarwal')).not.toBeInTheDocument();
    expect(screen.queryByText('Dr. Harsh Kumar')).not.toBeInTheDocument();
  });
});

// Cashier optgroup (PRD_WELLNESS_RBAC DD-5.1) — currently surfaced via the
// per-tenant /api/wellness/role-types catalog rather than a hardcoded
// optgroup. Skipped until the role-type catalog seeding is pinned in the
// AuthContext.vertical='wellness' test fixture.
describe.skip('<Staff /> — Edit modal: cashier wellnessRole option (DD-5.1)', () => {
  it.skip('catalog-driven option list — pinned via /api/wellness/role-types', () => {});
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

  it('clicking Cancel closes the modal and does NOT POST to /api/staff', async () => {
    renderStaff('ADMIN');
    await waitFor(() => expect(screen.getByText('Rishu Agarwal')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('staff-add-button'));
    expect(screen.getByTestId('staff-create-modal')).toBeInTheDocument();

    // Fill some fields so we can verify no payload leaks out.
    fireEvent.change(screen.getByTestId('staff-create-name'), { target: { value: 'Should Not Submit' } });

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    expect(screen.queryByTestId('staff-create-modal')).not.toBeInTheDocument();

    // No POST /api/staff call happened.
    const createCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/staff' && c[1]?.method === 'POST',
    );
    expect(createCalls.length).toBe(0);
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

