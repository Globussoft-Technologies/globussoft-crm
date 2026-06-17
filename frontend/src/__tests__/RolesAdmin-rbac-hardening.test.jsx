/**
 * RolesAdmin-rbac-hardening.test.jsx — Phase 3 + Phase 5 + Phase 7
 * regression tests for the lockout-prevention and version-history UI.
 *
 * Pins (mapped to the spec's named scenarios):
 *   Scenario 1 — single admin attempt to strip critical perms returns
 *                409; UI shows the lockout-error banner with
 *                "View role history" recovery link.
 *   Scenario 3 — clicking Restore on a previous version POSTs the
 *                restore endpoint with versionId; success toast
 *                mentions the new version number.
 *   Scenario 4 — when admin's save would remove a critical permission,
 *                the warning modal appears with the affected
 *                Roles & Permissions surface listed and a Continue
 *                button that chains into persistSave.
 *
 * The page-level hookup (history modal opens, restore handler closes
 * matrix on success) is pinned via the data-testid attributes added
 * to the components.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

const permissionsMock = {
  hasPermission: (m, a) => m === 'roles' && (a === 'read' || a === 'manage'),
  isLoading: false,
  isReady: true,
  refresh: vi.fn(() => Promise.resolve()),
  permissions: ['roles.read', 'roles.manage'],
  roles: [],
  isOwner: false,
  userType: 'STAFF',
  hasAllPermissions: () => true,
  hasAnyPermission: () => true,
};
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => permissionsMock,
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('../hooks/useScrollLock', () => ({
  useScrollLock: () => {},
}));

import { AuthContext } from '../App';
import RolesAdmin from '../pages/RolesAdmin';

const CATALOG = {
  catalog: {
    contacts: ['read', 'write'],
    roles: ['read', 'manage'],
    staff: ['read', 'manage'],
    // `developer.manage` is in SENSITIVE_PERMISSIONS_CLIENT but is
    // NOT in CRITICAL_RBAC_KEYS — used by the "derived from metadata"
    // test below to prove badge rendering doesn't hardcode a
    // staff/roles allow-list. If a future change removes developer
    // from SENSITIVE_PERMISSIONS_CLIENT, that test will surface it
    // before the badge silently disappears.
    developer: ['read', 'manage'],
  },
  modules: [
    { module: 'contacts', actions: ['read', 'write'] },
    { module: 'roles', actions: ['read', 'manage'] },
    { module: 'staff', actions: ['read', 'manage'] },
    { module: 'developer', actions: ['read', 'manage'] },
  ],
  domains: [
    { domain: 'CRM Core', modules: [{ module: 'contacts', actions: ['read', 'write'] }] },
    {
      domain: 'Admin & Platform',
      modules: [
        { module: 'roles', actions: ['read', 'manage'] },
        { module: 'staff', actions: ['read', 'manage'] },
        { module: 'developer', actions: ['read', 'manage'] },
      ],
    },
  ],
  vertical: 'travel',
};

// Role currently holds BOTH critical perms — used to test the
// removal-warning path.
const ADMIN_ROLE = {
  id: 193,
  key: 'ADMIN',
  name: 'Administrator',
  description: 'Tenant admin',
  isSystem: true,
  isActive: true,
  userType: 'STAFF',
  landingPath: null,
  userCount: 1,
  permissionCount: 4,
  visiblePermissionCount: 4,
  hiddenPermissionCount: 0,
  permissions: [
    { module: 'contacts', action: 'read' },
    { module: 'roles', action: 'read' },
    { module: 'roles', action: 'manage' },
    { module: 'staff', action: 'manage' },
  ],
};

function renderPage(roles = [ADMIN_ROLE]) {
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/roles' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ roles, tenantId: 11 });
    }
    if (url === '/api/roles/catalog') return Promise.resolve(CATALOG);
    if (url === '/api/pages/catalog') return Promise.resolve({ catalog: [] });
    return Promise.resolve({});
  });
  return render(
    <AuthContext.Provider
      value={{
        user: { id: 1, role: 'ADMIN', userType: 'STAFF', email: 'admin@x' },
        tenant: { vertical: 'travel' },
        token: 'tok',
        loading: false,
      }}
    >
      <MemoryRouter>
        <RolesAdmin />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
});

// ─────────── Phase 3 — Critical permission warning ───────────

describe('Phase 3 — critical permission removal warning', () => {
  it('shows the warning when admin would uncheck roles.manage', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Administrator/i }));
    await screen.findByText(/Permissions: Administrator/i);

    // Uncheck roles.manage by clicking its checkbox label
    const rolesManageCheckbox = (await screen.findAllByRole('checkbox')).find((cb) => {
      const label = cb.closest('label');
      return label && label.textContent && label.textContent.includes('manage') && cb.parentElement.parentElement.textContent.includes('roles');
    });
    // Fallback: find by label text "manage" under the roles card
    if (rolesManageCheckbox) {
      fireEvent.click(rolesManageCheckbox);
    } else {
      // Find any checkbox in the roles module's row and toggle the second action ("manage")
      const allCheckboxes = await screen.findAllByRole('checkbox');
      // The matrix renders contacts (2), roles (2), staff (2) in domain order;
      // roles.manage is the 4th checkbox.
      fireEvent.click(allCheckboxes[3]);
    }

    fireEvent.click(await screen.findByRole('button', { name: /Save permissions/i }));

    // Critical warning surfaces
    const modal = await screen.findByTestId('critical-perms-confirm-modal');
    expect(modal).toBeTruthy();
    expect(modal.textContent).toMatch(/Roles & Permissions/i);
    expect(modal.textContent).toMatch(/roles\.manage/);
  });

  it('does NOT show the warning when no critical perm is unchecked', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Administrator/i }));
    await screen.findByText(/Permissions: Administrator/i);

    // Toggle contacts.write only (non-critical)
    const allCheckboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(allCheckboxes[1]); // contacts.write
    fireEvent.click(await screen.findByRole('button', { name: /Save permissions/i }));

    // The critical warning should NOT appear; the PUT goes straight
    // through (fetchApi mock returns {} which becomes success).
    await waitFor(() => {
      expect(screen.queryByTestId('critical-perms-confirm-modal')).toBeNull();
    });
  });

  it('Continue button on the warning fires the PUT', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/roles' && (!opts || !opts.method)) {
        return Promise.resolve({ roles: [ADMIN_ROLE], tenantId: 11 });
      }
      if (url === '/api/roles/catalog') return Promise.resolve(CATALOG);
      if (url === '/api/pages/catalog') return Promise.resolve({ catalog: [] });
      if (url === `/api/roles/${ADMIN_ROLE.id}/permissions` && opts?.method === 'PUT') {
        return Promise.resolve({
          roleId: ADMIN_ROLE.id,
          permissions: [],
          newVersion: { id: 99, versionNumber: 3, changeType: 'UPDATE' },
        });
      }
      return Promise.resolve({});
    });
    render(
      <AuthContext.Provider
        value={{ user: { id: 1, role: 'ADMIN', userType: 'STAFF', email: 'admin@x' }, tenant: { vertical: 'travel' }, token: 'tok', loading: false }}
      >
        <MemoryRouter><RolesAdmin /></MemoryRouter>
      </AuthContext.Provider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Administrator/i }));
    await screen.findByText(/Permissions: Administrator/i);

    // Uncheck roles.manage (the 4th checkbox per our catalog order)
    const allCheckboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(allCheckboxes[3]);

    fireEvent.click(await screen.findByRole('button', { name: /Save permissions/i }));
    const continueBtn = await screen.findByTestId('critical-perms-continue');
    fireEvent.click(continueBtn);

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === `/api/roles/${ADMIN_ROLE.id}/permissions` && opts?.method === 'PUT',
      );
      expect(puts.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─────────── Scenario 1 — lockout error banner ───────────

describe('Scenario 1 — 409 LOCKOUT_PREVENTED surfaces the error banner with recovery link', () => {
  it('renders the lockout banner when PUT returns 409 with the spec body', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/roles' && (!opts || !opts.method)) {
        return Promise.resolve({ roles: [ADMIN_ROLE], tenantId: 11 });
      }
      if (url === '/api/roles/catalog') return Promise.resolve(CATALOG);
      if (url === '/api/pages/catalog') return Promise.resolve({ catalog: [] });
      if (url === `/api/roles/${ADMIN_ROLE.id}/permissions` && opts?.method === 'PUT') {
        const err = new Error('This change would remove RBAC administration access from all active users.');
        err.status = 409;
        err.body = {
          error: 'This change would remove RBAC administration access from all active users.',
          code: 'LOCKOUT_PREVENTED',
          criticalPermissions: ['roles.read', 'roles.manage'],
          qualifyingUserCount: 0,
          qualifyingUserIds: [],
        };
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });
    render(
      <AuthContext.Provider value={{ user: { id: 1, role: 'ADMIN', userType: 'STAFF', email: 'admin@x' }, tenant: { vertical: 'travel' }, token: 'tok', loading: false }}>
        <MemoryRouter><RolesAdmin /></MemoryRouter>
      </AuthContext.Provider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Administrator/i }));
    await screen.findByText(/Permissions: Administrator/i);
    // Uncheck BOTH critical perms (roles.read at index 2, roles.manage at index 3)
    const allCheckboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(allCheckboxes[2]);
    fireEvent.click(allCheckboxes[3]);
    fireEvent.click(await screen.findByRole('button', { name: /Save permissions/i }));
    // Past the critical-warning modal
    fireEvent.click(await screen.findByTestId('critical-perms-continue'));

    // Wait for the lockout banner
    const banner = await screen.findByTestId('lockout-error-banner');
    expect(banner.textContent).toMatch(/Save rejected/i);
    expect(banner.textContent).toMatch(/lockout/i);
    expect(banner.textContent).toMatch(/0 active user/i);
    // Recovery link present
    const historyBtn = within(banner).getByRole('button', { name: /View role history/i });
    expect(historyBtn).toBeTruthy();
  });
});

// ─────────── Scenario 3 — Restore previous version ───────────

describe('Scenario 3 — restore previous version', () => {
  it('clicking Restore on a non-current version POSTs /restore with versionId', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/roles' && (!opts || !opts.method)) {
        return Promise.resolve({ roles: [ADMIN_ROLE], tenantId: 11 });
      }
      if (url === '/api/roles/catalog') return Promise.resolve(CATALOG);
      if (url === '/api/pages/catalog') return Promise.resolve({ catalog: [] });
      if (url === `/api/roles/${ADMIN_ROLE.id}/permissions/versions`) {
        return Promise.resolve({
          roleId: ADMIN_ROLE.id,
          versions: [
            {
              id: 102,
              roleId: ADMIN_ROLE.id,
              versionNumber: 2,
              permissionCount: 4,
              changeType: 'UPDATE',
              changedAt: '2026-06-16T12:00:00Z',
              note: null,
              changedBy: { id: 1, name: 'Admin', email: 'a@x' },
              permissions: [],
              isCurrent: true,
            },
            {
              id: 101,
              roleId: ADMIN_ROLE.id,
              versionNumber: 1,
              permissionCount: 7,
              changeType: 'INITIAL',
              changedAt: '2026-06-16T11:00:00Z',
              note: 'Auto-snapshot',
              changedBy: null,
              permissions: [],
              isCurrent: false,
            },
          ],
        });
      }
      if (url === `/api/roles/${ADMIN_ROLE.id}/permissions/restore` && opts?.method === 'POST') {
        return Promise.resolve({
          roleId: ADMIN_ROLE.id,
          permissions: [],
          newVersion: { id: 103, versionNumber: 3, changeType: 'RESTORE' },
        });
      }
      return Promise.resolve({});
    });
    render(
      <AuthContext.Provider value={{ user: { id: 1, role: 'ADMIN', userType: 'STAFF', email: 'admin@x' }, tenant: { vertical: 'travel' }, token: 'tok', loading: false }}>
        <MemoryRouter><RolesAdmin /></MemoryRouter>
      </AuthContext.Provider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Administrator/i }));
    await screen.findByText(/Permissions: Administrator/i);
    fireEvent.click(await screen.findByTestId('open-permissions-history'));

    // History modal renders both versions
    const list = await screen.findByTestId('permissions-history-list');
    expect(list).toBeTruthy();
    // v1 has a Restore button (not current); v2 does not
    const restoreBtn = await screen.findByTestId('restore-version-1');
    expect(restoreBtn).toBeTruthy();
    expect(screen.queryByTestId('restore-version-2')).toBeNull();

    fireEvent.click(restoreBtn);

    await waitFor(() => {
      const posts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === `/api/roles/${ADMIN_ROLE.id}/permissions/restore` && opts?.method === 'POST',
      );
      expect(posts).toHaveLength(1);
      const body = JSON.parse(posts[0][1].body);
      expect(body.versionId).toBe(101);
    });
    // Success toast confirms the restore in plain language — no
    // internal version numbers leak into user-facing copy. The
    // History modal is the place admins see "Version N"; the toast
    // anchors on the source-version's date instead.
    await waitFor(() =>
      expect(notifyObj.success).toHaveBeenCalledWith(
        expect.stringMatching(/Restored "Administrator" to/i),
      ),
    );
    const lastCallArg = notifyObj.success.mock.calls.at(-1)[0];
    expect(lastCallArg).not.toMatch(/\bv\d+\b/);
    expect(lastCallArg).not.toMatch(/saved as/i);
  });
});

// ─────────── Phase 2 — severity badges (Critical / Caution) ──────────

describe('Phase 2 — severity badges in the permissions matrix', () => {
  // Each test opens the matrix and asserts badge presence/severity by
  // testid. The badges derive from the existing CRITICAL_RBAC_KEYS +
  // SENSITIVE_PERMISSIONS_CLIENT constants in RolesAdmin.jsx — no
  // UI-only allow-list. Test #7 below uses `developer.manage` to
  // prove the derivation.

  async function openMatrix() {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Administrator/i }));
    await screen.findByText(/Permissions: Administrator/i);
  }

  it('1. roles.read renders a Critical badge', async () => {
    await openMatrix();
    const badge = await screen.findByTestId('perm-badge-roles-read');
    expect(badge).toBeTruthy();
    expect(badge.dataset.severity).toBe('critical');
    expect(badge.textContent).toMatch(/Critical/i);
  });

  it('2. roles.manage renders a Critical badge (Critical wins over Caution)', async () => {
    await openMatrix();
    const badge = await screen.findByTestId('perm-badge-roles-manage');
    // roles.manage is in BOTH CRITICAL_RBAC_KEYS and
    // SENSITIVE_PERMISSIONS_CLIENT — the classifier returns
    // 'critical' first, so the badge is Critical (precedence rule).
    expect(badge.dataset.severity).toBe('critical');
    expect(badge.textContent).toMatch(/Critical/i);
    expect(badge.textContent).not.toMatch(/Caution/i);
  });

  it('3. Critical tooltip text renders correctly', async () => {
    await openMatrix();
    const badge = await screen.findByTestId('perm-badge-roles-read');
    const title = badge.getAttribute('title') || '';
    expect(title).toMatch(/RBAC-critical permission/i);
    expect(title).toMatch(/Removing this can prevent users from administering/i);
    expect(title).toMatch(/The server will reject changes/i);
  });

  it('4. Caution-classified permissions render a Caution badge', async () => {
    await openMatrix();
    // staff.manage is in SENSITIVE_PERMISSIONS_CLIENT but NOT in
    // CRITICAL_RBAC_KEYS — should classify as Caution.
    const staffManageBadge = await screen.findByTestId('perm-badge-staff-manage');
    expect(staffManageBadge.dataset.severity).toBe('caution');
    expect(staffManageBadge.textContent).toMatch(/Caution/i);
    expect(staffManageBadge.textContent).not.toMatch(/Critical/i);
  });

  it('5. Caution tooltip text renders correctly', async () => {
    await openMatrix();
    const badge = await screen.findByTestId('perm-badge-staff-manage');
    const title = badge.getAttribute('title') || '';
    expect(title).toMatch(/Operationally important permission/i);
    expect(title).toMatch(/user management, onboarding, reporting/i);
    expect(title).toMatch(/Review carefully before saving/i);
  });

  it('6. Ordinary permissions render no badge', async () => {
    await openMatrix();
    // contacts.read / contacts.write are in neither classification set
    expect(screen.queryByTestId('perm-badge-contacts-read')).toBeNull();
    expect(screen.queryByTestId('perm-badge-contacts-write')).toBeNull();
    // staff.read is in neither set (only the write-tier staff.* are
    // sensitive). Pins the contract: the badge tracks the existing
    // SENSITIVE_PERMISSIONS_CLIENT exactly, not a broader allow-list.
    expect(screen.queryByTestId('perm-badge-staff-read')).toBeNull();
    // developer.read — read-tier dev perm is not sensitive
    expect(screen.queryByTestId('perm-badge-developer-read')).toBeNull();
  });

  it('7. Badge rendering is driven by permission classification metadata, not hardcoded UI checks', async () => {
    await openMatrix();
    // developer.manage is in SENSITIVE_PERMISSIONS_CLIENT (defined
    // independently of any roles/staff hardcoding). If the badge
    // were keyed to a hardcoded ["roles.*", "staff.*"] allow-list,
    // this test would fail. The badge appearing here proves the
    // classifier reads from the existing source-of-truth set.
    const devManageBadge = await screen.findByTestId('perm-badge-developer-manage');
    expect(devManageBadge.dataset.severity).toBe('caution');
    expect(devManageBadge.textContent).toMatch(/Caution/i);
    // Same metadata-driven assertion in the opposite direction:
    // developer.read is NOT in the sensitive set, so no badge.
    expect(screen.queryByTestId('perm-badge-developer-read')).toBeNull();
  });
});

// ─────── Phase 2 — CriticalPermsConfirmModal copy update ─────────────

describe('Phase 2 — CriticalPermsConfirmModal carries the restore guidance', () => {
  it('renders the History recovery hint inside the confirmation modal', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Administrator/i }));
    await screen.findByText(/Permissions: Administrator/i);

    // Uncheck the Critical badge's checkbox (roles.manage, 4th in
    // catalog order: contacts.read, contacts.write, roles.read, roles.manage, ...)
    const allCheckboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(allCheckboxes[3]);

    fireEvent.click(await screen.findByRole('button', { name: /Save permissions/i }));
    const modal = await screen.findByTestId('critical-perms-confirm-modal');
    expect(modal).toBeTruthy();

    // Recovery callout block present + names History as the recovery
    // path — spec-pinned copy.
    const hint = await screen.findByTestId('critical-perms-recovery-hint');
    expect(hint.textContent).toMatch(/restore a previous version from .*History/i);
    expect(hint.textContent).toMatch(/required permissions/i);
  });
});

// ─────────── Per-vertical MODULE_DESCRIPTIONS override ────────────
//
// The permissions matrix renders one module card per catalog entry
// with a one-line description. Some descriptions used to leak
// wellness-specific terminology into the travel CRM — e.g. the
// shared `invoices` module's description read "Patient + customer
// invoice records …" on every vertical. The fix routes every
// description lookup through getModuleDescription(module, vertical)
// which consults a per-vertical override map (only entries that
// differ get overrides; everything else falls through to the base
// description).
//
// These tests pin: (a) travel tenants see travel-flavoured wording,
// (b) wellness keeps its existing wording, (c) generic falls through
// to the neutral base.

describe('Per-vertical MODULE_DESCRIPTIONS overrides', () => {
  const INVOICES_CATALOG = {
    catalog: {
      invoices: ['read', 'write'],
      contacts: ['read'],
    },
    modules: [
      { module: 'invoices', actions: ['read', 'write'] },
      { module: 'contacts', actions: ['read'] },
    ],
    domains: [
      { domain: 'Financial', modules: [{ module: 'invoices', actions: ['read', 'write'] }] },
      { domain: 'CRM Core',  modules: [{ module: 'contacts', actions: ['read'] }] },
    ],
    vertical: 'travel',
  };
  const ROLE_FIXTURE = {
    id: 100,
    key: 'CUSTOM',
    name: 'Custom',
    description: 'A role',
    isSystem: false,
    isActive: true,
    userType: 'STAFF',
    landingPath: null,
    userCount: 0,
    permissionCount: 0,
    visiblePermissionCount: 0,
    hiddenPermissionCount: 0,
    permissions: [],
  };

  function renderWithVertical(vertical) {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/roles' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ roles: [ROLE_FIXTURE], tenantId: 11 });
      }
      if (url === '/api/roles/catalog') {
        return Promise.resolve({ ...INVOICES_CATALOG, vertical });
      }
      if (url === '/api/pages/catalog') return Promise.resolve({ catalog: [] });
      return Promise.resolve({});
    });
    return render(
      <AuthContext.Provider
        value={{
          user: { id: 1, role: 'ADMIN', userType: 'STAFF', email: 'admin@x' },
          tenant: { vertical },
          token: 'tok',
          loading: false,
        }}
      >
        <MemoryRouter>
          <RolesAdmin />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
  }

  it('travel tenant shows travel-flavoured invoices description (no "Patient")', async () => {
    renderWithVertical('travel');
    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Custom/i }));
    await screen.findByText(/Permissions: Custom/i);
    // The matrix renders the description as the text underneath the
    // module name. Find it by partial match.
    expect(
      await screen.findByText(/Customer \+ traveler invoice records/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Patient \+ customer/i)).toBeNull();
  });

  it('wellness tenant keeps its existing wellness-flavoured invoices description', async () => {
    renderWithVertical('wellness');
    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Custom/i }));
    await screen.findByText(/Permissions: Custom/i);
    expect(
      await screen.findByText(/Patient \+ customer invoice records/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Customer \+ traveler/i)).toBeNull();
  });

  it('generic tenant falls through to the neutral base description', async () => {
    renderWithVertical('generic');
    fireEvent.click(await screen.findByRole('button', { name: /View permissions for Custom/i }));
    await screen.findByText(/Permissions: Custom/i);
    // Neutral base — no "Patient", no "traveler", just "Customer invoice records …"
    expect(
      await screen.findByText(/^Customer invoice records and the Invoices page\.$/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Patient/i)).toBeNull();
    expect(screen.queryByText(/traveler/i)).toBeNull();
  });
});
