import { lazy } from 'react';

/**
 * Wraps React.lazy() with stale-chunk auto-recovery + transient-failure retries.
 *
 * Two failure modes this guards against:
 *
 * 1. Deploy stale chunks (#249) — new index.html references new asset hashes,
 *    but a tab still holding the old SPA tries to import the OLD hash, which
 *    404s on the CDN. React surfaces this as "Failed to fetch dynamically
 *    imported module". Recovery: force a full reload so the browser pulls the
 *    fresh index.html. sessionStorage guards against an infinite reload loop —
 *    we only auto-reload once per session.
 *
 * 2. Transient chunk-fetch failures (#284) — flaky network / Nginx 5xx /
 *    cancelled in-flight request when the user clicks a nav link mid-fetch.
 *    These also surface as "Failed to fetch dynamically imported module" but
 *    a reload is overkill — the chunk URL is still valid, we just need to
 *    retry the import. We retry up to 2 times with exponential backoff
 *    (300ms, 900ms) before falling through to the stale-chunk reload path.
 */
export function lazyWithRetry(importFn) {
  return lazy(async () => {
    const reloadKey = 'lazyChunkReloaded';
    const isChunkError = (err) =>
      err?.message?.includes('Failed to fetch dynamically imported module') ||
      err?.message?.includes('error loading dynamically imported module') ||
      err?.name === 'ChunkLoadError';

    // Retry transient failures before assuming this is a stale-chunk situation.
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await importFn();
      } catch (err) {
        lastErr = err;
        if (!isChunkError(err)) throw err;
        if (attempt < maxAttempts - 1) {
          const backoffMs = 300 * Math.pow(3, attempt); // 300ms, 900ms
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
      }
    }

    // All retries exhausted on a chunk-load error. Most likely a real deploy:
    // force a one-shot full reload to pull the new index.html with new hashes.
    if (!sessionStorage.getItem(reloadKey)) {
      sessionStorage.setItem(reloadKey, '1');
      window.location.reload();
      return { default: () => null };
    }
    throw lastErr;
  });
}
