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
      .mockResolvedValueOnce(rows)           // rows for tenant 7 (batch 1)
      .mockResolvedValueOnce([]);            // empty batch terminates cursor walk

    const summary = await runAuditIntegritySweep();

    expect(summary).toEqual([{ tenantId, chainLength: 5, brokenAt: null, reason: null }]);
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
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
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
    expect(summary).toEqual([{ tenantId, chainLength: 0, brokenAt: null, reason: null }]);
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
    expect(summary).toHaveLength(1);
    expect(summary[0].tenantId).toBe(tenantId);
    expect(summary[0].chainLength).toBe(3);
    expect(summary[0].brokenAt).toBe(rows[2].id);
    expect(summary[0].reason).toMatch(/prevHash mismatch/i);
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
      .mockResolvedValueOnce([]) // terminate tenant 1 cursor walk
      .mockResolvedValueOnce(t2Rows)
      .mockResolvedValueOnce([]); // terminate tenant 2 cursor walk

    const summary = await runAuditIntegritySweep();
    expect(summary).toHaveLength(2);
    expect(summary).toContainEqual({ tenantId: 1, chainLength: 2, brokenAt: null, reason: null });
    expect(summary).toContainEqual({ tenantId: 2, chainLength: 3, brokenAt: null, reason: null });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });

  test('zero tenants — no integrity rows emitted, returns empty summary', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    const summary = await runAuditIntegritySweep();
    expect(summary).toEqual([]);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('rows with hash:null are treated as broken (#558 strict semantics)', async () => {
    // Pre-strict-refactor the cron silently skipped null-hash rows, which
    // matched the buggy /verify behaviour: a tenant with 200 legacy
    // unhashed rows logged "chainLength=0, brokenAt=null" and the UI's
    // green checkmark misled auditors. Strict semantics flip that: null
    // hash is a chain break, the cron emits AUDIT_INTEGRITY with
    // brokenAt populated, and the operator runs the backfill.
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 3);
    const stale = { ...rows[0], id: 999, hash: null, prevHash: null };
    const withStale = [stale, ...rows];
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(withStale);
    const summary = await runAuditIntegritySweep();
    expect(summary[0].brokenAt).toBe(999);
    expect(summary[0].chainLength).toBe(1);
    expect(summary[0].reason).toMatch(/null hash/i);
  });
});

describe('cron/auditIntegrityEngine — resilience', () => {
  test('auditLog.create failure logs but does NOT throw (sweep continues)', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 2);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
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
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
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

// ----------------------------------------------------------------------------
// Wave 11 extension (+8 cases) — pins under-covered branches of the SUT:
//
//   • Query contract — `findMany` is called with the documented `distinct`
//     selector for tenant discovery + the `[createdAt asc, id asc]` tie-break
//     order for chain walk. The tie-break comment in the SUT (lines 30-35)
//     calls out that without `id asc`, the cron + /api/audit/verify can
//     disagree on `brokenAt` for sub-millisecond writes; pinning the contract
//     in a unit test guards against silent removal.
//
//   • Detection halts on first break — once a row fails validation, subsequent
//     rows must NOT be walked (chainLength stops at the break point; the head
//     emitted in details reflects the last-good row).
//
//   • Cross-tenant isolation of brokenAt — a break in tenant A's chain must
//     not poison tenant B's brokenAt/reason; each tenant produces an
//     independent summary entry.
//
//   • Genesis-position break — tampering the first row's prevHash (must equal
//     GENESIS_<tenantId>) breaks the chain at row 1, NOT silently passes.
//
//   • Reason serialization — the human-readable reason string surfaces in the
//     emitted integrity row's `details.reason` field for /audit-log reviewers.
//
//   • Integrity-row identity shape — every emitted row carries
//     entity='AuditLog' + action='AUDIT_INTEGRITY' + entityId=null + userId=null
//     across the multi-tenant case (not only the single-tenant happy path).
//
//   • createdAt is a Date instance — the integrity row's createdAt field is
//     emitted as a JS Date (not a string), matching the schema column type and
//     the helper's own `.toISOString()` call site.
//
//   • Empty-chain integrity row hash — the hash on an emitted row for a
//     zero-row chain is correctly computed against GENESIS_<tenantId> with the
//     row's own canonical payload (proves the SUT can extend a fresh chain
//     even when there's nothing to verify).

describe('cron/auditIntegrityEngine — query contract', () => {
  test('uses distinct:["tenantId"] for tenant discovery and orderBy:[createdAt asc, id asc] for chain walk', async () => {
    const tenantId = 11;
    const rows = buildValidChain(tenantId, 2);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows);

    await runAuditIntegritySweep();

    // First call — distinct tenant discovery
    const distinctArg = prisma.auditLog.findMany.mock.calls[0][0];
    expect(distinctArg).toMatchObject({
      distinct: ['tenantId'],
      select: { tenantId: true },
    });

    // Second call — chain walk for tenant 11
    const walkArg = prisma.auditLog.findMany.mock.calls[1][0];
    expect(walkArg.where).toEqual({ tenantId: 11 });
    expect(walkArg.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    // Walk must select the fields required to recompute the hash.
    expect(walkArg.select).toMatchObject({
      id: true, action: true, entity: true, entityId: true, userId: true,
      details: true, createdAt: true, prevHash: true, hash: true,
    });
  });
});

describe('cron/auditIntegrityEngine — break stops the walk', () => {
  test('a break at row 2 does NOT process rows 3, 4, 5 — chainLength=2, head=row1.hash', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 5);
    // Break row 2 by tampering its prevHash AND row 3+'s prevHash/hash so that
    // if the walker erroneously continued past the break, the test would see
    // chainLength > 2.
    rows[1].prevHash = 'TAMPERED_AT_ROW_2';
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows);

    const summary = await runAuditIntegritySweep();

    expect(summary[0].chainLength).toBe(2);
    expect(summary[0].brokenAt).toBe(rows[1].id);
    // The emitted integrity row's head must reflect the LAST-GOOD row (row 1),
    // not any row past the break — proving the walker exited the loop early.
    const details = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(details.head).toBe(rows[0].hash);
    expect(details.chainLength).toBe(2);
  });

  test('genesis-position break — row 1 with non-GENESIS prevHash breaks at row 1', async () => {
    const tenantId = 5;
    const rows = buildValidChain(tenantId, 3);
    // Tamper row 1's prevHash so it no longer equals GENESIS_5. The walker
    // MUST flag this as a break — silently accepting any "head" would let an
    // attacker rewrite history by replacing the genesis row.
    rows[0].prevHash = 'FAKE_GENESIS';
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows);

    const summary = await runAuditIntegritySweep();

    expect(summary[0].brokenAt).toBe(rows[0].id);
    expect(summary[0].chainLength).toBe(1);
    expect(summary[0].reason).toMatch(/prevHash mismatch/i);
    // The emitted integrity row's head is null — no rows ever verified.
    const details = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(details.head).toBeNull();
  });
});

describe('cron/auditIntegrityEngine — cross-tenant isolation', () => {
  test('a break in tenant 1 does NOT propagate brokenAt/reason to tenant 2', async () => {
    const t1Rows = buildValidChain(1, 3);
    t1Rows[1].prevHash = 'BROKEN_T1';
    const t2Rows = buildValidChain(2, 2);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }, { tenantId: 2 }])
      .mockResolvedValueOnce(t1Rows) // tenant 1 breaks → loop exits, no empty batch needed
      .mockResolvedValueOnce(t2Rows)
      .mockResolvedValueOnce([]); // terminate tenant 2 cursor walk

    const summary = await runAuditIntegritySweep();

    expect(summary).toHaveLength(2);
    const t1 = summary.find((s) => s.tenantId === 1);
    const t2 = summary.find((s) => s.tenantId === 2);
    // Tenant 1: broken
    expect(t1.brokenAt).toBe(t1Rows[1].id);
    expect(t1.reason).toMatch(/prevHash mismatch/i);
    expect(t1.chainLength).toBe(2);
    // Tenant 2: clean — must not carry-over t1's brokenAt or reason
    expect(t2.brokenAt).toBeNull();
    expect(t2.reason).toBeNull();
    expect(t2.chainLength).toBe(2);
  });

  test('multi-tenant integrity rows carry the canonical identity shape — entity, action, entityId, userId all match', async () => {
    const t1Rows = buildValidChain(1, 1);
    const t2Rows = buildValidChain(2, 1);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId: 1 }, { tenantId: 2 }])
      .mockResolvedValueOnce(t1Rows)
      .mockResolvedValueOnce([]) // terminate tenant 1 cursor walk
      .mockResolvedValueOnce(t2Rows)
      .mockResolvedValueOnce([]); // terminate tenant 2 cursor walk

    await runAuditIntegritySweep();

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    for (const call of prisma.auditLog.create.mock.calls) {
      expect(call[0].data.action).toBe('AUDIT_INTEGRITY');
      expect(call[0].data.entity).toBe('AuditLog');
      expect(call[0].data.entityId).toBeNull();
      expect(call[0].data.userId).toBeNull();
    }
    // Per-tenant scope is preserved — emitted tenantId matches the chain's.
    const emittedTenantIds = prisma.auditLog.create.mock.calls.map((c) => c[0].data.tenantId);
    expect(emittedTenantIds).toEqual([1, 2]);
  });
});

describe('cron/auditIntegrityEngine — emitted-row metadata', () => {
  test('details.reason is null on a clean chain, populated on a broken chain', async () => {
    const tenantId = 1;
    const cleanRows = buildValidChain(tenantId, 2);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(cleanRows)
      .mockResolvedValueOnce([]);
    await runAuditIntegritySweep();
    const cleanDetails = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(cleanDetails.reason).toBeNull();

    // Re-set + run broken case
    prisma.auditLog.findMany.mockReset();
    prisma.auditLog.create.mockReset();
    prisma.auditLog.create.mockResolvedValue({});
    const brokenRows = buildValidChain(tenantId, 2);
    brokenRows[1].hash = 'TAMPERED';
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(brokenRows);
    await runAuditIntegritySweep();
    const brokenDetails = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(brokenDetails.reason).toMatch(/hash mismatch/i);
    expect(brokenDetails.brokenAt).toBe(brokenRows[1].id);
  });

  test('createdAt is a Date instance and verifiedAt is a parseable ISO-8601 timestamp', async () => {
    const tenantId = 1;
    const rows = buildValidChain(tenantId, 1);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);

    const before = Date.now();
    await runAuditIntegritySweep();
    const after = Date.now();

    const arg = prisma.auditLog.create.mock.calls[0][0];
    // Schema column is DateTime — emitted as a JS Date, not a string.
    expect(arg.data.createdAt).toBeInstanceOf(Date);
    expect(arg.data.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(arg.data.createdAt.getTime()).toBeLessThanOrEqual(after);
    // verifiedAt is the ISO string the human reviewer sees in /audit-log.
    const details = JSON.parse(arg.data.details);
    const verifiedAtMs = Date.parse(details.verifiedAt);
    expect(Number.isFinite(verifiedAtMs)).toBe(true);
    expect(verifiedAtMs).toBeGreaterThanOrEqual(before);
    expect(verifiedAtMs).toBeLessThanOrEqual(after);
  });

  test('empty-chain integrity row: prevHash=GENESIS_<tenantId> AND hash is the canonical extension thereof', async () => {
    const tenantId = 77;
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ tenantId }])
      .mockResolvedValueOnce([]);

    await runAuditIntegritySweep();

    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.prevHash).toBe('GENESIS_77');
    // The emitted hash must be the recomputed extension — proves the SUT can
    // start a fresh chain even when the walk found zero rows.
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
