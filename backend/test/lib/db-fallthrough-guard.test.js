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
import { dbFallthroughGuard } from '../setup.js';

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
