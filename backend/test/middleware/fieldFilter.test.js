// Unit tests for backend/middleware/fieldFilter.js
// Covers getFieldPermissions caching + DB error handling, filterReadFields
// (single object, array, primitive passthrough), filterWriteFields, and
// clearCache.
//
// Mocking note: vi.mock can't reliably intercept the SUT's CJS
// `require('../lib/prisma')` here, so we monkey-patch
// `prisma.fieldPermission.findMany` on the shared client. Prisma connects
// lazily — no live DB hit because we never invoke the real method.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const prisma = require('../../lib/prisma');
const {
  getFieldPermissions,
  filterReadFields,
  filterWriteFields,
  hasModuleAction,
  clearCache,
} = require('../../middleware/fieldFilter.js');

let originalFindMany;
let findManyMock;

beforeEach(() => {
  originalFindMany = prisma.fieldPermission.findMany;
  findManyMock = vi.fn();
  prisma.fieldPermission.findMany = findManyMock;
  clearCache();
});

afterEach(() => {
  prisma.fieldPermission.findMany = originalFindMany;
});

describe('getFieldPermissions', () => {
  test('returns {} when role missing', async () => {
    expect(await getFieldPermissions(null, 'Deal', 1)).toEqual({});
    expect(findManyMock).not.toHaveBeenCalled();
  });

  test('returns {} when entity missing', async () => {
    expect(await getFieldPermissions('USER', null, 1)).toEqual({});
    expect(findManyMock).not.toHaveBeenCalled();
  });

  test('builds map keyed by field with canRead/canWrite', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: 'salary', canRead: false, canWrite: false },
      { field: 'notes', canRead: true, canWrite: false },
    ]);
    const map = await getFieldPermissions('USER', 'Deal', 1);
    expect(map).toEqual({
      salary: { canRead: false, canWrite: false },
      notes: { canRead: true, canWrite: false },
    });
  });

  test('caches results across repeated calls (single DB hit)', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: 'salary', canRead: false, canWrite: false },
    ]);
    await getFieldPermissions('USER', 'Deal', 1);
    await getFieldPermissions('USER', 'Deal', 1);
    await getFieldPermissions('USER', 'Deal', 1);
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  test('different cache key per role/entity/tenant', async () => {
    findManyMock.mockResolvedValue([]);
    await getFieldPermissions('USER', 'Deal', 1);
    await getFieldPermissions('USER', 'Deal', 2); // different tenant
    await getFieldPermissions('ADMIN', 'Deal', 1); // different role
    await getFieldPermissions('USER', 'Contact', 1); // different entity
    expect(findManyMock).toHaveBeenCalledTimes(4);
  });

  test('clearCache forces a fresh DB lookup', async () => {
    findManyMock.mockResolvedValue([]);
    await getFieldPermissions('USER', 'Deal', 1);
    clearCache();
    await getFieldPermissions('USER', 'Deal', 1);
    expect(findManyMock).toHaveBeenCalledTimes(2);
  });

  test('defaults tenantId to 1 + action to WRITE when missing', async () => {
    findManyMock.mockResolvedValueOnce([]);
    await getFieldPermissions('USER', 'Deal');
    expect(findManyMock).toHaveBeenCalledWith({
      // PRD Gap §1.3 — action axis. Default is "WRITE" (the legacy bucket)
      // so existing call sites without an action argument keep the same
      // semantics as before the action column was added.
      where: { role: 'USER', entity: 'Deal', tenantId: 1, action: 'WRITE' },
    });
  });

  test('returns {} when DB throws (graceful fallback)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    findManyMock.mockRejectedValueOnce(new Error('DB down'));
    const map = await getFieldPermissions('USER', 'Deal', 1);
    expect(map).toEqual({});
    errSpy.mockRestore();
  });
});

describe('filterReadFields', () => {
  test('passes through null', async () => {
    expect(await filterReadFields(null, 'USER', 'Deal', 1)).toBeNull();
  });

  test('passes through undefined', async () => {
    expect(await filterReadFields(undefined, 'USER', 'Deal', 1)).toBeUndefined();
  });

  test('passes through primitives', async () => {
    expect(await filterReadFields('hello', 'USER', 'Deal', 1)).toBe('hello');
    expect(await filterReadFields(42, 'USER', 'Deal', 1)).toBe(42);
  });

  test('no rules in DB → all fields preserved', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const row = { id: 1, name: 'Acme', salary: 50000 };
    const out = await filterReadFields(row, 'USER', 'Deal', 1);
    expect(out).toEqual(row);
  });

  test('strips fields with canRead=false', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: 'salary', canRead: false, canWrite: false },
    ]);
    const row = { id: 1, name: 'Acme', salary: 50000 };
    const out = await filterReadFields(row, 'USER', 'Deal', 1);
    expect(out).toEqual({ id: 1, name: 'Acme' });
    // Original record is not mutated.
    expect(row).toHaveProperty('salary', 50000);
  });

  test('preserves fields with canRead=true', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: 'notes', canRead: true, canWrite: false },
    ]);
    const out = await filterReadFields(
      { id: 1, notes: 'hello' },
      'USER',
      'Deal',
      1
    );
    expect(out).toEqual({ id: 1, notes: 'hello' });
  });

  test('handles arrays of records', async () => {
    findManyMock.mockResolvedValue([
      { field: 'salary', canRead: false, canWrite: false },
    ]);
    const rows = [
      { id: 1, salary: 1 },
      { id: 2, salary: 2 },
    ];
    const out = await filterReadFields(rows, 'USER', 'Deal', 1);
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('skips strip when field is absent on the record', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: 'salary', canRead: false, canWrite: false },
    ]);
    const row = { id: 1, name: 'Acme' };
    const out = await filterReadFields(row, 'USER', 'Deal', 1);
    expect(out).toEqual(row);
  });
});

describe('filterWriteFields', () => {
  test('passes through null/undefined/non-object', async () => {
    expect(await filterWriteFields(null, 'USER', 'Deal', 1)).toBeNull();
    expect(
      await filterWriteFields(undefined, 'USER', 'Deal', 1)
    ).toBeUndefined();
    expect(await filterWriteFields('hello', 'USER', 'Deal', 1)).toBe('hello');
  });

  test('strips fields with canWrite=false', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: 'salary', canRead: true, canWrite: false },
    ]);
    const payload = { name: 'Acme', salary: 99999 };
    const out = await filterWriteFields(payload, 'USER', 'Deal', 1);
    expect(out).toEqual({ name: 'Acme' });
    // Original payload not mutated.
    expect(payload).toHaveProperty('salary', 99999);
  });

  test('preserves fields with canWrite=true even if canRead=false', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: 'salary', canRead: false, canWrite: true },
    ]);
    const out = await filterWriteFields(
      { name: 'Acme', salary: 1 },
      'USER',
      'Deal',
      1
    );
    expect(out).toEqual({ name: 'Acme', salary: 1 });
  });

  test('no rules → entire payload preserved', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const payload = { name: 'Acme', salary: 1, notes: 'x' };
    const out = await filterWriteFields(payload, 'USER', 'Deal', 1);
    expect(out).toEqual(payload);
  });
});

// PRD Gap §1.3 — module × action permissions. hasModuleAction() is the
// gate every route handler can call instead of (or in addition to) the
// per-field filterReadFields / filterWriteFields helpers above.
describe('hasModuleAction', () => {
  test('returns false when user is null', async () => {
    expect(await hasModuleAction(null, 'Deal', 'DELETE')).toBe(false);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  test('ADMIN bypasses every action without DB hit', async () => {
    const admin = { role: 'ADMIN', tenantId: 1 };
    expect(await hasModuleAction(admin, 'Deal', 'READ')).toBe(true);
    expect(await hasModuleAction(admin, 'Deal', 'WRITE')).toBe(true);
    expect(await hasModuleAction(admin, 'Deal', 'DELETE')).toBe(true);
    expect(await hasModuleAction(admin, 'Deal', 'EXPORT')).toBe(true);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  test('MANAGER bypasses READ + WRITE but not DELETE/EXPORT', async () => {
    const manager = { role: 'MANAGER', tenantId: 1 };
    expect(await hasModuleAction(manager, 'Deal', 'READ')).toBe(true);
    expect(await hasModuleAction(manager, 'Deal', 'WRITE')).toBe(true);
    expect(findManyMock).not.toHaveBeenCalled();
    findManyMock.mockResolvedValueOnce([]);
    expect(await hasModuleAction(manager, 'Deal', 'DELETE')).toBe(true); // default-allow
    findManyMock.mockResolvedValueOnce([
      { field: '*', action: 'EXPORT', canRead: true, canWrite: false },
    ]);
    expect(await hasModuleAction(manager, 'Deal', 'EXPORT')).toBe(false);
  });

  test('USER default-allows when no rule exists for (role, module, action)', async () => {
    findManyMock.mockResolvedValueOnce([]);
    expect(
      await hasModuleAction({ role: 'USER', tenantId: 1 }, 'Deal', 'DELETE')
    ).toBe(true);
  });

  test('module-level rule (field=*) is authoritative', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: '*', action: 'DELETE', canRead: true, canWrite: false },
    ]);
    expect(
      await hasModuleAction({ role: 'USER', tenantId: 1 }, 'Deal', 'DELETE')
    ).toBe(false);
  });

  test('per-field deny propagates to module-level when no field=* rule', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: 'amount', action: 'WRITE', canRead: true, canWrite: false },
    ]);
    expect(
      await hasModuleAction({ role: 'USER', tenantId: 1 }, 'Deal', 'WRITE')
    ).toBe(false);
  });

  test('READ uses canRead, mutating actions use canWrite', async () => {
    findManyMock.mockResolvedValueOnce([
      { field: '*', action: 'READ', canRead: false, canWrite: true },
    ]);
    expect(
      await hasModuleAction({ role: 'USER', tenantId: 1 }, 'Patient', 'READ')
    ).toBe(false);
    findManyMock.mockResolvedValueOnce([
      { field: '*', action: 'WRITE', canRead: false, canWrite: true },
    ]);
    expect(
      await hasModuleAction({ role: 'USER', tenantId: 1 }, 'Patient', 'WRITE')
    ).toBe(true);
  });

  test('DB error fails open (preserves availability of historically-open routes)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    findManyMock.mockRejectedValueOnce(new Error('DB down'));
    expect(
      await hasModuleAction({ role: 'USER', tenantId: 1 }, 'Deal', 'DELETE')
    ).toBe(true);
    errSpy.mockRestore();
  });

  test('unknown action falls back to WRITE bucket', async () => {
    findManyMock.mockResolvedValueOnce([]);
    await hasModuleAction({ role: 'USER', tenantId: 1 }, 'Deal', 'BOGUS');
    expect(findManyMock).toHaveBeenCalledWith({
      where: { role: 'USER', entity: 'Deal', tenantId: 1, action: 'WRITE' },
    });
  });
});
