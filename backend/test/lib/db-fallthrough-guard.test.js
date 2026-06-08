// Sentinel test for the T35 test-harness guard against real-DB fall-through.
//
// What's tested: backend/test/setup.js's dbFallthroughGuard() function.
//
// Why this matters: the guard exists to make mock-coverage gaps LOUD. Without
// it, a route's unmocked prisma call falls through to whatever DATABASE_URL
// points at (typically the demo MySQL on a dev box) and the test passes "by
// accident" against real data. The guard refuses to start the vitest suite
// when DATABASE_URL is non-local — this test pins the guard's contract so a
// future refactor doesn't silently re-introduce the trap.
//
// Contract pinned here:
//   1. Throws when DATABASE_URL is a remote host AND VITEST === 'true'.
//   2. Allows localhost / 127.0.0.1 / ::1 / *.local / "mysql" / "db".
//   3. Respects the ALLOW_REMOTE_DB_IN_TESTS=1 escape hatch.
//   4. No-ops when VITEST is not set (so non-vitest callers don't trip it).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dbFallthroughGuard, prismaSurfaceGuard } from '../setup.js';

describe('db-fallthrough-guard (T35)', () => {
  let originalDatabaseUrl;
  let originalAllow;
  let originalVitest;

  beforeEach(() => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    originalAllow = process.env.ALLOW_REMOTE_DB_IN_TESTS;
    originalVitest = process.env.VITEST;
    // Ensure VITEST is set so the guard's gate is open by default in each
    // case — the suite is running under vitest so this is its natural value,
    // but we set it explicitly to make the test deterministic against any
    // future env-cleanup wrapper.
    process.env.VITEST = 'true';
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalAllow === undefined) delete process.env.ALLOW_REMOTE_DB_IN_TESTS;
    else process.env.ALLOW_REMOTE_DB_IN_TESTS = originalAllow;
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
  });

  it('throws when DATABASE_URL is remote and VITEST is set', () => {
    process.env.DATABASE_URL = 'mysql://root:pw@163.227.174.141:3306/gbscrm';
    delete process.env.ALLOW_REMOTE_DB_IN_TESTS;
    expect(() => dbFallthroughGuard()).toThrow(/remote host/);
  });

  it('allows localhost DATABASE_URL', () => {
    process.env.DATABASE_URL = 'mysql://root@localhost:3306/gbscrm';
    delete process.env.ALLOW_REMOTE_DB_IN_TESTS;
    expect(() => dbFallthroughGuard()).not.toThrow();
  });

  it('allows 127.0.0.1 DATABASE_URL', () => {
    process.env.DATABASE_URL = 'mysql://root@127.0.0.1:3306/gbscrm';
    delete process.env.ALLOW_REMOTE_DB_IN_TESTS;
    expect(() => dbFallthroughGuard()).not.toThrow();
  });

  it('allows ::1 (IPv6 loopback) DATABASE_URL', () => {
    process.env.DATABASE_URL = 'mysql://root@[::1]:3306/gbscrm';
    delete process.env.ALLOW_REMOTE_DB_IN_TESTS;
    expect(() => dbFallthroughGuard()).not.toThrow();
  });

  it('allows docker-compose "mysql" service host', () => {
    process.env.DATABASE_URL = 'mysql://root:pw@mysql:3306/gbscrm';
    delete process.env.ALLOW_REMOTE_DB_IN_TESTS;
    expect(() => dbFallthroughGuard()).not.toThrow();
  });

  it('respects ALLOW_REMOTE_DB_IN_TESTS escape hatch', () => {
    process.env.DATABASE_URL = 'mysql://root@163.227.174.141:3306/gbscrm';
    process.env.ALLOW_REMOTE_DB_IN_TESTS = '1';
    expect(() => dbFallthroughGuard()).not.toThrow();
  });

  it('no-ops when VITEST is not set (non-vitest callers)', () => {
    delete process.env.VITEST;
    process.env.DATABASE_URL = 'mysql://root@163.227.174.141:3306/gbscrm';
    delete process.env.ALLOW_REMOTE_DB_IN_TESTS;
    expect(() => dbFallthroughGuard()).not.toThrow();
  });

  it('no-ops when DATABASE_URL is empty (prisma surfaces its own error)', () => {
    process.env.DATABASE_URL = '';
    delete process.env.ALLOW_REMOTE_DB_IN_TESTS;
    expect(() => dbFallthroughGuard()).not.toThrow();
  });

  it('no-ops when DATABASE_URL is unparseable (prisma surfaces its own error)', () => {
    process.env.DATABASE_URL = 'not-a-valid-url-at-all';
    delete process.env.ALLOW_REMOTE_DB_IN_TESTS;
    expect(() => dbFallthroughGuard()).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T39 — Option B: PrismaClient surface guard. Catches the LOCAL-DB-with-
// incomplete-mocks case that T35 misses. Wraps `@prisma/client`'s
// PrismaClient at the class level so any unmocked surface call throws a
// diagnostic error naming the offending model + method.
//
// Contract pinned here:
//   1. `prismaSurfaceGuard` is exported as a named function from setup.js.
//   2. After setupFiles run (which they do before this test file is
//      collected), the PrismaClient export from `@prisma/client` is the
//      wrapped class (`__t39Wrapped === true`).
//   3. `new PrismaClient()` returns a proxy. Any `client.<model>.<method>()`
//      call throws with `[prisma-surface-guard]` + the model + method name.
//   4. Lifecycle methods don't throw: `$connect` / `$disconnect` resolve
//      to undefined; `$on` / `$use` return undefined sync; `$extends`
//      returns the proxy itself (so chained .$extends(...) works for the
//      `backend/lib/prisma.js` singleton's PII extension).
//   5. `$transaction` and raw-query methods (`$queryRaw`, `$executeRaw`,
//      `$queryRawUnsafe`, `$executeRawUnsafe`) throw — there's no way a
//      test should be hitting these without a mock.
//   6. PRISMA_ALLOW_REAL_CALLS env var is the documented escape hatch (the
//      wrap is gated on its absence at setupFiles-load time; this test
//      pins that the gate exists rather than re-running setupFiles).
// ───────────────────────────────────────────────────────────────────────────
describe('prisma-surface-guard (T39)', () => {
  it('exports prismaSurfaceGuard as a named function', () => {
    expect(typeof prismaSurfaceGuard).toBe('function');
  });

  it('wraps @prisma/client PrismaClient (marker flag set)', () => {
    const { PrismaClient } = require('@prisma/client');
    expect(PrismaClient.__t39Wrapped).toBe(true);
  });

  it('preserves the original PrismaClient constructor for introspection', () => {
    const { PrismaClient } = require('@prisma/client');
    expect(typeof PrismaClient.__realPrismaClient).toBe('function');
    expect(PrismaClient.__realPrismaClient).not.toBe(PrismaClient);
  });

  it('throws with a clear diagnostic when an unmocked model.method() is called', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    expect(() => client.user.findMany()).toThrow(/\[prisma-surface-guard\]/);
    expect(() => client.user.findMany()).toThrow(/prisma\.user\.findMany/);
  });

  it('names the specific model + method in the error (different surface)', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    expect(() => client.contact.create()).toThrow(/prisma\.contact\.create/);
  });

  it('lifecycle $connect and $disconnect resolve without throwing', async () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    await expect(client.$connect()).resolves.toBeUndefined();
    await expect(client.$disconnect()).resolves.toBeUndefined();
  });

  it('$on and $use are sync no-ops (used by some Prisma middleware patterns)', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    expect(() => client.$on('query', () => {})).not.toThrow();
    expect(() => client.$use(async (params, next) => next(params))).not.toThrow();
  });

  it('$extends returns the proxy itself so chained extensions work', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    const extended = client.$extends({ name: 'test' });
    // The extended client should still be a proxy that throws on model access
    expect(() => extended.user.findMany()).toThrow(/\[prisma-surface-guard\]/);
  });

  it('$transaction throws (no test should ever hit a real transaction)', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    expect(() => client.$transaction([])).toThrow(/\[prisma-surface-guard\]/);
    expect(() => client.$transaction([])).toThrow(/\$transaction/);
  });

  it('raw query methods throw with a diagnostic message', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    expect(() => client.$queryRaw`SELECT 1`).toThrow(/\[prisma-surface-guard\]/);
    expect(() => client.$executeRawUnsafe('SELECT 1')).toThrow(/\[prisma-surface-guard\]/);
  });

  it('Symbol property access does not throw (avoids breaking iteration/inspection)', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    expect(() => client[Symbol.iterator]).not.toThrow();
    expect(client[Symbol.iterator]).toBeUndefined();
    expect(() => client.user[Symbol.iterator]).not.toThrow();
  });

  it('promise-like introspection (then/catch/finally) returns undefined, not a thrower', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    // If `then` threw, every `await prisma` would explode — keep the proxy
    // safe to accidentally return from an async function.
    expect(client.then).toBeUndefined();
    expect(client.catch).toBeUndefined();
    expect(client.user.then).toBeUndefined();
  });

  it('error message points devs at the documented escape hatch', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    expect(() => client.user.findMany()).toThrow(/PRISMA_ALLOW_REAL_CALLS=1/);
  });

  it('error message points devs at the canonical vi.mock pattern', () => {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    expect(() => client.user.findMany()).toThrow(/vi\.mock/);
  });
});
