// Unit tests for backend/cron/auditIntegrityEngine.js — Wave 10 coverage extension.
//
// Why this file exists (Wave 10 inspection):
//   • Pre-Wave-10 the module was 0% covered. The cron-engine implements #558's
//     daily integrity sweep: for every tenant, walk the audit hash chain,
//     verify each row's prevHash + recomputed hash, and emit an AUDIT_INTEGRITY
//     row recording {chainLength, brokenAt, head}. The integrity row itself is
//     hash-chained on top so future sweeps prove past sweeps weren't edited.
//
// Coverage targets (branch matrix at backend/cron/auditIntegrityEngine.js):
//   • happy path — tenant with N rows, chain unbroken → chainLength=N, brokenAt=null
//   • broken-chain detection at the prevHash check (row 2's prevHash != row 1's hash)
//   • broken-chain detection at the recomputed-hash check (row's hash tampered)
//   • multi-tenant scope — each tenant walks its own chain independently
//   • zero tenants — sweep completes without error, returns empty summary
//   • tenant with hash:null rows — skipped (chainLength only counts hashed rows)
//   • GENESIS marker — first row's prevHash must be `GENESIS_<tenantId>`
//   • AUDIT_INTEGRITY row creation — emits even on broken chains
//   • create-failure resilience — auditLog.create rejection logs but doesn't crash
//   • outer-catch resilience — auditLog.findMany rejection logs but doesn't crash
//
// Mocking strategy mirrors backend/test/cron/recurringInvoiceEngine.test.js:
// import the prisma singleton, monkey-patch model methods. The cron module is
// inlined via vitest.config.js → server.deps.inline so its `require("../lib/prisma")`
// resolves to the same singleton instance.
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { runAuditIntegritySweep } from '../../cron/auditIntegrityEngine.js';
import { computeHash } from '../../lib/audit.js';

beforeAll(() => {
  prisma.auditLog = {
    findMany: vi.fn(),
    create: vi.fn(),
  };
});

beforeEach(() => {
  prisma.auditLog.findMany.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({});
});

/**
 * Build a synthetic chain of N audit rows where each row's prevHash + hash
 * follow the canonical computeHash contract. Returns the rows ready to be
 * returned from prisma.auditLog.findMany (in createdAt-asc order).
 */
function buildValidChain(tenantId, n) {
  const rows = [];
  let lastHash = null;
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(Date.UTC(2026, 0, i + 1));
    const prevHash = lastHash == null ? `GENESIS_${tenantId}` : lastHash;
    const row = {
      id: i + 1,
      action: 'CREATE',
      entity: 'Contact',
      entityId: 100 + i,
      userId: 1,
      details: JSON.stringify({ name: `row-${i}` }),
      createdAt,
      prevHash,
      hash: null, // filled below
    };
    const hash = computeHash(prevHash, {
      tenantId,
      entity: row.entity,
      action: row.action,
      entityId: row.entityId,
      userId: row.userId,
      details: row.details,
      createdAt: createdAt.toISOString(),
    });
    row.hash = hash;
    lastHash = hash;
    rows.push(row);
  }
  return rows;
}

describe('cron/auditIntegrityEngine — happy path (chain unbroken)', () => {
  test('single-tenant 5-row chain → chainLength=5, brokenAt=null, emits AUDIT_INTEGRITY row', async () => {
    const tenantId = 7;
    const rows = buildValidChain(tenantId, 5);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }]) // distinct tenants
      .mockResolvedValueOnce(rows);          // rows for tenant 7

    const summary = await runAuditIntegritySweep();

    expect(summary).toEqual([{ tenantId, chainLength: 5, brokenAt: null }]);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.action).toBe('AUDIT_INTEGRITY');
    expect(arg.data.entity).toBe('AuditLog');
    expect(arg.data.tenantId).toBe(tenantId);
    expect(arg.data.userId).toBeNull();
    const details = JSON.parse(arg.data.details);
    expect(details.chainLength).toBe(5);
    expect(details.brokenAt).toBeNull();
    expect(details.head).toBe(rows[4].hash);
    expect(details.source).toBe('AuditIntegrityEngine');
    expect(typeof details.verifiedAt).toBe('string');
  });

  test('single-row chain — prevHash anchored to GENESIS_<tenantId>', async () => {
    const tenantId = 42;
    const rows = buildValidChain(tenantId, 1);
    expect(rows[0].prevHash).toBe('GENESIS_42');
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows);
    const summary = await runAuditIntegritySweep();
    expect(summary[0].chainLength).toBe(1);
    expect(summary[0].brokenAt).toBeNull();
  });

  test('empty chain — chainLength=0, brokenAt=null, AUDIT_INTEGRITY row still emitted', async () => {
    const tenantId = 9;
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce([]);
    const summary = await runAuditIntegritySweep();
    expect(summary).toEqual([{ tenantId, chainLength: 0, brokenAt: null }]);
    // The integrity row carries head:null when the chain was empty.
    const details = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(details.head).toBeNull();
    expect(details.chainLength).toBe(0);
    // The new integrity row anchors to GENESIS_<tenantId> when no prior hash.
    expect(prisma.auditLog.create.mock.calls[0][0].data.prevHash).toBe('GENESIS_9');
  });
});

describe('cron/auditIntegrityEngine — broken-chain detection', () => {
  test('prevHash mismatch at row 3 → brokenAt = row 3.id, chain count stops early', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 5);
    // Tamper: row 3's prevHash points to a different value.
    rows[2].prevHash = 'TAMPERED';
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows);

    const summary = await runAuditIntegritySweep();
    expect(summary).toEqual([{ tenantId, chainLength: 3, brokenAt: rows[2].id }]);
    // Integrity row still emitted with brokenAt populated.
    const details = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(details.brokenAt).toBe(rows[2].id);
    expect(details.head).toBe(rows[1].hash); // last good head
  });

  test('hash mismatch (row content tampered) → brokenAt = that row.id', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 3);
    // Tamper details on row 2 WITHOUT recomputing hash → recomputed != stored.
    rows[1].details = JSON.stringify({ name: 'evil' });
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows);

    const summary = await runAuditIntegritySweep();
    expect(summary[0].brokenAt).toBe(rows[1].id);
    expect(summary[0].chainLength).toBe(2);
  });

  test('logs a console.error when a chain is broken', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 2);
    rows[1].prevHash = 'BROKEN';
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAuditIntegritySweep();
    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls.map((args) => args.join(' ')).join(' ');
    expect(msg).toMatch(/BROKEN at row id=/);
    errSpy.mockRestore();
  });
});

describe('cron/auditIntegrityEngine — multi-tenant + edge cases', () => {
  test('walks each tenant independently with its own findMany call', async () => {
    const t1Rows = buildValidChain(1, 2);
    const t2Rows = buildValidChain(2, 3);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }, { tenantId: 2 }]) // distinct
      .mockResolvedValueOnce(t1Rows)
      .mockResolvedValueOnce(t2Rows);

    const summary = await runAuditIntegritySweep();
    expect(summary).toHaveLength(2);
    expect(summary).toContainEqual({ tenantId: 1, chainLength: 2, brokenAt: null });
    expect(summary).toContainEqual({ tenantId: 2, chainLength: 3, brokenAt: null });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });

  test('zero tenants — no integrity rows emitted, returns empty summary', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    const summary = await runAuditIntegritySweep();
    expect(summary).toEqual([]);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('rows with hash:null are skipped (chainLength only counts hashed rows)', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 3);
    // Insert a hash:null row at the start (simulates a pre-#558 row pre-dating the chain).
    const stale = { ...rows[0], id: 999, hash: null, prevHash: null };
    const withStale = [stale, ...rows];
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(withStale);
    const summary = await runAuditIntegritySweep();
    // chainLength should be 3, not 4 — the hash:null row is skipped silently.
    expect(summary[0].chainLength).toBe(3);
    expect(summary[0].brokenAt).toBeNull();
  });
});

describe('cron/auditIntegrityEngine — resilience', () => {
  test('auditLog.create failure logs but does NOT throw (sweep continues)', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 2);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows);
    prisma.auditLog.create.mockRejectedValue(new Error('DB write failed'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Should not throw — the .catch() on the create call swallows the error.
    await expect(runAuditIntegritySweep()).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('top-level findMany failure logs but does NOT throw', async () => {
    prisma.auditLog.findMany.mockRejectedValue(new Error('DB connection lost'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const summary = await runAuditIntegritySweep();
    expect(summary).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('cron/auditIntegrityEngine — emitted-row hash-chain anchoring', () => {
  test('AUDIT_INTEGRITY row chains to the head it just verified (prevents retroactive edits)', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 2);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows);
    await runAuditIntegritySweep();
    const arg = prisma.auditLog.create.mock.calls[0][0];
    // The new row's prevHash must equal the verified head.
    expect(arg.data.prevHash).toBe(rows[1].hash);
    // The new row's hash must be the recomputed chain extension.
    const expected = computeHash(arg.data.prevHash, {
      tenantId,
      entity: 'AuditLog',
      action: 'AUDIT_INTEGRITY',
      entityId: null,
      userId: null,
      details: arg.data.details,
      createdAt: arg.data.createdAt.toISOString(),
    });
    expect(arg.data.hash).toBe(expected);
  });
});
