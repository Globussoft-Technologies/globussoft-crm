// Effective-brand hook (2026-07-08) — the fallback-RESOLVED counterpart to
// useBrandKit(). useBrandKit(subBrand) answers "does THIS sub-brand have its
// own kit" (used by operator pages to show sub-brand-specific accents,
// returning null with no fallback walk). This hook answers "what logo/color
// should actually be DISPLAYED for this sub-brand right now" — walking the
// full chain server-side via GET /api/brand-kits/effective/:subBrand
// (lib/brandResolver.js): subBrand kit → tenant default-brand kit →
// Tenant.logoUrl/brandColor → null (system default).
//
// This is the single source of truth the Sidebar's one logo and the
// Settings → Branding card should both read from, so switching the active
// sub-brand updates both consistently with no separate propagation step.
//
//   const { effective, loading } = useEffectiveBrand(activeSubBrand);
//   // effective?.logoUrl, effective?.primaryColor, effective?.source
//
// Caching: per-tenant + per-subBrand module-level cache + in-flight de-dupe.
// A sub-brand name such as "travelstall" is reused by multiple organizations,
// so it is never a safe cache key by itself. The implementation otherwise
// follows the same shape as useBrandKit's. Callers that just wrote a
// logo/color/default should
// call invalidateEffectiveBrandCache() before re-fetching so they don't see
// stale data (there is no TTL — writes must actively bust the cache).

import { useEffect, useState } from 'react';
import { fetchApi } from '../utils/api';

const _cache = new Map();
const _inflight = new Map();

// Cross-component sync: Settings.jsx (writer) and Sidebar.jsx (persistent,
// always-mounted reader) each hold their OWN useEffectiveBrand(subBrand)
// instance. Invalidating the module-level cache alone doesn't make an
// already-rendered Sidebar refetch — it needs to be TOLD to. A DOM
// CustomEvent is the simplest reader-agnostic broadcast: every mounted
// instance listens and re-fetches on invalidate, regardless of which
// component triggered the write.
const BROADCAST_EVENT = 'globussoft:effective-brand-invalidated';

function cacheKey(subBrand, tenantId) {
  const tenant = tenantId == null ? '__unknown_tenant__' : String(tenantId);
  const brand = subBrand == null ? '__null__' : String(subBrand);
  return `${tenant}:${brand}`;
}

/** Clear the whole cache (or just one subBrand's entry) after a write, and
 * tell every mounted useEffectiveBrand() instance to re-fetch. */
export function invalidateEffectiveBrandCache(subBrand, tenantId) {
  if (subBrand === undefined) {
    _cache.clear();
    _inflight.clear();
  } else {
    _cache.delete(cacheKey(subBrand, tenantId));
    _inflight.delete(cacheKey(subBrand, tenantId));
  }
  try {
    window.dispatchEvent(new CustomEvent(BROADCAST_EVENT));
  } catch {
    /* non-browser environment (tests) — safe to skip */
  }
}

async function fetchEffective(subBrand) {
  const path = subBrand ? encodeURIComponent(subBrand) : '_';
  try {
    const res = await fetchApi(`/api/brand-kits/effective/${path}`, { silent: true });
    if (res && typeof res === 'object' && ('logoUrl' in res || 'primaryColor' in res)) {
      return res;
    }
    return null;
  } catch (_err) {
    return null;
  }
}

/**
 * Read the fully fallback-resolved brand for a sub-brand.
 * @param {string|null|undefined} subBrand
 * @param {number|string|null|undefined} tenantId authenticated organization ID
 * @returns {{effective: {logoUrl:string|null, primaryColor:string|null, source:string}|null, loading: boolean, reload: Function}}
 */
export function useEffectiveBrand(subBrand, tenantId) {
  const key = cacheKey(subBrand, tenantId);
  const cached = _cache.get(key);
  const [effective, setEffective] = useState(cached !== undefined ? cached : null);
  const [loading, setLoading] = useState(cached === undefined);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let active = true;
    const k = cacheKey(subBrand, tenantId);
    if (_cache.has(k) && reloadTick === 0) {
      setEffective(_cache.get(k));
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    let p = _inflight.get(k);
    if (!p) {
      p = fetchEffective(subBrand).then((res) => {
        _cache.set(k, res);
        _inflight.delete(k);
        return res;
      });
      _inflight.set(k, p);
    }
    p.then((res) => {
      if (!active) return;
      setEffective(res);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [subBrand, tenantId, reloadTick]);

  // Listen for invalidation broadcasts from OTHER components (e.g. Settings
  // saving a logo while Sidebar stays mounted) and re-fetch this instance's
  // subBrand. Cheap no-op re-render when this subBrand's cache entry is
  // already gone (the effect above just re-fetches it).
  useEffect(() => {
    const onInvalidate = () => setReloadTick((t) => t + 1);
    window.addEventListener(BROADCAST_EVENT, onInvalidate);
    return () => window.removeEventListener(BROADCAST_EVENT, onInvalidate);
  }, []);

  const reload = () => {
    invalidateEffectiveBrandCache(subBrand, tenantId);
    setReloadTick((t) => t + 1);
  };

  return { effective, loading, reload };
}

export default useEffectiveBrand;
