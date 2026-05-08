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

const { writeAudit, diffFields, canonicalize, computeHash } = audit;

beforeAll(() => {
  // #558 — writeAudit now also calls prisma.auditLog.findFirst() to look up
  // the previous row's hash; mock it alongside .create.
  prisma.auditLog = { create: vi.fn(), findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset();
  prisma.auditLog.findFirst.mockResolvedValue(null); // default: empty chain
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

