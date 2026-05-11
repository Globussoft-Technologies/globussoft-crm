// Unit tests for backend/lib/audit.js
//
// Mocking strategy: vitest 4's `vi.mock` does NOT intercept CJS `require()`
// calls inside the SUT (see commentary in test/lib/eventBus.test.js). We
// therefore monkey-patch the prisma singleton's model properties at
// beforeAll() so that BOTH the SUT and this test file see the same vi.fn()
// instance. This works because lib/prisma.js exports a singleton.
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import audit from '../../lib/audit.js';

const { writeAudit, diffFields, canonicalize, computeHash, genesisFor, backfillTenantChain } = audit;

beforeAll(() => {
  // #558 — writeAudit now also calls prisma.auditLog.findFirst() to look up
  // the previous row's hash; mock it alongside .create. backfillTenantChain
  // additionally needs findMany + update.
  prisma.auditLog = {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  };
});

beforeEach(() => {
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset();
  prisma.auditLog.findFirst.mockResolvedValue(null); // default: empty chain
  prisma.auditLog.findMany.mockReset();
  prisma.auditLog.findMany.mockResolvedValue([]);
  prisma.auditLog.update.mockReset();
  prisma.auditLog.update.mockResolvedValue({});
});

describe('lib/audit — module shape', () => {
  test('exports writeAudit + diffFields functions', () => {
    expect(typeof writeAudit).toBe('function');
    expect(typeof diffFields).toBe('function');
  });
});

describe('lib/audit — writeAudit', () => {
  test('no-ops when tenantId missing', async () => {
    await writeAudit('Contact', 'CREATE', 1, 1, null, { foo: 'bar' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('no-ops when tenantId undefined', async () => {
    await writeAudit('Contact', 'CREATE', 1, 1, undefined, null);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('no-ops when tenantId is 0 (falsy)', async () => {
    await writeAudit('Contact', 'CREATE', 1, 1, 0, null);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('creates basic audit row with all fields', async () => {
    await writeAudit('Contact', 'CREATE', 42, 7, 9, { name: 'Foo' });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.action).toBe('CREATE');
    expect(arg.data.entity).toBe('Contact');
    expect(arg.data.entityId).toBe(42);
    expect(arg.data.userId).toBe(7);
    expect(arg.data.tenantId).toBe(9);
  });

  test('coerces entityId/userId/tenantId to Number', async () => {
    await writeAudit('Deal', 'UPDATE', '12', '34', '56', null);
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.entityId).toBe(12);
    expect(arg.data.userId).toBe(34);
    expect(arg.data.tenantId).toBe(56);
  });

  test('passes entityId=null when entityId is null', async () => {
    await writeAudit('Bulk', 'EXPORT', null, 1, 1, null);
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.entityId).toBeNull();
  });

  test('passes userId=null when userId is null (system action)', async () => {
    await writeAudit('Cron', 'RUN', 1, null, 1, null);
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.userId).toBeNull();
  });

  test('JSON-stringifies object details', async () => {
    await writeAudit('Contact', 'UPDATE', 1, 1, 1, { fieldsChanged: ['x'] });
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(typeof arg.data.details).toBe('string');
    expect(JSON.parse(arg.data.details)).toEqual({ fieldsChanged: ['x'] });
  });

  test('passes string details through unchanged', async () => {
    await writeAudit('Contact', 'NOTE', 1, 1, 1, 'plain string detail');
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.details).toBe('plain string detail');
  });

  test('details=null is preserved', async () => {
    await writeAudit('Contact', 'DELETE', 1, 1, 1, null);
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.details).toBeNull();
  });

  test('default actorType=user → does NOT mutate details', async () => {
    await writeAudit('Contact', 'CREATE', 1, 7, 1, { name: 'A' });
    const arg = prisma.auditLog.create.mock.calls[0][0];
    const parsed = JSON.parse(arg.data.details);
    expect(parsed._actorType).toBeUndefined();
  });

  test('actorType=patient injects _actorType into details', async () => {
    await writeAudit('Visit', 'PATIENT_DETAIL_READ', 5, null, 1, { foo: 1 }, { actorType: 'patient', patientId: 99 });
    const arg = prisma.auditLog.create.mock.calls[0][0];
    const parsed = JSON.parse(arg.data.details);
    expect(parsed._actorType).toBe('patient');
    expect(parsed._patientActorId).toBe(99);
    expect(parsed.foo).toBe(1);
  });

  test('actorType=system inferred when userId is null', async () => {
    await writeAudit('Cron', 'RUN', 1, null, 1, { task: 'sync' });
    const arg = prisma.auditLog.create.mock.calls[0][0];
    const parsed = JSON.parse(arg.data.details);
    expect(parsed._actorType).toBe('system');
  });

  test('null details + patient actor → wraps into object', async () => {
    await writeAudit('Visit', 'READ', 5, null, 1, null, { actorType: 'patient', patientId: 7 });
    const arg = prisma.auditLog.create.mock.calls[0][0];
    const parsed = JSON.parse(arg.data.details);
    expect(parsed._actorType).toBe('patient');
    expect(parsed._patientActorId).toBe(7);
  });

  test('string-encoded JSON details + patient actor → merged', async () => {
    await writeAudit('Visit', 'READ', 5, null, 1, '{"foo":"bar"}', { actorType: 'patient', patientId: 7 });
    const arg = prisma.auditLog.create.mock.calls[0][0];
    const parsed = JSON.parse(arg.data.details);
    expect(parsed.foo).toBe('bar');
    expect(parsed._actorType).toBe('patient');
  });

  test('non-JSON string details + patient actor → wrapped as _raw', async () => {
    await writeAudit('Visit', 'READ', 5, null, 1, 'not-a-json', { actorType: 'patient', patientId: 7 });
    const arg = prisma.auditLog.create.mock.calls[0][0];
    const parsed = JSON.parse(arg.data.details);
    expect(parsed._raw).toBe('not-a-json');
    expect(parsed._actorType).toBe('patient');
  });

  test('patientId coerced to Number', async () => {
    await writeAudit('Visit', 'READ', 5, null, 1, {}, { actorType: 'patient', patientId: '123' });
    const arg = prisma.auditLog.create.mock.calls[0][0];
    const parsed = JSON.parse(arg.data.details);
    expect(parsed._patientActorId).toBe(123);
  });

  test('swallows prisma.auditLog.create failures (does not throw)', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(writeAudit('Contact', 'CREATE', 1, 1, 1, null)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('returns undefined on success', async () => {
    const result = await writeAudit('Contact', 'CREATE', 1, 1, 1, null);
    expect(result).toBeUndefined();
  });
});

describe('lib/audit — diffFields (pure)', () => {
  test('returns empty object when both inputs identical', () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1, b: 2 }, ['a', 'b'])).toEqual({});
  });

  test('captures changed primitive fields', () => {
    const out = diffFields({ a: 1, b: 2 }, { a: 1, b: 5 }, ['a', 'b']);
    expect(out).toEqual({ b: { from: 2, to: 5 } });
  });

  test('captures multiple changes', () => {
    const out = diffFields({ a: 1, b: 2, c: 3 }, { a: 9, b: 2, c: 7 }, ['a', 'b', 'c']);
    expect(out).toEqual({
      a: { from: 1, to: 9 },
      c: { from: 3, to: 7 },
    });
  });

  test('returns empty {} when before is null', () => {
    expect(diffFields(null, { a: 1 }, ['a'])).toEqual({});
  });

  test('returns empty {} when after is null', () => {
    expect(diffFields({ a: 1 }, null, ['a'])).toEqual({});
  });

  test('skips fields where after value is undefined', () => {
    const out = diffFields({ a: 1, b: 2 }, { a: undefined, b: 5 }, ['a', 'b']);
    expect(out).toEqual({ b: { from: 2, to: 5 } });
  });

  test('falls back to Object.keys(after) when keys list omitted', () => {
    const out = diffFields({ a: 1, b: 2 }, { a: 9, b: 2 });
    expect(out).toEqual({ a: { from: 1, to: 9 } });
  });

  test('normalises Date objects via toISOString', () => {
    const before = { d: new Date('2024-01-01T00:00:00Z') };
    const after = { d: new Date('2024-01-01T00:00:00Z') };
    expect(diffFields(before, after, ['d'])).toEqual({});
  });

  test('detects different Date values', () => {
    const before = { d: new Date('2024-01-01T00:00:00Z') };
    const after = { d: new Date('2024-02-01T00:00:00Z') };
    const out = diffFields(before, after, ['d']);
    expect(out.d.from).toBe('2024-01-01T00:00:00.000Z');
    expect(out.d.to).toBe('2024-02-01T00:00:00.000Z');
  });

  test('uses JSON.stringify equality for nested objects', () => {
    const out = diffFields({ a: { x: 1 } }, { a: { x: 1 } }, ['a']);
    expect(out).toEqual({});
  });

  test('detects nested object changes', () => {
    const out = diffFields({ a: { x: 1 } }, { a: { x: 2 } }, ['a']);
    expect(out.a).toBeDefined();
  });

  test('null → value counts as change', () => {
    const out = diffFields({ a: null }, { a: 'x' }, ['a']);
    expect(out.a).toEqual({ from: null, to: 'x' });
  });
});

// #558 — Tamper-evidence hash chain.
describe('lib/audit — canonicalize (deterministic key sort)', () => {
  test('returns same string for object regardless of key order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  test('preserves array order', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  test('handles nested objects deterministically', () => {
    const a = canonicalize({ outer: { z: 1, a: 2 }, key: 'v' });
    const b = canonicalize({ key: 'v', outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  test('null and primitives serialise via JSON.stringify', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('s')).toBe('"s"');
  });
});

describe('lib/audit — computeHash', () => {
  test('returns stable 64-char hex sha256', () => {
    const h = computeHash('PREV', { a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changing prevHash changes the hash', () => {
    const h1 = computeHash('PREV1', { a: 1 });
    const h2 = computeHash('PREV2', { a: 1 });
    expect(h1).not.toBe(h2);
  });

  test('changing payload changes the hash', () => {
    const h1 = computeHash('PREV', { a: 1 });
    const h2 = computeHash('PREV', { a: 2 });
    expect(h1).not.toBe(h2);
  });

  test('null prevHash hashes to a stable value', () => {
    expect(computeHash(null, { a: 1 })).toBe(computeHash(null, { a: 1 }));
  });
});

describe('lib/audit — genesisFor (per-tenant chain anchor)', () => {
  test('returns the canonical sentinel for a tenantId', () => {
    expect(genesisFor(1)).toBe('GENESIS_1');
    expect(genesisFor(42)).toBe('GENESIS_42');
  });

  test('different tenants get distinct anchors so a row cannot cross chains', () => {
    expect(genesisFor(1)).not.toBe(genesisFor(2));
  });
});

describe('lib/audit — backfillTenantChain (idempotent retroactive chain fill)', () => {
  // Helper: build an ordered list of "stored" audit rows. Pass `chained=true`
  // and the helper fills prevHash + hash using the canonical formula so the
  // chain validates; `chained=false` leaves both null (simulating pre-#558
  // legacy rows that the backfill is meant to repair).
  function buildRows(tenantId, n, chained) {
    const rows = [];
    let lastHash = null;
    for (let i = 0; i < n; i++) {
      const createdAt = new Date(Date.UTC(2026, 3, i + 1));
      const expectedPrev = lastHash == null ? `GENESIS_${tenantId}` : lastHash;
      const expectedHash = computeHash(expectedPrev, {
        tenantId, entity: 'Contact', action: 'CREATE',
        entityId: 1000 + i, userId: 5, details: JSON.stringify({ i }),
        createdAt: createdAt.toISOString(),
      });
      rows.push({
        id: i + 1,
        action: 'CREATE',
        entity: 'Contact',
        entityId: 1000 + i,
        userId: 5,
        details: JSON.stringify({ i }),
        createdAt,
        prevHash: chained ? expectedPrev : null,
        hash: chained ? expectedHash : null,
      });
      lastHash = expectedHash;
    }
    return rows;
  }

  test('fully unchained tenant — every row gets an update', async () => {
    const rows = buildRows(9, 3, false);
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const r = await backfillTenantChain(9);
    expect(r.walkedRows).toBe(3);
    expect(r.updatedRows).toBe(3);
    expect(r.skippedRows).toBe(0);
    expect(prisma.auditLog.update).toHaveBeenCalledTimes(3);
    // First update anchors to GENESIS_<tenantId>.
    expect(prisma.auditLog.update.mock.calls[0][0].data.prevHash).toBe('GENESIS_9');
    // Subsequent rows chain off the prior hash.
    const u1 = prisma.auditLog.update.mock.calls[0][0].data;
    const u2 = prisma.auditLog.update.mock.calls[1][0].data;
    expect(u2.prevHash).toBe(u1.hash);
  });

  test('idempotent: already-chained tenant produces 0 updates', async () => {
    const rows = buildRows(9, 4, true);
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const r = await backfillTenantChain(9);
    expect(r.walkedRows).toBe(4);
    expect(r.updatedRows).toBe(0);
    expect(r.skippedRows).toBe(4);
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
    expect(r.head).toBe(rows[3].hash);
  });

  test('mixed: chained head, then null tail — only tail rows update', async () => {
    const head = buildRows(9, 2, true);
    const tail = buildRows(9, 2, false);
    // Renumber tail ids so they come after head, and adjust createdAt to
    // keep [createdAt asc, id asc] ordering consistent with what the route
    // would return from the DB.
    tail.forEach((row, idx) => {
      row.id = head.length + idx + 1;
      row.createdAt = new Date(Date.UTC(2026, 3, head.length + idx + 1));
    });
    prisma.auditLog.findMany.mockResolvedValueOnce([...head, ...tail]);
    const r = await backfillTenantChain(9);
    expect(r.walkedRows).toBe(4);
    expect(r.updatedRows).toBe(2);
    expect(r.skippedRows).toBe(2);
    // The first tail update must chain off the head's last hash.
    const firstUpdate = prisma.auditLog.update.mock.calls[0][0].data;
    expect(firstUpdate.prevHash).toBe(head[head.length - 1].hash);
  });

  test('throws conflictRowId when a stored hash disagrees with the recomputation', async () => {
    const rows = buildRows(9, 3, true);
    // Tamper row 2's stored hash without updating its content → recomputed
    // won't match. The backfill MUST refuse to silently overwrite.
    rows[1].hash = 'a'.repeat(64);
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    let caught = null;
    try {
      await backfillTenantChain(9);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.conflictRowId).toBe(rows[1].id);
    // No updates should have landed — the run aborts on first conflict.
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  test('rejects invalid tenantId', async () => {
    await expect(backfillTenantChain('not-a-number')).rejects.toThrow(/invalid tenantId/);
  });

  test('walks rows in [createdAt asc, id asc] — must match the verifier', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([]);
    await backfillTenantChain(5);
    const callArgs = prisma.auditLog.findMany.mock.calls[0][0];
    expect(callArgs.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(callArgs.where).toEqual({ tenantId: 5 });
  });

  test('multi-tenant: backfill of tenant A does NOT touch tenant B rows', async () => {
    // Strict per-tenant scoping — the where clause filters on tenantId, so
    // a backfill call for tenant 1 never reads tenant 2 rows. Encodes the
    // multi-tenant-isolation contract called out in the spec.
    const rowsA = buildRows(1, 2, false);
    prisma.auditLog.findMany.mockResolvedValueOnce(rowsA);
    await backfillTenantChain(1);
    // The findMany was scoped to tenant 1.
    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({ tenantId: 1 });
    // Each update sets a hash anchored on tenant 1's GENESIS sentinel,
    // not a tenant-2 sentinel — verifying the genesisFor() call is
    // parameterised correctly.
    expect(prisma.auditLog.update.mock.calls[0][0].data.prevHash).toBe('GENESIS_1');
  });

  test('forked chain (writeAudit anchored on GENESIS over legacy null-hash rows) is repaired', async () => {
    // Scenario: PR #709 fallout. A fresh seed creates a batch of legacy
    // null-hash audit rows (prevHash=null, hash=null). After the seed,
    // routes/contacts.js's POST handler fires writeAudit for a new contact
    // BEFORE anyone has hit /api/audit/backfill. writeAudit's fail-soft
    // fallback (when the latest row's hash is null, anchor on
    // GENESIS_<tenantId>) silently forks the chain: the new row's prevHash
    // is GENESIS_1 instead of the real prior row's hash. The row's CONTENT
    // is intact — only the anchor is wrong.
    //
    // The backfill MUST repair these forks (re-stamp prevHash + hash) so
    // the verifier returns integrityVerified=true. The previous strict
    // semantics 409'd here because it couldn't distinguish "content
    // tampering" from "wrong anchor on intact content."
    const t = 1;
    // 3 legacy seed rows: prevHash=null, hash=null
    const legacy = buildRows(t, 3, false);
    // 1 API-written row that forked: anchored on GENESIS instead of legacy[2]'s
    // future-hash. Content is intact (computeHash(GENESIS, payload) === stored hash).
    const forkedCreatedAt = new Date(Date.UTC(2026, 3, legacy.length + 1));
    const forkedPayload = {
      tenantId: t, entity: 'Contact', action: 'CREATE',
      entityId: 2000, userId: 5, details: JSON.stringify({ i: 'forked' }),
      createdAt: forkedCreatedAt.toISOString(),
    };
    const forkedHash = computeHash(`GENESIS_${t}`, forkedPayload);
    const forkedRow = {
      id: legacy.length + 1,
      action: 'CREATE',
      entity: 'Contact',
      entityId: 2000,
      userId: 5,
      details: JSON.stringify({ i: 'forked' }),
      createdAt: forkedCreatedAt,
      prevHash: `GENESIS_${t}`,
      hash: forkedHash,
    };
    prisma.auditLog.findMany.mockResolvedValueOnce([...legacy, forkedRow]);

    const r = await backfillTenantChain(t);
    expect(r.walkedRows).toBe(4);
    // Legacy rows update (hash was null), forked row also updates (prevHash repaired).
    expect(r.updatedRows).toBe(4);
    expect(r.skippedRows).toBe(0);
    // The forked row's update must use the legacy chain tail's hash as prevHash.
    const lastUpdate = prisma.auditLog.update.mock.calls.at(-1)[0];
    expect(lastUpdate.where.id).toBe(forkedRow.id);
    expect(lastUpdate.data.prevHash).not.toBe(`GENESIS_${t}`);
    expect(lastUpdate.data.prevHash).toMatch(/^[0-9a-f]{64}$/);
    // After re-stamping, head equals the recomputed forked-row hash.
    expect(r.head).toMatch(/^[0-9a-f]{64}$/);
  });

  test('forked chain: idempotent — a second backfill after fork-repair produces 0 updates', async () => {
    // Once a forked chain has been repaired, a second backfill run must
    // recognise it as already-chained (recomputeWithStoredPrev === hash AND
    // prevHash === expectedPrev) and report updatedRows=0.
    const t = 1;
    // Build a 3-row chain with all hashes correct (simulating post-backfill state)
    const rows = buildRows(t, 3, true);
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const r = await backfillTenantChain(t);
    expect(r.updatedRows).toBe(0);
    expect(r.skippedRows).toBe(3);
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  test('content tampering on a forked-anchor row is STILL detected as a conflict', async () => {
    // Defence: the fork-repair path must NOT silently overwrite a row whose
    // CONTENT has been tampered with. Build a row where prevHash points at
    // GENESIS (would-be fork) AND the stored hash is wrong for the row's
    // content under that stored prevHash. The backfill must throw.
    const t = 1;
    const tamperedRow = {
      id: 1,
      action: 'CREATE',
      entity: 'Contact',
      entityId: 1000,
      userId: 5,
      details: JSON.stringify({ i: 'tampered' }),
      createdAt: new Date(Date.UTC(2026, 3, 1)),
      prevHash: `GENESIS_${t}`,
      // Stored hash that does NOT match the content under stored prevHash.
      // This represents "someone forged the hash AND chose the wrong anchor."
      hash: 'c'.repeat(64),
    };
    prisma.auditLog.findMany.mockResolvedValueOnce([tamperedRow]);
    let caught = null;
    try {
      await backfillTenantChain(t);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.conflictRowId).toBe(tamperedRow.id);
  });
});

describe('lib/audit — writeAudit hash chain', () => {
  test('first row uses GENESIS_<tenantId> as prevHash', async () => {
    prisma.auditLog.findFirst.mockResolvedValue(null); // empty chain
    await writeAudit('Contact', 'CREATE', 1, 7, 9, { name: 'Alice' });
    const arg = prisma.auditLog.create.mock.calls[0][0];
    expect(arg.data.prevHash).toBe('GENESIS_9');
    expect(arg.data.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('second row chains off the first row hash', async () => {
    // Row 1: empty chain → GENESIS prev.
    prisma.auditLog.findFirst.mockResolvedValueOnce(null);
    await writeAudit('Contact', 'CREATE', 1, 7, 9, { name: 'Alice' });
    const row1 = prisma.auditLog.create.mock.calls[0][0].data;
    expect(row1.prevHash).toBe('GENESIS_9');

    // Row 2: prior row returns the row1 hash → row2.prevHash === row1.hash.
    prisma.auditLog.findFirst.mockResolvedValueOnce({ hash: row1.hash });
    await writeAudit('Contact', 'UPDATE', 1, 7, 9, { name: 'Bob' });
    const row2 = prisma.auditLog.create.mock.calls[1][0].data;
    expect(row2.prevHash).toBe(row1.hash);
    expect(row2.hash).not.toBe(row1.hash);
  });

  test('hash matches independent computeHash recomputation', async () => {
    const fixedDate = new Date('2026-05-08T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedDate);
    prisma.auditLog.findFirst.mockResolvedValue(null);
    await writeAudit('Contact', 'CREATE', 1, 7, 9, { name: 'Alice' });
    const row = prisma.auditLog.create.mock.calls[0][0].data;
    const expected = computeHash('GENESIS_9', {
      tenantId: 9, entity: 'Contact', action: 'CREATE',
      entityId: 1, userId: 7,
      details: JSON.stringify({ name: 'Alice' }),
      createdAt: fixedDate.toISOString(),
    });
    expect(row.hash).toBe(expected);
    vi.useRealTimers();
  });

  test('fail-soft: prevHash lookup error → prevHash=null, still inserts', async () => {
    prisma.auditLog.findFirst.mockRejectedValue(new Error('db transient'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeAudit('Contact', 'CREATE', 1, 7, 9, null);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const row = prisma.auditLog.create.mock.calls[0][0].data;
    expect(row.prevHash).toBeNull();
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('chain detects tampering: recomputed hash differs when payload edited', async () => {
    prisma.auditLog.findFirst.mockResolvedValue(null);
    const createdAt = new Date('2026-05-08T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(createdAt);
    await writeAudit('Contact', 'CREATE', 1, 7, 9, { name: 'Alice' });
    const stored = prisma.auditLog.create.mock.calls[0][0].data;
    vi.useRealTimers();

    // Tamper: replace details in the stored row's payload.
    const tamperedDetails = JSON.stringify({ name: 'Mallory' });
    const recomputed = computeHash(stored.prevHash, {
      tenantId: 9, entity: 'Contact', action: 'CREATE',
      entityId: 1, userId: 7,
      details: tamperedDetails,
      createdAt: createdAt.toISOString(),
    });
    expect(recomputed).not.toBe(stored.hash);
  });
});

