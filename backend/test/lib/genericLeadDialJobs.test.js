import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';
const require = createRequire(import.meta.url);
const client = require('../../services/callifiedClient');
const jobs = require('../../lib/genericLeadDialJobs');
const safety = require('../../lib/genericCallSafety');
const { mapBounded } = require('../../lib/boundedWork');
const permissions = require('../../middleware/requirePermission');

beforeEach(() => {
  prisma.tenantSetting.findUnique = vi.fn().mockResolvedValue(null);
  prisma.tenant.update = vi.fn().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
  prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
  prisma.$transaction = vi.fn(async (work) => work(prisma));
  prisma.contact.findMany = vi.fn().mockResolvedValue([]);
  prisma.contact.count = vi.fn().mockResolvedValue(3);
  prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'generic' });
  prisma.contact.findFirst = vi.fn().mockResolvedValue({ id: 3, tenantId: 1, status: 'Lead', callifiedLeadStatus: 'pending' });
  prisma.contact.updateMany = vi.fn().mockResolvedValue({ count: 1 });
  prisma.callLog.findFirst = vi.fn().mockResolvedValue(null);
  prisma.callLog.updateMany = vi.fn().mockResolvedValue({ count: 1 });
  prisma.leadDialJob = {
    findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(0), create: vi.fn(),
  };
  client.initiateCallForContact = vi.fn().mockResolvedValue({ callLogId: 7 });
  client.fetchAndStoreCallDetails = vi.fn();
  permissions.userHasPermission = vi.fn().mockResolvedValue(true);
  prisma.user.findFirst = vi.fn().mockResolvedValue({ id: 9, tenantId: 1, role: 'ADMIN' });
});

describe('dial audience validation', () => {
  it('queues only selected statuses across assigned campaigns, including legacy status names', async () => {
    prisma.contact.groupBy = vi.fn().mockResolvedValue(['no_answer', 'pending', 'qualified', 'junk', null].map(callifiedLeadStatus => ({ callifiedLeadStatus })));
    prisma.leadDialJob.create.mockImplementation(async ({ data }) => ({ id: 5, ...data }));
    const job = await jobs.createJob({ tenantId: 1, userId: 9, role: 'ADMIN' }, { byStatus: true, statuses: ['dnp', 'pending'] });
    const selection = JSON.parse(job.audience);
    expect(jobs.audienceWhere(1, selection)).toMatchObject({
      tenantId: 1, callifiedCampaignId: { not: null }, phone: { not: '' },
      OR: [{ callifiedLeadStatus: { in: ['no_answer', 'pending'] } }],
    });
    expect(() => jobs.parseAudience({ byStatus: true })).toThrow();
    expect(() => jobs.parseAudience({ byStatus: true, statuses: ['qualified'] })).toThrow();
  });
  it('previews hundreds of selected leads using a single scoped query', async () => {
    const contactIds = Array.from({ length: 300 }, (_, index) => index + 1);
    prisma.contact.findMany = vi.fn().mockResolvedValue([
      { id: 1, phone: '123', callifiedCampaignId: 12, callifiedLeadStatus: 'dnp' },
      { id: 2, phone: '234', callifiedCampaignId: 12, callifiedLeadStatus: 'qualified' },
      { id: 3, phone: null },
      { id: 4, phone: '456', callifiedCampaignId: 12, callifiedLeadStatus: 'junk' },
    ]);
    await expect(jobs.previewSelection({ tenantId: 1, userId: 9, role: 'ADMIN' }, { contactIds })).resolves.toEqual({
      eligibleIds: [1, 4], withPhone: 3, missingPhone: 1, unavailable: 296,
    });
    expect(prisma.contact.findMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: { tenantId: 1, id: { in: contactIds }, status: 'Lead', deletedAt: null },
    }));
    expect(client.initiateCallForContact).not.toHaveBeenCalled();
  });
  it('persists a bounded campaign snapshot before acknowledging the run', async () => {
    prisma.leadDialJob.create.mockImplementation(async ({ data }) => ({ id: 5, ...data }));
    const job = await jobs.createJob({ userId: 9, tenantId: 1, role: 'ADMIN' }, { campaignIds: [12], statuses: ['dnp'] });
    expect(job).toMatchObject({ id: 5, tenantId: 1, userId: 9, upperBoundId: 3, total: 3 });
    expect(JSON.parse(job.audience).campaignIds).toEqual([12]);
    expect(prisma.contact.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ AND: expect.arrayContaining([{ id: { lte: 3 } }]) }) }));
  });
  it('applies admission backpressure instead of accumulating unlimited queued runs', async () => {
    prisma.leadDialJob.count.mockResolvedValue(20);
    await expect(jobs.createJob({ userId: 9, tenantId: 1, role: 'ADMIN' }, { campaignIds: [12] })).rejects.toMatchObject({ code: 'DIAL_QUEUE_FULL' });
    expect(prisma.leadDialJob.create).not.toHaveBeenCalled();
  });
  it('accepts one-off lead calls and deduplicates IDs', () => {
    expect(jobs.parseAudience({ contactIds: [3, 3] })).toMatchObject({ contactIds: [3], statuses: ['yet_to_call', 'dnp', 'pending', 'junk'] });
  });
  it('supports whole campaigns with a selected callable status', () => {
    expect(jobs.parseAudience({ campaignIds: [12], statuses: ['dnp'] })).toMatchObject({ campaignIds: [12], statuses: ['dnp'] });
  });
  it.each([
    { contactIds: [3], statuses: ['qualified'] },
    { contactIds: [3], statuses: ['connected'] },
    { contactIds: [3], statuses: [] },
    { contactIds: [3], campaignIds: [12] },
    { contactIds: [-1] }, { contactIds: [0] }, { contactIds: ['oops'] }, {},
    { contactIds: Array.from({ length: 1001 }, (_, i) => i + 1) },
    { contactIds: [3], scheduledAt: 'invalid' },
    { contactIds: [3], scheduledAt: new Date(Date.now() - 60_000).toISOString() },
  ])('rejects invalid or unsafe audiences: %j', (body) => {
    expect(() => jobs.parseAudience(body)).toThrow();
  });
  it('keeps scheduled instants in UTC', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(jobs.parseAudience({ contactIds: [3], scheduledAt: future }).scheduledAt.toISOString()).toBe(future);
  });
});

describe('shared call safety', () => {
  it.each(['qualified', 'hot', 'Qualified'])('blocks %s before any provider side effect', async (status) => {
    prisma.contact.findFirst.mockResolvedValue({ id: 3, callifiedLeadStatus: status });
    const dial = vi.fn();
    await expect(safety.guardedCall({ tenantId: 1, contactId: 3 }, dial)).rejects.toMatchObject({ code: 'LEAD_ALREADY_QUALIFIED' });
    expect(dial).not.toHaveBeenCalled();
  });
  it('rejects a competing lease', async () => {
    prisma.contact.updateMany.mockResolvedValue({ count: 0 });
    const dial = vi.fn();
    await expect(safety.guardedCall({ tenantId: 1, contactId: 3 }, dial)).rejects.toMatchObject({ code: 'LEAD_CALL_LOCKED' });
    expect(dial).not.toHaveBeenCalled();
  });
  it('releases the lease on a provider failure', async () => {
    const dial = vi.fn().mockRejectedValue(new Error('provider offline'));
    await expect(safety.guardedCall({ tenantId: 1, contactId: 3 }, dial)).rejects.toThrow('provider offline');
    expect(prisma.contact.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { callifiedDialLeaseUntil: null } }));
  });
  it('blocks duplicate active calls', async () => {
    prisma.callLog.findFirst.mockResolvedValue({ id: 7, status: 'RINGING' });
    const dial = vi.fn();
    await expect(safety.guardedCall({ tenantId: 1, contactId: 3 }, dial)).rejects.toMatchObject({ code: 'LEAD_CALL_ACTIVE' });
    expect(dial).not.toHaveBeenCalled();
  });
  it('keeps non-generic calling behavior', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
    const dial = vi.fn().mockResolvedValue({ callLogId: 1 });
    await expect(safety.guardedCall({ tenantId: 1, contactId: 3 }, dial)).resolves.toEqual({ callLogId: 1 });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });
});

describe('durable cancellation', () => {
  it('cancels future work without touching an active provider call', async () => {
    prisma.leadDialJob.findFirst.mockResolvedValue({ id: 5, tenantId: 1, activeCallLogId: 7 });
    await expect(jobs.cancelJob(1, 5)).resolves.toEqual({ cancelled: true, currentCallContinues: true });
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }), data: { status: 'cancelled' } }));
    expect(prisma.callLog.updateMany).not.toHaveBeenCalled();
    expect(prisma.callLog.findFirst).not.toHaveBeenCalled();
    expect(client.initiateCallForContact).not.toHaveBeenCalled();
  });
  it('keeps cancellation tenant-scoped', async () => {
    prisma.leadDialJob.findFirst.mockResolvedValue(null);
    await expect(jobs.cancelJob(4, 7)).rejects.toMatchObject({ status: 404 });
    expect(prisma.leadDialJob.findFirst).toHaveBeenCalledWith({ where: { id: 7, tenantId: 4 } });
    expect(prisma.leadDialJob.updateMany).not.toHaveBeenCalled();
  });
  it('does not dispatch a cancelled job', async () => {
    const tx = {
      tenant: { update: vi.fn() },
      leadDialJob: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn() },
    };
    prisma.$transaction = vi.fn((work) => work(tx));
    expect(await jobs.claimJob({ id: 5, tenantId: 1 })).toBeNull();
    expect(tx.leadDialJob.findUnique).not.toHaveBeenCalled();
  });
  it('does not claim a second run while a tenant has a running job', async () => {
    const tx = { tenant: { update: vi.fn() }, leadDialJob: { findFirst: vi.fn().mockResolvedValue({ id: 2 }), updateMany: vi.fn() } };
    prisma.$transaction = vi.fn((work) => work(tx));
    expect(await jobs.claimJob({ id: 5, tenantId: 1 })).toBeNull();
    expect(tx.leadDialJob.updateMany).not.toHaveBeenCalled();
  });
});

describe('persistent worker', () => {
  const job = { id: 5, tenantId: 1, userId: 9, cursorId: 0, upperBoundId: 100, audience: JSON.stringify({ contactIds: [], campaignIds: [12], statuses: ['dnp'] }), leaseUntil: new Date(Date.now() + 120_000) };
  it('finishes a scheduled call without replacing a manual status set during that call', async () => {
    const createdAt = new Date();
    prisma.callLog.findFirst.mockResolvedValue({ id: 7, contactId: 3, status: 'COMPLETED', createdAt });
    client.fetchAndStoreCallDetails.mockResolvedValue({ transcripts: [{ createdAt: createdAt.toISOString() }] });
    prisma.contact.findFirst.mockResolvedValue({ id: 3, callifiedLeadStatus: 'junk', callifiedLeadStatusSource: 'manual' });

    await jobs.processJob({ ...job, activeCallLogId: 7 });

    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { activeCallLogId: null, completed: { increment: 1 } },
    }));
  });
  it.each(['pending', 'qualified', 'junk', 'dnp'])('finishes the last scheduled attempt with a matching automatic %s outcome', async (outcome) => {
    const createdAt = new Date();
    prisma.callLog.findFirst.mockResolvedValue({ id: 7, contactId: 3, createdAt, status: 'INITIATED',
      contact: { callLogs: [{ id: 7 }], callifiedLeadStatus: outcome, callifiedLeadStatusSource: 'transcripts_api', callifiedLeadStatusUpdatedAt: createdAt } });
    prisma.callLog.updateMany.mockResolvedValue({ count: 1 });
    await jobs.processJob({ ...job, activeCallLogId: 7, cursorId: 3, upperBoundId: 3 });
    expect(client.fetchAndStoreCallDetails).not.toHaveBeenCalled();
    expect(prisma.callLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: outcome === 'dnp' ? 'MISSED' : 'COMPLETED' } }));
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'completed', completed: { increment: 1 }, activeCallLogId: null,
    }) }));
  });
  it.each(['pending', 'dnp'])('uses one %s retry when a status bulk call is accepted', async (status) => {
    const engine = require('../../lib/callifiedDnpRetryEngine');
    const policy = vi.spyOn(engine, status === 'pending' ? 'getPendingRetrySettings' : 'getDnpRetrySettings')
      .mockResolvedValue({ enabled: true, maxRetries: 2 });
    try {
      prisma.leadDialJob.findFirst.mockResolvedValue(job);
      prisma.contact.findMany.mockResolvedValue([{ id: 3, phone: '123', callifiedCampaignId: 12, callifiedLeadStatus: status, callifiedDnpRetryCount: 0 }]);
      await jobs.processJob({ ...job, audience: JSON.stringify({ byStatus: true, statuses: [status], matchingStatuses: [status] }) });
      expect(prisma.contact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        callifiedDnpRetryCount: { increment: 1 }, callifiedDnpNextRetryAt: null,
      }) }));
    } finally { policy.mockRestore(); }
  });
  it('starts a persisted run only when due after the backend worker restarts', async () => {
    vi.useFakeTimers();
    try {
      const scheduledAt = new Date(Date.now() + 60_000);
      prisma.leadDialJob.create.mockImplementation(async ({ data }) => ({ ...job, ...data, status: 'scheduled' }));
      const stored = await jobs.createJob({ tenantId: 1, userId: 9, role: 'ADMIN' }, {
        contactIds: [3], statuses: ['dnp'], scheduledAt: scheduledAt.toISOString(),
      });
      prisma.leadDialJob.findMany = vi.fn(async ({ where }) => stored.scheduledAt <= where.scheduledAt.lte ? [stored] : []);
      prisma.leadDialJob.findFirst.mockResolvedValueOnce(null).mockResolvedValue(stored);
      prisma.leadDialJob.findUnique = vi.fn().mockResolvedValue({ ...stored, status: 'running' });
      prisma.contact.findMany.mockResolvedValue([{ id: 3, phone: '+919876543210', callifiedCampaignId: 12, callifiedLeadStatus: 'dnp' }]);

      jobs.start();
      await vi.advanceTimersByTimeAsync(55_000);
      expect(client.initiateCallForContact).not.toHaveBeenCalled();
      jobs.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.initiateCallForContact).not.toHaveBeenCalled();

      jobs.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(client.initiateCallForContact).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ contactId: 3, tenantId: 1, userId: 9 }));
      expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ activeCallLogId: 7, dispatching: false, audience: expect.stringContaining('firstDialAt') }) }));
    } finally {
      jobs.stop();
      vi.useRealTimers();
    }
  });
  it('dispatches an eligible lead and persists the active call before the next tick', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 3, phone: '+919876543210', callifiedCampaignId: 12, callifiedLeadStatus: 'dnp' }]);
    prisma.leadDialJob.findFirst.mockResolvedValue(job);
    await jobs.processJob(job);
    expect(client.initiateCallForContact).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 1, userId: 9, contactId: 3, campaignId: 12 }));
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ activeCallLogId: 7, dispatching: false }) }));
  });
  it('lets an in-flight dial finish without restarting a cancelled run', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 3, phone: '+919876543210', callifiedCampaignId: 12, callifiedLeadStatus: 'dnp' }]);
    prisma.leadDialJob.findFirst.mockResolvedValue(job);
    client.initiateCallForContact.mockImplementation(async () => {
      await jobs.cancelJob(1, 5);
      return { callLogId: 7 };
    });
    await jobs.processJob(job);
    expect(client.initiateCallForContact).toHaveBeenCalledTimes(1);
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'cancelled' } }));
    expect(prisma.leadDialJob.updateMany.mock.calls.some(([query]) => query.data.status === 'running')).toBe(false);
    expect(prisma.callLog.updateMany).not.toHaveBeenCalled();
  });
  it('passes the JWT-shaped actor to the permission checker', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    await jobs.processJob(job);
    expect(permissions.userHasPermission).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, tenantId: 1 }), 'leads', 'write');
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'completed' } }));
  });
  it('bounds the number of ineligible leads skipped in one worker tick', async () => {
    prisma.contact.findMany.mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({
      id: index + 1, phone: '+919876543210', callifiedCampaignId: 12, callifiedLeadStatus: 'junk',
    })));
    await jobs.processJob(job);
    expect(client.initiateCallForContact).not.toHaveBeenCalled();
    expect(prisma.contact.findMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ take: 10 }));
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { cursorId: 10, skipped: { increment: 10 } } }));
  });
  it('skips a legacy qualified status before dialing the next eligible campaign lead', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 3, phone: '+919876543210', callifiedCampaignId: 12, callifiedLeadStatus: 'Qualified lead' },
      { id: 4, phone: '+919876543211', callifiedCampaignId: 12, callifiedLeadStatus: 'dnp' },
    ]);
    prisma.leadDialJob.findFirst.mockResolvedValue(job);
    await jobs.processJob(job);
    expect(client.initiateCallForContact).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ contactId: 4, campaignId: 12 }));
  });
  it('checks cancellation again immediately before a provider call', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 3, phone: '+919876543210', callifiedCampaignId: 12, callifiedLeadStatus: 'dnp' }]);
    prisma.leadDialJob.findFirst.mockResolvedValue(null);
    await jobs.processJob(job);
    expect(client.initiateCallForContact).not.toHaveBeenCalled();
  });
  it('keeps a scheduled run moving when a lead becomes qualified before dispatch', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 3, phone: '+919876543210', callifiedCampaignId: 12, callifiedLeadStatus: 'dnp' }]);
    prisma.leadDialJob.findFirst.mockResolvedValue(job);
    client.initiateCallForContact.mockRejectedValueOnce(Object.assign(new Error('Qualified'), { code: 'LEAD_ALREADY_QUALIFIED' }));
    await jobs.processJob(job);
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { skipped: { increment: 1 }, dispatching: false } }));
    expect(prisma.leadDialJob.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'paused' }) }));
  });

  it('records a failed call and clears it from the active scheduled run', async () => {
    prisma.callLog.findFirst.mockResolvedValue({ id: 7, contactId: 3, status: 'FAILED' });
    await jobs.processJob({ ...job, activeCallLogId: 7 });
    expect(client.fetchAndStoreCallDetails).not.toHaveBeenCalled();
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { activeCallLogId: null, failed: { increment: 1 } } }));
  });
  it('pauses an ambiguous dispatch after restart instead of redialing', async () => {
    await jobs.processJob({ ...job, dispatching: true });
    expect(client.initiateCallForContact).not.toHaveBeenCalled();
    expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'paused' }) }));
  });
  it('honors the workspace pause before processing leads', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'true' });
    await jobs.processJob(job);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(client.initiateCallForContact).not.toHaveBeenCalled();
  });
  it('does not advance the queue using an old completed transcript', async () => {
    prisma.callLog.findFirst.mockImplementation(async () => ({ id: 7, contactId: 3, providerCallId: 'remote-3', status: 'COMPLETED', createdAt: new Date() }));
    client.fetchAndStoreCallDetails.mockResolvedValue({ transcripts: [{ created_at: new Date(Date.now() - 86_400_000).toISOString(), status: 'completed' }] });
    await jobs.processJob({ ...job, activeCallLogId: 7 });
    expect(client.initiateCallForContact).not.toHaveBeenCalled();
    expect(prisma.leadDialJob.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ completed: { increment: 1 } }) }));
    expect(prisma.callLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'INITIATED' } }));
  });
});

it('bounds independent bulk side effects and preserves order', async () => {
  let active = 0; let peak = 0;
  const result = await mapBounded([1, 2, 3, 4, 5, 6], 2, async (number) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1)); --active;
    return number * 2;
  });
  expect(peak).toBe(2);
  expect(result).toEqual([2, 4, 6, 8, 10, 12]);
});
