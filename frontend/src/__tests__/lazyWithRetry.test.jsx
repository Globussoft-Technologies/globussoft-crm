import React, { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { lazyWithRetry } from '../utils/lazyWithRetry';

/**
 * frontend/src/utils/lazyWithRetry.js — chunk-load retry + stale-chunk reload
 *
 * What's tested
 *   - Successful import resolves the lazy component synchronously after
 *     React's Suspense fallback flush.
 *   - Non-chunk errors (typo, syntax error in module) propagate WITHOUT a
 *     retry loop and WITHOUT a forced reload.
 *   - Chunk-load errors retry up to 3 attempts; if attempt 2 succeeds, the
 *     final render shows the component.
 *   - When ALL 3 attempts fail with a chunk error AND no reload guard is set
 *     in sessionStorage, the helper triggers window.location.reload() and
 *     marks the guard so a second failure within the same session doesn't
 *     loop reloads.
 *
 * Why
 *   This wraps EVERY route-level React.lazy() in App.jsx. Two production
 *   incidents (#249 stale chunks after deploy, #284 transient Nginx 5xx
 *   on chunk fetch) both manifest as a blank screen for users. The reload
 *   loop guard is the single most important contract here — without it a
 *   bad deploy would loop the user through endless reloads.
 *
 * Contract pinned
 *   - Retries 3x on "Failed to fetch dynamically imported module" / ChunkLoadError
 *   - Backoff: 300ms, 900ms (300 * 3^attempt)
 *   - Non-chunk errors throw immediately on attempt 1
 *   - Reload-loop guard via sessionStorage["lazyChunkReloaded"]
 */

describe('lazyWithRetry', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('resolves the component on first-try success (no retries)', async () => {
    const importFn = vi.fn(() => Promise.resolve({ default: () => <div>Hello</div> }));
    const Lazy = lazyWithRetry(importFn);

    render(
      <Suspense fallback={<div>loading…</div>}>
        <Lazy />
      </Suspense>,
    );

    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
    expect(importFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry non-chunk errors (real bug should fail fast)', async () => {
    const importFn = vi.fn(() => Promise.reject(new TypeError('undefined is not a function')));
    const Lazy = lazyWithRetry(importFn);

    // React's lazy throws into the nearest error boundary; we can't render
    // it directly without one, so test the inner promise via importFn.
    // The most reliable cross-React-version assertion is that importFn was
    // called only once (no retry loop).
    try {
      // Force resolution by awaiting the lazy load directly
      const result = await importFn().catch((e) => ({ err: e }));
      expect(result.err).toBeInstanceOf(TypeError);
    } catch {
      /* ignore */
    }

    // Now verify lazyWithRetry's own behaviour: call the loader factory once.
    // We re-create the wrapper and probe its inner async function indirectly
    // by mounting + capturing the rejection.
    const importFn2 = vi.fn(() => Promise.reject(new TypeError('boom')));
    const Lazy2 = lazyWithRetry(importFn2);

    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { err: null }; }
      static getDerivedStateFromError(err) { return { err }; }
      render() { return this.state.err ? <div>caught: {this.state.err.message}</div> : this.props.children; }
    }

    render(
      <Boundary>
        <Suspense fallback={<div>loading…</div>}>
          <Lazy2 />
        </Suspense>
      </Boundary>,
    );

    await waitFor(() => expect(screen.getByText(/caught: boom/)).toBeInTheDocument());
    // Non-chunk errors: NO retry loop.
    expect(importFn2).toHaveBeenCalledTimes(1);
  });

  it('retries chunk errors up to 3 attempts; succeeds on attempt 2', async () => {
    let attempt = 0;
    const importFn = vi.fn(() => {
      attempt += 1;
      if (attempt < 2) {
        return Promise.reject(new Error('Failed to fetch dynamically imported module: foo.js'));
      }
      return Promise.resolve({ default: () => <div>Recovered</div> });
    });
    const Lazy = lazyWithRetry(importFn);

    render(
      <Suspense fallback={<div>loading…</div>}>
        <Lazy />
      </Suspense>,
    );

    await waitFor(
      () => expect(screen.getByText('Recovered')).toBeInTheDocument(),
      { timeout: 4000 },
    );
    expect(importFn).toHaveBeenCalledTimes(2);
  });

  it('forces a one-shot window.location.reload() after 3 chunk-error retries (deploy-stale-chunk path)', async () => {
    const reloadSpy = vi.fn();
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, reload: reloadSpy },
    });

    try {
      const importFn = vi.fn(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
      const Lazy = lazyWithRetry(importFn);

      render(
        <Suspense fallback={<div>loading…</div>}>
          <Lazy />
        </Suspense>,
      );

      await waitFor(
        () => expect(reloadSpy).toHaveBeenCalled(),
        { timeout: 5000 },
      );

      // 3 attempts before reload trigger
      expect(importFn).toHaveBeenCalledTimes(3);
      // Guard set so the next failure in this session does NOT loop the reload
      expect(sessionStorage.getItem('lazyChunkReloaded')).toBe('1');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: origLocation });
    }
  });
});
