import { beforeEach, describe, expect, test, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { processStep, receiverConditionMatches } from '../../cron/sequenceEngine.js';

const enqueueSend = vi.hoisted(() => vi.fn());
vi.mock('../../lib/whatsappQueue.js', () => ({ getQueue: () => ({ enqueueSend }) }));

function enrollment() {
  return {
    id: 100,
    tenantId: 1,
    sequenceId: 50,
    currentStep: 0,
    contactId: 7,
    contact: { id: 7, name: 'Jane Doe', first_name: 'Jane', phone: '+919876543210', leadCustomFieldValues: [] },
    sequence: { tenant: { vertical: 'generic', name: 'NovaCrest' }, campaigns: [] },
  };
}

beforeEach(() => {
  prisma.payment = { findFirst: vi.fn().mockResolvedValue(null) };
  prisma.plotBooking = { findFirst: vi.fn().mockResolvedValue(null) };
  prisma.plotSite = { findFirst: vi.fn().mockResolvedValue(null) };
  prisma.whatsAppConfig = { findFirst: vi.fn().mockResolvedValue({ phoneNumberId: 'phone-id' }) };
  prisma.whatsAppOptOut = { findUnique: vi.fn().mockResolvedValue(null) };
  prisma.whatsAppTemplate = { findFirst: vi.fn().mockResolvedValue({ id: 9, name: 'follow_up', body: 'Hi {{1}}', variableMapping: '{"1":"contact.first_name"}' }) };
  prisma.whatsAppMessage = { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 22 }) };
  prisma.whatsAppThread = { upsert: vi.fn().mockResolvedValue({ id: 44 }), findMany: vi.fn().mockResolvedValue([]) };
  prisma.waOutboundJob = { create: vi.fn().mockResolvedValue({ id: 60, status: 'PENDING' }) };
  prisma.campaign = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
  enqueueSend.mockReset().mockResolvedValue({});
});

describe('Generic WhatsApp sequence execution', () => {
  test('queues the approved template stored in a WhatsApp step', async () => {
    await expect(processStep({
      id: 8,
      position: 0,
      kind: 'whatsapp',
      conditionJson: JSON.stringify({ version: 1, whatsappTemplateId: 9 }),
    }, enrollment())).resolves.toEqual({ advance: true });

    expect(prisma.whatsAppTemplate.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 9, tenantId: 1, status: 'APPROVED' } }));
    expect(prisma.whatsAppMessage.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      body: 'Hi Jane', templateName: 'follow_up', contactId: 7, threadId: 44,
    }) }));
    expect(prisma.waOutboundJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ messageId: 22, tenantId: 1 }) }));
  });

  test('reply condition only matches an inbound message sent after the latest sequence message', async () => {
    prisma.whatsAppMessage.findFirst
      .mockResolvedValueOnce({ id: 20, threadId: 44, createdAt: new Date('2026-10-21T10:00:00Z') })
      .mockResolvedValueOnce({ id: 21 });

    await expect(receiverConditionMatches({ type: 'whatsapp_activity', event: 'replied' }, enrollment())).resolves.toBe(true);
    expect(prisma.whatsAppMessage.findFirst.mock.calls[1][0].where).toMatchObject({
      contactId: 7,
      threadId: 44,
      direction: 'INBOUND',
      createdAt: { gt: new Date('2026-10-21T10:00:00Z') },
    });
  });
});
