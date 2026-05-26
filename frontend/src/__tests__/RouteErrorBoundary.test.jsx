import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RouteErrorBoundary from '../components/RouteErrorBoundary';

/**
 * frontend/src/components/RouteErrorBoundary.jsx
 *
 * What's tested
 *   - Pass-through render: children render normally when nothing throws.
 *   - getDerivedStateFromError flips the boundary into the fallback UI when
 *     a child throws during render.
 *   - componentDidCatch logs to console.error with the boundary's tag prefix.
 *   - Chunk-error detection — "Failed to fetch dynamically imported module",
 *     "error loading dynamically imported module", and `name === 'ChunkLoadError'`
 *     all surface the "Page needs a refresh" copy (the lazyWithRetry recovery path).
 *   - Generic errors surface the "Something went wrong" headline + the error's
 *     own message body.
 *   - The Reload CTA fires `window.location.reload()` AND clears the
 *     `lazyChunkReloaded` sessionStorage flag (so the user can retry a fresh
 *     fetch instead of being stuck in the post-reload guard).
 *
 * Why
 *   The boundary is the last line of defence between a stale-chunk fetch
 *   failure (or any uncaught render error in a lazy route) and a blank screen
 *   for the user. Issue #249 added it specifically to surface a manual
 *   Reload CTA when lazyWithRetry can't auto-recover. Pinning the chunk-error
 *   detection arms keeps the wording stable (which the user has been
 *   trained on) and pinning the sessionStorage clear keeps the
 *   post-reload-guard release path intact.
 */

// Helper component that throws on render — used to trip the boundary.
function Boom({ error }) {
  throw error;
}

describe('RouteErrorBoundary', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    // Suppress React's expected error log when a child throws inside the
    // boundary — keeps test output readable + lets us assert against our
    // own [RouteErrorBoundary] tag separately.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <RouteErrorBoundary>
        <div data-testid="happy-child">all good</div>
      </RouteErrorBoundary>
    );
    expect(screen.getByTestId('happy-child')).toBeInTheDocument();
    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reload page/i })).not.toBeInTheDocument();
  });

  it('renders the generic fallback when a child throws a non-chunk error', () => {
    render(
      <RouteErrorBoundary>
        <Boom error={new Error('database is on fire')} />
      </RouteErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('database is on fire')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument();
  });

  it('logs the caught error via componentDidCatch with the boundary tag', () => {
    render(
      <RouteErrorBoundary>
        <Boom error={new Error('tagged log probe')} />
      </RouteErrorBoundary>
    );
    // console.error fires multiple times (React's own warning + our log) — find ours.
    const calls = consoleErrorSpy.mock.calls;
    const ourLog = calls.find((args) => args[0] === '[RouteErrorBoundary]');
    expect(ourLog).toBeTruthy();
    expect(ourLog[1]).toBeInstanceOf(Error);
    expect(ourLog[1].message).toBe('tagged log probe');
  });

  it('surfaces the chunk-error copy when the error message matches "Failed to fetch dynamically imported module"', () => {
    render(
      <RouteErrorBoundary>
        <Boom error={new Error('Failed to fetch dynamically imported module: /assets/Patients.abc123.js')} />
      </RouteErrorBoundary>
    );
    expect(screen.getByText('Page needs a refresh')).toBeInTheDocument();
    expect(screen.getByText(/CRM was updated since you opened this tab/i)).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('surfaces the chunk-error copy when the error message matches "error loading dynamically imported module"', () => {
    render(
      <RouteErrorBoundary>
        <Boom error={new Error('error loading dynamically imported module foo')} />
      </RouteErrorBoundary>
    );
    expect(screen.getByText('Page needs a refresh')).toBeInTheDocument();
  });

  it('surfaces the chunk-error copy when the error name is ChunkLoadError', () => {
    const err = new Error('chunk go boom');
    err.name = 'ChunkLoadError';
    render(
      <RouteErrorBoundary>
        <Boom error={err} />
      </RouteErrorBoundary>
    );
    expect(screen.getByText('Page needs a refresh')).toBeInTheDocument();
    // generic-fallback body text should NOT show through.
    expect(screen.queryByText('chunk go boom')).not.toBeInTheDocument();
  });

  it('Reload CTA clears the lazyChunkReloaded sessionStorage flag and reloads the page', () => {
    sessionStorage.setItem('lazyChunkReloaded', '1');
    const reloadSpy = vi.fn();
    // jsdom's window.location.reload is non-configurable; replace the entire
    // window.location with a stub for the duration of this test.
    const originalLocation = window.location;
    delete window.location;
    window.location = { ...originalLocation, reload: reloadSpy };

    try {
      render(
        <RouteErrorBoundary>
          <Boom error={new Error('retry me')} />
        </RouteErrorBoundary>
      );

      const btn = screen.getByRole('button', { name: /reload page/i });
      fireEvent.click(btn);

      expect(sessionStorage.getItem('lazyChunkReloaded')).toBeNull();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      window.location = originalLocation;
    }
  });

  it('falls back to a default message when the thrown error has no message string', () => {
    // Throwing a non-Error value or an Error with empty message exercises the
    // "(An unexpected error occurred.)" branch.
    const err = new Error('');
    render(
      <RouteErrorBoundary>
        <Boom error={err} />
      </RouteErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
  });
});
