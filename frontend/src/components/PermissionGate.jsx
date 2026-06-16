import React from 'react';
import { usePermissions } from '../hooks/usePermissions';

/**
 * Conditionally render an action / button / control based on the
 * signed-in user's RBAC permissions.
 *
 * Wraps `usePermissions().hasPermission(module, action)` so the
 * inline pattern `hasPermission('quotes', 'write') && <button>...`
 * doesn't have to be re-derived at every call site, and so denial
 * UX (hidden vs. disabled-with-tooltip) is consistent across the app.
 *
 * ── Usage ──────────────────────────────────────────────────────────
 *
 *   // 1. Hide the action when the user lacks permission (most common):
 *   <PermissionGate module="quotes" action="write">
 *     <button onClick={createQuote}>New Quote</button>
 *   </PermissionGate>
 *
 *   // 2. Show a disabled placeholder with a tooltip explaining why:
 *   <PermissionGate module="quotes" action="delete" mode="disable">
 *     <button onClick={onDelete}>Delete</button>
 *   </PermissionGate>
 *
 *   // 3. Custom fallback element (dash, lock icon, "—"):
 *   <PermissionGate
 *     module="suppliers"
 *     action="manage"
 *     fallback={<span style={{ opacity: 0.5 }}>Locked</span>}
 *   >
 *     <button>Reveal Credential</button>
 *   </PermissionGate>
 *
 *   // 4. Multiple permissions (AND-join):
 *   <PermissionGate require={[{ module: 'quotes', action: 'read' }, { module: 'quotes', action: 'write' }]}>
 *     <button>Save & Send</button>
 *   </PermissionGate>
 *
 * ── Props ──────────────────────────────────────────────────────────
 *
 *   module    string  — single permission's module (e.g. "quotes")
 *   action    string  — single permission's action (e.g. "write")
 *   require   array   — alternative to module+action; AND-join of
 *                       {module, action} entries; user must have ALL
 *   mode      "hide" | "disable" (default "hide")
 *                       - "hide":    children render only if permitted;
 *                                    otherwise `fallback` renders.
 *                       - "disable": children ALWAYS render. When not
 *                                    permitted, the child element is
 *                                    cloned with disabled=true + a
 *                                    title tooltip explaining the
 *                                    missing permission.
 *   fallback  ReactNode — what to render in "hide" mode when not
 *                         permitted. Defaults to null (renders nothing).
 *
 * ── Behavior during initial permission load ───────────────────────
 *
 *   While permissions are still resolving (`!isReady`), this component
 *   defers rendering to its `fallback` in "hide" mode (so we don't
 *   flash content the user can't see) and renders children in
 *   "disable" mode. Backend gates remain the authoritative check —
 *   this component is a UX layer only.
 *
 * ── What this is NOT ──────────────────────────────────────────────
 *
 *   - NOT a security boundary. Backend `requirePermission` middleware
 *     is the security gate. PermissionGate is purely UX.
 *   - NOT for route-level access. Use `<RoleGuard requiredPermission=…>`
 *     for page-level routing decisions.
 *   - NOT for OWNER bypass. usePermissions().hasPermission already
 *     short-circuits to true for OWNER users.
 */
export default function PermissionGate({
  module,
  action,
  require,
  mode = 'hide',
  fallback = null,
  children,
}) {
  const { hasPermission, hasAllPermissions, isReady } = usePermissions();

  const checks = Array.isArray(require)
    ? require
    : module && action
      ? [{ module, action }]
      : [];

  if (checks.length === 0) {
    // Misconfigured — render children defensively rather than break
    // the page. A console warning helps surface the mistake.
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        'PermissionGate: no module+action or require[] supplied; rendering children unguarded.',
      );
    }
    return children;
  }

  // Pre-resolve: in "hide" mode, default to hidden to avoid a
  // flash-of-action-the-user-can't-perform. In "disable" mode,
  // show the disabled child so the layout doesn't shift when
  // permissions resolve.
  if (!isReady) {
    if (mode === 'disable') {
      return cloneAsDisabled(children, checks);
    }
    return fallback;
  }

  const granted =
    checks.length === 1
      ? hasPermission(checks[0].module, checks[0].action)
      : hasAllPermissions(checks);

  if (granted) return children;

  if (mode === 'disable') {
    return cloneAsDisabled(children, checks);
  }
  return fallback;
}

function cloneAsDisabled(children, checks) {
  if (!React.isValidElement(children)) return children;
  const missingLabel = checks.map((c) => `${c.module}.${c.action}`).join(', ');
  return React.cloneElement(children, {
    disabled: true,
    'aria-disabled': 'true',
    title: `Requires the "${missingLabel}" permission${checks.length > 1 ? 's' : ''}. Contact your administrator.`,
    onClick: undefined,
    style: { ...(children.props.style || {}), opacity: 0.5, cursor: 'not-allowed' },
  });
}
