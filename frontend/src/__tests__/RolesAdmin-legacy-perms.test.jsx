/**
 * RolesAdmin-legacy-perms.test.jsx — Bug 1 regression coverage.
 *
 * Pins: when the role being edited carries permissions that are NOT in
 * the current vertical-filtered catalog (the canonical case: travel
 * tenant role with wellness-flavored seed perms like patients.read,
 * appointments.read, consents.write), the PermissionsModal:
 *
 *   1. Does NOT silently strip them on Save.
 *   2. Surfaces an explicit confirmation modal listing each legacy
 *      key + a Cancel and "Remove and save" button pair.
 *   3. Cancel keeps the role's permissions untouched (no PUT).
 *   4. "Remove and save" fires the PUT with the visible-only selection
 *      (back-compat with the full-replace endpoint contract).
 *
 * Before this fix, the legacy perms were swallowed by the hydrate
 * filter, a console.warn was logged, and persistSave shipped the
 * filtered set — admins lost grants they had no UI control over.
 *
 * Stub strategy mirrors Approvals.test.jsx — mock fetchApi, useNotify,
 * usePermissions, render via MemoryRouter + AuthContext.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stable mock for fetchApi so call counts across renders are
// inspectable. Each test sets per-endpoint handlers via fetchApiMock.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify mock (see Approvals.test.jsx for the rationale on stable
// object identity for hooks consumed by useCallback dependency arrays).
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// usePermissions controls page-level access. Mock ADMIN with manage so
// the page renders the matrix instead of AccessDenied.
const permissionsMock = {
  hasPermission: (m, a) => m === 'roles' && (a === 'read' || a === 'manage'),
  isLoading: false,
  isReady: true,
  // refresh must return a Promise — refreshAll in RolesAdmin chains a
  // .catch() on the return value.
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

// useScrollLock is a noop side-effect; stub so the modal renders.
vi.mock('../hooks/useScrollLock', () => ({
  useScrollLock: () => {},
}));

import { AuthContext } from '../App';
import RolesAdmin from '../pages/RolesAdmin';

// Travel-tenant catalog (subset — enough to cover the cases). Anything
// outside this is a "legacy" perm from the modal's perspective.
const TRAVEL_CATALOG = {
  catalog: {
    contacts: ['read', 'write', 'update', 'delete', 'export'],
    deals: ['read', 'write'],
    itineraries: ['read', 'write', 'update', 'delete'],
    suppliers: ['read', 'write', 'manage'],
    roles: ['read', 'manage'],
  },
  modules: [
    { module: 'contacts', actions: ['read', 'write', 'update', 'delete', 'export'] },
    { module: 'deals', actions: ['read', 'write'] },
    { module: 'itineraries', actions: ['read', 'write', 'update', 'delete'] },
    { module: 'suppliers', actions: ['read', 'write', 'manage'] },
    { module: 'roles', actions: ['read', 'manage'] },
  ],
  domains: [
    { domain: 'CRM Core', modules: [{ module: 'contacts', actions: ['read', 'write', 'update', 'delete', 'export'] }, { module: 'deals', actions: ['read', 'write'] }] },
    { domain: 'Travel Itineraries & Trips', modules: [{ module: 'itineraries', actions: ['read', 'write', 'update', 'delete'] }] },
    { domain: 'Travel Suppliers', modules: [{ module: 'suppliers', actions: ['read', 'write', 'manage'] }] },
    { domain: 'Admin & Platform', modules: [{ module: 'roles', actions: ['read', 'manage'] }] },
  ],
  vertical: 'travel',
};

// Role with 3 in-catalog perms + 3 legacy/foreign perms (wellness
// leftovers + a removed module). The QA spec's worked example talks
// about 74 → 58 deltas; the test only needs the symptom, not the scale.
const dirtyRoleFromList = {
  id: 9,
  key: 'MANAGER',
  name: 'Manager',
  description: 'Tenant manager',
  isSystem: false,
  isActive: true,
  userType: 'STAFF',
  landingPath: null,
  userCount: 2,
  permissionCount: 6,
  visiblePermissionCount: 3,
  hiddenPermissionCount: 3,
  permissions: [
    { module: 'contacts', action: 'read' },
    { module: 'itineraries', action: 'read' },
    { module: 'suppliers', action: 'read' },
    // Foreign / legacy — modules NOT in TRAVEL_CATALOG above:
    { module: 'patients', action: 'read' },
    { module: 'appointments', action: 'write' },
    { module: 'consents', action: 'delete' },
  ],
};

function renderPage() {
  return render(
    <AuthContext.Provider
      value={{
        user: { id: 1, role: 'ADMIN', userType: 'STAFF', email: 'a@b' },
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
  // Default endpoint handlers — every test that runs the page hits these.
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/roles' && (!opts || opts.method == null || opts.method === 'GET')) {
      return Promise.resolve({ roles: [dirtyRoleFromList], tenantId: 11 });
    }
    if (url === '/api/roles/catalog') {
      return Promise.resolve(TRAVEL_CATALOG);
    }
    if (url === '/api/pages/catalog') {
      return Promise.resolve({ catalog: [] });
    }
    if (url === `/api/roles/${dirtyRoleFromList.id}/permissions` && opts?.method === 'PUT') {
      return Promise.resolve({
        roleId: dirtyRoleFromList.id,
        permissions: [],
        landingPathCleared: false,
      });
    }
    return Promise.resolve({});
  });
});

describe('Bug 1 — PermissionsModal legacy-perm acknowledgement', () => {
  it('shows the legacy-perm confirmation modal when Save would drop hidden grants', async () => {
    renderPage();

    // Wait for the role row to render, then click the permissions badge.
    const permBtn = await screen.findByRole('button', { name: /View permissions for Manager/i });
    fireEvent.click(permBtn);

    // Wait for the matrix to render — there should be checkboxes for each
    // catalog module's actions.
    await screen.findByText('Permissions: Manager');

    // Click Save (no selection change → the in-catalog perms are pre-
    // checked from hydration, legacy perms are NOT in `selected`).
    const saveBtn = await screen.findByRole('button', { name: /Save permissions/i });
    fireEvent.click(saveBtn);

    // The legacy-perm confirm modal appears.
    const legacyModal = await screen.findByTestId('legacy-perms-confirm-modal');
    expect(legacyModal).toBeTruthy();

    // It enumerates every legacy key.
    const modalText = legacyModal.textContent || '';
    expect(modalText).toMatch(/patients\.read/);
    expect(modalText).toMatch(/appointments\.write/);
    expect(modalText).toMatch(/consents\.delete/);

    // No PUT fired — gated on admin confirmation.
    const putCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        url === `/api/roles/${dirtyRoleFromList.id}/permissions` && opts?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('Cancel button leaves the role untouched (no PUT fired)', async () => {
    renderPage();
    const permBtn = await screen.findByRole('button', { name: /View permissions for Manager/i });
    fireEvent.click(permBtn);
    await screen.findByText('Permissions: Manager');
    fireEvent.click(await screen.findByRole('button', { name: /Save permissions/i }));

    const legacyModal = await screen.findByTestId('legacy-perms-confirm-modal');
    const cancelBtn = within(legacyModal.parentElement).getByTestId('legacy-perms-cancel');
    fireEvent.click(cancelBtn);

    // After cancel, the modal closes — but the matrix stays open.
    await waitFor(() =>
      expect(screen.queryByTestId('legacy-perms-confirm-modal')).toBeNull(),
    );
    expect(screen.queryByText('Permissions: Manager')).toBeTruthy();

    const putCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        url === `/api/roles/${dirtyRoleFromList.id}/permissions` && opts?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('"Remove and save" fires the PUT with only the visible selection', async () => {
    renderPage();
    const permBtn = await screen.findByRole('button', { name: /View permissions for Manager/i });
    fireEvent.click(permBtn);
    await screen.findByText('Permissions: Manager');
    fireEvent.click(await screen.findByRole('button', { name: /Save permissions/i }));

    const legacyModal = await screen.findByTestId('legacy-perms-confirm-modal');
    const confirmBtn = within(legacyModal.parentElement).getByTestId('legacy-perms-remove-and-save');
    fireEvent.click(confirmBtn);

    // PUT lands with the visible-only set — the legacy perms are
    // intentionally not in the payload (admin acknowledged the drop).
    await waitFor(() => {
      const putCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === `/api/roles/${dirtyRoleFromList.id}/permissions` && opts?.method === 'PUT',
      );
      expect(putCalls).toHaveLength(1);
    });
    const putBody = JSON.parse(
      fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === `/api/roles/${dirtyRoleFromList.id}/permissions` && opts?.method === 'PUT',
      )[1].body,
    );
    // The 3 visible perms are present.
    const sent = new Set(putBody.permissions.map((p) => `${p.module}.${p.action}`));
    expect(sent.has('contacts.read')).toBe(true);
    expect(sent.has('itineraries.read')).toBe(true);
    expect(sent.has('suppliers.read')).toBe(true);
    // None of the legacy perms made it into the payload.
    expect(sent.has('patients.read')).toBe(false);
    expect(sent.has('appointments.write')).toBe(false);
    expect(sent.has('consents.delete')).toBe(false);
  });

  it('does NOT show the legacy modal when the role has no foreign perms', async () => {
    // Override the default mock so /api/roles returns a clean role.
    const cleanRole = {
      ...dirtyRoleFromList,
      id: 10,
      key: 'CLEAN',
      name: 'Clean',
      permissions: [
        { module: 'contacts', action: 'read' },
        { module: 'itineraries', action: 'read' },
      ],
      permissionCount: 2,
      visiblePermissionCount: 2,
      hiddenPermissionCount: 0,
    };
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/roles' && (!opts || opts.method == null)) {
        return Promise.resolve({ roles: [cleanRole], tenantId: 11 });
      }
      if (url === '/api/roles/catalog') return Promise.resolve(TRAVEL_CATALOG);
      if (url === '/api/pages/catalog') return Promise.resolve({ catalog: [] });
      if (url === `/api/roles/${cleanRole.id}/permissions` && opts?.method === 'PUT') {
        return Promise.resolve({ roleId: cleanRole.id, permissions: [] });
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.click(
      await screen.findByRole('button', { name: /View permissions for Clean/i }),
    );
    await screen.findByText('Permissions: Clean');
    fireEvent.click(await screen.findByRole('button', { name: /Save permissions/i }));

    // No legacy modal — straight to the PUT (no sensitive grants either
    // because we didn't toggle any new boxes).
    await waitFor(() => {
      const putCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === `/api/roles/${cleanRole.id}/permissions` && opts?.method === 'PUT',
      );
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByTestId('legacy-perms-confirm-modal')).toBeNull();
  });
});

describe('Bug 2 — Delete button is disabled for system roles', () => {
  it('renders Delete disabled with the spec-pinned tooltip on a system role', async () => {
    const systemRole = {
      id: 1,
      key: 'ADMIN',
      name: 'Administrator',
      description: 'Built-in admin',
      isSystem: true,
      isActive: true,
      userType: 'STAFF',
      landingPath: null,
      userCount: 1,
      permissionCount: 50,
      visiblePermissionCount: 50,
      hiddenPermissionCount: 0,
      permissions: [],
    };
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/roles') return Promise.resolve({ roles: [systemRole], tenantId: 11 });
      if (url === '/api/roles/catalog') return Promise.resolve(TRAVEL_CATALOG);
      if (url === '/api/pages/catalog') return Promise.resolve({ catalog: [] });
      return Promise.resolve({});
    });
    renderPage();

    const deleteBtn = await screen.findByTestId('role-delete-ADMIN');
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn.getAttribute('title')).toMatch(/system role/i);
    expect(deleteBtn.getAttribute('title')).toMatch(/identity/i);
  });

  it('renders Delete enabled on a custom role', async () => {
    const customRole = {
      id: 9,
      key: 'CUSTOM',
      name: 'Custom',
      description: 'Custom role',
      isSystem: false,
      isActive: true,
      userType: 'STAFF',
      landingPath: null,
      userCount: 0,
      permissionCount: 5,
      visiblePermissionCount: 5,
      hiddenPermissionCount: 0,
      permissions: [],
    };
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/roles') return Promise.resolve({ roles: [customRole], tenantId: 11 });
      if (url === '/api/roles/catalog') return Promise.resolve(TRAVEL_CATALOG);
      if (url === '/api/pages/catalog') return Promise.resolve({ catalog: [] });
      return Promise.resolve({});
    });
    renderPage();

    const deleteBtn = await screen.findByTestId('role-delete-CUSTOM');
    expect(deleteBtn).not.toBeDisabled();
  });
});

describe('Bug 5 / Step-6 — Table badge count matches editor count', () => {
  it('renders the visible count from the API (not the raw count) on the table badge', async () => {
    renderPage();
    // The dirty role has permissionCount=6 but visiblePermissionCount=3.
    // The badge button should show 3, not 6.
    const badge = await screen.findByRole('button', { name: /View permissions for Manager/i });
    expect(badge.textContent).toMatch(/\b3\b/);
    expect(badge.textContent).not.toMatch(/\b6\b/);
  });

  it('does NOT render an inline "(+N hidden)" indicator in the main table (Step 6 UI follow-up)', async () => {
    renderPage();
    const badge = await screen.findByRole('button', { name: /View permissions for Manager/i });
    // The chip was removed per the post-cleanup UI follow-up; hidden
    // count surfaces only in the title tooltip + the editor's legacy-
    // perm confirmation modal.
    expect(badge.textContent).not.toMatch(/hidden/i);
    // Hover-title still carries the diagnostic for admins who care.
    expect(badge.getAttribute('title')).toMatch(/3 hidden/i);
  });
});
