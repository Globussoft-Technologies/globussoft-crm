/**
 * Build a browser-storage key that cannot be shared by two signed-in users
 * or tenants on the same browser profile.
 */
export function scopedStorageKey(prefix, { tenantId, userId, resourceId } = {}) {
  const tenant = tenantId ?? 'unknown';
  const user = userId ?? 'anonymous';
  const resource = resourceId === undefined ? '' : `:resource:${resourceId}`;
  return `${prefix}:tenant:${tenant}:user:${user}${resource}`;
}
