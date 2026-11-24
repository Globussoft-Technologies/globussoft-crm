import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

prisma.contact = prisma.contact || {};
prisma.contact.updateMany = vi.fn();
prisma.$transaction = vi.fn(async (operations) => Promise.all(operations));

const requireCJS = createRequire(import.meta.url);
const { ensureGenericContactStatuses } = requireCJS('../../scripts/ensureGenericContactStatuses');

beforeEach(() => {
  prisma.contact.updateMany.mockReset()
    .mockResolvedValueOnce({ count: 4 });
  prisma.$transaction.mockClear();
});

describe('ensureGenericContactStatuses', () => {
  test('normalizes only Generic New to Lead without deleting contacts', async () => {
    await expect(ensureGenericContactStatuses()).resolves.toEqual({
      updated: 4,
      replacements: {
        'New->Lead': 4,
      },
    });

    expect(prisma.contact.updateMany.mock.calls).toEqual([
      [{ where: { status: 'New', tenant: { vertical: 'generic' } }, data: { status: 'Lead' } }],
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  test('is a no-op after the legacy values have already been replaced', async () => {
    prisma.contact.updateMany.mockReset().mockResolvedValue({ count: 0 });

    await expect(ensureGenericContactStatuses()).resolves.toMatchObject({ updated: 0 });
  });
});
