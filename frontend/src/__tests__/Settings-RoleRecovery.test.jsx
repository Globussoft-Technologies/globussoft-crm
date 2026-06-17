/**
 * Settings-RoleRecovery.test.jsx — pins the secondary recovery surface
 * added under Settings.
 *
 * Lives at /settings (not /settings/role-recovery — no new route was
 * added per the architectural decision to reuse the existing Settings
 * page). The section renders a card titled "Role Recovery" that lists
 * the tenant's roles via the existing GET /api/roles endpoint and
 * opens the shared RoleHistoryDialog on demand. Restore wires through
 * to the existing POST /api/roles/:id/permissions/restore endpoint.
 *
 * Test contract:
 *   1. Visibility — section renders when the user holds roles.read OR
 *      settings.manage. Hidden when neither.
 *   2. Listing — calls GET /api/roles on mount, renders one row per role.
 *   3. Open dialog — clicking "View history" opens the history modal
 *      and triggers GET /api/roles/:id/permissions/versions.
 *   4. Restore — clicking Restore on a non-current version POSTs
 *      /restore with versionId. Success toast is plain-language (no
 *      internal version numbers leak).
 *   5. Restore button gate — admins WITHOUT roles.manage and WITHOUT
 *      settings.manage see history but no Restore button.
 *
 * Mock strategy mirrors RolesAdmin-rbac-hardening.test.jsx —
 * fetchApi, useNotify, usePermissions all stubbed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 't-abc',
}));

// Stable notify mock — the recovery flow uses confirm() before
// restoring so the stub must resolve.
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// usePermissions — vary the perm set per test.
let permsForTest = new Set(['roles.read', 'roles.manage', 'settings.read', 'settings.manage']);
let isOwnerForTest = false;
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({
    hasPermission: (m, a) => permsForTest.has(`${m}.${a}`),
    hasAllPermissions: (list) => list.every((p) => permsForTest.has(`${p.module}.${p.action}`)),
    hasAnyPermission: (list) => list.some((p) => permsForTest.has(`${p.module}.${p.action}`)),
    isLoading: false,
    isReady: true,
    permissions: Array.from(permsForTest),
    isOwner: isOwnerForTest,
    refresh: vi.fn(() => Promise.resolve()),
  }),
  invalidatePermissionCache: vi.fn(),
}));

// Lightweight stubs for Settings dependencies that aren't part of the
// Role Recovery flow.
vi.mock('../components/PasswordInput', () => ({
  default: (props) => <input data-testid="password-input" {...props} />,
}));
vi.mock('../components/WebhookSigningCredential', () => ({
  default: () => <div data-testid="webhook-credential" />,
}));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../utils/adsgpt', () => ({
  launchAdsGptAs: vi.fn(),
  ADSGPT_DASHBOARD: 'https://example.test',
  ADSGPT_DEMO_LOGIN: 'demo@x.test',
}));
vi.mock('../utils/callified', () => ({ launchCallifiedSSO: vi.fn() }));

import { AuthContext, ThemeContext } from '../App';
import Settings from '../pages/Settings';

const SAMPLE_ROLES = [
  {
    id: 193,
    key: 'ADMIN',
    name: 'Admin',
    description: 'Tenant administrator',
    isSystem: true,
    isActive: true,
    userType: 'STAFF',
    landingPath: '/dashboard',
    permissions: [],
    userCount: 2,
    permissionCount: 259,
    visiblePermissionCount: 259,
    hiddenPermissionCount: 0,
  },
  {
    id: 194,
    key: 'MANAGER',
    name: 'Manager',
    description: 'Manager role',
    isSystem: false,
    isActive: true,
    userType: 'STAFF',
    landingPath: '/dashboard',
    permissions: [],
    userCount: 2,
    permissionCount: 58,
    visiblePermissionCount: 58,
    hiddenPermissionCount: 0,
  },
];

const SAMPLE_VERSIONS = {
  roleId: 193,
  versions: [
    {
      id: 901,
      roleId: 193,
      versionNumber: 9,
      permissionCount: 259,
      changeType: 'UPDATE',
      restoredFromVersionId: null,
      changedAt: '2026-06-17T10:00:00Z',
      changedBy: { id: 93, name: 'Demo Admin', email: 'admin@travelstall.demo' },
      note: null,
      permissions: [],
      isCurrent: true,
    },
    {
      id: 900,
      roleId: 193,
      versionNumber: 8,
      permissionCount: 258,
      changeType: 'UPDATE',
      restoredFromVersionId: null,
      changedAt: '2026-06-17T09:30:00Z',
      changedBy: { id: 93, name: 'Demo Admin', email: 'admin@travelstall.demo' },
      note: null,
      permissions: [],
      isCurrent: false,
    },
  ],
};

function renderSettings() {
  return render(
    <AuthContext.Provider
      value={{
        user: { id: 1, role: 'ADMIN', userType: 'STAFF', email: 'a@x' },
        tenant: { id: 11, name: 'Travel Stall', vertical: 'travel' },
        setTenant: vi.fn(),
        token: 'tok',
        loading: false,
      }}
    >
      <ThemeContext.Provider
        value={{ theme: 'dark', setTheme: vi.fn(), toggleTheme: vi.fn() }}
      >
        <MemoryRouter>
          <Settings />
        </MemoryRouter>
      </ThemeContext.Provider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  permsForTest = new Set(['roles.read', 'roles.manage', 'settings.read', 'settings.manage']);
  isOwnerForTest = false;
  // Default URL-routing mock; per-test handlers override.
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/roles' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ roles: SAMPLE_ROLES, tenantId: 11 });
    }
    if (url === '/api/roles/193/permissions/versions') {
      return Promise.resolve(SAMPLE_VERSIONS);
    }
    if (url === '/api/roles/193/permissions/restore' && opts?.method === 'POST') {
      return Promise.resolve({
        roleId: 193,
        permissions: [],
        newVersion: { id: 902, versionNumber: 10, changeType: 'RESTORE' },
      });
    }
    return Promise.resolve({});
  });
});

describe('Settings → Role Recovery — visibility', () => {
  it('renders the section when user holds roles.read', async () => {
    permsForTest = new Set(['roles.read']);
    renderSettings();
    expect(await screen.findByTestId('settings-role-recovery-card')).toBeTruthy();
  });

  it('renders the section when user holds settings.manage (the lockout-recovery path)', async () => {
    // The tester scenario — roles.read missing, settings.manage retained.
    permsForTest = new Set(['settings.read', 'settings.manage']);
    renderSettings();
    expect(await screen.findByTestId('settings-role-recovery-card')).toBeTruthy();
  });

  it('does NOT render the section when user holds neither perm', async () => {
    permsForTest = new Set(['contacts.read']);
    renderSettings();
    // Wait for any async render to settle, then assert absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('settings-role-recovery-card')).toBeNull();
  });
});

describe('Settings → Role Recovery — listing + open + restore', () => {
  it('lists roles on mount via GET /api/roles and renders one row per role', async () => {
    renderSettings();
    expect(await screen.findByTestId('settings-role-recovery-card')).toBeTruthy();
    expect(await screen.findByTestId('settings-role-recovery-list')).toBeTruthy();
    expect(await screen.findByTestId('settings-role-recovery-open-ADMIN')).toBeTruthy();
    expect(await screen.findByTestId('settings-role-recovery-open-MANAGER')).toBeTruthy();
    // The GET /api/roles call landed at least once.
    const listCalls = fetchApiMock.mock.calls.filter(([url]) => url === '/api/roles');
    expect(listCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('opens the history dialog and fetches versions when "View history" is clicked', async () => {
    renderSettings();
    fireEvent.click(await screen.findByTestId('settings-role-recovery-open-ADMIN'));
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/roles/193/permissions/versions',
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
    // Dialog renders the version list with both rows.
    expect(await screen.findByTestId('history-version-9')).toBeTruthy();
    expect(await screen.findByTestId('history-version-8')).toBeTruthy();
  });

  it('clicking Restore on a non-current version POSTs /restore with versionId', async () => {
    renderSettings();
    fireEvent.click(await screen.findByTestId('settings-role-recovery-open-ADMIN'));
    fireEvent.click(await screen.findByTestId('restore-version-8'));

    await waitFor(() => {
      const restores = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/api/roles/193/permissions/restore' && opts?.method === 'POST',
      );
      expect(restores.length).toBe(1);
      expect(JSON.parse(restores[0][1].body).versionId).toBe(900);
    });

    // Success toast is plain-language — no version numbers leak.
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalled();
    });
    const lastToast = notifyObj.success.mock.calls.at(-1)[0];
    expect(lastToast).toMatch(/Restored "Admin"/i);
    expect(lastToast).not.toMatch(/\bv\d+\b/);
    expect(lastToast).not.toMatch(/saved as/i);
  });
});

describe('Settings → Role Recovery — dialog close + opacity', () => {
  // The user reported that the in-page history modal had two UX issues
  // when invoked from Settings:
  //   1. No obvious way to cancel (Close button blended into the
  //      semi-transparent theme surface).
  //   2. The dialog inherited the theme's --surface-color which is
  //      intentionally translucent for glassmorphism (40-70% opacity
  //      in dark mode), making content overlap with the Settings
  //      card visible underneath.
  // Both fixes — opaque background override + a clearly identified
  // Close button — are pinned here.

  it('renders a Close button identified by testid that closes the dialog', async () => {
    renderSettings();
    fireEvent.click(await screen.findByTestId('settings-role-recovery-open-ADMIN'));
    // History list renders
    await screen.findByTestId('history-version-9');
    // Close button is testid-pinned so it can't drift to be visually hidden
    const closeBtn = await screen.findByTestId('role-history-close');
    expect(closeBtn).toBeTruthy();
    expect(closeBtn.textContent).toMatch(/close/i);
    fireEvent.click(closeBtn);
    // After close the version list is no longer in the DOM
    await waitFor(() => {
      expect(screen.queryByTestId('history-version-9')).toBeNull();
    });
  });

  it('renders a header X close button that is always reachable (flex-shrink: 0 layout guarantee)', async () => {
    // The custom popup's header is flex-shrink: 0 so it never gets
    // pushed off-screen by tall body content (the failure mode that
    // hit the shared <Modal> primitive on the Admin role with 8+
    // version snapshots). Pin the header X presence + closing
    // semantics so future contributors can't silently drop this
    // guaranteed-visible affordance.
    renderSettings();
    fireEvent.click(await screen.findByTestId('settings-role-recovery-open-ADMIN'));
    await screen.findByTestId('history-version-9');
    const headerClose = await screen.findByTestId('role-history-header-close');
    expect(headerClose).toBeTruthy();
    expect(headerClose.getAttribute('aria-label')).toMatch(/close dialog/i);
    fireEvent.click(headerClose);
    await waitFor(() => {
      expect(screen.queryByTestId('history-version-9')).toBeNull();
    });
  });

  it('renders a floating close button at viewport top-right that cannot be cropped or hidden', async () => {
    // The floating close button is z-index: 10001 (above the dialog
    // overlay's 9999) and position: fixed at top-right of the
    // viewport — not inside the dialog. This is the universal
    // belt-and-braces close affordance that can't be hidden by
    // viewport quirks, partial screenshots, browser chrome, or
    // any other UI overlay (telephony widget, OS watermarks). Pin
    // its testid + closing semantics so it can't silently drop.
    renderSettings();
    fireEvent.click(await screen.findByTestId('settings-role-recovery-open-ADMIN'));
    await screen.findByTestId('history-version-9');
    const floatingClose = await screen.findByTestId('role-history-floating-close');
    expect(floatingClose).toBeTruthy();
    expect(floatingClose.style.position).toBe('fixed');
    expect(parseInt(floatingClose.style.zIndex, 10)).toBeGreaterThan(9999);
    fireEvent.click(floatingClose);
    await waitFor(() => {
      expect(screen.queryByTestId('history-version-9')).toBeNull();
    });
  });

  it('uses absolute-positioned header + footer so they can never be pushed off-screen by body content', async () => {
    // Layout contract: position: relative on the dialog with
    // explicit fixed height + absolute-positioned header at top:0
    // and footer at bottom:0. Body fills the space between via its
    // own absolute positioning. This guarantees header X and footer
    // Close stay visible regardless of how tall the version list
    // grows. (Earlier flex-column attempts failed when the body's
    // intrinsic height pushed the footer below the dialog.)
    renderSettings();
    fireEvent.click(await screen.findByTestId('settings-role-recovery-open-ADMIN'));
    const dialog = await screen.findByTestId('role-history-dialog');
    expect(dialog.style.position).toBe('relative');
    expect(dialog.style.overflow).toBe('hidden');
    expect(dialog.style.height).toMatch(/vh$/);
    // Both close affordances are testid-pinned + present.
    expect(await screen.findByTestId('role-history-header-close')).toBeTruthy();
    expect(await screen.findByTestId('role-history-close')).toBeTruthy();
  });

  it('renders multiple close affordances with aria-label="Close dialog" — header X + floating close', async () => {
    renderSettings();
    fireEvent.click(await screen.findByTestId('settings-role-recovery-open-ADMIN'));
    await screen.findByTestId('history-version-9');
    // The dialog now ships THREE close paths: header X (inside the
    // dialog top bar), footer Close (bottom-right of the dialog),
    // and a floating Close button anchored to the viewport top-right
    // (z-index above everything else). Both the header X and the
    // floating button carry aria-label="Close dialog" for screen
    // readers — pin that we have at least 2 such affordances.
    const closeAffordances = screen.getAllByLabelText(/close dialog/i);
    expect(closeAffordances.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Settings → Role Recovery — restore button gating', () => {
  it('hides Restore button when user has neither roles.manage nor settings.manage', async () => {
    // Recovery-only-read scenario: user has roles.read but neither
    // manage perm. They can review history; they cannot restore from
    // here. (Backend POST /restore enforces the same gate.)
    permsForTest = new Set(['roles.read']);
    renderSettings();
    fireEvent.click(await screen.findByTestId('settings-role-recovery-open-ADMIN'));
    // History list renders…
    expect(await screen.findByTestId('history-version-8')).toBeTruthy();
    // …but no Restore button on the non-current version.
    expect(screen.queryByTestId('restore-version-8')).toBeNull();
  });

  it('shows Restore button when user holds settings.manage only (lockout-recovery path)', async () => {
    permsForTest = new Set(['settings.read', 'settings.manage']);
    renderSettings();
    fireEvent.click(await screen.findByTestId('settings-role-recovery-open-ADMIN'));
    expect(await screen.findByTestId('restore-version-8')).toBeTruthy();
  });
});
