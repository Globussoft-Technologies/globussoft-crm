// @ts-check
/**
 * Unit tests for backend/cron/workflowEngine.js — Wave 11 Agent A.
 *
 * Why this file exists:
 *   The workflowEngine module is event-driven (NOT polled like the rest of
 *   the cron/ engines). Its sole responsibility is to hold the Socket.io
 *   reference so event handlers — wired up elsewhere (server.js +
 *   eventBus listeners in routes/workflows.js etc.) — can push real-time
 *   notifications to clients. Pre-Wave-11 the module was 0% covered.
 *
 * SUT surface (intentionally tiny — see backend/cron/workflowEngine.js):
 *   - initWorkflowEngine(io)  → stores io on module-local _io, logs init
 *   - getIO()                 → returns the currently-stored io reference
 *
 * Contract pinned by this test file:
 *   - getIO() returns null before initWorkflowEngine is called
 *   - initWorkflowEngine stores the passed reference verbatim
 *   - The reference is reused (not cloned) on each getIO() call (object
 *     identity preserved — required because Socket.io's Server instance
 *     holds open sockets that must not be re-wrapped)
 *   - initWorkflowEngine accepts a null/undefined io (server.js may pass
 *     undefined during a degraded boot path) — getIO returns the same
 *     falsy value the engine was initialized with
 *   - Re-calling initWorkflowEngine REPLACES the stored ref (idempotency
 *     of the cron register — the wellness Reorders-on-reboot pattern)
 *   - initWorkflowEngine returns undefined (no return contract; assert
 *     so a future refactor that adds a return value is caught)
 *   - Logging side-effect — emits "[WorkflowEngine] Initialized …" once
 *
 * Mocking strategy:
 *   None needed — module has no external deps beyond a `let _io` and a
 *   console.log. We use createRequire + module cache delete to reset
 *   the closed-over `_io` between tests (so the "getIO() === null
 *   before init" test isn't tainted by prior tests).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const sutPath = requireCJS.resolve('../../cron/workflowEngine.js');

let workflowEngine;

beforeEach(() => {
  // Clear the cache so the module's closed-over `_io = null` resets to
  // pristine state for each test. Without this, a prior test's
  // initWorkflowEngine(someIo) would leak across tests.
  delete requireCJS.cache[sutPath];
  workflowEngine = requireCJS('../../cron/workflowEngine.js');
});

describe('cron/workflowEngine — module exports + initial state', () => {
  test('exports initWorkflowEngine + getIO as functions', () => {
    expect(typeof workflowEngine.initWorkflowEngine).toBe('function');
    expect(typeof workflowEngine.getIO).toBe('function');
  });

  test('getIO() returns null BEFORE initWorkflowEngine is called', () => {
    expect(workflowEngine.getIO()).toBeNull();
  });
});

describe('cron/workflowEngine — initWorkflowEngine stores the io reference', () => {
  test('stores the io reference verbatim and exposes it via getIO()', () => {
    const fakeIo = { emit: vi.fn(), on: vi.fn(), sockets: { adapter: {} } };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    workflowEngine.initWorkflowEngine(fakeIo);
    logSpy.mockRestore();
    expect(workflowEngine.getIO()).toBe(fakeIo);
  });

  test('preserves object identity (same reference, not a clone)', () => {
    const fakeIo = { __marker: Symbol('socket-io-marker'), emit: vi.fn() };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    workflowEngine.initWorkflowEngine(fakeIo);
    logSpy.mockRestore();
    const retrieved = workflowEngine.getIO();
    expect(retrieved).toBe(fakeIo);
    expect(retrieved.__marker).toBe(fakeIo.__marker);
  });

  test('returns undefined (no return contract — pinned so a future refactor that adds a return is flagged)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ret = workflowEngine.initWorkflowEngine({ emit: vi.fn() });
    logSpy.mockRestore();
    expect(ret).toBeUndefined();
  });

  test('logs the initialization message exactly once', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    workflowEngine.initWorkflowEngine({ emit: vi.fn() });
    const initLogs = logSpy.mock.calls
      .map((args) => args.join(' '))
      .filter((s) => s.includes('[WorkflowEngine]'));
    logSpy.mockRestore();
    expect(initLogs).toHaveLength(1);
    expect(initLogs[0]).toMatch(/Initialized/);
  });
});

describe('cron/workflowEngine — initWorkflowEngine accepts falsy io', () => {
  test('accepts null io (server.js degraded-boot path)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => workflowEngine.initWorkflowEngine(null)).not.toThrow();
    logSpy.mockRestore();
    expect(workflowEngine.getIO()).toBeNull();
  });

  test('accepts undefined io', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => workflowEngine.initWorkflowEngine(undefined)).not.toThrow();
    logSpy.mockRestore();
    expect(workflowEngine.getIO()).toBeUndefined();
  });
});

describe('cron/workflowEngine — idempotency: re-init REPLACES the stored ref', () => {
  test('second init call overwrites the first io reference', () => {
    const first = { emit: vi.fn(), __which: 'first' };
    const second = { emit: vi.fn(), __which: 'second' };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    workflowEngine.initWorkflowEngine(first);
    expect(workflowEngine.getIO().__which).toBe('first');
    workflowEngine.initWorkflowEngine(second);
    expect(workflowEngine.getIO().__which).toBe('second');
    expect(workflowEngine.getIO()).toBe(second);
    expect(workflowEngine.getIO()).not.toBe(first);
    logSpy.mockRestore();
  });

  test('re-init with null clears a previously-stored ref', () => {
    const fakeIo = { emit: vi.fn() };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    workflowEngine.initWorkflowEngine(fakeIo);
    expect(workflowEngine.getIO()).toBe(fakeIo);
    workflowEngine.initWorkflowEngine(null);
    expect(workflowEngine.getIO()).toBeNull();
    logSpy.mockRestore();
  });
});

describe('cron/workflowEngine — getIO stability + observed-side-effect emission contract', () => {
  test('getIO() returns the same reference on repeated calls (no per-call recompute)', () => {
    const fakeIo = { emit: vi.fn() };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    workflowEngine.initWorkflowEngine(fakeIo);
    const a = workflowEngine.getIO();
    const b = workflowEngine.getIO();
    const c = workflowEngine.getIO();
    logSpy.mockRestore();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('stored io can be used to emit (proves the ref is the live Socket.io instance, not a stale clone)', () => {
    const emit = vi.fn();
    const fakeIo = { emit };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    workflowEngine.initWorkflowEngine(fakeIo);
    workflowEngine.getIO().emit('workflow.test', { payload: 'x' });
    logSpy.mockRestore();
    expect(emit).toHaveBeenCalledWith('workflow.test', { payload: 'x' });
  });

  test('calling getIO() before init does NOT throw (pre-boot safety)', () => {
    expect(() => workflowEngine.getIO()).not.toThrow();
    expect(workflowEngine.getIO()).toBeNull();
  });
});

describe('cron/workflowEngine — module-load idempotency (require cache)', () => {
  test('two requireCJS calls without cache delete return the SAME module instance', () => {
    // After beforeEach we already deleted + re-required. A subsequent
    // require without cache-delete should return the cached instance,
    // proving the closed-over _io persists.
    const cached1 = requireCJS('../../cron/workflowEngine.js');
    const cached2 = requireCJS('../../cron/workflowEngine.js');
    expect(cached1).toBe(cached2);
    expect(cached1.initWorkflowEngine).toBe(cached2.initWorkflowEngine);
    expect(cached1.getIO).toBe(cached2.getIO);
  });
});
