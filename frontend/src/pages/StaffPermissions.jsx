import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { usePermissions } from '../hooks/usePermissions';
import AccessDenied from '../components/AccessDenied';

// Per-target user permission view at /staff/:userId/permissions.
//
// Mirrors the visual layout of MyPermissions (account tiles → assigned roles
// → effective permissions grouped by module) but is driven by a userId URL
// param + the backend /api/users/:userId/permissions endpoint.
//
// Page-level guard: requires roles.read (matches the route's intent — staff
// directory admins use this to see what a teammate can do). Non-permitted
// users see the same AccessDenied card the rest of the RBAC pages use.
export default function StaffPermissions() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const {
    hasPermission,
    isLoading: permLoading,
  } = usePermissions();
  const canRead = hasPermission('roles', 'read');

  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Skip the fetch entirely if the viewer lacks roles.read — backend
    // would 403 anyway, no point firing a doomed request that pollutes the
    // toast stream.
    if (permLoading || !canRead) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetchApi(`/api/users/${encodeURIComponent(userId)}/permissions`, {
      silent: true,
    })
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
        setData(null);
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, canRead, permLoading]);

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

  const target = data?.user;
  const isOwnerTarget = data?.isOwner;
  const permissions = data?.permissions || [];
  const roles = data?.roles || [];
  const grouped = groupByModule(permissions);

  return (
    <div style={{ padding: '1.5rem', maxWidth: 960 }}>
      <button
        type="button"
        onClick={() => navigate('/staff')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.3rem',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          padding: '0.25rem 0',
          marginBottom: '0.75rem',
          fontSize: '0.85rem',
        }}
      >
        <ArrowLeft size={14} /> Back to Staff Directory
      </button>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ marginBottom: '0.25rem' }}>
            {target?.name || target?.email || 'User'} — permissions
          </h1>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.875rem',
              margin: 0,
            }}
          >
            Effective permissions, computed from every role assigned to this
            user. To change them, edit the user&apos;s role assignments under
            Roles &amp; permissions.
          </p>
        </div>
        <Link
          to="/settings/roles"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.45rem 0.9rem',
            borderRadius: 8,
            background: 'var(--subtle-bg-3)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
            textDecoration: 'none',
            fontSize: '0.85rem',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          <ShieldCheck size={14} /> Manage roles
        </Link>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
          gap: '0.75rem',
          marginTop: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <Card label="Account">{target?.email || '—'}</Card>
        <Card label="User type">{data?.userType || target?.userType || 'STAFF'}</Card>
        <Card label="Legacy role">{target?.role || '—'}</Card>
        {target?.wellnessRole && (
          <Card label="Wellness role">{target.wellnessRole}</Card>
        )}
        {target?.deactivatedAt && (
          <Card label="Status">
            <span style={{ color: '#ef4444', fontWeight: 600 }}>Inactive</span>
          </Card>
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
          Could not load permissions: {error.message || 'Unknown error'}
        </div>
      )}

      {!isLoading && !error && (
        <>
          <Section title="Assigned roles">
            {roles.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                {isOwnerTarget
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
            {isOwnerTarget ? (
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
