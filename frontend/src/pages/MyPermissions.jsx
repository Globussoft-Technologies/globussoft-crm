import { useContext } from 'react';
import { AuthContext } from '../App';
import { usePermissions } from '../hooks/usePermissions';
import AccessDenied from '../components/AccessDenied';

// Read-only display of the current user's effective permissions, merged across
// all roles. Useful for: (a) the user verifying what they can do, (b) an
// admin temporarily switching to the user's seat to debug an access issue.
//
// Mounts under /profile/permissions. Gated behind `roles.read` — viewing
// effective-permission listings is an admin tool (it's also how the same
// page model is reused for /staff/:userId/permissions to view *other*
// users' permissions). Non-permitted users see the shared AccessDenied
// card rather than a working page, matching /settings/roles' gating style.
export default function MyPermissions() {
  const { user } = useContext(AuthContext) || {};
  const {
    permissions,
    roles,
    isOwner,
    userType,
    isLoading,
    error,
    hasPermission,
    isReady,
  } = usePermissions();
  const canRead = hasPermission('roles', 'read');

  // Wait for the permission fetch to resolve before deciding. Without this,
  // the page would flash AccessDenied for ~one frame on cold-load for users
  // who DO have the grant — `hasPermission` returns false until isReady.
  if (!isReady && isLoading) {
    return (
      <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>
        Loading…
      </div>
    );
  }
  if (!canRead && !isOwner) {
    return <AccessDenied permission={{ module: 'roles', action: 'read' }} />;
  }

  const grouped = groupByModule(permissions);

  return (
    <div style={{ padding: '1.5rem', maxWidth: 960 }}>
      <h1 style={{ marginBottom: '0.25rem' }}>My permissions</h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: '0.875rem',
          marginBottom: '1.5rem',
        }}
      >
        These are your effective permissions, computed from every role assigned
        to you. Contact your administrator to request more access.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
          gap: '0.75rem',
          marginBottom: '1.5rem',
        }}
      >
        <Card label="Account">{user?.email || '—'}</Card>
        <Card label="User type">{userType || 'STAFF'}</Card>
        <Card label="Legacy role">{user?.role || '—'}</Card>
        {user?.wellnessRole && (
          <Card label="Wellness role">{user.wellnessRole}</Card>
        )}
      </div>

      {isLoading && (
        <p style={{ color: 'var(--text-secondary)' }}>Loading permissions…</p>
      )}
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
          Could not load permissions: {error.message}
        </div>
      )}

      {!isLoading && (
        <>
          <Section title="Assigned roles">
            {roles.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                {isOwner
                  ? 'OWNER — bypasses the role system'
                  : 'No RBAC roles assigned.'}
              </p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {roles.map((r) => (
                  <span
                    key={r}
                    style={{
                      padding: '0.25rem 0.6rem',
                      borderRadius: 999,
                      background: 'var(--subtle-bg-3)',
                      border: '1px solid var(--border-color)',
                      fontSize: '0.8rem',
                      fontWeight: 500,
                    }}
                  >
                    {r}
                  </span>
                ))}
              </div>
            )}
          </Section>

          <Section title="Effective permissions">
            {isOwner ? (
              <p style={{ color: '#10b981', fontWeight: 500, margin: 0 }}>
                ✓ Platform admin — full access to every module
              </p>
            ) : grouped.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                No permissions granted.
              </p>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
                  gap: '0.75rem',
                }}
              >
                {grouped.map(([module, actions]) => (
                  <div
                    key={module}
                    style={{
                      padding: '0.75rem',
                      borderRadius: 8,
                      border: '1px solid var(--border-color)',
                      background: 'var(--subtle-bg-2)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--text-secondary)',
                        marginBottom: '0.4rem',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {module}
                    </div>
                    <ul
                      style={{
                        listStyle: 'none',
                        padding: 0,
                        margin: 0,
                        fontSize: '0.85rem',
                      }}
                    >
                      {actions.map((a) => (
                        <li key={a} style={{ padding: '0.15rem 0' }}>
                          ✓ {a}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Card({ label, children }) {
  return (
    <div
      style={{
        padding: '0.65rem 0.85rem',
        borderRadius: 8,
        border: '1px solid var(--border-color)',
        background: 'var(--subtle-bg-2)',
      }}
    >
      <div
        style={{
          fontSize: '0.7rem',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          letterSpacing: '0.04em',
          marginBottom: '0.2rem',
        }}
      >
        {label}
      </div>
      <div style={{ fontWeight: 500, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>{title}</h2>
      {children}
    </div>
  );
}

function groupByModule(permissions) {
  const map = new Map();
  (permissions || []).forEach((p) => {
    const [module, action] = String(p).split('.');
    if (!module || !action) return;
    if (!map.has(module)) map.set(module, []);
    map.get(module).push(action);
  });
  for (const [, arr] of map) arr.sort();
  return Array.from(map.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
}
