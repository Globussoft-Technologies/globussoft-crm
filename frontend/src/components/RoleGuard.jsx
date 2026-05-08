import React, { useContext, useEffect, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthContext } from '../App';
import { useNotify } from '../utils/notify';

/**
 * RoleGuard — route-level RBAC gate.
 *
 * Renders children only when the current user's role is in `allow`. Otherwise
 * redirects (default `/dashboard` since there's no /403 page) WITHOUT mounting
 * the wrapped page — so the page's chrome (KPI cards, filter UI, etc.) never
 * appears for a non-privileged user. A single denial toast emits once per
 * mount via notify.error.
 *
 * #589: replaces the prior "render-and-toast" pattern at /audit-log where
 * USER role saw the full Audit Log shell with zeroed cards + filter UI before
 * the error toast surfaced — leaking the existence of the audit pipeline,
 * tracked entities, and the role-name "System Admin".
 */
export default function RoleGuard({ allow, children, redirectTo = '/dashboard', message }) {
  const { user } = useContext(AuthContext) || {};
  const notify = useNotify();
  const role = user?.role;
  const allowed = Array.isArray(allow) ? allow.includes(role) : role === allow;
  const toastedRef = useRef(false);

  useEffect(() => {
    if (!allowed && !toastedRef.current) {
      toastedRef.current = true;
      notify.error(message || "You don't have access to that page.");
    }
  }, [allowed, notify, message]);

  if (!allowed) return <Navigate to={redirectTo} replace />;
  return children;
}
