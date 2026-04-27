import { lazy } from 'react';

/**
 * Wraps React.lazy() with stale-chunk auto-recovery.
 *
 * When a deploy ships, the new index.html references new asset hashes
 * (e.g. MarketplaceLeads-XYZ.js) but any tab still holding the old SPA
 * tries to import the OLD hash (e.g. MarketplaceLeads-PSyx6Dk5.js), which
 * 404s on the CDN. React surfaces this as "Failed to fetch dynamically
 * imported module" and the route renders blank — see #249.
 *
 * Recovery: the moment we see that error, force a full reload so the
 * browser pulls the fresh index.html with the new asset references.
 * sessionStorage guards against an infinite reload loop in case the
 * error is something else (network down, real 500, etc.) — we only
 * auto-reload once per session.
 */
export function lazyWithRetry(importFn) {
  return lazy(async () => {
    const reloadKey = 'lazyChunkReloaded';
    try {
      return await importFn();
    } catch (err) {
      const isStaleChunk =
        err?.message?.includes('Failed to fetch dynamically imported module') ||
        err?.message?.includes('error loading dynamically imported module') ||
        err?.name === 'ChunkLoadError';

      if (isStaleChunk && !sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, '1');
        window.location.reload();
        return { default: () => null };
      }
      throw err;
    }
  });
}
