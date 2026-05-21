import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Shield, Trash2, Users, X, UserMinus, UserPlus } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { usePermissions, invalidatePermissionCache } from '../hooks/usePermissions';
import AccessDenied from '../components/AccessDenied';

// Admin UI for the RBAC role + permission system. Mirrors the endpoints
// under /api/roles (see backend/routes/roles.js). Tenant scoping is enforced
// server-side — non-OWNER admins only see their own tenant's roles.
//
// Permission catalogue: the live matrix is fetched from
// `GET /api/roles/catalog` so the server's permissionCatalog stays the
// single source of truth (prevents the UI-vs-validator drift bug). The
// constant below is the fallback shape used (a) on first render before
// the fetch resolves, and (b) if a frontend deploy lands ahead of the
// catalog endpoint. Keep it loosely in sync with the catalog.
const PERMISSION_MODULES_FALLBACK = [
  { module: 'contacts',      actions: ['read', 'write', 'update', 'delete', 'export'] },
  { module: 'deals',         actions: ['read', 'write', 'update', 'delete', 'export', 'manage'] },
  { module: 'leads',         actions: ['read', 'write', 'update', 'delete', 'export'] },
  { module: 'tasks',         actions: ['read', 'write', 'update', 'delete'] },
  { module: 'tickets',       actions: ['read', 'write', 'update', 'delete'] },
  { module: 'marketing',     actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'reports',       actions: ['read', 'write', 'delete', 'export'] },
  { module: 'billing',       actions: ['read', 'write', 'update', 'delete', 'export', 'manage'] },
  { module: 'patients',      actions: ['read', 'write', 'update', 'delete', 'export', 'manage'] },
  { module: 'appointments',  actions: ['read', 'write', 'update', 'delete', 'export'] },
  { module: 'prescriptions', actions: ['read', 'write', 'update', 'delete'] },
  { module: 'visits',        actions: ['read', 'write', 'update', 'delete'] },
  { module: 'inventory',     actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'pos',           actions: ['read', 'write', 'manage'] },
  { module: 'workflows',     actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'integrations',  actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'audit',         actions: ['read', 'export'] },
  { module: 'staff',         actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'roles',         actions: ['read', 'manage'] },
  { module: 'settings',      actions: ['read', 'manage'] },
];

export default function RolesAdmin() {
  const {
    hasPermission,
    isLoading: permLoading,
    refresh: refreshPermissions,
  } = usePermissions();
  const canRead = hasPermission('roles', 'read');
  const canManage = hasPermission('roles', 'manage');

  const [roles, setRoles] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [permissionModules, setPermissionModules] = useState(
    PERMISSION_MODULES_FALLBACK,
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [permRole, setPermRole] = useState(null);
  const [usersRole, setUsersRole] = useState(null);

  const notify = useNotify();

  const loadRoles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetchApi('/api/roles');
      setRoles(Array.isArray(res?.roles) ? res.roles : []);
    } catch (err) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch the server's permission catalog so the matrix can never offer a
  // checkbox the validator will reject. If the endpoint is unavailable
  // (older backend), the fallback constant keeps the page functional.
  useEffect(() => {
    if (permLoading || !canRead) return;
    let cancelled = false;
    fetchApi('/api/roles/catalog')
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.modules) ? res.modules : null;
        if (list && list.length) setPermissionModules(list);
      })
      .catch(() => {
        // Stay on the fallback; fetchApi already surfaced any toast.
      });
    return () => {
      cancelled = true;
    };
  }, [permLoading, canRead]);

  useEffect(() => {
    if (!permLoading && canRead) loadRoles();
  }, [permLoading, canRead, loadRoles]);

  if (permLoading) {
    return (
      <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>
        Loading…
      </div>
    );
  }
  if (!canRead) {
    return <AccessDenied permission={{ module: 'roles', action: 'read' }} />;
  }

  const refreshAll = async () => {
    invalidatePermissionCache();
    await Promise.all([refreshPermissions().catch(() => {}), loadRoles()]);
  };

  const handleDelete = async (role) => {
    if (
      !window.confirm(
        `Delete role "${role.name}"? Users assigned to this role will lose its permissions.`,
      )
    ) {
      return;
    }
    try {
      await fetchApi(`/api/roles/${role.id}`, { method: 'DELETE' });
      notify.success?.(`Role "${role.name}" deleted`);
      await refreshAll();
    } catch {
      // fetchApi already showed a toast; nothing else needed.
    }
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1200 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ marginBottom: '0.25rem' }}>Roles &amp; permissions</h1>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.875rem',
              margin: 0,
            }}
          >
            Manage RBAC roles and their permission grants for this tenant.
            System roles cannot be modified.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <Plus size={16} /> New role
          </button>
        )}
      </div>

      {error && !isLoading && (
        <div
          role="alert"
          style={{
            background: 'rgba(239,68,68,0.1)',
            color: '#ef4444',
            padding: '0.75rem',
            borderRadius: 8,
            marginBottom: '1rem',
          }}
        >
          Could not load roles: {error.message}
        </div>
      )}

      <div
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          overflow: 'auto',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.9rem',
            minWidth: 760,
          }}
        >
          <thead>
            <tr
              style={{
                background: 'var(--subtle-bg-3)',
                textAlign: 'left',
              }}
            >
              <Th>Role</Th>
              <Th>Key</Th>
              <Th>User type</Th>
              <Th>Type</Th>
              <Th>Users</Th>
              <Th>Permissions</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <Td colSpan={7} center>
                  Loading roles…
                </Td>
              </tr>
            )}
            {!isLoading && roles.length === 0 && (
              <tr>
                <Td colSpan={7} center>
                  No roles yet.
                </Td>
              </tr>
            )}
            {!isLoading &&
              roles.map((r) => (
                <tr
                  key={r.id}
                  style={{ borderTop: '1px solid var(--border-color)' }}
                >
                  <Td>
                    <strong>{r.name}</strong>
                    {r.description && (
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {r.description}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <code style={{ fontSize: '0.8rem' }}>{r.key}</code>
                  </Td>
                  <Td>{r.userType || 'STAFF'}</Td>
                  <Td>
                    {r.isSystem ? (
                      <Badge color="amber">System</Badge>
                    ) : (
                      <Badge color="blue">Custom</Badge>
                    )}
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setUsersRole(r)}
                      style={linkBtn}
                      aria-label={`View ${r.userCount ?? 0} users in ${r.name}`}
                    >
                      <Users size={14} /> {r.userCount ?? 0}
                    </button>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setPermRole(r)}
                      style={linkBtn}
                      aria-label={`View permissions for ${r.name}`}
                    >
                      <Shield size={14} />{' '}
                      {Array.isArray(r.permissions) ? r.permissions.length : 0}
                    </button>
                  </Td>
                  <Td>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => handleDelete(r)}
                        className="btn-secondary"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                          fontSize: '0.8rem',
                        }}
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    ) : (
                      <span
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        —
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <CreateRoleModal
          onClose={() => setCreateOpen(false)}
          onSuccess={async () => {
            setCreateOpen(false);
            await loadRoles();
          }}
        />
      )}
      {permRole && (
        <PermissionsModal
          role={permRole}
          modules={permissionModules}
          readOnly={!canManage}
          onClose={() => setPermRole(null)}
          onSaved={async () => {
            await refreshAll();
            setPermRole(null);
          }}
        />
      )}
      {usersRole && (
        <UsersModal
          role={usersRole}
          canManage={canManage}
          onClose={() => setUsersRole(null)}
          onChange={() => refreshAll()}
        />
      )}
    </div>
  );
}

// ───────────────────────── Create role modal ─────────────────────────

function CreateRoleModal({ onClose, onSuccess }) {
  const [form, setForm] = useState({
    name: '',
    key: '',
    description: '',
    userType: 'STAFF',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState({});
  const notify = useNotify();

  const submit = async (ev) => {
    ev.preventDefault();
    setError('');
    const fieldErrors = {};
    if (!form.name.trim()) fieldErrors.name = 'Required';
    if (!form.key.trim()) fieldErrors.key = 'Required';
    else if (!/^[A-Z][A-Z0-9_]*$/.test(form.key.trim())) {
      fieldErrors.key = 'Uppercase letters, digits, underscores; must start with a letter';
    }
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length) return;

    setIsLoading(true);
    try {
      await fetchApi('/api/roles', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          key: form.key.trim().toUpperCase(),
          description: form.description.trim() || undefined,
          userType: form.userType,
        }),
      });
      notify.success?.(`Role "${form.name.trim()}" created`);
      onSuccess();
    } catch (err) {
      setError(err.message || 'Could not create role');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ModalShell title="Create a new role" onClose={onClose} width={500}>
      <form onSubmit={submit} noValidate>
        <Field label="Display name" error={errors.name}>
          <input
            type="text"
            className="input-field"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Receptionist"
            disabled={isLoading}
            required
          />
        </Field>
        <Field label="Key" error={errors.key} help="Unique within this tenant. Uppercase + underscores only.">
          <input
            type="text"
            className="input-field"
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })}
            placeholder="e.g. RECEPTIONIST"
            disabled={isLoading}
            required
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            className="input-field"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="What this role is for"
            disabled={isLoading}
            style={{ resize: 'vertical', minHeight: 60 }}
          />
        </Field>
        <Field label="User type" help="Which kind of user this role can be assigned to.">
          <select
            className="input-field"
            value={form.userType}
            onChange={(e) => setForm({ ...form, userType: e.target.value })}
            disabled={isLoading}
          >
            <option value="STAFF">Staff</option>
            <option value="CUSTOMER">Customer</option>
          </select>
        </Field>
        {error && (
          <div role="alert" style={errBoxStyle}>{error}</div>
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={isLoading}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={isLoading}>
            {isLoading ? 'Creating…' : 'Create role'}
          </button>
        </ModalActions>
      </form>
    </ModalShell>
  );
}

// ──────────────────────── Permissions matrix modal ───────────────────

function PermissionsModal({ role, modules, readOnly, onClose, onSaved }) {
  const matrix =
    Array.isArray(modules) && modules.length
      ? modules
      : PERMISSION_MODULES_FALLBACK;
  // Hydrate from role.permissions (the list endpoint already includes them).
  // We keep a Set of "module.action" strings for O(1) lookup + toggle.
  const initial = useMemo(() => {
    const s = new Set();
    (role.permissions || []).forEach((p) => {
      const m = p?.module;
      const a = p?.action;
      if (m && a) s.add(`${m}.${a}`);
    });
    return s;
  }, [role]);

  const [selected, setSelected] = useState(initial);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const notify = useNotify();

  const toggle = (module, action) => {
    if (readOnly) return;
    const key = `${module}.${action}`;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const toggleModule = (module, actions, allSelected) => {
    if (readOnly) return;
    const next = new Set(selected);
    actions.forEach((a) => {
      const key = `${module}.${a}`;
      if (allSelected) next.delete(key);
      else next.add(key);
    });
    setSelected(next);
  };

  const save = async () => {
    setError('');
    setIsLoading(true);
    try {
      const body = Array.from(selected).map((s) => {
        const [module, action] = s.split('.');
        return { module, action };
      });
      await fetchApi(`/api/roles/${role.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: body }),
      });
      notify.success?.(`Permissions updated for "${role.name}"`);
      onSaved();
    } catch (err) {
      setError(err.message || 'Could not save permissions');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ModalShell
      title={`Permissions: ${role.name}`}
      subtitle={
        readOnly
          ? 'You do not have permission to edit roles.'
          : `Check the actions this role can perform.`
      }
      onClose={onClose}
      width={760}
    >
      <div
        style={{
          maxHeight: '60vh',
          overflowY: 'auto',
          padding: '0.25rem',
          marginBottom: '0.75rem',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              'repeat(auto-fill, minmax(min(100%, 220px), 1fr))',
            gap: '0.75rem',
          }}
        >
          {matrix.map(({ module, actions }) => {
            const allSelected = actions.every((a) =>
              selected.has(`${module}.${a}`),
            );
            const anySelected = actions.some((a) =>
              selected.has(`${module}.${a}`),
            );
            return (
              <div
                key={module}
                style={{
                  padding: '0.75rem',
                  borderRadius: 8,
                  border: '1px solid var(--border-color)',
                  // Selected modules get a slightly more opaque overlay so
                  // the user can see at a glance which modules carry grants.
                  // Both vars adapt to light/dark theme automatically.
                  background: anySelected ? 'var(--subtle-bg-3)' : 'var(--subtle-bg-2)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {module}
                  </span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() =>
                        toggleModule(module, actions, allSelected)
                      }
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '0.7rem',
                        color: 'var(--primary-color, var(--accent-color))',
                        padding: '0.1rem 0.3rem',
                      }}
                    >
                      {allSelected ? 'Clear' : 'All'}
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  {actions.map((a) => {
                    const key = `${module}.${a}`;
                    const checked = selected.has(key);
                    return (
                      <label
                        key={a}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          fontSize: '0.85rem',
                          cursor: readOnly ? 'not-allowed' : 'pointer',
                          opacity: readOnly ? 0.7 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(module, a)}
                          disabled={readOnly}
                          style={{ cursor: readOnly ? 'not-allowed' : 'pointer' }}
                        />
                        {a}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div role="alert" style={errBoxStyle}>{error}</div>
      )}

      <ModalActions>
        <span style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {selected.size} permission{selected.size === 1 ? '' : 's'} selected
        </span>
        <button type="button" onClick={onClose} className="btn-secondary" disabled={isLoading}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button type="button" onClick={save} className="btn-primary" disabled={isLoading}>
            {isLoading ? 'Saving…' : 'Save permissions'}
          </button>
        )}
      </ModalActions>
    </ModalShell>
  );
}

// ──────────────────────── Users-on-role modal ────────────────────────

function UsersModal({ role, canManage, onClose, onChange }) {
  const [members, setMembers] = useState([]);
  const [allStaff, setAllStaff] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStaffLoading, setIsStaffLoading] = useState(false);
  const [error, setError] = useState('');
  const [picker, setPicker] = useState('');
  const [busyUserId, setBusyUserId] = useState(null);
  const notify = useNotify();

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await fetchApi(`/api/roles/${role.id}/users`);
      setMembers(Array.isArray(res?.users) ? res.users : []);
    } catch (err) {
      setError(err.message || 'Could not load users');
    } finally {
      setIsLoading(false);
    }
  }, [role.id]);

  const loadStaffList = useCallback(async () => {
    if (!canManage) return;
    setIsStaffLoading(true);
    try {
      // /api/staff returns the current tenant's users — same scope as roles.
      // TODO: replace with a dedicated /api/users?available-for-role=N endpoint
      // once tenants get larger than a single dropdown can handle.
      const res = await fetchApi('/api/staff');
      const list = Array.isArray(res) ? res : Array.isArray(res?.staff) ? res.staff : [];
      setAllStaff(list);
    } catch {
      // Non-fatal; the picker just renders empty.
    } finally {
      setIsStaffLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    load();
    loadStaffList();
  }, [load, loadStaffList]);

  const assignedIds = useMemo(
    () => new Set(members.map((m) => m.id)),
    [members],
  );
  const available = useMemo(
    () => allStaff.filter((u) => !assignedIds.has(u.id)),
    [allStaff, assignedIds],
  );

  const assign = async () => {
    if (!picker) return;
    setBusyUserId(parseInt(picker, 10));
    try {
      await fetchApi(`/api/roles/${role.id}/assign/${picker}`, {
        method: 'POST',
      });
      notify.success?.('Role assigned');
      setPicker('');
      await load();
      onChange?.();
    } catch {
      // toast handled by fetchApi
    } finally {
      setBusyUserId(null);
    }
  };

  const unassign = async (userId) => {
    if (!window.confirm('Remove this role from the user?')) return;
    setBusyUserId(userId);
    try {
      await fetchApi(`/api/roles/${role.id}/assign/${userId}`, {
        method: 'DELETE',
      });
      notify.success?.('Role removed');
      await load();
      onChange?.();
    } catch {
      // toast handled
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <ModalShell
      title={`Members of ${role.name}`}
      subtitle={
        canManage
          ? 'Assign or remove users from this role. Changes apply immediately.'
          : 'You do not have permission to manage role assignments.'
      }
      onClose={onClose}
      width={620}
    >
      {canManage && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            marginBottom: '1rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <select
            className="input-field"
            value={picker}
            onChange={(e) => setPicker(e.target.value)}
            disabled={isStaffLoading || available.length === 0}
            style={{ flex: 1, minWidth: 220 }}
          >
            <option value="">
              {isStaffLoading
                ? 'Loading users…'
                : available.length === 0
                  ? 'All eligible users are already assigned'
                  : 'Select a user to add…'}
            </option>
            {available.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email} {u.email && u.name ? `(${u.email})` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={assign}
            disabled={!picker || busyUserId != null}
            className="btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
          >
            <UserPlus size={14} />
            {busyUserId && picker && busyUserId === parseInt(picker, 10) ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      {error && (
        <div role="alert" style={errBoxStyle}>{error}</div>
      )}

      <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'auto', maxHeight: '50vh' }}>
        {isLoading && (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading members…</div>
        )}
        {!isLoading && members.length === 0 && (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
            No users assigned yet.
          </div>
        )}
        {!isLoading && members.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'var(--subtle-bg-3)', textAlign: 'left' }}>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Type</Th>
                {canManage && <Th>{''}</Th>}
              </tr>
            </thead>
            <tbody>
              {members.map((u) => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <Td>{u.name || '—'}</Td>
                  <Td>{u.email}</Td>
                  <Td>{u.userType || 'STAFF'}</Td>
                  {canManage && (
                    <Td>
                      <button
                        type="button"
                        onClick={() => unassign(u.id)}
                        className="btn-secondary"
                        disabled={busyUserId === u.id}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                          fontSize: '0.75rem',
                        }}
                      >
                        <UserMinus size={12} />
                        {busyUserId === u.id ? 'Removing…' : 'Remove'}
                      </button>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ModalActions>
        <button type="button" onClick={onClose} className="btn-secondary">
          Close
        </button>
      </ModalActions>
    </ModalShell>
  );
}

// ───────────────────────── Shared UI primitives ──────────────────────

function Th({ children }) {
  return (
    <th
      style={{
        padding: '0.6rem 0.85rem',
        fontWeight: 600,
        fontSize: '0.75rem',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--text-secondary)',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, colSpan, center }) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: '0.6rem 0.85rem',
        verticalAlign: 'middle',
        textAlign: center ? 'center' : 'left',
        color: center ? 'var(--text-secondary)' : 'inherit',
      }}
    >
      {children}
    </td>
  );
}

function Badge({ color = 'blue', children }) {
  const palette = {
    blue:  { bg: 'rgba(59,130,246,0.12)',  fg: '#3b82f6', bd: 'rgba(59,130,246,0.3)' },
    amber: { bg: 'rgba(245,158,11,0.12)',  fg: '#f59e0b', bd: 'rgba(245,158,11,0.3)' },
    green: { bg: 'rgba(16,185,129,0.12)',  fg: '#10b981', bd: 'rgba(16,185,129,0.3)' },
  };
  const c = palette[color] || palette.blue;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.15rem 0.5rem',
        borderRadius: 999,
        fontSize: '0.7rem',
        fontWeight: 600,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
      }}
    >
      {children}
    </span>
  );
}

const linkBtn = {
  background: 'transparent',
  border: '1px solid var(--border-color)',
  padding: '0.25rem 0.55rem',
  borderRadius: 6,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  fontSize: '0.8rem',
  color: 'inherit',
};

const errBoxStyle = {
  background: 'rgba(239,68,68,0.1)',
  color: '#ef4444',
  padding: '0.6rem 0.75rem',
  borderRadius: 6,
  fontSize: '0.85rem',
  marginBottom: '0.75rem',
};

function ModalShell({ title, subtitle, onClose, width = 480, children }) {
  // Lock body scroll while the modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(2px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          width: '100%',
          maxWidth: width,
          maxHeight: '90vh',
          overflow: 'auto',
          // --surface-color is the actual theme-aware translucent surface.
          // The earlier `var(--surface, #fff)` was a bug: --surface doesn't
          // exist anywhere, so it always fell back to solid white — and
          // text-primary in dark mode is also white → white-on-white modal.
          background: 'var(--surface-color)',
          color: 'var(--text-primary)',
          borderRadius: 12,
          border: '1px solid var(--border-color)',
          padding: '1.25rem',
          boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '0.5rem',
            marginBottom: subtitle ? '0.5rem' : '1rem',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h2>
            {subtitle && (
              <p
                style={{
                  margin: '0.2rem 0 0',
                  color: 'var(--text-secondary)',
                  fontSize: '0.8rem',
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              padding: '0.25rem',
            }}
          >
            <X size={18} />
          </button>
        </div>
        {subtitle && <div style={{ marginBottom: '0.75rem' }} />}
        {children}
      </div>
    </div>
  );
}

function ModalActions({ children }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '0.5rem',
        marginTop: '0.75rem',
        alignItems: 'center',
      }}
    >
      {children}
    </div>
  );
}

function Field({ label, error, help, children }) {
  return (
    <div style={{ marginBottom: '0.85rem' }}>
      <label
        style={{
          display: 'block',
          fontSize: '0.8rem',
          color: 'var(--text-secondary)',
          marginBottom: '0.25rem',
          fontWeight: 500,
        }}
      >
        {label}
      </label>
      {children}
      {help && !error && (
        <small
          style={{
            display: 'block',
            marginTop: '0.25rem',
            color: 'var(--text-secondary)',
            fontSize: '0.7rem',
          }}
        >
          {help}
        </small>
      )}
      {error && (
        <small
          role="alert"
          style={{
            display: 'block',
            marginTop: '0.25rem',
            color: '#ef4444',
            fontSize: '0.75rem',
          }}
        >
          {error}
        </small>
      )}
    </div>
  );
}
