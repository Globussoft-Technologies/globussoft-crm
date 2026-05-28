import { Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

// In-page "you don't have access" empty state for permission-gated routes
// and page-level guards. Mirrors RoleGuard's <LockedPanel> visual language
// so the user gets a consistent locked-state across legacy role gates and
// new RBAC permission gates.
//
// Usage:
//   <AccessDenied permission={{ module: 'roles', action: 'read' }} />
//   <AccessDenied title="Roles" message="Custom copy here" />
//   <AccessDenied inline />   // narrower, no nav buttons — for in-card use
export default function AccessDenied({
  title = "You don't have access to this page",
  message,
  permission,
  showActions = true,
  inline = false,
}) {
  const navigate = useNavigate();
  const body =
    message ||
    (permission
      ? `This page requires the "${permission.module}.${permission.action}" permission. Contact your administrator to request access.`
      : 'Contact your administrator to request access.');

  return (
    <div
      role="region"
      aria-label="Access denied"
      data-testid="access-denied"
      style={{
        padding: inline ? '1.5rem 1rem' : '3rem 2rem',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        minHeight: inline ? 'auto' : '60vh',
        color: 'var(--text-primary)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: inline ? 48 : 64,
          height: inline ? 48 : 64,
          borderRadius: '50%',
          background: 'var(--subtle-bg-3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '1rem',
        }}
      >
        <Lock size={inline ? 22 : 28} aria-hidden="true" />
      </div>
      <h2 style={{ fontSize: inline ? '1rem' : '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>
        {title}
      </h2>
      <p style={{ color: 'var(--text-secondary)', maxWidth: 480, lineHeight: 1.5, margin: 0 }}>
        {body}
      </p>
      {showActions && !inline && (
        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="btn-primary"
          >
            Go to dashboard
          </button>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="btn-secondary"
          >
            Go back
          </button>
        </div>
      )}
    </div>
  );
}
