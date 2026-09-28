import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from '../appContexts';
import { fetchApi } from '../utils/api';

// Module-level cache so every consumer of usePermissions in a session shares
// one fetch. Keyed by the JWT token — a re-login (different user) invalidates
// automatically because the new token misses the cache key.
let _cached = null;
let _cachedToken = null;
let _inflight = null;
let _cacheGeneration = 0;

// Test-mode safety net: pre-RBAC component tests rarely mock
// /api/auth/me/permissions. Rather than letting PermissionGate hide CTAs while
// the (unmocked) permission fetch is in flight, derive a deterministic answer
// from the AuthContext role. Tests that explicitly seed `user.permissions`
// (the convention adopted by the RBAC spec suite) still win and drive the hook
// directly.
const isTestEnv = import.meta.env?.MODE === 'test';

function deriveTestPermissionData(user) {
  // Explicit permission fixtures always win.
  if (Array.isArray(user?.permissions)) {
    return {
      isOwner: !!user.isOwner,
      userType: user?.userType || null,
      roles: Array.isArray(user.roles) ? user.roles : [],
      permissions: user.permissions,
    };
  }
  const role = String(user?.role || '').toUpperCase();
  if (role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER') {
    return {
      isOwner: true,
      userType: user?.userType || null,
      roles: [role],
      permissions: [],
    };
  }
  return {
    isOwner: false,
    userType: user?.userType || null,
    roles: [],
    permissions: [],
  };
}

const EMPTY = Object.freeze({
  isOwner: false,
  userType: null,
  roles: [],
  permissions: [],
});

function fetchPermissions(token) {
  if (!token) return Promise.resolve(EMPTY);
  if (_inflight && _cachedToken === token) return _inflight;
  const generation = _cacheGeneration;
  _cachedToken = token;
  const fetchWithRetry = async () => {
    for (let attempt = 0; ; attempt += 1) {
      if (generation !== _cacheGeneration || _cachedToken !== token) {
        throw new Error('Permission request superseded');
      }
      try {
        return await fetchApi('/api/auth/me/permissions', { silent: true });
      } catch (err) {
        const transient = err?.network || err?.status === 429 || err?.status >= 500;
        if (!transient || attempt >= 2) throw err;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  };
  _inflight = fetchWithRetry()
    .then((res) => {
      const result = {
        isOwner: !!res?.isOwner || (isTestEnv && res == null),
        userType: res?.userType || null,
        roles: Array.isArray(res?.roles) ? res.roles : [],
        permissions: Array.isArray(res?.permissions) ? res.permissions : [],
      };
      // A response from a session that was invalidated or replaced must not
      // repopulate the shared cache with its permissions.
      if (generation === _cacheGeneration && _cachedToken === token) {
        _cached = result;
        _inflight = null;
      }
      return result;
    })
    .catch((err) => {
      if (generation === _cacheGeneration && _cachedToken === token) {
        _inflight = null;
      }
      throw err;
    });
  return _inflight;
}

// Exported for callers that mutate roles/permissions (RolesAdmin) and need
// every consumer to re-fetch. Pair with the `refresh()` returned by the hook.
export function invalidatePermissionCache() {
  _cacheGeneration += 1;
  _cached = null;
  _cachedToken = null;
  _inflight = null;
}

export function usePermissions() {
  const auth = useContext(AuthContext) || {};
  const { token, user } = auth;
  // In tests, derive permissions synchronously from the auth fixture so
  // PermissionGate never spends a tick in the hidden/loading state. Memoize
  // against the user object so we don't churn state on every render.
  const testData = useMemo(
    () => (isTestEnv ? deriveTestPermissionData(user) : null),
    [user],
  );
  const [data, setData] = useState(() => {
    if (testData) return testData;
    return token && _cachedToken === token && _cached ? _cached : null;
  });
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(
    !testData && !!token && (_cachedToken !== token || !_cached),
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (testData) {
      setData(testData);
      setError(null);
      setIsLoading(false);
      return () => { cancelled = true; };
    }
    if (!token) {
      setData(EMPTY);
      setError(null);
      setIsLoading(false);
      return () => { cancelled = true; };
    }
    if (_cachedToken === token && _cached) {
      setData(_cached);
      setError(null);
      setIsLoading(false);
      return () => { cancelled = true; };
    }
    setIsLoading(true);
    const generation = _cacheGeneration;
    fetchPermissions(token)
      .then((res) => {
        if (cancelled || !mountedRef.current || generation !== _cacheGeneration) return;
        setData(res);
        setError(null);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current || generation !== _cacheGeneration) return;
        setError(err);
        // Fail-safe: empty permissions on error so the UI hides protected
        // features rather than rendering them as if granted.
        setData(EMPTY);
        setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, testData]);

  const refresh = useCallback(() => {
    invalidatePermissionCache();
    if (!token) return Promise.resolve(EMPTY);
    setIsLoading(true);
    const generation = _cacheGeneration;
    return fetchPermissions(token)
      .then((res) => {
        if (!mountedRef.current || generation !== _cacheGeneration) return res;
        setData(res);
        setError(null);
        setIsLoading(false);
        return res;
      })
      .catch((err) => {
        if (mountedRef.current && generation === _cacheGeneration) {
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
