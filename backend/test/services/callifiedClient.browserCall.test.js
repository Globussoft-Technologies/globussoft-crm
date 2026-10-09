// @ts-check
/**
 * Tests for the manual/browser (agent-bridge) call path in
 * backend/services/callifiedClient.js.
 *
 * The AI dial path is already covered by callifiedClient.test.js. This file
 * covers what the manual path adds, and — importantly — the lead lifecycle
 * both modes now share, because the whole point of the refactor is that a
 * customer never ends up with two Callified leads:
 *
 *   - prepareContactCall gates on the feature flag / budget / phone BEFORE
 *     any Callified request goes out
 *   - enrollLeadTolerant treats "already enrolled" as success
 *   - initiateBrowserCallForContact enrolls, then calls the documented
 *     campaign-scoped browser-call endpoint
 *   - a 404 (stale mapped lead) clears the mapping and rebuilds ONCE
 *   - the CallLog row records the call_sid and marks the call as a browser call
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const client = requireCJS('../../services/callifiedClient');

const CONTACT = {
  id: 11,
  tenantId: 1,
  name: 'Asha Menon',
  phone: '9876543210',
  email: 'asha@example.test',
  company: null,
};

function stub(name, impl) {
  return vi.spyOn(client, name).mockImplementation(impl);
}

beforeEach(() => {
  vi.restoreAllMocks();

  prisma.contact = prisma.contact || {};
  prisma.contact.findUnique = vi.fn().mockResolvedValue({ ...CONTACT });
  prisma.contact.findFirst = vi.fn().mockResolvedValue({ id: CONTACT.id });
  prisma.contact.update = vi.fn().mockResolvedValue({ ...CONTACT });
  prisma.contact.updateMany = vi.fn().mockResolvedValue({ count: 1 });
  prisma.tenant = prisma.tenant || {};
  prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'generic' });
  prisma.customerPickup = prisma.customerPickup || {};
  prisma.customerPickup.upsert = vi.fn();
  prisma.callLog = prisma.callLog || {};
  prisma.callLog.create = vi.fn().mockImplementation(({ data }) => ({ id: 501, ...data }));
  prisma.callLog.findFirst = vi.fn().mockResolvedValue(null);
  prisma.callLog.update = vi.fn();
  prisma.integration = prisma.integration || {};
  prisma.integration.findUnique = vi.fn().mockResolvedValue(null);
  prisma.integration.update = vi.fn().mockResolvedValue({});

  stub('isEnabledForTenant', async () => true);
  stub('checkBudgetCap', async () => ({ withinCap: true }));
});

describe('prepareContactCall', () => {
  test('refuses before any Callified request when calling is disabled', async () => {
    stub('isEnabledForTenant', async () => false);
    const createLead = stub('createLead', async () => ({ id: 1 }));

    await expect(
      client.prepareContactCall({ tenantId: 1, contactId: 11, campaignId: 42 }),
    ).rejects.toMatchObject({ code: 'AI_CALLING_DISABLED' });
    expect(createLead).not.toHaveBeenCalled();
  });

  test('refuses a contact with no phone number', async () => {
    prisma.contact.findUnique = vi.fn().mockResolvedValue({ ...CONTACT, phone: null });
    await expect(
      client.prepareContactCall({ tenantId: 1, contactId: 11, campaignId: 42 }),
    ).rejects.toMatchObject({ code: 'MISSING_PHONE', status: 400 });
  });

  test('404s a contact from another tenant rather than calling a stranger', async () => {
    prisma.contact.findUnique = vi.fn().mockResolvedValue(null);
    await expect(
      client.prepareContactCall({ tenantId: 1, contactId: 11, campaignId: 42 }),
    ).rejects.toMatchObject({ code: 'CONTACT_NOT_FOUND', status: 404 });
  });

  test('normalizes the phone and splits the name before building the lead', async () => {
    const createLead = stub('createLead', async () => ({ id: 900 }));
    const prepared = await client.prepareContactCall({
      tenantId: 1,
      contactId: 11,
      campaignId: 42,
      interest: 'Appointment — Facial',
    });

    expect(prepared.normalizedPhone).toBe('+919876543210');
    expect(prepared.firstName).toBe('Asha');
    expect(prepared.lastName).toBe('Menon');

    await prepared.buildLead();
    expect(createLead).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        firstName: 'Asha',
        lastName: 'Menon',
        phone: '+919876543210',
        interest: 'Appointment — Facial',
        campaignId: 42,
        contactId: 11,
      }),
    );
  });
});

describe('enrollLeadTolerant', () => {
  test('reports a fresh enrollment', async () => {
    stub('enrollLead', async () => ({ added: 1 }));
    await expect(client.enrollLeadTolerant(1, 42, 900)).resolves.toMatchObject({
      enrolled: true,
      alreadyEnrolled: false,
    });
  });

  test('treats "already exists" as success — re-enrolling is a no-op, not a failure', async () => {
    stub('enrollLead', async () => {
      throw new Error('Lead already exists in this campaign');
    });
    await expect(client.enrollLeadTolerant(1, 42, 900)).resolves.toMatchObject({
      alreadyEnrolled: true,
    });
  });

  test('re-throws anything else so the caller can recover', async () => {
    stub('enrollLead', async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    await expect(client.enrollLeadTolerant(1, 42, 900)).rejects.toMatchObject({ status: 404 });
  });
});

describe('initiateBrowserCallForContact', () => {
  test('enrolls then browser-calls, and logs the call as a browser call', async () => {
    stub('createLead', async () => ({ id: 900 }));
    const enroll = stub('enrollLeadTolerant', async () => ({ enrolled: true }));
    const browser = stub('browserCall', async () => ({
      call_sid: 'EXsid1',
      agent_url: '/ws/agent?call_sid=EXsid1',
      status: 'dialing',
    }));

    const result = await client.initiateBrowserCallForContact({
      tenantId: 1,
      contactId: 11,
      campaignId: 42,
      userId: 5,
    });

    expect(enroll).toHaveBeenCalledWith(1, 42, 900);
    expect(browser).toHaveBeenCalledWith(1, 42, 900, expect.any(Object));
    expect(result).toMatchObject({
      mode: 'browser',
      callifiedLeadId: 900,
      callSid: 'EXsid1',
      agentUrl: '/ws/agent?call_sid=EXsid1',
      callLogId: 501,
      status: 'dialing',
    });

    const logged = prisma.callLog.create.mock.calls[0][0].data;
    expect(logged).toMatchObject({
      provider: 'callified',
      // The lead id, not the call_sid — so the existing details / attempts /
      // call-status lookups find browser calls the same way they find AI ones.
      providerCallId: '900',
      calleeNumber: '+919876543210',
      direction: 'OUTBOUND',
    });
    const notes = JSON.parse(logged.notes);
    expect(notes).toMatchObject({ mode: 'browser', callSid: 'EXsid1', callifiedLeadId: 900 });
  });

  test('a stale mapped lead (404) is rebuilt exactly once, then retried', async () => {
    const createLead = stub('createLead', async () => ({ id: 900 }));
    stub('enrollLeadTolerant', async () => ({ enrolled: true }));

    let attempt = 0;
    stub('browserCall', async () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { call_sid: 'EXsid2', agent_url: '/ws/agent?call_sid=EXsid2' };
    });

    const result = await client.initiateBrowserCallForContact({
      tenantId: 1,
      contactId: 11,
      campaignId: 42,
    });

    expect(createLead).toHaveBeenCalledTimes(2);
    expect(attempt).toBe(2);
    expect(result.callSid).toBe('EXsid2');
  });

  test('a non-404 failure is surfaced without a silent retry', async () => {
    const createLead = stub('createLead', async () => ({ id: 900 }));
    stub('enrollLeadTolerant', async () => ({ enrolled: true }));
    stub('browserCall', async () => {
      throw Object.assign(new Error('Server Error'), { status: 500 });
    });

    await expect(
      client.initiateBrowserCallForContact({ tenantId: 1, contactId: 11, campaignId: 42 }),
    ).rejects.toMatchObject({ status: 500 });
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(prisma.callLog.create).not.toHaveBeenCalled();
  });

  test('a response with no call_sid is rejected — there would be nothing to bridge', async () => {
    stub('createLead', async () => ({ id: 900 }));
    stub('enrollLeadTolerant', async () => ({ enrolled: true }));
    stub('browserCall', async () => ({ status: 'dialing' }));

    await expect(
      client.initiateBrowserCallForContact({ tenantId: 1, contactId: 11, campaignId: 42 }),
    ).rejects.toMatchObject({ code: 'CALLIFIED_MISSING_CALL_SID' });
    expect(prisma.callLog.create).not.toHaveBeenCalled();
  });
});

describe('resolveAgentSocketUrl', () => {
  beforeEach(() => {
    stub('getCallifiedConfig', async () => ({ baseUrl: 'https://app.callified.ai' }));
  });

  test('turns the relative agent_url into an absolute wss URL', async () => {
    await expect(client.resolveAgentSocketUrl(1, '/ws/agent?call_sid=abc')).resolves.toBe(
      'wss://app.callified.ai/ws/agent?call_sid=abc',
    );
  });

  test('leaves an already-absolute ws URL alone', async () => {
    await expect(client.resolveAgentSocketUrl(1, 'wss://other.host/ws/agent')).resolves.toBe(
      'wss://other.host/ws/agent',
    );
  });

  test('downgrades an http base to ws so a local deployment still bridges', async () => {
    stub('getCallifiedConfig', async () => ({ baseUrl: 'http://localhost:8000' }));
    await expect(client.resolveAgentSocketUrl(1, '/ws/agent?call_sid=abc')).resolves.toBe(
      'ws://localhost:8000/ws/agent?call_sid=abc',
    );
  });
});

describe('fetchAndStoreCallDetails pickup extraction', () => {
  test('automatically stores a confirmed transcript pickup for a generic CRM contact', async () => {
    stub('getCallDetails', async () => ({
      transcripts: [{
        id: 789,
        created_at: '2026-10-06T11:38:00.000Z',
        call_duration_s: 101,
        transcript: [{
          role: 'AI',
          text: 'I recorded that your pickup location is eighth block Koramangala near Lavis Pharma, SLS Ladies PG.',
        }],
      }],
      reviews: [{
        transcript_id: 789,
        summary: 'The pickup location is eighth block Koramangala near Lavis Pharma, SLS Ladies PG.',
      }],
    }));
    prisma.customerPickup.upsert.mockResolvedValue({
      id: 91,
      pickupAddress: 'eighth block Koramangala near Lavis Pharma, SLS Ladies PG',
      sourceTranscriptId: '789',
    });

    const result = await client.fetchAndStoreCallDetails({
      tenantId: 1,
      callifiedLeadId: '900',
      contactId: 11,
      updateScore: false,
    });

    expect(prisma.customerPickup.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_contactId: { tenantId: 1, contactId: 11 } },
      create: expect.objectContaining({
        pickupAddress: 'eighth block Koramangala near Lavis Pharma, SLS Ladies PG',
        sourceTranscriptId: '789',
      }),
    }));
    expect(result.capturedPickup).toMatchObject({ id: 91, sourceTranscriptId: '789' });
  });

  test('keeps Callified details available when pickup saving fails', async () => {
    stub('getCallDetails', async () => ({
      transcripts: [{
        id: 790,
        created_at: '2026-10-06T11:40:00.000Z',
        transcript: [{ role: 'AI', text: 'Your confirmed pickup location is 8th Block Koramangala.' }],
      }],
      reviews: [],
    }));
    prisma.customerPickup.upsert.mockRejectedValue(new Error('pickup table unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(client.fetchAndStoreCallDetails({
      tenantId: 1,
      callifiedLeadId: '901',
      contactId: 11,
      updateScore: false,
    })).resolves.toMatchObject({
      callStatus: expect.any(String),
      capturedPickup: null,
      latestTranscript: { id: 790 },
    });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('pickup capture failed (non-fatal)'));
  });

  test('clears a previously inferred interested area when the customer explicitly has no preference', async () => {
    stub('getCallDetails', async () => ({
      transcripts: [{
        id: 791,
        created_at: '2026-10-08T11:40:00.000Z',
        transcript: [
          { role: 'AI', text: 'Which plot or area would you like to visit?' },
          { role: 'User', text: "I don't have any specific area. Can you recommend?" },
        ],
      }],
      reviews: [{
        transcript_id: 791,
        summary: 'The customer may be interested in Koramangala plots.',
      }],
    }));

    const result = await client.fetchAndStoreCallDetails({
      tenantId: 1,
      callifiedLeadId: '902',
      contactId: 11,
      updateScore: false,
    });

    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { id: 11, tenantId: 1, deletedAt: null },
      data: { interestedPlotArea: null },
    });
    expect(result.interestedPlotArea).toBeNull();
  });
});
