import { beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';
const require = createRequire(import.meta.url);
const Module = require('node:module');
const notify = vi.fn().mockResolvedValue(undefined);
const path = require.resolve('../../lib/notificationService');
Module._cache[path] = { id: path, filename: path, loaded: true, exports: { notify } };
const { assignQualifiedLeadsBatch } = require('../../lib/callifiedLeadStatus');
const { KEYS } = require('../../lib/tenantSettings');
let rows;
beforeEach(() => {
  notify.mockClear();
  rows = [1, 2, 3, 4, 5].map((id) => ({ id }));
  prisma.tenantSetting.findUnique = vi.fn().mockImplementation(async ({ where }) => ({ value: where.tenantId_key.key === KEYS.CALLIFIED_ASSIGN_STAFF_LEADS_PER_USER ? '2' : where.tenantId_key.key === KEYS.CALLIFIED_ASSIGN_STAFF_LOGIC ? 'round_robin' : 'true' }));
  prisma.tenant.update = vi.fn().mockResolvedValue({ callifiedLastHotAssignedUserId: null, callifiedLastHotAssignedCount: 0 });
  prisma.user.findMany = vi.fn().mockResolvedValue([{ id: 11 }, { id: 12 }]);
  prisma.contact.findMany = vi.fn().mockImplementation(async () => rows);
  prisma.contact.updateMany = vi.fn().mockImplementation(async ({ where }) => ({ count: where.id.in.length }));
  prisma.$transaction = vi.fn(async (work) => work(prisma));
});
it('balances qualified leads in configured groups with one staff read and grouped writes', async () => {
  const result = await assignQualifiedLeadsBatch(1, [1, 2, 3, 4, 5]);
  expect(result.assigned).toBe(5);
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.contact.updateMany).toHaveBeenCalledTimes(2);
  expect(prisma.contact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 1, id: { in: [1, 2, 5] }, assignedToId: null }), data: { assignedToId: 11 } }));
  expect(prisma.contact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: [3, 4] } }), data: { assignedToId: 12 } }));
  expect(notify).toHaveBeenCalledTimes(2);
});
it('continues the tenant cursor across batches', async () => {
  prisma.tenant.update.mockResolvedValue({ callifiedLastHotAssignedUserId: 11, callifiedLastHotAssignedCount: 2 });
  rows = [{ id: 6 }];
  await assignQualifiedLeadsBatch(1, [6]);
  expect(prisma.contact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { assignedToId: 12 } }));
});
it('honors the assignment toggle without touching contacts', async () => {
  prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'false' });
  expect(await assignQualifiedLeadsBatch(1, [1])).toMatchObject({ assigned: 0, skipped: 1 });
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it('does not assign to an empty staff pool', async () => {
  prisma.user.findMany.mockResolvedValue([]);
  expect(await assignQualifiedLeadsBatch(1, [1, 2])).toMatchObject({ assigned: 0, skipped: 2 });
  expect(prisma.contact.updateMany).not.toHaveBeenCalled();
});
