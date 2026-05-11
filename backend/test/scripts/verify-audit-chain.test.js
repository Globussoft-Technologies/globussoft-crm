/**
 * Unit tests for backend/scripts/verify-audit-chain.js — the CLI mirror
 * of GET /api/audit/verify + cron/auditIntegrityEngine, for the #558
 * hash-chain tamper-evidence trail.
 *
 * The CLI's main() exits the process and prints to stdout, which is
 * awkward to test directly. Instead we test walkTenant() and listTenants()
 * — the underlying primitives — which are the SUT for "does the walker
 * agree with the route + cron walker on what counts as broken?"
 *
 * Mocking strategy mirrors backend/test/cron/auditIntegrityEngine.test.js:
 * patch the prisma singleton's auditLog methods so the script's
 * `require('../lib/prisma')` resolves to the same vi.fn() instance.
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { walkTenant, listTenants } from '../../scripts/verify-audit-chain.js';
import { computeHash } from '../../lib/audit.js';

beforeAll(() => {
  prisma.auditLog = {
    findMany: vi.fn(),
  };
});

beforeEach(() => {
  prisma.auditLog.findMany.mockReset();
});

function buildValidChain(tenantId, n) {
  const rows = [];
  let lastHash = null;
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(Date.UTC(2026, 4, i + 1));
    const prevHash = lastHash == null ? `GENESIS_${tenantId}` : lastHash;
    const row = {
      id: i + 1,
      action: 'CREATE',
      entity: 'Contact',
      entityId: 100 + i,
      userId: 1,
      details: JSON.stringify({ n: i }),
      createdAt,
      prevHash,
      hash: null,
    };
    row.hash = computeHash(prevHash, {
      tenantId,
      entity: row.entity,
      action: row.action,
      entityId: row.entityId,
      userId: row.userId,
      details: row.details,
      createdAt: createdAt.toISOString(),
    });
    lastHash = row.hash;
    rows.push(row);
  }
  return rows;
}

describe('scripts/verify-audit-chain — walkTenant (happy path)', () => {
  test('clean 4-row chain → integrityVerified=true, chainLength=4', async () => {
    const tenantId = 11;
    const rows = buildValidChain(tenantId, 4);
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const r = await walkTenant(tenantId);
    expect(r.integrityVerified).toBe(true);
    expect(r.chainLength).toBe(4);
    expect(r.brokenAt).toBeNull();
    expect(r.brokenReason).toBeNull();
    expect(r.head).toBe(rows[3].hash);
  });

  test('empty chain → integrityVerified=true, chainLength=0, head=null', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    const r = await walkTenant(42);
    expect(r.integrityVerified).toBe(true);
    expect(r.chainLength).toBe(0);
    expect(r.head).toBeNull();
  });

  test('queries with deterministic [createdAt asc, id asc] ordering', async () => {
    // The CLI must walk in the same order as the HTTP route + cron sweep
    // so all three agree on which row is "broken" when they disagree.
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    await walkTenant(1);
    const callArgs = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArgs.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(callArgs.where).toEqual({ tenantId: 1 });
  });

  test('legacy null-hash row is treated as broken (#558 strict semantics)', async () => {
    // Pre-strict-refactor this test asserted the walker silently SKIPPED
    // null-hash rows. That was the bug: a tenant with 200 legacy unhashed
    // rows and zero hashed rows showed chainLength=0, integrityVerified=true
    // — a false-green badge in the UI. Strict semantics flip that to:
    // null hash on ANY row is a chain break, and the UI must show the
    // operator a "backfill required" banner. The CLI agrees so a forensic
    // sweep matches the UI's verdict.
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 3);
    rows.unshift({
      id: 99, action: 'CREATE', entity: 'X', entityId: 1, userId: 1,
      details: null, createdAt: new Date(Date.UTC(2026, 0, 1)),
      prevHash: null, hash: null,
    });
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const r = await walkTenant(tenantId);
    expect(r.integrityVerified).toBe(false);
    expect(r.brokenAt).toBe(99);
    expect(r.brokenReason).toMatch(/null hash/i);
    // chainLength counts the broken row in (we increment before the check),
    // matching the route + cron walker semantics so all three agree.
    expect(r.chainLength).toBe(1);
    expect(r.totalRows).toBe(4);
  });
});

describe('scripts/verify-audit-chain — walkTenant (broken-chain detection)', () => {
  test('prevHash mismatch → brokenAt + brokenReason populated', async () => {
    const tenantId = 7;
    const rows = buildValidChain(tenantId, 3);
    rows[1].prevHash = 'NOT-THE-ACTUAL-PREV';
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const r = await walkTenant(tenantId);
    expect(r.integrityVerified).toBe(false);
    expect(r.brokenAt).toBe(rows[1].id);
    expect(r.brokenReason).toMatch(/prevHash mismatch/i);
    // chainLength counts the broken row in (incremented BEFORE the check),
    // matching cron/auditIntegrityEngine's semantics so a sweep + a CLI
    // run report the same number.
    expect(r.chainLength).toBe(2);
  });

  test('row-content tampering (hash recomputes to a different value)', async () => {
    const tenantId = 7;
    const rows = buildValidChain(tenantId, 3);
    // Tamper details on row 2 without updating .hash → recomputed != stored.
    rows[1].details = JSON.stringify({ evil: true });
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const r = await walkTenant(tenantId);
    expect(r.integrityVerified).toBe(false);
    expect(r.brokenAt).toBe(rows[1].id);
    expect(r.brokenReason).toMatch(/hash mismatch/i);
  });

  test('userId tamper detected (different field, same shape)', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 2);
    rows[0].userId = 99999;
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const r = await walkTenant(tenantId);
    expect(r.integrityVerified).toBe(false);
    expect(r.brokenAt).toBe(rows[0].id);
  });

  test('first row prevHash != GENESIS_<tenantId> → broken at row 1', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 1);
    rows[0].prevHash = 'GENESIS_OTHER_TENANT';
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const r = await walkTenant(tenantId);
    expect(r.integrityVerified).toBe(false);
    expect(r.brokenAt).toBe(rows[0].id);
  });
});

describe('scripts/verify-audit-chain — listTenants', () => {
  test('with only=<id> short-circuits the DB query (forensic-friendly)', async () => {
    // When the auditor passes --tenant N, skip the distinct-tenants query
    // entirely (avoids a full-table scan when the tenant is known).
    const out = await listTenants(5);
    expect(out).toEqual([{ tenantId: 5 }]);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('without args lists distinct tenants asc', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([
      { tenantId: 1 }, { tenantId: 2 }, { tenantId: 3 },
    ]);
    const out = await listTenants(null);
    expect(out).toEqual([{ tenantId: 1 }, { tenantId: 2 }, { tenantId: 3 }]);
    const callArgs = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArgs.distinct).toEqual(['tenantId']);
    expect(callArgs.orderBy).toEqual({ tenantId: 'asc' });
  });
});
