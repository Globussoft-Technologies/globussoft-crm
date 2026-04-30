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

const { writeAudit, diffFields } = audit;

beforeAll(() => {
  prisma.auditLog = { create: vi.fn() };
});

beforeEach(() => {
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
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
