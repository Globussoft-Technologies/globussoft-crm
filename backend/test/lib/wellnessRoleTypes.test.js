// Unit tests for backend/lib/wellnessRoleTypes.js
//
// Mocking strategy: monkey-patch the prisma singleton (vi.mock doesn't
// intercept CJS require in this vitest setup — see leadJunkFilter.test.js
// for the same pattern).
//
// Covers:
//   - ensureRoleKey / ensureRoleLabel pure-input validators
//   - DEFAULT_WELLNESS_ROLES shape (one entry per legacy whitelist key
//     plus the new "nurse" addition that motivated Option B)
//   - listForTenant + isCatalogedKey + seedDefaultsForTenant DB interactions

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import roleTypes from '../../lib/wellnessRoleTypes.js';

const {
  DEFAULT_WELLNESS_ROLES,
  ROLE_KEY_RE,
  ensureRoleKey,
  ensureRoleLabel,
  listForTenant,
  isCatalogedKey,
  seedDefaultsForTenant,
} = roleTypes;

beforeAll(() => {
  prisma.wellnessRoleType = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  };
});

beforeEach(() => {
  prisma.wellnessRoleType.findMany.mockReset();
  prisma.wellnessRoleType.findFirst.mockReset();
  prisma.wellnessRoleType.create.mockReset();
});

describe('module shape', () => {
  test('exports the public surface', () => {
    expect(Array.isArray(DEFAULT_WELLNESS_ROLES)).toBe(true);
    expect(ROLE_KEY_RE).toBeInstanceOf(RegExp);
    expect(typeof ensureRoleKey).toBe('function');
    expect(typeof ensureRoleLabel).toBe('function');
    expect(typeof listForTenant).toBe('function');
    expect(typeof isCatalogedKey).toBe('function');
    expect(typeof seedDefaultsForTenant).toBe('function');
  });
});

describe('DEFAULT_WELLNESS_ROLES', () => {
  test('includes every key from the legacy hardcoded whitelist', () => {
    const keys = DEFAULT_WELLNESS_ROLES.map((r) => r.key);
    for (const legacy of ['doctor', 'professional', 'telecaller', 'helper', 'stylist']) {
      expect(keys).toContain(legacy);
    }
  });

  test('includes "nurse" — the example role that motivated Option B', () => {
    const keys = DEFAULT_WELLNESS_ROLES.map((r) => r.key);
    expect(keys).toContain('nurse');
  });

  test('every default has canTakeVisits as a boolean', () => {
    for (const r of DEFAULT_WELLNESS_ROLES) {
      expect(typeof r.canTakeVisits).toBe('boolean');
    }
  });

  test('telecaller + helper are NOT practitioners (operational roles)', () => {
    const find = (k) => DEFAULT_WELLNESS_ROLES.find((r) => r.key === k);
    expect(find('telecaller').canTakeVisits).toBe(false);
    expect(find('helper').canTakeVisits).toBe(false);
  });

  test('doctor + nurse + professional + stylist ARE practitioners', () => {
    const find = (k) => DEFAULT_WELLNESS_ROLES.find((r) => r.key === k);
    expect(find('doctor').canTakeVisits).toBe(true);
    expect(find('nurse').canTakeVisits).toBe(true);
    expect(find('professional').canTakeVisits).toBe(true);
    expect(find('stylist').canTakeVisits).toBe(true);
  });
});

describe('ensureRoleKey — pure validator', () => {
  test('returns ROLE_KEY_REQUIRED on empty when required (default)', () => {
    expect(ensureRoleKey('')).toEqual(expect.objectContaining({ status: 400, code: 'ROLE_KEY_REQUIRED' }));
    expect(ensureRoleKey(null)).toEqual(expect.objectContaining({ code: 'ROLE_KEY_REQUIRED' }));
    expect(ensureRoleKey(undefined)).toEqual(expect.objectContaining({ code: 'ROLE_KEY_REQUIRED' }));
  });

  test('returns null on empty when required=false', () => {
    expect(ensureRoleKey('', { required: false })).toBeNull();
    expect(ensureRoleKey(null, { required: false })).toBeNull();
  });

  test('accepts valid keys', () => {
    expect(ensureRoleKey('doctor')).toBeNull();
    expect(ensureRoleKey('nurse')).toBeNull();
    expect(ensureRoleKey('senior-doctor')).toBeNull();
    expect(ensureRoleKey('on-call-nurse-2')).toBeNull();
    expect(ensureRoleKey('a')).toBeNull();
  });

  test('rejects uppercase letters', () => {
    expect(ensureRoleKey('Doctor')).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
    expect(ensureRoleKey('NURSE')).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
  });

  test('rejects spaces and special characters', () => {
    expect(ensureRoleKey('senior doctor')).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
    expect(ensureRoleKey('nurse_2')).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
    expect(ensureRoleKey('nurse@home')).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
  });

  test('rejects keys starting with a digit or hyphen', () => {
    expect(ensureRoleKey('2nd-doctor')).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
    expect(ensureRoleKey('-doctor')).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
  });

  test('rejects keys longer than 32 chars', () => {
    const tooLong = 'a' + 'b'.repeat(32);
    expect(tooLong.length).toBe(33);
    expect(ensureRoleKey(tooLong)).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
  });

  test('accepts a key at the 32-char boundary', () => {
    const boundary = 'a' + 'b'.repeat(31);
    expect(boundary.length).toBe(32);
    expect(ensureRoleKey(boundary)).toBeNull();
  });

  test('rejects non-string values', () => {
    expect(ensureRoleKey(123)).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
    expect(ensureRoleKey({ key: 'doctor' })).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_KEY' }));
  });
});

describe('ensureRoleLabel — pure validator', () => {
  test('returns ROLE_LABEL_REQUIRED on empty when required (default)', () => {
    expect(ensureRoleLabel('')).toEqual(expect.objectContaining({ code: 'ROLE_LABEL_REQUIRED' }));
    expect(ensureRoleLabel(null)).toEqual(expect.objectContaining({ code: 'ROLE_LABEL_REQUIRED' }));
  });

  test('returns null on empty when required=false', () => {
    expect(ensureRoleLabel('', { required: false })).toBeNull();
  });

  test('accepts normal labels', () => {
    expect(ensureRoleLabel('Doctor')).toBeNull();
    expect(ensureRoleLabel('Nurse')).toBeNull();
    expect(ensureRoleLabel('Senior Physiotherapist')).toBeNull();
  });

  test('rejects labels longer than 64 chars', () => {
    expect(ensureRoleLabel('x'.repeat(65))).toEqual(expect.objectContaining({ code: 'INVALID_ROLE_LABEL' }));
  });

  test('accepts a 64-char label (boundary)', () => {
    expect(ensureRoleLabel('x'.repeat(64))).toBeNull();
  });
});

describe('listForTenant', () => {
  test('queries by tenantId only when activeOnly is false', async () => {
    prisma.wellnessRoleType.findMany.mockResolvedValue([{ id: 1, key: 'doctor' }]);
    const rows = await listForTenant(7);
    expect(prisma.wellnessRoleType.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7 },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
    expect(rows).toEqual([{ id: 1, key: 'doctor' }]);
  });

  test('adds isActive filter when activeOnly is true', async () => {
    prisma.wellnessRoleType.findMany.mockResolvedValue([]);
    await listForTenant(7, { activeOnly: true });
    expect(prisma.wellnessRoleType.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  });
});

describe('isCatalogedKey', () => {
  test('returns false on empty/missing key without hitting the DB', async () => {
    expect(await isCatalogedKey(7, '')).toBe(false);
    expect(await isCatalogedKey(7, null)).toBe(false);
    expect(await isCatalogedKey(7, undefined)).toBe(false);
    expect(prisma.wellnessRoleType.findFirst).not.toHaveBeenCalled();
  });

  test('returns true when an active row exists', async () => {
    prisma.wellnessRoleType.findFirst.mockResolvedValue({ id: 42 });
    expect(await isCatalogedKey(7, 'nurse')).toBe(true);
    expect(prisma.wellnessRoleType.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, key: 'nurse', isActive: true },
      select: { id: true },
    });
  });

  test('returns false when no matching row', async () => {
    prisma.wellnessRoleType.findFirst.mockResolvedValue(null);
    expect(await isCatalogedKey(7, 'nurse')).toBe(false);
  });

  test('returns false on DB error (fails closed)', async () => {
    prisma.wellnessRoleType.findFirst.mockRejectedValue(new Error('boom'));
    expect(await isCatalogedKey(7, 'nurse')).toBe(false);
  });
});

describe('seedDefaultsForTenant', () => {
  test('creates every default role when none exist', async () => {
    prisma.wellnessRoleType.findFirst.mockResolvedValue(null);
    prisma.wellnessRoleType.create.mockResolvedValue({});
    await seedDefaultsForTenant(7);
    expect(prisma.wellnessRoleType.create).toHaveBeenCalledTimes(DEFAULT_WELLNESS_ROLES.length);
    // Spot-check: nurse was passed in with tenantId
    const calls = prisma.wellnessRoleType.create.mock.calls;
    const nurseCall = calls.find((c) => c[0].data.key === 'nurse');
    expect(nurseCall).toBeDefined();
    expect(nurseCall[0].data.tenantId).toBe(7);
    expect(nurseCall[0].data.canTakeVisits).toBe(true);
  });

  test('is idempotent — skips roles that already exist', async () => {
    // First role exists, the rest don't.
    prisma.wellnessRoleType.findFirst.mockImplementation((args) => {
      if (args.where.key === DEFAULT_WELLNESS_ROLES[0].key) return Promise.resolve({ id: 1 });
      return Promise.resolve(null);
    });
    prisma.wellnessRoleType.create.mockResolvedValue({});
    await seedDefaultsForTenant(7);
    expect(prisma.wellnessRoleType.create).toHaveBeenCalledTimes(DEFAULT_WELLNESS_ROLES.length - 1);
  });

  test('does nothing when all roles already exist', async () => {
    prisma.wellnessRoleType.findFirst.mockResolvedValue({ id: 1 });
    await seedDefaultsForTenant(7);
    expect(prisma.wellnessRoleType.create).not.toHaveBeenCalled();
  });
});
