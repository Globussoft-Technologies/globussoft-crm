import { beforeEach, describe, expect, test, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

for (const modelName of ['tenant', 'whatsAppConfig', 'tenantSetting', 'whatsAppMessage', 'whatsAppThread']) {
  if (!prisma[modelName]) prisma[modelName] = {};
}

prisma.tenant.findUnique = vi.fn();
prisma.whatsAppConfig.findFirst = vi.fn();
prisma.tenantSetting.findUnique = vi.fn();
prisma.whatsAppMessage.findFirst = vi.fn();
prisma.whatsAppMessage.create = vi.fn();
prisma.whatsAppThread.upsert = vi.fn();

const queue = require('../../lib/whatsappQueue');
const enqueueSend = vi.fn();
vi.spyOn(queue, 'getQueue').mockReturnValue({ enqueueSend });

const { sendGenericWebFormWhatsApp } = require('../../lib/genericWebFormWhatsApp');

const form = { id: 8, tenantId: 11, scope: 'generic', name: 'Contact us' };
const contact = { id: 21, name: 'Jane Doe', phone: '+919876543210', email: 'jane@example.com' };

beforeEach(() => {
  for (const fn of [
    prisma.tenant.findUnique,
    prisma.whatsAppConfig.findFirst,
    prisma.tenantSetting.findUnique,
    prisma.whatsAppMessage.findFirst,
    prisma.whatsAppMessage.create,
    prisma.whatsAppThread.upsert,
    enqueueSend,
  ]) fn.mockReset();

  prisma.tenant.findUnique.mockResolvedValue({ name: 'Acme', vertical: 'generic' });
  prisma.whatsAppConfig.findFirst.mockResolvedValue({ phoneNumberId: 'sender-1' });
  prisma.tenantSetting.findUnique.mockResolvedValue(null);
  prisma.whatsAppMessage.findFirst.mockResolvedValue(null);
  prisma.whatsAppThread.upsert.mockResolvedValue({ id: 31 });
  prisma.whatsAppMessage.create.mockResolvedValue({ id: 41 });
  enqueueSend.mockResolvedValue({ jobId: 51, status: 'PENDING' });
});

describe('generic web-form WhatsApp acknowledgement', () => {
  test('queues a configured Generic acknowledgement without requiring an admin phone', async () => {
    const result = await sendGenericWebFormWhatsApp({ form, contact, submissionId: 1001 });

    expect(result).toEqual({ sent: true, messageId: 41 });
    expect(prisma.whatsAppMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 11,
        contactId: 21,
        to: '+919876543210',
        interactiveJson: JSON.stringify({ submissionId: 1001, source: 'web_form' }),
      }),
    });
    expect(enqueueSend).toHaveBeenCalledWith({ messageId: 41, tenantId: 11 });
  });

  test('deduplicates retries of one submission instead of blocking later submissions forever', async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ id: 41 });

    const result = await sendGenericWebFormWhatsApp({ form, contact, submissionId: 1002 });

    expect(result).toEqual({ sent: false, code: 'DUPLICATE' });
    expect(prisma.whatsAppMessage.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: 11,
        contactId: 21,
        interactiveJson: JSON.stringify({ submissionId: 1002, source: 'web_form' }),
      }),
      select: { id: true },
    });
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('does not enqueue when the tenant has no active WhatsApp sender', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue(null);

    await expect(sendGenericWebFormWhatsApp({ form, contact, submissionId: 1003 })).resolves.toEqual({
      sent: false,
      code: 'WHATSAPP_NOT_CONFIGURED',
    });
    expect(prisma.whatsAppMessage.findFirst).not.toHaveBeenCalled();
  });
});
