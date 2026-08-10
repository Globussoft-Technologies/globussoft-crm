// @ts-check
/**
 * Tests for backend/lib/callifiedAutoDialQueue.js.
 *
 * Pins the new-lead auto-dial contract:
 *   - Only Lead contacts with callifiedCampaignId + phone are dialable.
 *   - Enqueueing a dialable lead triggers one-by-one processing.
 *   - The lead is marked "connecting" before the call starts.
 *   - Classification is deferred until Callified transcripts/reviews are ready.
 *   - Qualified leads are round-robin assigned once classification completes.
 *   - Recently-dialled or no-longer-dialable leads are skipped.
 *   - Transient failures are retried a bounded number of times.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

const requireCJS = (await import('node:module')).createRequire(import.meta.url);
const Module = requireCJS('node:module');

// Patch callifiedClient BEFORE the queue module loads it.
const callifiedClientPath = requireCJS.resolve('../../services/callifiedClient.js');
const initiateCallForContactMock = vi.fn();
Module._cache[callifiedClientPath] = {
  id: callifiedClientPath,
  filename: callifiedClientPath,
  loaded: true,
  exports: {
    initiateCallForContact: initiateCallForContactMock,
  },
};

// Patch callifiedLeadStatus so we control classification + assignment.
const leadStatusPath = requireCJS.resolve('../../lib/callifiedLeadStatus.js');
const classifyLeadStatusMock = vi.fn();
const assignQualifiedLeadRoundRobinMock = vi.fn();
Module._cache[leadStatusPath] = {
  id: leadStatusPath,
  filename: leadStatusPath,
  loaded: true,
  exports: {
    CALL_STATUS: {
      YET_TO_CALL: 'yet_to_call',
      CONNECTED: 'connected',
      DNP: 'dnp',
      QUALIFIED: 'qualified',
      JUNK: 'junk',
    },
    classifyLeadStatus: classifyLeadStatusMock,
    assignQualifiedLeadRoundRobin: assignQualifiedLeadRoundRobinMock,
  },
};

// Patch DNP retry engine BEFORE the queue module lazy-loads it.
const dnpEnginePath = requireCJS.resolve('../../lib/callifiedDnpRetryEngine.js');
const scheduleDnpRetryMock = vi.fn().mockResolvedValue({ id: 11 });
const clearDnpRetryStateMock = vi.fn().mockResolvedValue({ id: 11 });
Module._cache[dnpEnginePath] = {
  id: dnpEnginePath,
  filename: dnpEnginePath,
  loaded: true,
  exports: {
    scheduleDnpRetry: scheduleDnpRetryMock,
    clearDnpRetryState: clearDnpRetryStateMock,
  },
};

const queueModule = requireCJS('../../lib/callifiedAutoDialQueue');
const { enqueue, stopProcessor, startProcessor, getQueueLength, isDialable } = queueModule;

describe('callifiedAutoDialQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stopProcessor();
    initiateCallForContactMock.mockReset().mockResolvedValue({ callifiedLeadId: 9001 });
    classifyLeadStatusMock.mockReset().mockResolvedValue({
      status: 'qualified',
      source: 'score',
      reason: 'High score',
    });
    assignQualifiedLeadRoundRobinMock.mockReset().mockResolvedValue(101);
    scheduleDnpRetryMock.mockReset().mockResolvedValue({ id: 11 });
    clearDnpRetryStateMock.mockReset().mockResolvedValue({ id: 11 });

    prisma.contact = prisma.contact || {};
    prisma.contact.findUnique = vi.fn().mockResolvedValue({
      id: 11,
      tenantId: 1,
      status: 'Lead',
      phone: '+919876543210',
      callifiedCampaignId: 42,
      callifiedLeadStatus: 'yet_to_call',
      assignedToId: null,
    });
    prisma.contact.update = vi.fn().mockResolvedValue({ id: 11 });
    prisma.callLog = prisma.callLog || {};
    prisma.callLog.findFirst = vi.fn().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    stopProcessor();
  });

  test('isDialable returns true for fresh Lead with campaign and phone', () => {
    expect(isDialable({ status: 'Lead', callifiedCampaignId: 42, phone: '+919876543210' })).toBe(true);
  });

  test('isDialable returns true for DNP leads (retries are allowed)', () => {
    expect(isDialable({ status: 'Lead', callifiedCampaignId: 42, phone: '+919876543210', callifiedLeadStatus: 'dnp' })).toBe(true);
  });

  test('isDialable returns false for already-called outcomes', () => {
    expect(isDialable({ status: 'Lead', callifiedCampaignId: 42, phone: '+919876543210', callifiedLeadStatus: 'qualified' })).toBe(false);
    expect(isDialable({ status: 'Lead', callifiedCampaignId: 42, phone: '+919876543210', callifiedLeadStatus: 'junk' })).toBe(false);
    expect(isDialable({ status: 'Lead', callifiedCampaignId: 42, phone: '+919876543210', callifiedLeadStatus: 'connected' })).toBe(false);
  });

  test('isDialable returns false when status, campaign, or phone is missing', () => {
    expect(isDialable({ status: 'Prospect', callifiedCampaignId: 42, phone: '+919876543210' })).toBe(false);
    expect(isDialable({ status: 'Lead', callifiedCampaignId: null, phone: '+919876543210' })).toBe(false);
    expect(isDialable({ status: 'Lead', callifiedCampaignId: 42, phone: '' })).toBe(false);
    expect(isDialable(null)).toBe(false);
  });

  test('enqueue marks lead as connecting before dialing, then classifies and assigns after delay', async () => {
    startProcessor();
    enqueue({ tenantId: 1, contactId: 11, campaignId: 42, userId: 7 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(initiateCallForContactMock).toHaveBeenCalledTimes(1);
    expect(initiateCallForContactMock).toHaveBeenCalledWith({
      tenantId: 1,
      contactId: 11,
      campaignId: 42,
      userId: 7,
      interest: 'Auto-dial on lead creation',
    });

    // Immediately after the dial succeeds the contact should be "connecting".
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: {
        callifiedLeadStatus: 'connected',
        callifiedLeadStatusSource: 'auto_dial',
        callifiedLeadStatusReason: 'Auto-dial in progress.',
        callifiedLeadStatusUpdatedAt: expect.any(Date),
      },
    });

    // Classification is deferred; it should not have run yet.
    expect(classifyLeadStatusMock).not.toHaveBeenCalled();

    // Advance past the classification delay to trigger polling.
    await vi.advanceTimersByTimeAsync(50_000);

    expect(classifyLeadStatusMock).toHaveBeenCalledWith(1, 11, { userId: 7 });
    expect(prisma.contact.update).toHaveBeenLastCalledWith({
      where: { id: 11 },
      data: {
        callifiedLeadStatus: 'qualified',
        callifiedLeadStatusSource: 'score',
        callifiedLeadStatusReason: 'High score',
        callifiedLeadStatusUpdatedAt: expect.any(Date),
      },
    });
    expect(assignQualifiedLeadRoundRobinMock).toHaveBeenCalledWith(1, 11, 'qualified');
    expect(clearDnpRetryStateMock).toHaveBeenCalledWith(11);
  });

  test('classification schedules DNP retry when call ends as DNP', async () => {
    classifyLeadStatusMock.mockResolvedValue({
      status: 'dnp',
      source: 'score',
      reason: 'Call was not answered.',
    });

    startProcessor();
    enqueue({ tenantId: 1, contactId: 11, campaignId: 42, userId: 7 });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(50_000);

    expect(classifyLeadStatusMock).toHaveBeenCalledWith(1, 11, { userId: 7 });
    expect(scheduleDnpRetryMock).toHaveBeenCalledWith(1, 11);
    expect(clearDnpRetryStateMock).not.toHaveBeenCalled();
  });

  test('classification keeps polling while review data is still pending', async () => {
    classifyLeadStatusMock
      .mockResolvedValueOnce({
        status: 'yet_to_call',
        source: 'score',
        reason: 'No Callified review data available yet.',
      })
      .mockResolvedValueOnce({
        status: 'junk',
        source: 'score',
        reason: 'Low score',
      });

    startProcessor();
    enqueue({ tenantId: 1, contactId: 11, campaignId: 42, userId: 7 });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(50_000);

    // First poll sees pending data; schedules another attempt.
    expect(classifyLeadStatusMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(35_000);

    expect(classifyLeadStatusMock).toHaveBeenCalledTimes(2);
    expect(prisma.contact.update).toHaveBeenLastCalledWith({
      where: { id: 11 },
      data: {
        callifiedLeadStatus: 'junk',
        callifiedLeadStatusSource: 'score',
        callifiedLeadStatusReason: 'Low score',
        callifiedLeadStatusUpdatedAt: expect.any(Date),
      },
    });
    expect(clearDnpRetryStateMock).toHaveBeenCalledWith(11);
  });

  test('enqueue skips a lead that is no longer dialable at process time', async () => {
    prisma.contact.findUnique.mockResolvedValue({
      id: 11,
      tenantId: 1,
      status: 'Prospect', // converted since enqueue
      phone: '+919876543210',
      callifiedCampaignId: 42,
      assignedToId: null,
    });
    startProcessor();
    enqueue({ tenantId: 1, contactId: 11, campaignId: 42, userId: 7 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(initiateCallForContactMock).not.toHaveBeenCalled();
  });

  test('enqueue skips a lead that was recently dialled', async () => {
    prisma.callLog.findFirst.mockResolvedValue({ id: 99, createdAt: new Date() });
    startProcessor();
    enqueue({ tenantId: 1, contactId: 11, campaignId: 42, userId: 7 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(initiateCallForContactMock).not.toHaveBeenCalled();
  });

  test('transient failures are retried up to 3 times then dropped', async () => {
    initiateCallForContactMock.mockRejectedValue(new Error('Callified timeout'));
    startProcessor();
    enqueue({ tenantId: 1, contactId: 11, campaignId: 42, userId: 7 });

    // 1 initial attempt + 2 retries = 3 total calls spread across delays.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(initiateCallForContactMock).toHaveBeenCalledTimes(3);
    expect(getQueueLength()).toBe(0);
  });

  test('deduplicates multiple enqueues for the same contact', async () => {
    startProcessor();
    enqueue({ tenantId: 1, contactId: 11, campaignId: 42, userId: 7 });
    enqueue({ tenantId: 1, contactId: 11, campaignId: 42, userId: 7 });

    await vi.advanceTimersByTimeAsync(2000);

    expect(initiateCallForContactMock).toHaveBeenCalledTimes(1);
  });
});
