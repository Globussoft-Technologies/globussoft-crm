// Unit tests for backend/lib/leadAutoRouter.js
//
// Mocking strategy: monkey-patch the prisma singleton (vi.mock doesn't
// intercept CJS require in this vitest setup).
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import router from '../../lib/leadAutoRouter.js';

const { pickAssignee, detectCategory } = router;

beforeAll(() => {
  prisma.user = { findMany: vi.fn(), findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.user.findMany.mockReset();
  prisma.user.findFirst.mockReset();
});

describe('lib/leadAutoRouter — module shape', () => {
  test('exports pickAssignee and detectCategory', () => {
    expect(typeof pickAssignee).toBe('function');
    expect(typeof detectCategory).toBe('function');
  });
});

describe('lib/leadAutoRouter — detectCategory (pure)', () => {
  test('returns null for empty input', () => {
    expect(detectCategory(null)).toBeNull();
    expect(detectCategory('')).toBeNull();
  });

  test('detects hair → "hair"', () => {
    expect(detectCategory('hair transplant')).toBe('hair');
    expect(detectCategory('FUE booking')).toBe('hair');
    expect(detectCategory('PRP scalp')).toBe('hair');
  });

  test('detects aesthetics', () => {
    expect(detectCategory('botox')).toBe('aesthetics');
    expect(detectCategory('filler')).toBe('aesthetics');
  });

  test('detects laser', () => {
    expect(detectCategory('laser hair removal')).toBe('laser');
  });

  test('detects skin', () => {
    expect(detectCategory('acne treatment')).toBe('skin');
  });

  test('detects body', () => {
    expect(detectCategory('liposuction')).toBe('body');
  });

  test('detects ayurveda', () => {
    expect(detectCategory('shirodhara')).toBe('ayurveda');
  });

  test('detects salon', () => {
    expect(detectCategory('haircut')).toBe('salon');
  });

  test('returns null for non-matching text', () => {
    expect(detectCategory('hello world')).toBeNull();
  });
});

describe('lib/leadAutoRouter — pickAssignee', () => {
  test('keyword match → assigns to specialist (doctor for hair)', async () => {
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 11, name: 'Dr. Harsh' },
      { id: 12, name: 'Dr. Priya' },
    ]);
    const out = await pickAssignee({ tenantId: 1, note: 'hair transplant inquiry' });
    expect([11, 12]).toContain(out.userId);
    expect(out.reason).toMatch(/hair.*doctor/i);
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where.wellnessRole).toBe('doctor');
  });

  test('keyword match → assigns to professional (laser)', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 21, name: 'Pro' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'laser hair removal' });
    expect(out.userId).toBe(21);
    expect(out.reason).toMatch(/laser.*professional/i);
  });

  test('aesthetics → doctor', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 31, name: 'Dr. A' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'botox booking' });
    expect(out.userId).toBe(31);
    expect(out.reason).toMatch(/aesthetics.*doctor/i);
  });

  test('skin → doctor', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 32, name: 'Dr. S' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'acne' });
    expect(out.reason).toMatch(/skin.*doctor/i);
  });

  test('ayurveda → professional', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 33, name: 'Practitioner' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'shirodhara therapy' });
    expect(out.reason).toMatch(/ayurveda.*professional/i);
  });

  test('falls back to telecaller round-robin when no specialist found', async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 41, name: 'TC1' }, { id: 42, name: 'TC2' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'hair transplant' });
    expect([41, 42]).toContain(out.userId);
    expect(out.reason).toMatch(/round-robin telecaller/i);
  });

  test('falls back to telecaller when no category detected', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 51, name: 'TC' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'just a generic question' });
    expect(out.userId).toBe(51);
    expect(out.reason).toMatch(/round-robin telecaller/i);
  });

  test('falls back to manager when no telecaller exists', async () => {
    prisma.user.findMany.mockResolvedValueOnce([]); // telecallers empty
    prisma.user.findFirst.mockResolvedValueOnce({ id: 99 }); // manager exists
    const out = await pickAssignee({ tenantId: 1, note: 'plain question' });
    expect(out.userId).toBe(99);
    expect(out.reason).toMatch(/manager/i);
  });

  test('returns null userId when no staff at all', async () => {
    prisma.user.findMany.mockResolvedValueOnce([]); // telecallers
    prisma.user.findFirst.mockResolvedValueOnce(null); // no manager
    const out = await pickAssignee({ tenantId: 1, note: 'plain' });
    expect(out.userId).toBeNull();
    expect(out.reason).toMatch(/no available staff/i);
  });

  test('combines name + source + note in keyword detection haystack', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1, name: 'Dr. X' }]);
    const out = await pickAssignee({
      tenantId: 1,
      name: 'Rishu',
      source: 'indiamart',
      note: 'wants liposuction',
    });
    expect(out.reason).toMatch(/body.*doctor/i);
  });

  test('round-robin distributes across telecallers across calls', async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 100 }, { id: 101 }, { id: 102 }])
      .mockResolvedValueOnce([{ id: 100 }, { id: 101 }, { id: 102 }])
      .mockResolvedValueOnce([{ id: 100 }, { id: 101 }, { id: 102 }]);
    const a = await pickAssignee({ tenantId: 1, note: 'plain' });
    const b = await pickAssignee({ tenantId: 1, note: 'plain' });
    const c = await pickAssignee({ tenantId: 1, note: 'plain' });
    const ids = [a.userId, b.userId, c.userId];
    const distinct = new Set(ids);
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });
});
