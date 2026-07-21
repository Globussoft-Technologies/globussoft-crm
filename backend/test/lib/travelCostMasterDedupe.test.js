// Unit tests for backend/lib/travelCostMasterDedupe.js
//
// Covers the live drift guard that collapses duplicate logical rows in the
// Travel Cost Master table. The boot-time entry point is intentionally thin so
// the deterministic deduplication logic can be unit-tested in isolation.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCjs = createRequire(import.meta.url);

prisma.travelCostMaster = {
  findMany: vi.fn(),
  deleteMany: vi.fn(),
};

const {
  collapseCostMasterDuplicates,
  collapseCostMasterDuplicatesOnBoot,
} = requireCjs('../../lib/travelCostMasterDedupe');

function row(over = {}) {
  return {
    id: 1,
    tenantId: 1,
    subBrand: 'default',
    category: 'hotel',
    routeOrSku: 'goa-3star',
    updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    ...over,
  };
}

beforeEach(() => {
  prisma.travelCostMaster.findMany.mockReset();
  prisma.travelCostMaster.deleteMany.mockReset();
  delete process.env.DISABLE_COST_MASTER_DEDUP_BOOT_SYNC;
});

describe('collapseCostMasterDuplicates', () => {
  test('empty table → scanned 0, removed 0, no deleteMany', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    const r = await collapseCostMasterDuplicates();
    expect(r).toEqual({ scanned: 0, removed: 0 });
    expect(prisma.travelCostMaster.deleteMany).not.toHaveBeenCalled();
  });

  test('no duplicates → scanned N, removed 0, no deleteMany', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      row({ id: 1, tenantId: 1, category: 'hotel', routeOrSku: 'goa-3star' }),
      row({ id: 2, tenantId: 1, category: 'flight', routeOrSku: 'bom-goi' }),
      row({ id: 3, tenantId: 2, category: 'hotel', routeOrSku: 'goa-3star' }),
    ]);
    const r = await collapseCostMasterDuplicates();
    expect(r.scanned).toBe(3);
    expect(r.removed).toBe(0);
    expect(prisma.travelCostMaster.deleteMany).not.toHaveBeenCalled();
  });

  test('duplicate natural key removes the older row, keeping the newest updatedAt', async () => {
    const rows = [
      row({ id: 10, tenantId: 1, updatedAt: new Date('2026-07-18T00:00:00.000Z') }),
      row({ id: 20, tenantId: 1, updatedAt: new Date('2026-07-21T00:00:00.000Z') }),
    ];
    prisma.travelCostMaster.findMany.mockResolvedValue(rows);
    prisma.travelCostMaster.deleteMany.mockResolvedValue({ count: 1 });

    const r = await collapseCostMasterDuplicates();

    expect(r.scanned).toBe(2);
    expect(r.removed).toBe(1);
    expect(prisma.travelCostMaster.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [10] } },
    });
  });

  test('equal updatedAt → higher id wins', async () => {
    const sameDate = new Date('2026-07-20T00:00:00.000Z');
    const rows = [
      row({ id: 5, tenantId: 1, updatedAt: sameDate }),
      row({ id: 8, tenantId: 1, updatedAt: sameDate }),
    ];
    prisma.travelCostMaster.findMany.mockResolvedValue(rows);
    prisma.travelCostMaster.deleteMany.mockResolvedValue({ count: 1 });

    const r = await collapseCostMasterDuplicates();

    expect(r.removed).toBe(1);
    expect(prisma.travelCostMaster.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [5] } },
    });
  });

  test('natural key is scoped by tenantId + subBrand + category + routeOrSku', async () => {
    const rows = [
      row({ id: 1, tenantId: 1, subBrand: 'a', category: 'hotel', routeOrSku: 'x' }),
      row({ id: 2, tenantId: 1, subBrand: 'b', category: 'hotel', routeOrSku: 'x' }),
      row({ id: 3, tenantId: 1, subBrand: 'a', category: 'hotel', routeOrSku: 'x' }),
      row({ id: 4, tenantId: 2, subBrand: 'a', category: 'hotel', routeOrSku: 'x' }),
    ];
    prisma.travelCostMaster.findMany.mockResolvedValue(rows);
    prisma.travelCostMaster.deleteMany.mockResolvedValue({ count: 1 });

    await collapseCostMasterDuplicates();

    // Only id 1 and id 3 share the exact same natural key.
    expect(prisma.travelCostMaster.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [1] } },
    });
  });

  test('multiple duplicate groups collapse independently', async () => {
    const rows = [
      row({ id: 1, category: 'hotel', routeOrSku: 'x', updatedAt: new Date('2026-07-18T00:00:00.000Z') }),
      row({ id: 2, category: 'hotel', routeOrSku: 'x', updatedAt: new Date('2026-07-21T00:00:00.000Z') }),
      row({ id: 3, category: 'flight', routeOrSku: 'y', updatedAt: new Date('2026-07-19T00:00:00.000Z') }),
      row({ id: 4, category: 'flight', routeOrSku: 'y', updatedAt: new Date('2026-07-20T00:00:00.000Z') }),
    ];
    prisma.travelCostMaster.findMany.mockResolvedValue(rows);
    prisma.travelCostMaster.deleteMany.mockResolvedValue({ count: 2 });

    const r = await collapseCostMasterDuplicates();

    expect(r.removed).toBe(2);
    expect(prisma.travelCostMaster.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: expect.arrayContaining([1, 3]) } },
    });
  });

  test('passes optional where clause to findMany', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    const where = { tenantId: 7 };
    await collapseCostMasterDuplicates(where);
    expect(prisma.travelCostMaster.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
  });

  test('selects only the columns needed for the natural key + updatedAt', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    await collapseCostMasterDuplicates();
    expect(prisma.travelCostMaster.findMany).toHaveBeenCalledWith({
      where: {},
      select: {
        id: true,
        tenantId: true,
        subBrand: true,
        category: true,
        routeOrSku: true,
        updatedAt: true,
      },
      orderBy: [{ id: 'asc' }],
    });
  });

  test('missing updatedAt falls back to id-based tie-break', async () => {
    const rows = [
      row({ id: 5, tenantId: 1, updatedAt: null }),
      row({ id: 6, tenantId: 1, updatedAt: null }),
    ];
    prisma.travelCostMaster.findMany.mockResolvedValue(rows);
    prisma.travelCostMaster.deleteMany.mockResolvedValue({ count: 1 });

    await collapseCostMasterDuplicates();

    expect(prisma.travelCostMaster.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [5] } },
    });
  });
});

describe('collapseCostMasterDuplicatesOnBoot', () => {
  test('runs deduplication by default', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    const r = await collapseCostMasterDuplicatesOnBoot();
    expect(r).toEqual({ scanned: 0, removed: 0 });
  });

  test('returns null when DISABLE_COST_MASTER_DEDUP_BOOT_SYNC=1', async () => {
    process.env.DISABLE_COST_MASTER_DEDUP_BOOT_SYNC = '1';
    const r = await collapseCostMasterDuplicatesOnBoot();
    expect(r).toBeNull();
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });
});
