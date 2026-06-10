import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';

// Module-level cache so every consumer of usePermissions in a session shares
// one fetch. Keyed by the JWT token — a re-login (different user) invalidates
// automatically because the new token misses the cache key.
let _cached = null;
let _cachedToken = null;
let _inflight = null;

const EMPTY = Object.freeze({
  isOwner: false,
  userType: null,
  roles: [],
  permissions: [],
});

function fetchPermissions(token) {
  if (!token) return Promise.resolve(EMPTY);
  if (_inflight && _cachedToken === token) return _inflight;
  _cachedToken = token;
  _inflight = fetchApi('/api/auth/me/permissions', { silent: true })
    .then((res) => {
      _cached = {
        isOwner: !!res?.isOwner,
        userType: res?.userType || null,
        roles: Array.isArray(res?.roles) ? res.roles : [],
        permissions: Array.isArray(res?.permissions) ? res.permissions : [],
      };
      _inflight = null;
      return _cached;
    })
    .catch((err) => {
      _inflight = null;
      throw err;
    });
  return _inflight;
}

// Exported for callers that mutate roles/permissions (RolesAdmin) and need
// every consumer to re-fetch. Pair with the `refresh()` returned by the hook.
export function invalidatePermissionCache() {
  _cached = null;
  _cachedToken = null;
  _inflight = null;
}

export function usePermissions() {
  const auth = useContext(AuthContext) || {};
  const { token } = auth;
  const [data, setData] = useState(() =>
    token && _cachedToken === token && _cached ? _cached : null,
  );
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(
    !!token && (_cachedToken !== token || !_cached),
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!token) {
      setData(EMPTY);
      setError(null);
      setIsLoading(false);
      return;
    }
    if (_cachedToken === token && _cached) {
      setData(_cached);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    fetchPermissions(token)
      .then((res) => {
        if (!mountedRef.current) return;
        setData(res);
        setError(null);
        setIsLoading(false);
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setError(err);
        // Fail-safe: empty permissions on error so the UI hides protected
        // features rather than rendering them as if granted.
        setData(EMPTY);
        setIsLoading(false);
      });
  }, [token]);

  const refresh = useCallback(() => {
    invalidatePermissionCache();
    if (!token) return Promise.resolve(EMPTY);
    setIsLoading(true);
    return fetchPermissions(token)
      .then((res) => {
        if (!mountedRef.current) return res;
        setData(res);
        setError(null);
        setIsLoading(false);
        return res;
      })
      .catch((err) => {
        if (mountedRef.current) {
          setError(err);
          setData(EMPTY);
          setIsLoading(false);
        }
        throw err;
      });
  }, [token]);

  const hasPermission = useCallback(
    (module, action) => {
      if (!data) return false;
      if (data.isOwner) return true;
      const key = `${module}.${action}`;
      return data.permissions.includes(key);
    },
    [data],
  );

  const hasAllPermissions = useCallback(
    (list) =>
      Array.isArray(list) &&
      list.every(({ module, action }) => hasPermission(module, action)),
    [hasPermission],
  );

  const hasAnyPermission = useCallback(
    (list) =>
      Array.isArray(list) &&
      list.some(({ module, action }) => hasPermission(module, action)),
    [hasPermission],
  );

  // `isReady` means we have a definitive answer for hasPermission(). Sidebar /
  // nav filters use this to avoid HIDING items during the first 100ms while
  // permissions are still resolving — they fall through to the legacy
  // adminOnly / managerOnly checks until the answer arrives.
  const isReady = !isLoading && data !== null;

  return {
    permissions: data?.permissions || [],
    roles: data?.roles || [],
    isOwner: data?.isOwner || false,
    userType: data?.userType || null,
    isLoading,
    isReady,
    error,
    hasPermission,
    hasAllPermissions,
    hasAnyPermission,
    refresh,
  };
}
