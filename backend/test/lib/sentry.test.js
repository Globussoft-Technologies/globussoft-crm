/**
 * Unit tests for backend/lib/sentry.js
 *
 * What this covers:
 *   - initSentry() in unconfigured mode (SENTRY_DSN unset) → no-ops, returns
 *     null, never calls into @sentry/node.init. This is the dev/local path.
 *   - initSentry() in configured mode → calls Sentry.init exactly once with
 *     the DSN + environment + tracesSampleRate + integrations, returns the
 *     Sentry namespace.
 *   - captureException() in unconfigured mode → no-ops silently (does not
 *     throw, does not call Sentry.captureException). This is the
 *     graceful-degrade contract every route handler relies on — if a
 *     route does `try { ... } catch (e) { captureException(e); ... }`
 *     and SENTRY_DSN is unset, the catch arm must never explode.
 *   - captureException() in configured mode → forwards err + extra to
 *     Sentry.captureException.
 *
 * WHY (regression class):
 *   server.js calls initSentry(app) at boot. A regression that throws here
 *   when SENTRY_DSN is unset would crash every dev/CI boot. Likewise, every
 *   route's catch block calls captureException — a regression that throws
 *   from the no-op path would mask the original error with a Sentry
 *   ReferenceError and corrupt the response. Both are silent-failure
 *   classes that production tests cover poorly (production HAS a DSN).
 *
 * Mocking notes:
 *   - vi.mock('@sentry/node') does NOT reliably intercept the SUT's CJS
 *     `require('@sentry/node')` under this repo's vitest setup
 *     (see commentary in test/lib/eventBus.test.js, test/lib/audit.test.js,
 *     and test/lib/notificationService.test.js for the same blocker). We
 *     therefore monkey-patch the real CJS module.exports of @sentry/node
 *     via createRequire(), exactly mirroring how notificationService.test.js
 *     patches pushService. The SUT's top-level
 *     `const Sentry = require('@sentry/node')` and the runtime
 *     `require('@sentry/node').captureException(...)` inside captureException
 *     both resolve to the same cached module instance, so our patches stick.
 *   - SENTRY_DSN is read at call time (inside both initSentry and
 *     captureException), so we can flip it per-test without re-importing
 *     the SUT.
 */
import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
// Resolve the real CJS module.exports of @sentry/node — the SUT will
// receive this same object via require('@sentry/node').
const Sentry = requireCjs('@sentry/node');

// Capture original methods so we can restore after the suite finishes.
const ORIGINAL_INIT = Sentry.init;
const ORIGINAL_CAPTURE = Sentry.captureException;
const ORIGINAL_HTTP_INTEG = Sentry.httpIntegration;
const ORIGINAL_EXPRESS_INTEG = Sentry.expressIntegration;
const ORIGINAL_DSN = process.env.SENTRY_DSN;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeAll(() => {
  // Replace the methods the SUT calls. `httpIntegration` /
  // `expressIntegration` are factories that return integration instances —
  // mock them to return inert sentinel values so init() can collect them
  // without exploding.
  Sentry.init = vi.fn();
  Sentry.captureException = vi.fn();
  Sentry.httpIntegration = vi.fn(() => ({ name: 'mock:http' }));
  Sentry.expressIntegration = vi.fn(() => ({ name: 'mock:express' }));
});

afterAll(() => {
  Sentry.init = ORIGINAL_INIT;
  Sentry.captureException = ORIGINAL_CAPTURE;
  Sentry.httpIntegration = ORIGINAL_HTTP_INTEG;
  Sentry.expressIntegration = ORIGINAL_EXPRESS_INTEG;
  if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIGINAL_DSN;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  Sentry.init.mockReset();
  Sentry.captureException.mockReset();
  Sentry.httpIntegration.mockReset();
  Sentry.httpIntegration.mockReturnValue({ name: 'mock:http' });
  Sentry.expressIntegration.mockReset();
  Sentry.expressIntegration.mockReturnValue({ name: 'mock:express' });
  delete process.env.SENTRY_DSN;
  process.env.NODE_ENV = 'test';
});

// Import the SUT once — captureException reads SENTRY_DSN at call time, so
// we don't need re-imports between tests.
import sentryLib from '../../lib/sentry.js';
const { initSentry, captureException } = sentryLib;

describe('lib/sentry — module shape', () => {
  test('exports initSentry + captureException', () => {
    expect(typeof initSentry).toBe('function');
    expect(typeof captureException).toBe('function');
  });
});

describe('lib/sentry — initSentry (unconfigured / no DSN)', () => {
  test('returns null when SENTRY_DSN is unset', () => {
    delete process.env.SENTRY_DSN;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = initSentry({});
      expect(out).toBeNull();
      expect(Sentry.init).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toMatch(/SENTRY_DSN not set/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('returns null when SENTRY_DSN is empty string', () => {
    process.env.SENTRY_DSN = '';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = initSentry({});
      expect(out).toBeNull();
      expect(Sentry.init).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('does not throw when called with no app argument', () => {
    delete process.env.SENTRY_DSN;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => initSentry()).not.toThrow();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('lib/sentry — initSentry (configured)', () => {
  test('calls Sentry.init exactly once with the configured DSN', () => {
    process.env.SENTRY_DSN = 'https://abc123@sentry.example.com/1';
    process.env.NODE_ENV = 'production';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const out = initSentry({});
      expect(Sentry.init).toHaveBeenCalledTimes(1);
      const cfg = Sentry.init.mock.calls[0][0];
      expect(cfg.dsn).toBe('https://abc123@sentry.example.com/1');
      expect(cfg.environment).toBe('production');
      expect(cfg.tracesSampleRate).toBe(0.1);
      // Both integration factories were invoked and returned values were
      // forwarded into the integrations array.
      expect(Sentry.httpIntegration).toHaveBeenCalledTimes(1);
      expect(Sentry.expressIntegration).toHaveBeenCalledTimes(1);
      expect(cfg.integrations).toEqual([
        { name: 'mock:http' },
        { name: 'mock:express' },
      ]);
      // Returns the Sentry namespace so callers can opt-in to the API.
      expect(out).toBe(Sentry);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  test('falls back to "development" environment when NODE_ENV unset', () => {
    process.env.SENTRY_DSN = 'https://x@s.example.com/2';
    delete process.env.NODE_ENV;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      initSentry({});
      const cfg = Sentry.init.mock.calls[0][0];
      expect(cfg.environment).toBe('development');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('lib/sentry — captureException', () => {
  test('no-ops silently when SENTRY_DSN is unset', () => {
    delete process.env.SENTRY_DSN;
    expect(() => captureException(new Error('boom'))).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('no-ops silently when SENTRY_DSN is empty string', () => {
    process.env.SENTRY_DSN = '';
    expect(() => captureException(new Error('boom'))).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('forwards err + extra context when SENTRY_DSN is set', () => {
    process.env.SENTRY_DSN = 'https://x@s.example.com/3';
    const err = new Error('kaboom');
    captureException(err, { route: '/api/leads', userId: 7 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [forwardedErr, opts] = Sentry.captureException.mock.calls[0];
    expect(forwardedErr).toBe(err);
    expect(opts).toEqual({ extra: { route: '/api/leads', userId: 7 } });
  });

  test('passes undefined extra when no context provided (still wraps in {extra})', () => {
    process.env.SENTRY_DSN = 'https://x@s.example.com/4';
    captureException(new Error('x'));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, opts] = Sentry.captureException.mock.calls[0];
    expect(opts).toEqual({ extra: undefined });
  });

  test('does not throw when err is a non-Error value (string / null / undefined)', () => {
    process.env.SENTRY_DSN = 'https://x@s.example.com/5';
    expect(() => captureException('string error')).not.toThrow();
    expect(() => captureException(null)).not.toThrow();
    expect(() => captureException(undefined)).not.toThrow();
    // All three forwarded — captureException is dumb, that's the contract.
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
  });
});
