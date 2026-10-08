import { beforeEach, describe, expect, test, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { processContactCreated } from '../../lib/genericCampaignAutomation.js';

beforeEach(() => {
  prisma.tenant = { findUnique: vi.fn().mockResolvedValue({ vertical: 'generic' }) };
  prisma.contact = { findFirst: vi.fn().mockResolvedValue({ id: 7, status: 'Lead' }) };
  prisma.leadCustomFieldValue = { findMany: vi.fn().mockResolvedValue([]) };
  prisma.campaign = { findMany: vi.fn() };
  prisma.sequenceEnrollment = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 42 }),
  };
});

describe('Generic campaign enrollment', () => {
  test('missing/malformed filters do not prevent later campaigns from enrolling', async () => {
    const sequence = { id: 10, steps: [] };
    prisma.campaign.findMany.mockResolvedValue([
      { sequence, scheduleFilters: null },
      { sequence, scheduleFilters: '{broken' },
      { sequence, scheduleFilters: '[]' },
      { sequence, scheduleFilters: JSON.stringify({ trigger: [{ field: 'contact.status', op: 'eq', value: 'Lead' }] }) },
    ]);
    expect(await processContactCreated(7, 1)).toEqual({ enrolled: 1 });
    expect(prisma.sequenceEnrollment.create).toHaveBeenCalledTimes(1);
    // No direct dispatcher runs: only the locked cron worker can deliver.
    expect(prisma.sequenceEnrollment.create.mock.calls[0][0].data).toMatchObject({ status: 'Active', tenantId: 1 });
  });

  test('does not enroll manual campaigns or non-generic tenants', async () => {
    prisma.campaign.findMany.mockResolvedValue([{ scheduleFilters: '{"enrollmentMode":"manual"}' }]);
    expect(await processContactCreated(7, 1)).toEqual({ enrolled: 0 });
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'travel' });
    expect(await processContactCreated(7, 1)).toMatchObject({ skipped: 'non_generic' });
    expect(prisma.sequenceEnrollment.create).not.toHaveBeenCalled();
  });
});
