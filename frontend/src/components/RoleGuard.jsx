import React, { useContext } from 'react';
import { Lock } from 'lucide-react';
import { AuthContext } from '../App';

/**
 * RoleGuard — route-level RBAC gate.
 *
 * #768 CANONICAL permission-denial pattern (2026-05-15). When the caller's
 * role is not in `allow`, RoleGuard renders ONE full-page lock panel in
 * place of the protected children:
 *
 *   - NO toast.
 *   - NO redirect.
 *   - NO partial page render — children never mount, so an info-disclosure-
 *     sensitive page (/audit-log, /settings, /staff, /field-permissions)
 *     never leaks its chrome / internal model names / KPI shapes.
 *
 * Pre-#768 this component had TWO modes — strict (redirect + toast) and
 * `lockedInPlace` (panel + toast) — which produced the three inconsistent
 * denial behaviours the pen-test cluster #756-#768 flagged (toast-over-a-
 * working-page, toast + full-page lock, silent redirect to Calendar with
 * stacked toasts). Both modes, the toast, and the redirect are gone. There
 * is now exactly ONE behaviour.
 *
 * Props:
 *   allow     — string | string[]   role(s) that pass the gate
 *   children  — React node          the protected page
 *   feature   — string (optional)   user-facing feature label, e.g.
 *                                    "Gift Cards" — drives the lock-panel
 *                                    heading ("Gift Cards is restricted").
 *   roles     — string (optional)   user-facing role list, e.g.
 *                                    "manager (or admin)". Falls back to a
 *                                    humanised form of `allow`.
 *   message   — string (optional)   legacy escape hatch — a full custom
 *                                    denial sentence. Used as the lock-panel
 *                                    body when `feature` is not supplied.
 *
 * Auth-loading safety (#721): while the session is still rehydrating
 * (`loading` true) OR the user is null after loading completes (corrupted /
 * cold-start session), RoleGuard renders nothing rather than flashing a
 * denial panel at a user whose session simply hadn't finished loading. The
 * upstream Layout wrapper is responsible for the /login bounce.
 */
const ROLE_LABELS = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  USER: 'staff',
};

function humaniseRoles(allow) {
  const arr = Array.isArray(allow) ? allow : [allow];
  const labels = arr.map((r) => ROLE_LABELS[r] || String(r).toLowerCase());
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}

export default function RoleGuard({ allow, children, message, feature, roles }) {
  const auth = useContext(AuthContext) || {};
  const { user, loading } = auth;
  const role = user?.role;
  const allowed = Array.isArray(allow) ? allow.includes(role) : role === allow;

  // #721 auth-loading safety: don't flash the denial panel while the session
  // is still rehydrating, or when a corrupted session leaves user=null after
  // loading completes. Render nothing; the upstream Layout wrapper handles
  // the /login bounce on its own pass.
  const sessionReady = !loading && !!user && !!role;
  if (!sessionReady) return null;

  if (allowed) return children;

  return (
    <LockedPanel
      feature={feature}
      rolesText={roles || humaniseRoles(allow)}
      message={message}
    />
  );
}

/**
 * LockedPanel — the single "you don't have access" full-page state. Renders
 * inside the same <main> the page would have used so the URL stays intact
 * and the sidebar/header chrome remain visible. No KPI leakage, no internal
 * model names — only the human label + role requirement.
 *
 * Copy precedence:
 *   1. `feature` + `rolesText` → "<feature> is restricted" + role guidance
 *   2. `message` only          → generic heading + the custom sentence
 *   3. neither                 → fully generic copy
 */
function LockedPanel({ feature, rolesText, message }) {
  const heading = feature ? `${feature} is restricted` : 'This page is restricted';
  let body;
  if (feature && rolesText) {
    body = `You need ${rolesText} access to view this page. Contact your administrator to request access.`;
  } else if (message) {
    body = message;
  } else {
    body = 'Contact your administrator to request access.';
  }
  return (
    <div
      role="region"
      aria-label={heading}
      data-testid="role-guard-locked-panel"
      style={{
        padding: '3rem 2rem',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        minHeight: '60vh',
        color: 'var(--text-primary)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: 'var(--surface-elevated, rgba(0,0,0,0.05))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '1rem',
        }}
      >
        <Lock size={28} aria-hidden="true" />
      </div>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>{heading}</h2>
      <p style={{ color: 'var(--text-secondary)', maxWidth: 480, lineHeight: 1.5 }}>{body}</p>
    </div>
  );
}
