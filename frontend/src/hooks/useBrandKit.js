// Branding Wave 4 G102 — per-sub-brand BrandKit lookup hook.
//
// Operator-page surfaces (Travel admin tables, sub-brand chrome, sidebar
// pinned logo) all want to read the active BrandKit row for a sub-brand.
// The previous shape sprinkled hex/rgba lookups inline (utils/travelSubBrand
// SUB_BRAND_BG map) which is fine for placeholder colors but doesn't
// support the real per-tenant per-sub-brand BrandKit values shipped via
// /api/brand-kits/active/:subBrand. This hook bridges that:
//
//   const { brandKit, loading } = useBrandKit('tmc');
//   // brandKit?.logoUrl, brandKit?.primaryColor, brandKit?.tagline, …
//
// Caching:
//   - Per-subBrand cache shared across all consumers of the hook within
//     a single page load (module-level Map keyed by subBrand).
//   - A null subBrand is also cached separately (resolves to the
//     tenant-wide kit via /active/_).
//   - 404 from the endpoint caches a `null` result so subsequent renders
//     don't hammer the server with futile re-fetches.
//   - No TTL — the cache is page-lifetime; an admin save on /admin/brand-kits
//     triggers a full SPA reload through the toast handler anyway, so
//     stale-cache risk is bounded.
//
// FR-3.3 fallback chain: when the sub-brand-scoped kit returns null, the
// caller should fall back to bare CSS vars (var(--primary-color, var(--accent-color))
// per the standing rule). The hook does NOT itself walk the fallback —
// returning null lets the caller use a familiar pattern.
//
// Server endpoint shape (already shipped in routes/brand_kits.js):
//   GET /api/brand-kits/active/:subBrand → { brandKit: <BrandKit | null> }
// Slug "_" means "tenant-wide" (subBrand IS NULL); the hook translates
// null subBrand to "_" for the path segment.

import { useEffect, useState } from 'react';
import { fetchApi } from '../utils/api';

// Module-level cache keyed by subBrand id (or '__null__' for the
// tenant-wide kit). Each value is `{ brandKit: <kit|null>, loading: false }`
// once resolved. Concurrent consumers wait on the in-flight promise so
// we never fire two requests for the same brand.
const _cache = new Map(); // key → resolved value
const _inflight = new Map(); // key → Promise<value>

function cacheKey(subBrand) {
  return subBrand == null ? '__null__' : String(subBrand);
}

/**
 * Test seam: clear the module-level cache. Vitest tests call this in
 * `beforeEach` so each test starts with a clean slate. Production code
 * does not call this — page reload is the cache-bust mechanism.
 */
export function __resetBrandKitCache() {
  _cache.clear();
  _inflight.clear();
}

async function fetchKit(subBrand) {
  const path = subBrand ? encodeURIComponent(subBrand) : '_';
  try {
    const res = await fetchApi(`/api/brand-kits/active/${path}`, { silent: true });
    // Endpoint returns { brandKit: <row | null> }; tolerate either shape
    // defensively in case the response is unwrapped by a future shape change.
    if (res && typeof res === 'object') {
      if ('brandKit' in res) return res.brandKit || null;
      // Fallback: if the response IS a brand-kit row (id + tenantId), use it.
      if (res.id && res.tenantId !== undefined) return res;
    }
    return null;
  } catch (_err) {
    // Endpoint missing OR 404 OR network error → null. Caller falls back
    // to bare CSS vars per the standing rule.
    return null;
  }
}

/**
 * Read the active BrandKit row for a sub-brand. Caches per-subBrand at
 * module scope so multiple operator-page consumers don't re-fetch.
 *
 * @param {string|null|undefined} subBrand — tmc | rfu | travelstall | visasure | null
 * @returns {{brandKit: object|null, loading: boolean}}
 */
export function useBrandKit(subBrand) {
  const key = cacheKey(subBrand);
  const cached = _cache.get(key);
  const [brandKit, setBrandKit] = useState(cached !== undefined ? cached : null);
  const [loading, setLoading] = useState(cached === undefined);

  useEffect(() => {
    let active = true;
    const k = cacheKey(subBrand);
    if (_cache.has(k)) {
      // Cache hit — sync state without fetching.
      setBrandKit(_cache.get(k));
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    // De-dupe in-flight requests so concurrent consumers share one fetch.
    let p = _inflight.get(k);
    if (!p) {
      p = fetchKit(subBrand).then((kit) => {
        _cache.set(k, kit);
        _inflight.delete(k);
        return kit;
      });
      _inflight.set(k, p);
    }
    p.then((kit) => {
      if (!active) return;
      setBrandKit(kit);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [subBrand]);

  return { brandKit, loading };
}

/**
 * Convenience accessor: resolve the primary color for a sub-brand, falling
 * back to the CSS var when the kit has no primaryColor or no kit exists.
 * Useful for inline styles that don't want to deal with the loading flag.
 *
 * @param {object|null} brandKit
 * @param {string} fallback - e.g. 'var(--primary-color, var(--accent-color))'
 */
export function brandPrimaryColor(brandKit, fallback = 'var(--primary-color, var(--accent-color))') {
  return brandKit && brandKit.primaryColor ? brandKit.primaryColor : fallback;
}

/**
 * Convenience accessor: resolve the logo URL for a sub-brand (light
 * variant). Returns null when missing so the caller can skip the <img>
 * tag entirely rather than render a broken image.
 *
 * @param {object|null} brandKit
 */
export function brandLogoUrl(brandKit) {
  return brandKit && brandKit.logoUrl ? brandKit.logoUrl : null;
}

export default useBrandKit;
