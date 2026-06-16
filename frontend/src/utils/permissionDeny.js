/**
 * Permission-denied notification helper.
 *
 * Standardizes the user-facing copy that surfaces when a user attempts
 * an action they don't have the RBAC permission for. Two patterns:
 *
 *   1. Pre-flight (preferred) — check the permission BEFORE calling the
 *      API. If denied, surface a clear toast and skip the network roundtrip:
 *
 *        const { hasPermission } = usePermissions();
 *        const notify = useNotify();
 *
 *        function handleDelete() {
 *          if (!hasPermission('quotes', 'delete')) {
 *            notifyPermissionDenied(notify, { module: 'quotes', action: 'delete', feature: 'Delete Quote' });
 *            return;
 *          }
 *          // ... do the delete
 *        }
 *
 *   2. Backend 403 fallback — when the API rejects with HTTP 403, surface
 *      the friendly copy instead of the generic API error:
 *
 *        try {
 *          await fetchApi('/api/travel/quotes/' + id, { method: 'DELETE' });
 *        } catch (err) {
 *          if (err.status === 403) {
 *            notifyPermissionDenied(notify, { module: 'quotes', action: 'delete' });
 *            return;
 *          }
 *          throw err;
 *        }
 *
 * Why centralize this:
 *   - One canonical copy avoids "Permission denied" / "Forbidden" /
 *     "You can't do that" / "Access denied" sprinkled across pages.
 *   - Includes the permission key in the message so admins can
 *     reverse-engineer what grant they need to give the user.
 *   - Matches the "Contact your administrator" trailer that
 *     AccessDenied.jsx uses, so page-level + action-level denials
 *     read as one consistent voice.
 */

/**
 * @typedef {Object} PermissionDenyOpts
 * @property {string} module     — the RBAC module key (e.g. "quotes")
 * @property {string} action     — the action key (e.g. "write", "delete")
 * @property {string} [feature]  — friendly action label shown in the
 *                                 message ("Delete Quote", "Export CSV").
 *                                 Falls back to `<module>.<action>` if
 *                                 omitted.
 */

/**
 * Surface a permission-denied toast.
 *
 * @param {{error: (msg: string) => void}} notify — useNotify() instance
 * @param {PermissionDenyOpts} opts
 */
export function notifyPermissionDenied(notify, { module, action, feature }) {
  if (!notify || typeof notify.error !== 'function') return;
  const what = feature || `${module}.${action}`;
  notify.error(
    `You don't have permission to ${what}. Contact your administrator if you believe this is an error.`,
  );
}

/**
 * Format the permission-denied message without firing a toast.
 * Useful for inline error banners or test assertions.
 *
 * @param {PermissionDenyOpts} opts
 * @returns {string}
 */
export function formatPermissionDeniedMessage({ module, action, feature }) {
  const what = feature || `${module}.${action}`;
  return `You don't have permission to ${what}. Contact your administrator if you believe this is an error.`;
}
